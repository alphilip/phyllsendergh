// Owner admin panel: user management, platform stats, announcements,
// plan settings. MERGED into the main platform: the admin is a normal
// user account with role "admin" (auth.js), set only by the one-time
// claim route below. There is no separate admin login, no secret URL,
// and no separate admin session anymore — the admin logs in through
// the normal login page and sees an Admin tab in the main dashboard.
// The old __owner__ WhatsApp session is gone too: the admin links
// WhatsApp through the normal user flow, like everyone else.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";

import { findUserById, hasAnyAdmin, listUsers, persistAuthNow, removeUserAccount, requireAdminUser, requireUser, setUserPassword } from "./auth.js";
import {
  addSubHistory,
  billingConfigured,
  effectiveStatus,
  getSubscription,
  invalidatePaystackPlan,
  limitsForUser,
  refreshSubscription,
  suspendUserAccount,
  tierForUser
} from "./billing.js";
import { getTier, isKnownTier, publicTiers, savePlanSettings } from "./plans.js";
import { getUserStore } from "./store.js";
import { disconnect, peekStatus } from "./whatsapp.js";

const BASE_DATA_DIR = process.env.DATA_DIR || "/data";
const ANNOUNCE_FILE = path.join(BASE_DATA_DIR, "announcement.json");

// ---- merged admin: no separate admin login ----
// The admin is a normal user account with role "admin" (auth.js). All
// routes below use requireAdminUser (same session cookie, role check).
// The old secret-URL panel, admin_session cookie, and __owner__ WhatsApp
// session are gone: the admin links WhatsApp through the normal user
// flow, like everyone else.

// ---- per-user row for the admin table ----

async function adminUserRow(user) {
  // Advance time-based transitions (past_due -> suspended) before reporting.
  await refreshSubscription(user);
  const sub = getSubscription(user);
  const status = effectiveStatus(user);
  const tier = tierForUser(user);
  // peekStatus never starts the user's WhatsApp socket.
  const wa = peekStatus(user.id);
  let contacts = 0;
  let campaigns = 0;
  let lists = 0;
  let dms24h = 0;
  let failStreak = 0;
  let flagged = false;
  try {
    const us = getUserStore(user.id);
    await us.load();
    const s = us.get();
    contacts = Array.isArray(s.contacts) ? s.contacts.length : 0;
    campaigns = Array.isArray(s.campaigns) ? s.campaigns.length : 0;
    lists = Array.isArray(s.lists) ? s.lists.length : 0;
    const dayAgo = Date.now() - 86400000;
    const hourAgo = Date.now() - 3600000;
    const logs = Array.isArray(s.logs) ? s.logs : [];
    for (const l of logs) {
      if (l.kind === "dm" && l.ok && new Date(l.ts).getTime() >= dayAgo) dms24h += 1;
    }
    // Logs are newest-first: walk back until the first success or the
    // one-hour window ends.
    for (const l of logs) {
      if (l.kind !== "dm") continue;
      if (new Date(l.ts).getTime() < hourAgo) break;
      if (l.ok) break;
      failStreak += 1;
    }
    // Abuse/velocity signal: >3x the user's tier daily cap in 24h, or a
    // long run of consecutive send failures (likely ban/restriction).
    flagged = dms24h > 3 * limitsForUser(user).dailyDmCap || failStreak > 10;
  } catch (error) {
    // Unreadable store — report zeros rather than failing the whole table.
  }
  const endMs = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : NaN;
  return {
    id: user.id,
    email: user.email,
    createdAt: user.createdAt,
    // Deliberately a projection: never passwordHash, session tokens, or keys.
    subscription: {
      status,
      planId: sub.planId,
      tierId: tier.id,
      tierName: tier.name,
      period: sub.period,
      currentPeriodEnd: sub.currentPeriodEnd,
      daysLeft: Number.isNaN(endMs) ? null : Math.ceil((endMs - Date.now()) / 86400000)
    },
    whatsapp: {
      connected: wa.status === "connected",
      number: wa.number || null,
      state: wa.status || "disconnected"
    },
    counts: { contacts, campaigns, lists, dms24h },
    flagged
  };
}

