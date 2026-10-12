import cron from "node-cron";

import { getUserStore, identifierFor, isQuietNow, newId, tzParts, utcDateString } from "./store.js";
import { listUsers, findUserById } from "./auth.js";
import { billingConfigured, effectiveLimits, refreshSubscription } from "./billing.js";
import { deliverToContact, isConnected, sendImageToJid, sendStatusPost, sendTextToJid } from "./whatsapp.js";
import { spin } from "./spintax.js";

let started = false;

// Per-user busy flags so one user's long send run never blocks another
// user's tick, while still preventing overlapping runs for the same user.
const busy = new Set();
function acquire(key) {
  if (busy.has(key)) return false;
  busy.add(key);
  return true;
}
function release(key) {
  busy.delete(key);
}

// Schedule occurrence keys already reported as missed while offline,
// namespaced per user.
const notifiedMissed = new Set();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(ms) {
  return ms + Math.floor(Math.random() * 3000);
}

function minutesOf(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
}

// 0=Sunday..6=Saturday in the given IANA timezone.
function weekdayInTz(now, tz) {
  try {
    const day = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
    return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[day] ?? -1;
  } catch {
    return -1;
  }
}

export function startScheduler() {
  if (started) return;
  started = true;
  cron.schedule("* * * * *", () => {
    tick().catch((error) => console.error("Scheduler tick error:", error.message));
  });
  // Pick up anything due shortly after boot.
  setTimeout(() => {
    tick().catch((error) => console.error("Scheduler tick error:", error.message));
  }, 20000);
  console.log("Marketing scheduler started (every minute).");
}

async function tick() {
  let users = [];
  try {
    users = listUsers();
  } catch (error) {
    console.error("Scheduler tick: could not list users:", error.message);
    return;
  }
  // Fire each user's pass without awaiting: users run concurrently, and a
  // slow sender can never stall another user's campaigns.
  for (const user of users) {
    processUser(user.id).catch((error) =>
      console.error(`Scheduler error for user ${user.id}:`, error.message)
    );
  }
}

// Exported for testing. Billing: only active subscriptions send. past_due /
// suspended / pending_payment accounts are skipped entirely (their dashboard
// shows a banner / paywall / suspended notice instead).
export async function processUser(userId) {
  if (billingConfigured()) {
    const user = findUserById(userId);
    if (!user) return;
    const status = await refreshSubscription(user);
    if (status !== "active") return;
  }
  const userStore = getUserStore(userId);
  await userStore.load();
  const store = userStore.get();
  const settings = store.settings;
  await processCampaigns(userId, userStore, store, settings);
  await processFollowUps(userId, userStore, store, settings);
  await processSchedules(userId, userStore, store, settings);
  await processStatusPosts(userId, userStore, store, settings);
  userStore.save();
}

/* =========================
   BULK DM CAMPAIGNS
========================= */

function buildRecipients(store, campaign) {
  if (campaign.audienceType === "ids") {
    const wanted = new Set(campaign.contactIds || []);
    return store.contacts.filter((c) => wanted.has(c.id));
  }
  if (campaign.audienceType === "groups") {
    const wanted = new Set(campaign.groupJids || []);
    return store.contacts.filter((c) => c.sourceGroups.some((g) => wanted.has(g)));
  }
  if (campaign.audienceType === "list") {
    return store.contacts.filter((c) => (c.listIds || []).includes(campaign.listId));
  }
  return store.contacts.slice();
}

function touchContact(store, contactId) {
  const contact = store.contacts.find((c) => c.id === contactId);
  if (contact) contact.lastSentAt = new Date().toISOString();
}

function contactLabel(contact) {
  return contact.digits ? `+${contact.digits}` : "(number hidden)";
}

