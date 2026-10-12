import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";

import {
  identifierFor,
  newId,
  utcDateString
} from "./store.js";
import {
  authRouter,
  findUserById,
  listUsers,
  loadAuthStore,
  persistAuthNow,
  requireUser,
  requireUserPage
} from "./auth.js";
import {
  assertCanLinkNumber,
  billingConfigured,
  billingRouter,
  effectiveStatus,
  paystackWebhookHandler,
  requireSendAllowed,
  sendBlockedReason,
  setAuthPersister,
  subscriptionGate
} from "./billing.js";
import { PLAN } from "./plans.js";
import { adminEnabled, adminRouter, announcementRouter } from "./admin.js";
import {
  disconnect,
  getGroupParticipants,
  getStatus,
  isConnected,
  listChats,
  listGroups,
  resolveChatContact,
  senderDigits,
  sendImageToDigits,
  sendPollToJid,
  sendTextToDigits,
  startWhatsApp
} from "./whatsapp.js";
import { startScheduler } from "./scheduler.js";
import { spin } from "./spintax.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// Paystack webhook needs the RAW body for HMAC verification, so it is
// mounted here with express.raw() BEFORE the JSON body parser — otherwise
// express.json() would consume the stream first and the signature could
// never verify.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), paystackWebhookHandler);

app.use(express.json({ limit: "8mb" }));
app.use(authRouter);

app.use(billingRouter); // full /api/billing/* paths defined inside

// Owner admin panel. Only mounted when ADMIN_EMAIL + ADMIN_PASSWORD are set;
// otherwise /api/admin/* falls through to Express's 404 (never hint it exists).
// Mounted before the subscription gate so admin requests never touch it.
if (adminEnabled()) {
  console.log("[admin] admin panel enabled");
  app.use(adminRouter); // full /api/admin/* paths defined inside
} else {
  console.log("[admin] ADMIN_EMAIL/ADMIN_PASSWORD not set — admin API disabled");
}

// User-facing announcement feed (logged-in users). Mounted before the gate
// so pending_payment accounts can see owner broadcasts too.
app.use(announcementRouter);

// Subscription gate for every other /api/* route. Lets /api/billing/* and
// /api/auth/me through (they handle their own auth/status).
app.use("/api", (req, res, next) => {
  if (req.path.startsWith("/billing/") || req.path === "/auth/me") return next();
  subscriptionGate(req, res, next);
});

setAuthPersister(persistAuthNow);

// The dashboard itself requires a login; the login/signup pages stay public.
app.get(["/", "/index.html"], requireUserPage, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.static(path.join(__dirname, "public")));

const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function isHhMm(s) {
  if (!/^\d{2}:\d{2}$/.test(String(s || ""))) return false;
  const [h, m] = String(s).split(":").map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

function isYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const d = new Date(String(s) + "T00:00:00Z");
  return !Number.isNaN(d.getTime());
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

// "233201234567, 233244567890\n233270000000" -> ["233201234567", ...]
function parseNumberList(text) {
  const out = [];
  const seen = new Set();
  for (const part of String(text || "").split(/[\s,;]+/)) {
    const digits = senderDigits(part);
    if (digits.length >= 7 && !seen.has(digits)) {
      seen.add(digits);
      out.push(digits);
    }
  }
  return out;
}

// CSV: first column = number, second column = name (header row ok)
function parseCsvContacts(text) {
  const entries = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    if (!/[0-9]/.test(cols[0] || "")) continue; // header row
    const digits = senderDigits(cols[0]);
    if (digits.length < 7 || seen.has(digits)) continue;
    seen.add(digits);
    entries.push({ digits, name: cols[1] || null });
  }
  return entries;
}

// data URL -> { buffer, ext }; throws BAD_IMAGE on invalid input.
function decodeImageData(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || "").trim());
  if (!m) {
    const err = new Error("Invalid image. Attach a PNG, JPEG, or WebP under 5MB.");
    err.code = "BAD_IMAGE";
    throw err;
  }
  const buffer = Buffer.from(m[3].replace(/\s/g, ""), "base64");
  if (buffer.length === 0 || buffer.length > MAX_IMAGE_BYTES) {
    const err = new Error("Image must be under 5MB.");
    err.code = "BAD_IMAGE";
    throw err;
  }
  return { buffer, ext: m[2] === "png" ? "png" : m[2] === "webp" ? "webp" : "jpg" };
}

// data URL -> "uploads/<id>.jpg" saved under the user's own uploads dir
async function saveImageData(userStore, dataUrl) {
  const { buffer, ext } = decodeImageData(dataUrl);
  const dir = userStore.uploadsDir;
  await mkdir(dir, { recursive: true });
  const filename = `${newId()}.${ext}`;
  await writeFile(path.join(dir, filename), buffer);
  return `uploads/${filename}`;
}

function countRecipients(userStore, { audienceType, groupJids = [], contactIds = [], listId = null }) {
  const store = userStore.get();
  const contacts = store.contacts.filter((c) => {
    const id = identifierFor(c);
    return id && !userStore.isOptedOut(id);
  });
  if (audienceType === "ids") {
    const wanted = new Set(contactIds);
    return contacts.filter((c) => wanted.has(c.id));
  }
  if (audienceType === "groups") {
    const wanted = new Set(groupJids);
    return contacts.filter((c) => c.sourceGroups.some((g) => wanted.has(g)));
  }
  if (audienceType === "list") {
    return contacts.filter((c) => (c.listIds || []).includes(listId));
  }
  return contacts;
}

/* =========================
   PUBLIC
========================= */

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

/* =========================
   ADMIN API
========================= */

app.get("/api/status", requireUser, ah(async (req, res) => {
  res.json(getStatus(req.user.id));
}));

app.post("/api/disconnect", requireUser, ah(async (req, res) => {
  await disconnect(req.user.id);
  res.json({ ok: true });
}));