/* =========================
   Admin API router (/api/admin/*)
========================= */

export const adminRouter = Router();

// ---- one-time admin claim ----
// The FIRST admin is claimed, not auto-assigned: a logged-in user posts
// the ADMIN_PASSWORD env value once, and their account gains role
// "admin". Once any admin exists, claiming closes (409) — and if
// ADMIN_PASSWORD is unset, claiming is unavailable (503). After a
// successful claim the env vars can be removed; a future re-claim
// (e.g. admin account deleted) needs ADMIN_PASSWORD set again.
adminRouter.get("/api/admin/claim-available", requireUser, async (req, res, next) => {
  try {
    res.json({ ok: true, available: !hasAnyAdmin() });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/claim", requireUser, async (req, res, next) => {
  try {
    const wantPass = String(process.env.ADMIN_PASSWORD || "");
    if (!wantPass) {
      return res.status(503).json({ error: "Admin claim is not configured (ADMIN_PASSWORD not set on the server)." });
    }
    if (hasAnyAdmin()) {
      return res.status(409).json({ error: "An admin already exists." });
    }
    const tryPass = String(req.body?.password || "");
    const a = Buffer.from(tryPass, "utf8");
    const b = Buffer.from(wantPass, "utf8");
    const passOk = a.length === b.length && timingSafeEqual(a, b);
    if (!passOk) {
      return res.status(401).json({ error: "Wrong admin password." });
    }
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    user.role = "admin";
    await persistAuthNow();
    console.log(`[admin] ${user.email} claimed admin`);
    res.json({ ok: true, isAdmin: true });
  } catch (error) {
    next(error);
  }
});

// ---- plan settings: editable tiers (prices + limits) ----
adminRouter.get("/api/admin/plans", requireAdminUser, async (req, res, next) => {
  try {
    res.json({ ok: true, tiers: publicTiers() });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/plans", requireAdminUser, async (req, res, next) => {
  try {
    const saved = await savePlanSettings(req.body || {});
    for (const { tierId, period } of saved.changed) {
      await invalidatePaystackPlan(tierId, period);
    }
    console.log(`[admin] ${req.adminUser.email} saved plan settings (changed: ${saved.changed.map((c) => `${c.tierId}/${c.period}`).join(", ") || "none"})`);
    res.json({ ok: true, tiers: saved.tiers, changed: saved.changed });
  } catch (error) {
    res.status(400).json({ error: error.message || "Invalid plan settings." });
  }
});

adminRouter.get("/api/admin/users", requireAdminUser, async (req, res, next) => {
  try {
    const rows = [];
    for (const slim of listUsers()) {
      const user = findUserById(slim.id);
      if (user) rows.push(await adminUserRow(user));
    }
    res.json({ ok: true, users: rows });
  } catch (error) {
    next(error);
  }
});

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

adminRouter.get("/api/admin/users/export", requireAdminUser, async (req, res, next) => {
  try {
    const rows = [];
    for (const slim of listUsers()) {
      const user = findUserById(slim.id);
      if (user) rows.push(await adminUserRow(user));
    }
    const header = ["email", "userId", "status", "period", "periodEnd", "whatsappConnected", "whatsappNumber", "contacts", "campaigns", "lists", "dms24h", "flagged", "createdAt", "tier"];
    const lines = [header.join(",")];
    for (const r of rows) {
      lines.push([
        r.email, r.id, r.subscription.status, r.subscription.period || "",
        r.subscription.currentPeriodEnd || "", r.whatsapp.connected ? "yes" : "no",
        r.whatsapp.number || "", r.counts.contacts, r.counts.campaigns,
        r.counts.lists, r.counts.dms24h, r.flagged ? "yes" : "no", r.createdAt,
        r.subscription.tierId || ""
      ].map(csvCell).join(","));
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="phyllhost-users.csv"');
    res.send(lines.join("\n"));
  } catch (error) {
    next(error);
  }
});

// Per-user drill-down: full safe projection + recent campaigns + recent logs
// + subscription timeline. Never passwordHash, sessions, or keys.
adminRouter.get("/api/admin/users/:id", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    const row = await adminUserRow(user);
    const sub = getSubscription(user);
    let campaigns = [];
    let logs = [];
    try {
      const us = getUserStore(user.id);
      await us.load();
      const s = us.get();
      campaigns = (Array.isArray(s.campaigns) ? s.campaigns : []).slice(0, 10).map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        audienceType: c.audienceType,
        progress: c.progress || null,
        variants: Array.isArray(c.variants) ? c.variants.length : 0,
        createdAt: c.createdAt,
        startedAt: c.startedAt || null,
        completedAt: c.completedAt || null
      }));
      logs = (Array.isArray(s.logs) ? s.logs : []).slice(0, 20).map((l) => ({
        ts: l.ts,
        kind: l.kind,
        ok: l.ok,
        target: l.target || null,
        message: l.message || l.error || null
      }));
    } catch {
      // Unreadable store — detail still returns the admin row.
    }
    res.json({
      ok: true,
      user: {
        ...row,
        referralCode: user.referralCode || null,
        referredBy: user.referredBy || null,
        subscription: {
          ...row.subscription,
          history: Array.isArray(sub.history) ? sub.history.slice(-50) : []
        }
      },
      campaigns,
      logs
    });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/users/:id/suspend", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    // Reuses the billing suspension path: flips status, persists, and
    // disconnects WhatsApp without restarting it.
    await suspendUserAccount(user, `manual suspend by ${req.adminUser.email}`);
    console.log(`[admin] ${req.adminUser.email} suspended ${user.email} (${user.id})`);
    res.json({ ok: true, status: "suspended" });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/users/:id/unsuspend", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    const sub = getSubscription(user);
    const endMs = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : NaN;
    // Restore, don't reward: "active" only if paid time remains; otherwise
    // "past_due" so the normal expiry flow (grace -> suspended) applies and
    // the user must renew. Documented choice: unsuspend never grants days.
    sub.status = !Number.isNaN(endMs) && endMs > Date.now() ? "active" : "past_due";
    addSubHistory(user, "unsuspended");
    await persistAuthNow();
    console.log(`[admin] ${req.adminUser.email} unsuspended ${user.email} (${user.id}) -> ${sub.status}`);
    res.json({ ok: true, status: sub.status });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/users/:id/extend", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    const days = Math.round(Number(req.body?.days));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: "days must be between 1 and 365." });
    }
    const sub = getSubscription(user);
    const now = Date.now();
    const cur = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : NaN;
    // Extend from the current end when time remains (early goodwill never
    // loses days); a suspended/expired account reactivates from now.
    const base = !Number.isNaN(cur) && cur > now ? cur : now;
    sub.currentPeriodEnd = new Date(base + days * 86400000).toISOString();
    sub.status = "active";
    addSubHistory(user, `extended:${days}d`);
    await persistAuthNow();
    console.log(`[admin] ${req.adminUser.email} extended ${user.email} (${user.id}) by ${days}d -> ${sub.currentPeriodEnd}`);
    res.json({ ok: true, status: "active", currentPeriodEnd: sub.currentPeriodEnd });
  } catch (error) {
    next(error);
  }
});