// Shared sending engine for campaigns and follow-ups.
// Returns true when the job just completed.
async function runOutboundJob(userId, userStore, store, settings, job) {
  if (isQuietNow(settings, settings.defaultTimezone)) return false;
  if (!isConnected(userId)) return false; // stay queued/running until WhatsApp is linked
  if (!Array.isArray(job.sentIds)) job.sentIds = []; // pre-v1.7 jobs

  // Cooldown rest after the hourly cap was hit: wait it out, then resume.
  if (job.coolUntil) {
    if (Date.now() < job.coolUntil) return false; // stay running; the next tick retries
    delete job.coolUntil;
    delete job.cooldownMsg;
    userStore.save();
  }
  if (typeof job.batchSentCount !== "number") job.batchSentCount = 0; // pre-batch-cooldown jobs

  // Plan ceilings: the Pro plan caps daily/hourly DMs no matter what the
  // user configured (their own lower settings still apply via min()).
  const caps = effectiveLimits(settings);

  let consecutiveFailures = 0;
  while (job.cursor < job.recipientIds.length && job.status === "running") {
    // Batch cooldown: after every dmBatchSize sends, pause for
    // dmBatchCooldownMin minutes, then resume automatically. Keeps the
    // send rhythm human instead of one long burst (ban-proofing).
    if (settings.dmBatchSize > 0 && job.cooldownUntil) {
      if (new Date(job.cooldownUntil).getTime() > Date.now()) {
        return false; // stay running; the next tick retries
      }
      job.cooldownUntil = null;
      userStore.addLog({ kind: "dm", ref: job.id, ok: true, message: "Cooldown over — resuming sends." });
    }

    const contact = store.contacts.find((c) => c.id === job.recipientIds[job.cursor]);
    if (!contact) {
      job.cursor += 1;
      continue;
    }
    const label = contactLabel(contact);
    const ident = identifierFor(contact);

    if (!ident || userStore.isOptedOut(ident)) {
      job.progress.skipped += 1;
      job.cursor += 1;
      continue;
    }

    const today = utcDateString(new Date());
    const sentToday = store.logs.filter(
      (l) => l.kind === "dm" && l.ok && typeof l.ts === "string" && l.ts.slice(0, 10) === today
    ).length;
    if (sentToday >= caps.dailyCap) {
      job.status = "paused";
      job.error = `Daily DM cap reached (${caps.dailyCap}). Resume tomorrow or raise the cap in Settings.`;
      userStore.addLog({ kind: "dm", ref: job.id, ok: false, error: job.error });
      return false;
    }

    // Hourly pacing: when the cap is hit, take a cooldown rest before resuming.
    if (caps.hourlyCap > 0) {
      const hourAgo = Date.now() - 3600 * 1000;
      const sentLastHour = store.logs.filter(
        (l) => l.kind === "dm" && l.ok && typeof l.ts === "string" && new Date(l.ts).getTime() >= hourAgo
      ).length;
      if (sentLastHour >= caps.hourlyCap) {
        const mins = settings.dmHourlyCooldownMin > 0 ? Math.round(settings.dmHourlyCooldownMin) : 0;
        if (mins > 0) {
          job.coolUntil = Date.now() + mins * 60000;
          const resumeAt = new Date(job.coolUntil).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
          job.cooldownMsg = `Cooling down after ${caps.hourlyCap} DMs this hour — resumes ~${resumeAt}.`;
          userStore.save();
        }
        return false; // stay running; the next tick retries
      }
    }

    try {
      const text = spin(job.message, contact);
      const image = await userStore.readUpload(job.imagePath);
      await deliverToContact(userId, contact, text, image);
      userStore.addLog({ kind: "dm", ref: job.id, target: label, ok: true });
      job.progress.sent += 1;
      job.sentIds.push(contact.id);
      touchContact(store, contact.id);
      consecutiveFailures = 0;
    } catch (error) {
      userStore.addLog({ kind: "dm", ref: job.id, target: label, ok: false, error: error.message });
      job.progress.failed += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 5) {
        job.status = "paused";
        job.error = `Paused after 5 consecutive failures: ${error.message}`;
        return false;
      }
    }

    job.cursor += 1;

    // Batch cooldown: after every dmBatchSize successful sends, pause for
    // dmBatchCooldownMin minutes. Only triggers mid-job (not at the end).
    if (settings.dmBatchSize > 0) {
      job.batchSentCount = (job.batchSentCount || 0) + 1;
      if (job.batchSentCount >= settings.dmBatchSize && job.cursor < job.recipientIds.length) {
        job.batchSentCount = 0;
        job.cooldownUntil = new Date(Date.now() + settings.dmBatchCooldownMin * 60000).toISOString();
        userStore.addLog({
          kind: "dm",
          ref: job.id,
          ok: true,
          message: `Batch of ${settings.dmBatchSize} sent — cooling down for ${settings.dmBatchCooldownMin} min.`
        });
        return false; // stay running; the next tick resumes after the cooldown
      }
    }

    if (job.cursor < job.recipientIds.length) {
      await sleep(jitter(settings.dmDelayMs));
    }
  }

  if (job.status === "running" && job.cursor >= job.recipientIds.length) {
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    return true;
  }
  return false;
}

function progressSummary(job) {
  const p = job.progress || { sent: 0, failed: 0, skipped: 0 };
  return `${p.sent} sent, ${p.failed} failed, ${p.skipped} skipped`;
}