// Explicit link gate: the Pro plan allows 1 linked WhatsApp number.
// A new link while one is connected is rejected — disconnect first.
app.post("/api/link", requireUser, ah(async (req, res) => {
  try {
    assertCanLinkNumber(isConnected(req.user.id) ? 1 : 0);
  } catch (error) {
    if (error.code === "NUMBER_LIMIT") {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
  await startWhatsApp(req.user.id);
  res.json({ ok: true, status: getStatus(req.user.id) });
}));

app.post("/api/test-send", requireUser, requireSendAllowed, ah(async (req, res) => {
  const digits = senderDigits(req.body?.digits);
  const message = String(req.body?.message || "");
  if (!digits || digits.length < 7) {
    return res.status(400).json({ error: "Enter a valid number, e.g. 233201234567." });
  }
  if (!message.trim() || message.length > 2000) {
    return res.status(400).json({ error: "Message is required (max 2000 characters)." });
  }
  let imageBuffer = null;
  if (req.body?.imageData) {
    try {
      imageBuffer = decodeImageData(req.body.imageData).buffer;
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  }
  try {
    const text = spin(message.trim(), null);
    if (imageBuffer) await sendImageToDigits(req.user.id, digits, imageBuffer, text);
    else await sendTextToDigits(req.user.id, digits, text);
  } catch (error) {
    req.userStore.addLog({ kind: "dm", target: digits, ok: false, error: "Test send failed: " + error.message });
    if (error.code === "NOT_CONNECTED") {
      return res.status(409).json({ error: error.message });
    }
    return res.status(500).json({ error: "Send failed: " + error.message });
  }
  req.userStore.addLog({ kind: "dm", target: digits, ok: true, message: "Test message sent from dashboard" });
  res.json({ ok: true });
}));

app.post("/api/spin-preview", requireUser, ah(async (req, res) => {
  const message = String(req.body?.message || "");
  if (!message.trim()) return res.status(400).json({ error: "Type a message first." });
  // Sample contact so {name} shows something realistic.
  const samples = [0, 1, 2].map(() => spin(message, { name: "Ama Serwaa" }));
  res.json({ ok: true, samples });
}));

/* ---------- scheduled status posts ---------- */

function validateTimes(times) {
  if (!Array.isArray(times)) return [];
  const cleaned = [];
  for (const t of times) {
    const s = String(t || "").trim();
    if (!/^\d{2}:\d{2}$/.test(s)) return null;
    const [h, m] = s.split(":").map(Number);
    if (h > 23 || m > 59) return null;
    if (!cleaned.includes(s)) cleaned.push(s);
  }
  return cleaned;
}

app.get("/api/status", requireUser, ah(async (req, res) => {
  res.json({ posts: req.userStore.get().statusPosts });
}));

app.post("/api/status", requireUser, requireSendAllowed, ah(async (req, res) => {
  const store = req.userStore.get();
  const { name = "", message = "", startDate = "", endDate = "", timezone = "" } = req.body || {};
  if (!String(name).trim()) return res.status(400).json({ error: "Name is required." });
  if (!String(message).trim() || String(message).length > 700) {
    return res.status(400).json({ error: "Message is required (max 700 characters for Status)." });
  }
  const times = validateTimes(req.body?.times);
  if (!times || times.length === 0 || times.length > 10) {
    return res.status(400).json({ error: "Provide 1–10 times as HH:MM." });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
    return res.status(400).json({ error: "Start/end dates are required (YYYY-MM-DD)." });
  }
  let imagePath = null;
  if (req.body?.imageData) {
    try {
      imagePath = await saveImageData(req.userStore, req.body.imageData);
    } catch (error) {
      if (error.code === "BAD_IMAGE") return res.status(400).json({ error: error.message });
      throw error;
    }
  }
  const post = {
    id: newId(),
    name: String(name).trim(),
    message: String(message),
    imagePath,
    times,
    startDate,
    endDate,
    timezone: String(timezone || store.settings.defaultTimezone || "Africa/Accra").trim() || "Africa/Accra",
    active: true,
    createdAt: new Date().toISOString()
  };
  store.statusPosts.unshift(post);
  req.userStore.save();
  req.userStore.addLog({ kind: "system", ref: post.id, ok: true, message: `Status schedule "${post.name}" created` });
  res.json({ ok: true, post });
}));

for (const action of ["toggle"]) {
  app.post(`/api/status/:id/${action}`, requireUser, ah(async (req, res) => {
    const store = req.userStore.get();
    const post = store.statusPosts.find((p) => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: "Status schedule not found." });
    post.active = !post.active;
    req.userStore.save();
    res.json({ ok: true, post });
  }));
}

app.delete("/api/status/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const idx = store.statusPosts.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Status schedule not found." });
  store.statusPosts.splice(idx, 1);
  req.userStore.save();
  res.json({ ok: true });
}));

/* ---------- welcome messages ---------- */

app.get("/api/welcome", requireUser, ah(async (req, res) => {
  res.json({ rules: req.userStore.get().welcomeRules });
}));

app.post("/api/welcome", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const { groupJid = "", message = "", via = "dm" } = req.body || {};
  if (typeof groupJid !== "string" || !groupJid.endsWith("@g.us")) {
    return res.status(400).json({ error: "Choose a group." });
  }
  if (!String(message).trim() || String(message).length > 2000) {
    return res.status(400).json({ error: "Welcome message is required (max 2000 characters)." });
  }
  if (!["dm", "group"].includes(via)) return res.status(400).json({ error: "Invalid delivery method." });
  if (store.welcomeRules.some((r) => r.groupJid === groupJid && r.via === via && r.active)) {
    return res.status(400).json({ error: "An active welcome rule already exists for this group and method." });
  }
  let imagePath = null;
  if (req.body?.imageData) {
    try {
      imagePath = await saveImageData(req.userStore, req.body.imageData);
    } catch (error) {
      if (error.code === "BAD_IMAGE") return res.status(400).json({ error: error.message });
      throw error;
    }
  }
  const rule = {
    id: newId(),
    groupJid,
    message: String(message),
    imagePath,
    via,
    active: true,
    createdAt: new Date().toISOString()
  };
  store.welcomeRules.push(rule);
  req.userStore.save();
  req.userStore.addLog({ kind: "system", message: `Welcome message rule added (${via})` });
  res.json({ ok: true, rule });
}));

app.post("/api/welcome/:id/toggle", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const rule = store.welcomeRules.find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found." });
  rule.active = !rule.active;
  req.userStore.save();
  res.json({ ok: true, rule });
}));

app.delete("/api/welcome/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const idx = store.welcomeRules.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Rule not found." });
  store.welcomeRules.splice(idx, 1);
  req.userStore.save();
  res.json({ ok: true });
}));

/* ---------- missed-call text-back ---------- */

app.get("/api/callreply", requireUser, ah(async (req, res) => {
  res.json({ callReply: req.userStore.get().callReply });
}));

app.post("/api/callreply", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const { active = false, message = "" } = req.body || {};
  if (active && (!String(message).trim() || String(message).length > 2000)) {
    return res.status(400).json({ error: "Reply message is required to activate (max 2000 characters)." });
  }
  store.callReply = { active: Boolean(active), message: String(message || "") };
  req.userStore.save();
  res.json({ ok: true, callReply: store.callReply });
}));

/* ---------- polls ---------- */