// ---- plan controls: change tier and/or period, grant complimentary access ----

adminRouter.post("/api/admin/users/:id/plan", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    const tierId = req.body?.tierId !== undefined && req.body?.tierId !== null
      ? String(req.body.tierId).trim().toLowerCase() : null;
    const period = req.body?.period !== undefined && req.body?.period !== null
      ? String(req.body.period).trim().toLowerCase() : null;
    if (tierId && !isKnownTier(tierId)) {
      return res.status(400).json({ error: "Unknown tier." });
    }
    if (period && period !== "monthly" && period !== "yearly") {
      return res.status(400).json({ error: "period must be monthly or yearly." });
    }
    if (!tierId && !period) {
      return res.status(400).json({ error: "Nothing to change — send tierId and/or period." });
    }
    const sub = getSubscription(user);
    // Tier/period labels only: no days granted or lost. The next renewal
    // charges at the new tier+period price automatically.
    if (tierId) sub.planId = tierId;
    if (period) sub.period = period;
    addSubHistory(user, `plan:${sub.planId || "pro"}:${sub.period || "?"}`);
    await persistAuthNow();
    console.log(`[admin] ${req.adminUser.email} changed plan for ${user.email} (${user.id}): tier=${sub.planId} period=${sub.period}`);
    res.json({ ok: true, tierId: sub.planId, period: sub.period, status: effectiveStatus(user), currentPeriodEnd: sub.currentPeriodEnd });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/users/:id/grant", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    const days = Math.round(Number(req.body?.days));
    if (!Number.isFinite(days) || days < 1 || days > 365) {
      return res.status(400).json({ error: "days must be between 1 and 365." });
    }
    const period = String(req.body?.period || "").trim().toLowerCase();
    if (period && period !== "monthly" && period !== "yearly") {
      return res.status(400).json({ error: "period must be monthly or yearly." });
    }
    const tierId = req.body?.tierId !== undefined && req.body?.tierId !== null
      ? String(req.body.tierId).trim().toLowerCase() : null;
    if (tierId && !isKnownTier(tierId)) {
      return res.status(400).json({ error: "Unknown tier." });
    }
    const sub = getSubscription(user);
    const now = Date.now();
    const cur = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : NaN;
    // Same no-lost-days rule as extend. Unlike extend, this also
    // activates pending_payment accounts — it is the complimentary
    // access grant (free access, no payment involved).
    const base = !Number.isNaN(cur) && cur > now ? cur : now;
    sub.currentPeriodEnd = new Date(base + days * 86400000).toISOString();
    sub.status = "active";
    if (period) sub.period = period;
    if (tierId) sub.planId = tierId;
    addSubHistory(user, `granted:${days}d:${sub.planId || "pro"}:${sub.period || "monthly"}`);
    await persistAuthNow();
    console.log(`[admin] ${req.adminUser.email} granted ${user.email} (${user.id}) ${days}d (${sub.planId}/${sub.period}) -> ${sub.currentPeriodEnd}`);
    res.json({ ok: true, status: "active", tierId: sub.planId, period: sub.period || null, currentPeriodEnd: sub.currentPeriodEnd });
  } catch (error) {
    next(error);
  }
});