async function processCampaigns(userId, userStore, store, settings) {
  const key = `campaigns:${userId}`;
  if (!acquire(key)) return;
  try {
    const now = new Date();
    for (const campaign of store.campaigns) {
      if (campaign.status !== "queued" && campaign.status !== "running") continue;
      if (campaign.scheduledStartAt && new Date(campaign.scheduledStartAt) > now) continue;

      if (campaign.status === "queued") {
        campaign.recipientIds = buildRecipients(store, campaign).map((c) => c.id);
        campaign.progress = {
          total: campaign.recipientIds.length,
          sent: 0,
          failed: 0,
          skipped: 0
        };
        campaign.cursor = 0;
        campaign.sentIds = [];
        campaign.status = "running";
        campaign.startedAt = now.toISOString();
        userStore.addLog({
          kind: "dm",
          ref: campaign.id,
          ok: true,
          message: `Campaign "${campaign.name}" started (${campaign.progress.total} recipients)`
        });
        if (campaign.progress.total === 0) {
          campaign.status = "completed";
          campaign.completedAt = now.toISOString();
          userStore.addLog({ kind: "dm", ref: campaign.id, ok: true, message: "Campaign completed (no recipients)" });
          continue;
        }
      }

      const justCompleted = await runOutboundJob(userId, userStore, store, settings, campaign);
      if (justCompleted) {
        userStore.addLog({
          kind: "dm",
          ref: campaign.id,
          ok: true,
          message: `Campaign "${campaign.name}" completed: ${progressSummary(campaign)}`
        });
        queueFollowUp(userStore, store, campaign);
      }
    }
  } finally {
    release(key);
  }
}

/* =========================
   FOLLOW-UP SEQUENCES
   Sent later to campaign recipients who never replied.
========================= */

function queueFollowUp(userStore, store, campaign) {
  const fu = campaign.followUp;
  if (!fu || !fu.message || !fu.delayHours) return;
  if (store.followUps.some((x) => x.campaignId === campaign.id)) return;
  store.followUps.unshift({
    id: newId(),
    campaignId: campaign.id,
    name: `Follow-up: ${campaign.name}`,
    message: fu.message,
    imagePath: fu.imagePath || null,
    delayHours: fu.delayHours,
    sendAt: new Date(Date.now() + fu.delayHours * 3600 * 1000).toISOString(),
    candidateIds: (campaign.sentIds || []).slice(),
    recipientIds: [],
    status: "queued",
    progress: null,
    cursor: 0,
    sentIds: [],
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null
  });
  userStore.addLog({ kind: "dm", ref: campaign.id, ok: true, message: `Follow-up scheduled in ${fu.delayHours}h (non-repliers only)` });
}

async function processFollowUps(userId, userStore, store, settings) {
  const key = `followups:${userId}`;
  if (!acquire(key)) return;
  try {
    const now = new Date();
    for (const fu of store.followUps) {
      if (fu.status !== "queued" && fu.status !== "running") continue;
      if (fu.status === "queued" && new Date(fu.sendAt) > now) continue;

      if (fu.status === "queued") {
        // Lock the recipient list at fire time: everyone who got the main
        // message, minus anyone who replied since the campaign started.
        const campaign = store.campaigns.find((c) => c.id === fu.campaignId);
        const startedAt = campaign?.startedAt ? new Date(campaign.startedAt) : null;
        fu.recipientIds = (fu.candidateIds || []).filter((id) => {
          const c = store.contacts.find((x) => x.id === id);
          if (!c) return false;
          const ident = identifierFor(c);
          if (!ident || userStore.isOptedOut(ident)) return false;
          if (startedAt && c.lastInboundAt && new Date(c.lastInboundAt) >= startedAt) return false;
          return true;
        });
        fu.progress = {
          total: fu.recipientIds.length,
          sent: 0,
          failed: 0,
          skipped: 0
        };
        fu.cursor = 0;
        fu.sentIds = [];
        fu.status = "running";
        fu.startedAt = now.toISOString();
        userStore.addLog({
          kind: "dm",
          ref: fu.id,
          ok: true,
          message: `Follow-up "${fu.name}" started (${fu.progress.total} recipients who didn't reply)`
        });
        if (fu.progress.total === 0) {
          fu.status = "completed";
          fu.completedAt = now.toISOString();
          userStore.addLog({ kind: "dm", ref: fu.id, ok: true, message: "Follow-up completed (everyone replied or opted out)" });
          continue;
        }
      }

      const justCompleted = await runOutboundJob(userId, userStore, store, settings, fu);
      if (justCompleted) {
        userStore.addLog({
          kind: "dm",
          ref: fu.id,
          ok: true,
          message: `Follow-up "${fu.name}" completed: ${progressSummary(fu)}`
        });
      }
    }
  } finally {
    release(key);
  }
}