app.post("/api/polls/send", requireUser, requireSendAllowed, ah(async (req, res) => {
  const { groupJids = [], question = "", options = [], selectableCount = 1 } = req.body || {};
  if (!Array.isArray(groupJids) || groupJids.length === 0) {
    return res.status(400).json({ error: "Choose at least one group." });
  }
  if (groupJids.some((j) => typeof j !== "string" || !j.endsWith("@g.us"))) {
    return res.status(400).json({ error: "Invalid group selected." });
  }
  const values = (Array.isArray(options) ? options : []).map((o) => String(o).trim()).filter(Boolean);
  if (!String(question).trim() || values.length < 2 || values.length > 12) {
    return res.status(400).json({ error: "A poll needs a question and 2–12 options." });
  }
  try {
    for (const jid of groupJids) {
      await sendPollToJid(req.user.id, jid, String(question).trim(), values, Number(selectableCount) || 1);
      req.userStore.addLog({ kind: "group", target: jid, ok: true, message: `Poll sent: "${String(question).trim().slice(0, 60)}"` });
      await new Promise((r) => setTimeout(r, 1500));
    }
  } catch (error) {
    if (error.code === "NOT_CONNECTED") {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
  res.json({ ok: true, sent: groupJids.length });
}));

/* ---------- edits (PATCH) ---------- */

// Shared: replace/remove/upload image on edit. Returns the new imagePath.
async function applyImageEdit(userStore, body, currentPath) {
  if (body?.removeImage) return null;
  if (body?.imageData) return await saveImageData(userStore, body.imageData); // throws BAD_IMAGE
  return currentPath;
}

function badImage(res, error) {
  if (error && error.code === "BAD_IMAGE") {
    res.status(400).json({ error: error.message });
    return true;
  }
  return false;
}

// Campaigns: editable while queued or paused.
app.patch("/api/campaigns/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const campaign = store.campaigns.find((c) => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  if (!["queued", "paused"].includes(campaign.status)) {
    return res.status(400).json({ error: `Only queued or paused campaigns can be edited (this one is ${campaign.status}).` });
  }
  const b = req.body || {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) return res.status(400).json({ error: "Campaign name is required." });
    campaign.name = String(b.name).trim();
  }
  if (b.message !== undefined) {
    if (!String(b.message).trim() || String(b.message).length > 2000) {
      return res.status(400).json({ error: "Message is required (max 2000 characters)." });
    }
    campaign.message = String(b.message);
  }
  if (b.scheduledStartAt !== undefined) {
    if (b.scheduledStartAt) {
      const d = new Date(b.scheduledStartAt);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "Invalid scheduled start time." });
      campaign.scheduledStartAt = d.toISOString();
    } else {
      campaign.scheduledStartAt = null;
    }
  }
  try {
    campaign.imagePath = await applyImageEdit(req.userStore, b, campaign.imagePath);
  } catch (error) {
    if (badImage(res, error)) return;
    throw error;
  }
  if (b.followUp !== undefined) {
    const fu = b.followUp;
    if (!fu || !String(fu.message || "").trim()) {
      campaign.followUp = null;
    } else {
      const delayHours = Number(fu.delayHours);
      if (!Number.isFinite(delayHours) || delayHours < 1 || delayHours > 720) {
        return res.status(400).json({ error: "Follow-up delay must be between 1 and 720 hours." });
      }
      if (String(fu.message).length > 2000) {
        return res.status(400).json({ error: "Follow-up message max 2000 characters." });
      }
      try {
        const fuImagePath = await applyImageEdit(req.userStore, fu, campaign.followUp?.imagePath || null);
        campaign.followUp = { delayHours, message: String(fu.message), imagePath: fuImagePath };
      } catch (error) {
        if (badImage(res, error)) return;
        throw error;
      }
    }
  }
  req.userStore.save();
  req.userStore.addLog({ kind: "dm", ref: campaign.id, ok: true, message: `Campaign "${campaign.name}" edited` });
  res.json({ ok: true, campaign });
}));

// Schedules: editable any time (future slots use the new values).
app.patch("/api/schedules/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const schedule = store.schedules.find((s) => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: "Schedule not found." });
  const b = req.body || {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) return res.status(400).json({ error: "Schedule name is required." });
    schedule.name = String(b.name).trim();
  }
  if (b.message !== undefined) {
    if (!String(b.message).trim() || String(b.message).length > 2000) {
      return res.status(400).json({ error: "Message is required (max 2000 characters)." });
    }
    schedule.message = String(b.message);
  }
  if (b.times !== undefined) {
    const times = validateTimes(b.times);
    if (!times || times.length === 0 || times.length > 10) {
      return res.status(400).json({ error: "Provide 1–10 times as HH:MM." });
    }
    schedule.times = [...new Set(times)].sort();
  }
  if (b.startDate !== undefined || b.endDate !== undefined) {
    const startDate = b.startDate !== undefined ? b.startDate : schedule.startDate;
    const endDate = b.endDate !== undefined ? b.endDate : schedule.endDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      return res.status(400).json({ error: "Start/end dates are invalid (YYYY-MM-DD, start before end)." });
    }
    schedule.startDate = startDate;
    schedule.endDate = endDate;
  }
  if (b.timezone !== undefined) {
    const tz = String(b.timezone || store.settings.defaultTimezone).trim() || "Africa/Accra";
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    } catch {
      return res.status(400).json({ error: "Invalid timezone." });
    }
    schedule.timezone = tz;
  }
  if (b.recurrence !== undefined) {
    if (!["once", "weekly"].includes(b.recurrence)) return res.status(400).json({ error: "Invalid recurrence." });
    schedule.recurrence = b.recurrence;
  }
  if (b.days !== undefined) {
    const dayNums = (Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => d >= 0 && d <= 6);
    if (schedule.recurrence === "weekly" && dayNums.length === 0) {
      return res.status(400).json({ error: "Pick at least one weekday for a weekly schedule." });
    }
    schedule.days = [...new Set(dayNums)].sort();
  }
  if (b.groupJids !== undefined) {
    if (!Array.isArray(b.groupJids) || b.groupJids.length === 0) {
      return res.status(400).json({ error: "Select at least one group." });
    }
    if (b.groupJids.some((j) => typeof j !== "string" || !j.endsWith("@g.us"))) {
      return res.status(400).json({ error: "Invalid group selected." });
    }
    schedule.groupJids = b.groupJids;
  }
  try {
    schedule.imagePath = await applyImageEdit(req.userStore, b, schedule.imagePath);
  } catch (error) {
    if (badImage(res, error)) return;
    throw error;
  }
  req.userStore.save();
  req.userStore.addLog({ kind: "system", ref: schedule.id, ok: true, message: `Schedule "${schedule.name}" edited` });
  res.json({ ok: true, schedule });
}));