// ---- per-user WhatsApp control (support: stuck sessions) ----

adminRouter.post("/api/admin/users/:id/whatsapp/disconnect", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    // restart:false: the number stays offline until the user relinks
    // from their own dashboard. disconnect() also wipes the session
    // dir, so the next link scans a fresh QR.
    await disconnect(user.id, { restart: false });
    console.log(`[admin] ${req.adminUser.email} disconnected WhatsApp for ${user.email} (${user.id})`);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---- per-user account maintenance ----

adminRouter.post("/api/admin/users/:id/reset-password", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    // Server-generated temp password, shown ONCE in the response: the
    // admin copies it to the user out-of-band. All live sessions die.
    const tempPassword = randomBytes(6).toString("hex");
    await setUserPassword(user.id, tempPassword);
    console.log(`[admin] ${req.adminUser.email} reset password for ${user.email} (${user.id})`);
    res.json({ ok: true, tempPassword });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/users/:id/delete", requireAdminUser, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    if (user.role === "admin") {
      return res.status(400).json({ error: "Cannot delete an admin account." });
    }
    try {
      await disconnect(user.id, { restart: false });
    } catch {
      // Disconnect failure must not block the delete itself.
    }
    await removeUserAccount(user.id);
    // Whole user dir: store file + WhatsApp session (belt and braces
    // after the disconnect above).
    try {
      await rm(path.join(BASE_DATA_DIR, user.id), { recursive: true, force: true });
    } catch (error) {
      console.error(`[admin] failed to delete data dir for ${user.id}:`, error.message);
    }
    console.log(`[admin] ${req.adminUser.email} deleted user ${user.email} (${user.id})`);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/api/admin/stats", requireAdminUser, async (req, res, next) => {
  try {
    const rows = [];
    for (const slim of listUsers()) {
      const user = findUserById(slim.id);
      if (user) rows.push(await adminUserRow(user));
    }
    const byStatus = { active: 0, past_due: 0, suspended: 0, pending_payment: 0 };
    let mrr = 0;
    let dms24h = 0;
    let flagged = 0;
    const refCounts = new Map();
    for (const r of rows) {
      const st = r.subscription.status;
      if (byStatus[st] !== undefined) byStatus[st] += 1;
      if (st === "active") {
        // MRR estimate: monthly actives at full price, yearly actives / 12,
        // each at their own tier's price.
        const tier = getTier(r.subscription.tierId);
        mrr += r.subscription.period === "yearly"
          ? tier.prices.yearly.ghs / 12
          : tier.prices.monthly.ghs;
      }
      dms24h += r.counts.dms24h;
      if (r.flagged) flagged += 1;
    }
    // Referral leaderboard: top 5 referrers by referred-user count.
    // Tracking only — no monetary rewards attached (documented).
    for (const slim of listUsers()) {
      const u = findUserById(slim.id);
      if (u && u.referredBy) {
        refCounts.set(u.referredBy, (refCounts.get(u.referredBy) || 0) + 1);
      }
    }
    const topReferrers = [...refCounts.entries()]
      .map(([id, count]) => {
        const u = findUserById(id);
        return { id, email: u ? u.email : "(deleted)", count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    res.json({
      ok: true,
      users: rows.length,
      ...byStatus,
      mrr: Math.round(mrr * 100) / 100,
      dms24h,
      flagged,
      topReferrers
    });
  } catch (error) {
    next(error);
  }
});

// Platform health: linked-number counts without starting any socket
// (peekStatus only), billing wiring, uptime.
adminRouter.get("/api/admin/health", requireAdminUser, async (req, res, next) => {
  try {
    let whatsappConnected = 0;
    let whatsappAwaitingQr = 0;
    for (const slim of listUsers()) {
      const st = peekStatus(slim.id).status;
      if (st === "connected") whatsappConnected += 1;
      else if (st === "qr") whatsappAwaitingQr += 1;
    }
    res.json({
      ok: true,
      users: listUsers().length,
      whatsappConnected,
      whatsappAwaitingQr,
      billingConfigured: billingConfigured(),
      uptimeSeconds: Math.floor(process.uptime())
    });
  } catch (error) {
    next(error);
  }
});

// ---- announcements (owner -> users) ----

async function readAnnouncement() {
  try {
    const raw = await readFile(ANNOUNCE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      text: String(parsed.text || ""),
      updatedAt: parsed.updatedAt || null
    };
  } catch {
    return { text: "", updatedAt: null };
  }
}

adminRouter.get("/api/admin/announcement", requireAdminUser, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await readAnnouncement()) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/announcement", requireAdminUser, async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").slice(0, 500);
    const data = {
      text,
      updatedAt: new Date().toISOString(),
      updatedBy: req.adminUser.email
    };
    await mkdir(BASE_DATA_DIR, { recursive: true });
    const tmp = ANNOUNCE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, ANNOUNCE_FILE);
    console.log(`[admin] ${req.adminUser.email} set announcement: ${text ? text.slice(0, 80) : "(cleared)"}`);
    res.json({ ok: true, text: data.text, updatedAt: data.updatedAt });
  } catch (error) {
    next(error);
  }
});

/* =========================
   User-facing announcement feed
========================= */

export const announcementRouter = Router();

// Logged-in users only (their own session). Mounted before the
// subscription gate so pending_payment users can see it too —
// announcements are owner broadcasts, not a paid feature.
announcementRouter.get("/api/announcement", requireUser, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await readAnnouncement()) });
  } catch (error) {
    next(error);
  }
});