/* =========================
   SCHEDULED STATUS POSTS
========================= */

async function processStatusPosts(userId, userStore, store, settings) {
  const key = `status:${userId}`;
  if (!acquire(key)) return;
  try {
    const now = new Date();
    for (const post of store.statusPosts) {
      if (!post.active) continue;
      const tz = post.timezone || settings.defaultTimezone;
      const { date, time } = tzParts(now, tz);
      if (date < post.startDate || date > post.endDate) continue;

      const nowMinutes = minutesOf(time);
      for (const slot of post.times || []) {
        const slotMinutes = minutesOf(slot);
        const lateBy = nowMinutes - slotMinutes;
        if (lateBy < 0 || lateBy > 10) continue;

        const key2 = `status|${userId}|${post.id}|${date}|${slot}`;
        if (store.sentKeys.includes(key2)) continue;

        if (!isConnected(userId)) {
          if (!notifiedMissed.has(key2)) {
            notifiedMissed.add(key2);
            userStore.addLog({ kind: "system", ref: post.id, ok: false, error: `Status post for ${date} ${slot} skipped: WhatsApp is not connected` });
          }
          continue;
        }

        try {
          const text = spin(post.message, null);
          const image = await userStore.readUpload(post.imagePath);
          await sendStatusPost(userId, text, image);
          store.sentKeys.push(key2);
          userStore.addLog({ kind: "system", ref: post.id, ok: true, message: `Status posted (${date} ${slot})` });
        } catch (error) {
          userStore.addLog({ kind: "system", ref: post.id, ok: false, error: "Status post failed: " + error.message });
        }

        if (store.sentKeys.length > 5000) {
          store.sentKeys = store.sentKeys.slice(-5000);
        }
        await sleep(jitter(settings.groupDelayMs));
      }
    }
  } finally {
    release(key);
  }
}

/* =========================
   SCHEDULED GROUP PROMOS
========================= */

async function processSchedules(userId, userStore, store, settings) {
  const key = `schedules:${userId}`;
  if (!acquire(key)) return;
  try {
    const now = new Date();
    for (const schedule of store.schedules) {
      if (!schedule.active) continue;
      const tz = schedule.timezone || settings.defaultTimezone;
      const { date, time } = tzParts(now, tz);
      if (date < schedule.startDate || date > schedule.endDate) continue;
      // Weekly recurrence: only fire on the chosen weekdays.
      if (schedule.recurrence === "weekly") {
        const days = Array.isArray(schedule.days) ? schedule.days : [];
        if (!days.includes(weekdayInTz(now, tz))) continue;
      }

      const nowMinutes = minutesOf(time);
      for (const slot of schedule.times || []) {
        const slotMinutes = minutesOf(slot);
        const lateBy = nowMinutes - slotMinutes;
        // Fire at the scheduled minute, with a 10-minute grace window
        // for slow ticks or brief disconnects.
        if (lateBy < 0 || lateBy > 10) continue;

        for (const groupJid of schedule.groupJids || []) {
          const key2 = `${userId}|${schedule.id}|${date}|${slot}|${groupJid}`;
          if (store.sentKeys.includes(key2)) continue;

          if (!isConnected(userId)) {
            if (!notifiedMissed.has(key2)) {
              notifiedMissed.add(key2);
              userStore.addLog({
                kind: "system",
                ref: schedule.id,
                ok: false,
                error: `Scheduled promo for ${date} ${slot} skipped: WhatsApp is not connected`
              });
            }
            continue;
          }

          try {
            const text = spin(schedule.message, null);
            const image = await userStore.readUpload(schedule.imagePath);
            if (image) await sendImageToJid(userId, groupJid, image, text);
            else await sendTextToJid(userId, groupJid, text);
            store.sentKeys.push(key2);
            userStore.addLog({
              kind: "group",
              ref: schedule.id,
              target: groupJid,
              ok: true,
              message: `Scheduled promo sent (${date} ${slot})`
            });
          } catch (error) {
            userStore.addLog({
              kind: "group",
              ref: schedule.id,
              target: groupJid,
              ok: false,
              error: error.message
            });
          }

          if (store.sentKeys.length > 5000) {
            store.sentKeys = store.sentKeys.slice(-5000);
          }
          await sleep(jitter(settings.groupDelayMs));
        }
      }
    }
  } finally {
    release(key);
  }
}