// Follow-ups: editable while queued or paused.
app.patch("/api/followups/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const fu = store.followUps.find((f) => f.id === req.params.id);
  if (!fu) return res.status(404).json({ error: "Follow-up not found." });
  if (!["queued", "paused"].includes(fu.status)) {
    return res.status(400).json({ error: `Only queued or paused follow-ups can be edited (this one is ${fu.status}).` });
  }
  const b = req.body || {};
  if (b.message !== undefined) {
    if (!String(b.message).trim() || String(b.message).length > 2000) {
      return res.status(400).json({ error: "Message is required (max 2000 characters)." });
    }
    fu.message = String(b.message);
  }
  if (b.sendAt !== undefined) {
    const d = new Date(b.sendAt);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: "Invalid send time." });
    fu.sendAt = d.toISOString();
  }
  try {
    fu.imagePath = await applyImageEdit(req.userStore, b, fu.imagePath);
  } catch (error) {
    if (badImage(res, error)) return;
    throw error;
  }
  req.userStore.save();
  req.userStore.addLog({ kind: "dm", ref: fu.id, ok: true, message: `Follow-up "${fu.name}" edited` });
  res.json({ ok: true, followUp: fu });
}));

// Auto-replies.
app.patch("/api/autoreplies/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const rule = store.autoReplies.find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found." });
  const b = req.body || {};
  if (b.keyword !== undefined) {
    if (!String(b.keyword).trim() || String(b.keyword).length > 100) {
      return res.status(400).json({ error: "Keyword is required (max 100 characters)." });
    }
    rule.keyword = String(b.keyword).trim();
  }
  if (b.matchType !== undefined) {
    if (!["exact", "contains"].includes(b.matchType)) {
      return res.status(400).json({ error: "Match type must be exact or contains." });
    }
    rule.matchType = b.matchType;
  }
  if (b.message !== undefined) {
    if (!String(b.message).trim() || String(b.message).length > 2000) {
      return res.status(400).json({ error: "Reply message is required (max 2000 characters)." });
    }
    rule.message = String(b.message);
  }
  try {
    rule.imagePath = await applyImageEdit(req.userStore, b, rule.imagePath);
  } catch (error) {
    if (badImage(res, error)) return;
    throw error;
  }
  req.userStore.save();
  res.json({ ok: true, rule });
}));

// Welcome rules.
app.patch("/api/welcome/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const rule = store.welcomeRules.find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found." });
  const b = req.body || {};
  const newGroupJid = b.groupJid !== undefined ? b.groupJid : rule.groupJid;
  const newVia = b.via !== undefined ? b.via : rule.via;
  if (typeof newGroupJid !== "string" || !newGroupJid.endsWith("@g.us")) {
    return res.status(400).json({ error: "Choose a group." });
  }
  if (!["dm", "group"].includes(newVia)) return res.status(400).json({ error: "Invalid delivery method." });
  if (store.welcomeRules.some((r) => r.id !== rule.id && r.groupJid === newGroupJid && r.via === newVia && r.active)) {
    return res.status(400).json({ error: "An active welcome rule already exists for this group and method." });
  }
  rule.groupJid = newGroupJid;
  rule.via = newVia;
  if (b.message !== undefined) {
    if (!String(b.message).trim() || String(b.message).length > 2000) {
      return res.status(400).json({ error: "Welcome message is required (max 2000 characters)." });
    }
    rule.message = String(b.message);
  }
  try {
    rule.imagePath = await applyImageEdit(req.userStore, b, rule.imagePath);
  } catch (error) {
    if (badImage(res, error)) return;
    throw error;
  }
  req.userStore.save();
  res.json({ ok: true, rule });
}));

// Status posts.
app.patch("/api/status/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const post = store.statusPosts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: "Status schedule not found." });
  const b = req.body || {};
  if (b.name !== undefined) {
    if (!String(b.name).trim()) return res.status(400).json({ error: "Name is required." });
    post.name = String(b.name).trim();
  }
  if (b.message !== undefined) {
    if (!String(b.message).trim() || String(b.message).length > 700) {
      return res.status(400).json({ error: "Message is required (max 700 characters for Status)." });
    }
    post.message = String(b.message);
  }
  if (b.times !== undefined) {
    const times = validateTimes(b.times);
    if (!times || times.length === 0 || times.length > 10) {
      return res.status(400).json({ error: "Provide 1–10 times as HH:MM." });
    }
    post.times = [...new Set(times)].sort();
  }
  if (b.startDate !== undefined || b.endDate !== undefined) {
    const startDate = b.startDate !== undefined ? b.startDate : post.startDate;
    const endDate = b.endDate !== undefined ? b.endDate : post.endDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || startDate > endDate) {
      return res.status(400).json({ error: "Start/end dates are invalid (YYYY-MM-DD)." });
    }
    post.startDate = startDate;
    post.endDate = endDate;
  }
  if (b.timezone !== undefined) {
    const tz = String(b.timezone || "Africa/Accra").trim() || "Africa/Accra";
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    } catch {
      return res.status(400).json({ error: "Invalid timezone." });
    }
    post.timezone = tz;
  }
  try {
    post.imagePath = await applyImageEdit(req.userStore, b, post.imagePath);
  } catch (error) {
    if (badImage(res, error)) return;
    throw error;
  }
  req.userStore.save();
  res.json({ ok: true, post });
}));

// Lists: rename.
app.patch("/api/lists/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const list = store.lists.find((l) => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: "List not found." });
  const name = String(req.body?.name || "").trim();
  if (!name || name.length > 60) {
    return res.status(400).json({ error: "List name is required (max 60 characters)." });
  }
  if (store.lists.some((l) => l.id !== list.id && l.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: "A list with that name already exists." });
  }
  list.name = name;
  req.userStore.save();
  res.json({ ok: true, list });
}));

/* ---------- keyword auto-replies ---------- */

app.get("/api/autoreplies", requireUser, ah(async (req, res) => {
  res.json({ rules: req.userStore.get().autoReplies });
}));

app.post("/api/autoreplies", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const { keyword = "", matchType = "contains", message = "" } = req.body || {};
  if (!String(keyword).trim()) return res.status(400).json({ error: "Keyword is required." });
  if (String(keyword).length > 100) return res.status(400).json({ error: "Keyword max 100 characters." });
  if (!["exact", "contains"].includes(matchType)) {
    return res.status(400).json({ error: "Match type must be exact or contains." });
  }
  if (!String(message).trim() || String(message).length > 2000) {
    return res.status(400).json({ error: "Reply message is required (max 2000 characters)." });
  }
  let imagePath = null;
  if (req.body?.imageData) {
    try {
      imagePath = await saveImageData(req.userStore, req.body.imageData);
    } catch (error) {
      if (error.code === "BAD_IMAGE") return res.status(400).json({ error: error.message });
      throw error;
    }
  }
  const rule = {
    id: newId(),
    keyword: String(keyword).trim(),
    matchType,
    message: String(message),
    imagePath,
    active: true,
    createdAt: new Date().toISOString()
  };
  store.autoReplies.push(rule);
  req.userStore.save();
  req.userStore.addLog({ kind: "system", message: `Auto-reply added for keyword "${rule.keyword}"` });
  res.json({ ok: true, rule });
}));

app.post("/api/autoreplies/:id/toggle", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const rule = store.autoReplies.find((r) => r.id === req.params.id);
  if (!rule) return res.status(404).json({ error: "Rule not found." });
  rule.active = !rule.active;
  req.userStore.save();
  res.json({ ok: true, rule });
}));

app.delete("/api/autoreplies/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const idx = store.autoReplies.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Rule not found." });
  store.autoReplies.splice(idx, 1);
  req.userStore.save();
  res.json({ ok: true });
}));

/* ---------- contact lists ---------- */

app.get("/api/lists", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const lists = store.lists.map((l) => ({
    ...l,
    count: store.contacts.filter((c) => (c.listIds || []).includes(l.id)).length
  }));
  res.json({ lists });
}));

app.post("/api/lists", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "List name is required." });
  if (name.length > 60) return res.status(400).json({ error: "List name max 60 characters." });
  if (store.lists.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: "A list with that name already exists." });
  }
  if (store.lists.length >= PLAN.limits.maxLists) return res.status(400).json({ error: `Maximum ${PLAN.limits.maxLists} lists on the Pro plan.` });
  const list = { id: newId(), name, createdAt: new Date().toISOString() };
  store.lists.push(list);
  req.userStore.save();
  res.json({ ok: true, list });
}));

app.delete("/api/lists/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const idx = store.lists.findIndex((l) => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "List not found." });
  store.lists.splice(idx, 1);
  for (const c of store.contacts) {
    c.listIds = (c.listIds || []).filter((id) => id !== req.params.id);
  }
  req.userStore.save();
  res.json({ ok: true });
}));

app.post("/api/lists/:id/members", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const list = store.lists.find((l) => l.id === req.params.id);
  if (!list) return res.status(404).json({ error: "List not found." });
  const add = Array.isArray(req.body?.add) ? req.body.add : [];
  const remove = Array.isArray(req.body?.remove) ? req.body.remove : [];
  let changed = 0;
  for (const contact of store.contacts) {
    let ids = contact.listIds || (contact.listIds = []);
    if (add.includes(contact.id) && !ids.includes(list.id)) { ids.push(list.id); changed += 1; }
    if (remove.includes(contact.id) && ids.includes(list.id)) {
      contact.listIds = ids.filter((x) => x !== list.id);
      changed += 1;
    }
  }
  req.userStore.save();
  res.json({ ok: true, changed });
}));

/* ---------- follow-ups ---------- */

app.get("/api/followups", requireUser, ah(async (req, res) => {
  res.json({ followUps: req.userStore.get().followUps });
}));

for (const action of ["pause", "resume"]) {
  app.post(`/api/followups/:id/${action}`, requireUser, ah(async (req, res) => {
    const store = req.userStore.get();
    const fu = store.followUps.find((f) => f.id === req.params.id);
    if (!fu) return res.status(404).json({ error: "Follow-up not found." });
    if (action === "resume") {
      const blocked = sendBlockedReason(req);
      if (blocked) return res.status(402).json({ ...blocked, billingRequired: true });
    }
    if (action === "pause" && (fu.status === "running" || fu.status === "queued")) {
      fu.status = "paused";
      req.userStore.addLog({ kind: "dm", ref: fu.id, ok: true, message: `Follow-up "${fu.name}" paused` });
    } else if (action === "resume" && fu.status === "paused") {
      fu.status = fu.recipientIds && fu.recipientIds.length > 0 ? "running" : "queued";
      fu.error = null;
      req.userStore.addLog({ kind: "dm", ref: fu.id, ok: true, message: `Follow-up "${fu.name}" resumed` });
    } else {
      return res.status(400).json({ error: `Cannot ${action} a ${fu.status} follow-up.` });
    }
    req.userStore.save();
    res.json({ ok: true, followUp: fu });
  }));
}

app.get("/api/chats", requireUser, ah(async (req, res) => {
  try {
    const store = req.userStore.get();
    const groups = await listGroups(req.user.id);
    // Persist group names so contacts keep their extraction source labels
    // even when groups aren't loaded.
    for (const g of groups) {
      if (g.jid && g.name) store.groupNames[g.jid] = g.name;
    }
    req.userStore.save();
    res.json({ groups });
  } catch (error) {
    if (error.code === "NOT_CONNECTED") {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}));

app.get("/api/chats/:jid/participants", requireUser, ah(async (req, res) => {
  const jid = decodeURIComponent(req.params.jid);
  try {
    const participants = await getGroupParticipants(req.user.id, jid);
    res.json({ jid, participants });
  } catch (error) {
    if (error.code === "NOT_CONNECTED") {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}));

app.get("/api/chats/all", requireUser, ah(async (req, res) => {
  try {
    const chats = await listChats(req.user.id);
    res.json({ chats });
  } catch (error) {
    if (error.code === "NOT_CONNECTED") {
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}));

app.post("/api/extract", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const { groupJids = [], dmJids = [], excludeSelf = true, groupNames = {} } = req.body || {};

  // Remember group names at extraction time so contacts keep readable labels.
  for (const [jid, name] of Object.entries(groupNames || {})) {
    if (typeof jid === "string" && typeof name === "string" && name.trim()) {
      store.groupNames[jid] = name.trim();
    }
  }

  if ((!Array.isArray(groupJids) || groupJids.length === 0) && (!Array.isArray(dmJids) || dmJids.length === 0)) {
    return res.status(400).json({ error: "Select at least one chat." });
  }
  if (groupJids.some((j) => typeof j !== "string" || !j.endsWith("@g.us"))) {
    return res.status(400).json({ error: "Invalid group selected." });
  }
  if (dmJids.some((j) => typeof j !== "string" || j.endsWith("@g.us") || j === "status@broadcast")) {
    return res.status(400).json({ error: "Invalid chat selected." });
  }

  const existing = new Set(store.contacts.map((c) => identifierFor(c)).filter(Boolean));
  let total = 0;
  let added = 0;
  let withNumbers = 0;
  let hidden = 0;

  for (const groupJid of groupJids) {
    let participants;
    try {
      participants = await getGroupParticipants(req.user.id, groupJid);
    } catch (error) {
      if (error.code === "NOT_CONNECTED") {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
    for (const p of participants) {
      if (excludeSelf && p.isSelf) continue;
      total += 1;
      const key = p.digits || (p.lid ? "lid:" + String(p.lid).split("@")[0].split(":")[0] : null);
      if (key && !existing.has(key)) {
        existing.add(key);
        added += 1;
      }
      const contact = req.userStore.upsertContact({ digits: p.digits, lid: p.lid, name: p.name, sourceGroup: groupJid });
      if (contact) {
        if (contact.digits) withNumbers += 1;
        else hidden += 1;
      }
    }
  }

  // Individual DM chats: one contact each.
  let dmCount = 0;
  for (const dmJid of dmJids) {
    let person;
    try {
      person = await resolveChatContact(req.user.id, dmJid);
    } catch (error) {
      if (error.code === "NOT_CONNECTED") {
        return res.status(409).json({ error: error.message });
      }
      throw error;
    }
    if (!person || (!person.digits && !person.lid)) continue;
    total += 1;
    dmCount += 1;
    const key = person.digits || ("lid:" + String(person.lid).split("@")[0].split(":")[0]);
    if (!existing.has(key)) {
      existing.add(key);
      added += 1;
    }
    const contact = req.userStore.upsertContact({ digits: person.digits, lid: person.lid, name: person.name, sourceGroup: `dm:${dmJid}` });
    if (contact) {
      if (contact.digits) withNumbers += 1;
      else hidden += 1;
    }
  }

  req.userStore.save();
  req.userStore.addLog({
    kind: "system",
    ok: true,
    message: `Extracted ${total} people from ${groupJids.length} group(s) and ${dmJids.length} DM chat(s); ${added} new contacts (${withNumbers} with real numbers, ${hidden} hidden by WhatsApp)`
  });
  res.json({ ok: true, groups: groupJids.length, dms: dmJids.length, participants: total, added, withNumbers, hidden });
}));

function filterContacts(store, query) {
  const search = String(query.search || "").toLowerCase();
  const source = String(query.source || "");
  const listId = String(query.list || "");
  const optedOut = query.optedOut;
  return store.contacts
    .filter((c) => {
      if (search && !(c.digits.includes(search) || (c.name || "").toLowerCase().includes(search))) return false;
      if (source && !c.sourceGroups.includes(source)) return false;
      if (listId && !(c.listIds || []).includes(listId)) return false;
      if (optedOut === "true" && !c.optedOut) return false;
      if (optedOut === "false" && c.optedOut) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, 500);
}

app.get("/api/contacts", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  res.json({ contacts: filterContacts(store, req.query), total: store.contacts.length, groupNames: store.groupNames || {} });
}));

app.get("/api/contacts/export", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const contacts = filterContacts(store, req.query);
  const rows = [
    ["digits", "name", "lid", "source_groups", "opted_out", "last_sent_at"].join(","),
    ...contacts.map((c) =>
      [
        csvCell(c.digits),
        csvCell(c.name || ""),
        csvCell(c.lid || ""),
        csvCell(c.sourceGroups.join(";")),
        csvCell(c.optedOut ? "yes" : "no"),
        csvCell(c.lastSentAt || "")
      ].join(",")
    )
  ];
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="whatsapp-contacts-${utcDateString()}.csv"`
  );
  res.send(rows.join("\n"));
}));

app.post("/api/contacts/optout", requireUser, ah(async (req, res) => {
  const { contactId, optedOut } = req.body || {};
  const store = req.userStore.get();
  const contact = store.contacts.find((c) => c.id === contactId);
  if (!contact) return res.status(404).json({ error: "Contact not found." });
  if (typeof optedOut !== "boolean") return res.status(400).json({ error: "optedOut must be true or false." });
  req.userStore.setContactOptOut(identifierFor(contact), optedOut);
  res.json({ ok: true });
}));

app.post("/api/contacts/import", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const { numbersText = "", csvText = "", source = "manual" } = req.body || {};

  const entries = csvText
    ? parseCsvContacts(csvText)
    : parseNumberList(numbersText).map((digits) => ({ digits, name: null }));

  if (entries.length === 0) {
    return res.status(400).json({ error: "No valid phone numbers found. Use international format, e.g. 233201234567." });
  }
  if (entries.length > 5000) {
    return res.status(400).json({ error: "Too many numbers at once (max 5000 per import)." });
  }
  if (billingConfigured()) {
    const already = store.contacts.length;
    if (already >= PLAN.limits.maxContacts) {
      return res.status(400).json({ error: `Your Pro plan allows ${PLAN.limits.maxContacts.toLocaleString()} contacts. Delete some to import more.` });
    }
    if (already + entries.length > PLAN.limits.maxContacts) {
      return res.status(400).json({ error: `This import would exceed your Pro plan limit of ${PLAN.limits.maxContacts.toLocaleString()} contacts (${already.toLocaleString()} already saved).` });
    }
  }

  const existing = new Set(store.contacts.map((c) => c.digits));
  let added = 0;
  for (const e of entries) {
    if (!existing.has(e.digits)) {
      existing.add(e.digits);
      added += 1;
    }
    req.userStore.upsertContact({ digits: e.digits, name: e.name, sourceGroup: `import:${source}` });
  }
  req.userStore.save();
  req.userStore.addLog({ kind: "system", ok: true, message: `Imported ${entries.length} numbers (${added} new) via ${source}` });
  res.json({ ok: true, total: entries.length, added });
}));

/* -------- campaigns -------- */

app.post("/api/campaigns", requireUser, requireSendAllowed, ah(async (req, res) => {
  const store = req.userStore.get();
  const {
    name = "",
    message = "",
    dryRun = false,
    scheduledStartAt = null
  } = req.body || {};
  let { audienceType = "all", groupJids = [], contactIds = [], listId = null } = req.body || {};

  if (!String(name).trim()) return res.status(400).json({ error: "Campaign name is required." });
  if (!String(message).trim() || String(message).length > 2000) {
    return res.status(400).json({ error: "Message is required (max 2000 characters)." });
  }
  if (!["all", "groups", "ids", "manual", "list"].includes(audienceType)) {
    return res.status(400).json({ error: "Invalid audience type." });
  }
  if (audienceType === "list") {
    const list = store.lists.find((l) => l.id === listId);
    if (!list) return res.status(400).json({ error: "Choose a contact list for this audience." });
  }
  if (audienceType === "manual") {
    const digitsList = parseNumberList(req.body?.manualText);
    if (digitsList.length === 0) {
      return res.status(400).json({ error: "No valid phone numbers found. Paste numbers like 233201234567." });
    }
    if (dryRun) {
      return res.json({ ok: true, dryRun: true, recipients: digitsList.length, sample: digitsList.slice(0, 5).map((d) => `+${d}`) });
    }
    const ids = [];
    for (const digits of digitsList) {
      const contact = req.userStore.upsertContact({ digits, name: null, sourceGroup: "import:manual" });
      if (!ids.includes(contact.id)) ids.push(contact.id);
    }
    audienceType = "ids";
    contactIds = ids;
  }
  if (audienceType === "groups" && (!Array.isArray(groupJids) || groupJids.length === 0)) {
    return res.status(400).json({ error: "Choose at least one source group for this audience." });
  }
  if (audienceType === "ids" && (!Array.isArray(contactIds) || contactIds.length === 0)) {
    return res.status(400).json({ error: "No contacts selected." });
  }
  let startAt = null;
  if (scheduledStartAt) {
    startAt = new Date(scheduledStartAt);
    if (Number.isNaN(startAt.getTime())) {
      return res.status(400).json({ error: "Invalid scheduled start time." });
    }
  }

  const recipients = countRecipients(req.userStore, { audienceType, groupJids, contactIds, listId });

  const imageData = req.body?.imageData || "";
  let imagePath = null;
  if (imageData) {
    try {
      if (dryRun) decodeImageData(imageData); // validate only
      else imagePath = await saveImageData(req.userStore, imageData);
    } catch (error) {
      if (error.code === "BAD_IMAGE") return res.status(400).json({ error: error.message });
      throw error;
    }
  }

  // Optional follow-up: sent later to recipients who never replied.
  let followUp = null;
  const fuBody = req.body?.followUp || {};
  if (String(fuBody.message || "").trim()) {
    const delayHours = Number(fuBody.delayHours);
    if (!Number.isFinite(delayHours) || delayHours < 1 || delayHours > 720) {
      return res.status(400).json({ error: "Follow-up delay must be between 1 and 720 hours." });
    }
    if (String(fuBody.message).length > 2000) {
      return res.status(400).json({ error: "Follow-up message max 2000 characters." });
    }
    let fuImagePath = null;
    if (fuBody.imageData) {
      try {
        if (dryRun) decodeImageData(fuBody.imageData);
        else fuImagePath = await saveImageData(req.userStore, fuBody.imageData);
      } catch (error) {
        if (error.code === "BAD_IMAGE") return res.status(400).json({ error: error.message });
        throw error;
      }
    }
    followUp = { delayHours, message: String(fuBody.message), imagePath: fuImagePath };
  }

  if (dryRun) {
    return res.json({
      ok: true,
      dryRun: true,
      recipients: recipients.length,
      sample: recipients.slice(0, 5).map((c) => (c.digits ? `+${c.digits}` : "(number hidden)"))
    });
  }

  const campaign = {
    id: newId(),
    name: String(name).trim(),
    message: String(message),
    imagePath,
    audienceType,
    groupJids: audienceType === "groups" ? groupJids : [],
    contactIds: audienceType === "ids" ? contactIds : [],
    listId: audienceType === "list" ? listId : null,
    followUp,
    status: "queued",
    dryRun: false,
    scheduledStartAt: startAt ? startAt.toISOString() : null,
    recipientDigits: [],
    progress: null,
    cursor: 0,
    error: null,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null
  };
  store.campaigns.unshift(campaign);
  req.userStore.save();
  req.userStore.addLog({ kind: "dm", ref: campaign.id, ok: true, message: `Campaign "${campaign.name}" created (${recipients.length} recipients)` });
  res.json({ ok: true, campaign });
}));

app.get("/api/campaigns", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  res.json({ campaigns: store.campaigns });
}));

app.post("/api/campaigns/:id/pause", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const campaign = store.campaigns.find((c) => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  campaign.status = "paused";
  req.userStore.save();
  req.userStore.addLog({ kind: "dm", ref: campaign.id, ok: true, message: `Campaign "${campaign.name}" paused` });
  res.json({ ok: true, campaign });
}));

app.post("/api/campaigns/:id/resume", requireUser, requireSendAllowed, ah(async (req, res) => {
  const store = req.userStore.get();
  const campaign = store.campaigns.find((c) => c.id === req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found." });
  if (campaign.status !== "paused") return res.status(400).json({ error: "Only paused campaigns can be resumed." });
  campaign.status = campaign.recipientIds && campaign.recipientIds.length ? "running" : "queued";
  campaign.error = null;
  req.userStore.save();
  req.userStore.addLog({ kind: "dm", ref: campaign.id, ok: true, message: `Campaign "${campaign.name}" resumed` });
  res.json({ ok: true, campaign });
}));

/* -------- schedules -------- */

app.post("/api/schedules", requireUser, requireSendAllowed, ah(async (req, res) => {
  const store = req.userStore.get();
  const {
    name = "",
    groupJids = [],
    message = "",
    times = [],
    startDate = "",
    endDate = "",
    timezone = "",
    active = true,
    recurrence = "once",
    days = []
  } = req.body || {};

  if (!String(name).trim()) return res.status(400).json({ error: "Schedule name is required." });
  if (!Array.isArray(groupJids) || groupJids.length === 0) {
    return res.status(400).json({ error: "Select at least one group." });
  }
  if (groupJids.some((j) => typeof j !== "string" || !j.endsWith("@g.us"))) {
    return res.status(400).json({ error: "Invalid group selected." });
  }
  if (!String(message).trim() || String(message).length > 2000) {
    return res.status(400).json({ error: "Message is required (max 2000 characters)." });
  }
  if (!Array.isArray(times) || times.length === 0 || times.length > 10 || !times.every(isHhMm)) {
    return res.status(400).json({ error: "Add 1-10 send times in HH:MM format (e.g. 08:00, 13:00)." });
  }
  if (!isYmd(startDate) || !isYmd(endDate) || startDate > endDate) {
    return res.status(400).json({ error: "Start/end dates are invalid (YYYY-MM-DD, start before end)." });
  }
  const tz = String(timezone || store.settings.defaultTimezone).trim() || "Africa/Accra";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    return res.status(400).json({ error: "Invalid timezone." });
  }
  if (!["once", "weekly"].includes(recurrence)) {
    return res.status(400).json({ error: "Invalid recurrence." });
  }
  const dayNums = (Array.isArray(days) ? days : []).map(Number).filter((d) => d >= 0 && d <= 6);
  if (recurrence === "weekly" && dayNums.length === 0) {
    return res.status(400).json({ error: "Pick at least one weekday for a weekly schedule." });
  }

  let imagePath = null;
  if (req.body?.imageData) {
    try {
      imagePath = await saveImageData(req.userStore, req.body.imageData);
    } catch (error) {
      if (error.code === "BAD_IMAGE") return res.status(400).json({ error: error.message });
      throw error;
    }
  }

  const schedule = {
    id: newId(),
    name: String(name).trim(),
    groupJids,
    message: String(message),
    imagePath,
    times: [...new Set(times)].sort(),
    startDate,
    endDate,
    timezone: tz,
    recurrence,
    days: [...new Set(dayNums)].sort(),
    active: active !== false,
    createdAt: new Date().toISOString()
  };
  store.schedules.unshift(schedule);
  req.userStore.save();
  req.userStore.addLog({ kind: "system", ref: schedule.id, ok: true, message: `Schedule "${schedule.name}" created (${times.join(", ")}, ${startDate} to ${endDate})` });
  res.json({ ok: true, schedule });
}));

app.get("/api/schedules", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  res.json({ schedules: store.schedules });
}));

app.post("/api/schedules/:id/toggle", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const schedule = store.schedules.find((s) => s.id === req.params.id);
  if (!schedule) return res.status(404).json({ error: "Schedule not found." });
  if (!schedule.active) {
    const blocked = sendBlockedReason(req);
    if (blocked) return res.status(402).json({ ...blocked, billingRequired: true });
  }
  schedule.active = !schedule.active;
  req.userStore.save();
  res.json({ ok: true, schedule });
}));

app.delete("/api/schedules/:id", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const index = store.schedules.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Schedule not found." });
  const [removed] = store.schedules.splice(index, 1);
  req.userStore.save();
  req.userStore.addLog({ kind: "system", ref: removed.id, ok: true, message: `Schedule "${removed.name}" deleted` });
  res.json({ ok: true });
}));

/* -------- logs & settings -------- */

app.get("/api/logs", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const kind = String(req.query.kind || "");
  const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10) || 100, 1), 500);
  const logs = store.logs.filter((l) => !kind || l.kind === kind).slice(0, limit);
  res.json({ logs });
}));

app.get("/api/settings", requireUser, ah(async (req, res) => {
  res.json({ settings: req.userStore.get().settings });
}));

app.post("/api/settings", requireUser, ah(async (req, res) => {
  const store = req.userStore.get();
  const body = req.body || {};
  const next = { ...store.settings };

  // Plan ceilings: the Pro plan caps daily/hourly DMs no matter what the
  // user types. (The scheduler also applies min() as a backstop.)
  if (billingConfigured()) {
    if (body.dmDailyCap !== undefined && Number(body.dmDailyCap) > PLAN.limits.dailyDmCap) {
      return res.status(400).json({ error: `Your Pro plan allows at most ${PLAN.limits.dailyDmCap} DMs per day.` });
    }
    if (body.dmHourlyCap !== undefined && Number(body.dmHourlyCap) > PLAN.limits.hourlyDmCap) {
      return res.status(400).json({ error: `Your Pro plan allows at most ${PLAN.limits.hourlyDmCap} DMs per hour.` });
    }
  }

  if (body.dmDelayMs !== undefined) {
    const v = Number(body.dmDelayMs);
    if (!Number.isFinite(v) || v < 1000 || v > 120000) {
      return res.status(400).json({ error: "dmDelayMs must be between 1000 and 120000." });
    }
    next.dmDelayMs = Math.round(v);
  }
  if (body.dmDailyCap !== undefined) {
    const v = Number(body.dmDailyCap);
    if (!Number.isFinite(v) || v < 1 || v > 2000) {
      return res.status(400).json({ error: "dmDailyCap must be between 1 and 2000." });
    }
    next.dmDailyCap = Math.round(v);
  }
  if (body.dmHourlyCap !== undefined) {
    const v = Number(body.dmHourlyCap);
    if (!Number.isFinite(v) || v < 0 || v > 500) {
      return res.status(400).json({ error: "dmHourlyCap must be between 0 (off) and 500." });
    }
    next.dmHourlyCap = Math.round(v);
  }
  if (body.dmHourlyCooldownMin !== undefined) {
    const v = Number(body.dmHourlyCooldownMin);
    if (!Number.isFinite(v) || v < 0 || v > 120) {
      return res.status(400).json({ error: "dmHourlyCooldownMin must be between 0 (none) and 120." });
    }
    next.dmHourlyCooldownMin = Math.round(v);
  }
  if (body.dmBatchSize !== undefined) {
    const v = Number(body.dmBatchSize);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return res.status(400).json({ error: "dmBatchSize must be between 0 (off) and 100." });
    }
    next.dmBatchSize = Math.round(v);
  }
  if (body.dmBatchCooldownMin !== undefined) {
    const v = Number(body.dmBatchCooldownMin);
    if (!Number.isFinite(v) || v < 1 || v > 120) {
      return res.status(400).json({ error: "dmBatchCooldownMin must be between 1 and 120." });
    }
    next.dmBatchCooldownMin = Math.round(v);
  }
  if (body.groupDelayMs !== undefined) {
    const v = Number(body.groupDelayMs);
    if (!Number.isFinite(v) || v < 1000 || v > 120000) {
      return res.status(400).json({ error: "groupDelayMs must be between 1000 and 120000." });
    }
    next.groupDelayMs = Math.round(v);
  }
  if (body.defaultTimezone !== undefined) {
    const tz = String(body.defaultTimezone).trim();
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    } catch {
      return res.status(400).json({ error: "Invalid default timezone." });
    }
    next.defaultTimezone = tz;
  }
  if (body.quietStart !== undefined) {
    if (!isHhMm(body.quietStart)) return res.status(400).json({ error: "quietStart must be HH:MM." });
    next.quietStart = body.quietStart;
  }
  if (body.quietEnd !== undefined) {
    if (!isHhMm(body.quietEnd)) return res.status(400).json({ error: "quietEnd must be HH:MM." });
    next.quietEnd = body.quietEnd;
  }
  for (const key of ["autoOptOutReply", "quietEnabled"]) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean") return res.status(400).json({ error: `${key} must be true or false.` });
      next[key] = body[key];
    }
  }

  store.settings = next;
  req.userStore.save();
  req.userStore.addLog({ kind: "system", ok: true, message: "Settings updated" });
  res.json({ ok: true, settings: next });
}));

app.use((err, req, res, _next) => {
  console.error("API error:", err.message);
  res.status(500).json({ error: "Server error: " + err.message });
});

/* =========================
   BOOT
========================= */

await loadAuthStore(); // fails fast when SESSION_SECRET is missing

if (process.env.SKIP_WHATSAPP === "1") {
  console.log("SKIP_WHATSAPP=1: WhatsApp connection disabled (testing mode).");
} else {
  // (Re)connect every registered user's WhatsApp session — except
  // suspended accounts, which stay offline until they renew.
  for (const user of listUsers()) {
    if (billingConfigured()) {
      try {
        const full = findUserById(user.id);
        if (full && effectiveStatus(full) === "suspended") continue;
      } catch { /* fall through and try connecting */ }
    }
    startWhatsApp(user.id).catch((error) => {
      console.error(`Failed to start WhatsApp for user ${user.id}:`, error.message);
    });
  }
}

startScheduler();

app.listen(PORT, () => {
  console.log(`WhatsApp marketing bot dashboard: http://localhost:${PORT}`);
});
