// Owner admin panel: admin auth, user management, platform stats, announcements.
//
// Separate from user auth (auth.js). Credentials come from ADMIN_EMAIL +
// ADMIN_PASSWORD + ADMIN_LOGIN_PATH env vars. When any of the three is
// unset/invalid, the admin router is never mounted, so /api/admin/* falls
// through to Express's 404 — the panel's existence is never hinted at.
// The owner page lives ONLY at the secret ADMIN_LOGIN_PATH (never at
// /admin.html, which always 404s) and is served from the private/ dir,
// not from public/ static files.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";

import { cookieSecure, findUserById, getSessionSecret, listUsers, persistAuthNow, requireUser } from "./auth.js";
import {
  addSubHistory,
  effectiveStatus,
  getSubscription,
  refreshSubscription,
  suspendUserAccount
} from "./billing.js";
import { PLAN } from "./plans.js";
import { getUserStore } from "./store.js";
import { peekStatus } from "./whatsapp.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_DATA_DIR = process.env.DATA_DIR || "/data";
const ADMIN_FILE = path.join(BASE_DATA_DIR, "admin.json");
const ANNOUNCE_FILE = path.join(BASE_DATA_DIR, "announcement.json");
const COOKIE_NAME = "admin_session";
const ADMIN_TTL_MS = 12 * 3600 * 1000; // 12 hours

export function adminEnabled() {
  return !!(process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && adminLoginPath());
}

// Full picture for the boot self-check: which of the three required env
// vars are missing/invalid, so a first deploy that can't find the owner
// panel gets the exact reason from the server log (the panel itself
// stays invisible — nothing about it is ever exposed over HTTP).
export function adminConfigStatus() {
  const missing = [];
  if (!String(process.env.ADMIN_EMAIL || "").trim()) missing.push("ADMIN_EMAIL");
  if (!String(process.env.ADMIN_PASSWORD || "")) missing.push("ADMIN_PASSWORD");
  const p = adminLoginPath();
  if (!p) {
    missing.push("ADMIN_LOGIN_PATH (unset or invalid — must start with /, be 2–120 chars of letters/digits/- _ . ~ /, not a real page like /admin.html, and not start with /api/)");
  }
  return { enabled: missing.length === 0, missing, path: p, email: adminEmail() || null };
}

const BANNED_LOGIN_PATHS = new Set([
  "/", "/index.html", "/login.html", "/signup.html", "/reset.html", "/admin.html", "/health"
]);

let loginPathWarned = false;

// Owner panel lives at a hidden, unguessable URL from ADMIN_LOGIN_PATH.
// Validated strictly so Express can never treat it as a route parameter
// (:), wildcard (*), or query/fragment (?:#) — those break matching or
// leak into other routes.
export function adminLoginPath() {
  const raw = String(process.env.ADMIN_LOGIN_PATH || "").trim();
  const fail = (reason) => {
    if (!loginPathWarned) {
      loginPathWarned = true;
      console.warn(`[admin] ADMIN_LOGIN_PATH invalid (${reason}) — admin panel disabled`);
    }
    return null;
  };
  if (!raw) return fail("not set");
  if (!raw.startsWith("/")) return fail("must start with /");
  if (raw.length < 2 || raw.length > 120) return fail("length must be 2-120 characters");
  if (!/^[A-Za-z0-9\-_.~\/]+$/.test(raw)) {
    return fail("invalid characters (allowed: letters, digits, - _ . ~ /)");
  }
  if (BANNED_LOGIN_PATHS.has(raw)) return fail("reserved path");
  if (raw.startsWith("/api/")) return fail("must not start with /api/");
  return raw;
}

function adminEmail() {
  return String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
}

// ---- signed admin session cookie (same HMAC style as auth.js) ----

function signToken(token) {
  return createHmac("sha256", getSessionSecret()).update(token, "utf8").digest("hex");
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function readAdminToken(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  const raw = cookies[COOKIE_NAME];
  if (!raw || !raw.includes(".")) return null;
  const [token, sig] = raw.split(".");
  if (!token || !sig) return null;
  let expected;
  try {
    expected = signToken(token);
  } catch {
    return null;
  }
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return token;
}

function adminCookieHeader(token, req) {
  const value = `${token}.${signToken(token)}`;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(ADMIN_TTL_MS / 1000)}`
  ];
  // Same rule as the user session cookie (see auth.js cookieSecure):
  // Secure follows the scheme of THIS request, never NODE_ENV — an
  // unconditional Secure here silently broke first owner logins on
  // plain-HTTP deploys (browser discards the cookie, login "fails").
  if (cookieSecure(req)) parts.push("Secure");
  return parts.join("; ");
}

function clearAdminCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

// Single-owner session: one token in /data/admin.json, rotated on every
// login (a second login invalidates the first). Good enough for one owner,
// and there is no user table to leak into.
async function readAdminState() {
  try {
    const raw = await readFile(ADMIN_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeAdminState(state) {
  await mkdir(BASE_DATA_DIR, { recursive: true });
  const tmp = ADMIN_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, ADMIN_FILE);
}

export async function requireAdmin(req, res, next) {
  try {
    const token = readAdminToken(req);
    const state = await readAdminState();
    const stored = String(state.token || "");
    const a = Buffer.from(token || "", "utf8");
    const b = Buffer.from(stored, "utf8");
    const tokenOk = token && stored && a.length === b.length && timingSafeEqual(a, b);
    const fresh = state.expiresAt && new Date(state.expiresAt).getTime() > Date.now();
    if (!tokenOk || !fresh) {
      return res.status(401).json({ error: "Not signed in as admin." });
    }
    req.adminEmail = adminEmail();
    next();
  } catch (error) {
    next(error);
  }
}

// ---- brute-force brake (same shape as auth.js) ----

const attempts = new Map();
function tooManyAttempts(ip) {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const entry = attempts.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }
  entry.count += 1;
  attempts.set(ip, entry);
  if (attempts.size > 5000 && Math.random() < 0.05) {
    for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
  }
  return entry.count > 30;
}

// ---- per-user row for the admin table ----

async function adminUserRow(user) {
  // Advance time-based transitions (past_due -> suspended) before reporting.
  await refreshSubscription(user);
  const sub = getSubscription(user);
  const status = effectiveStatus(user);
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
    // Abuse/velocity signal: >3x the plan's daily cap in 24h, or a long
    // run of consecutive send failures (likely ban/restriction).
    flagged = dms24h > 3 * PLAN.limits.dailyDmCap || failStreak > 10;
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

// Owner page served ONLY at the hidden ADMIN_LOGIN_PATH — no auth check on
// the GET because the page contains no secrets; it boots via
// /api/admin/me and shows the login form or the dashboard in-page. All data
// loads through requireAdmin-guarded APIs. Computed once at module scope.
const SECRET_OWNER_PATH = adminLoginPath();
if (SECRET_OWNER_PATH) {
  adminRouter.get(SECRET_OWNER_PATH, (req, res) => {
    res.sendFile(path.join(__dirname, "private", "admin.html"));
  });
}

adminRouter.post("/api/admin/login", async (req, res, next) => {
  try {
    if (tooManyAttempts(req.ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }
    const wantEmail = adminEmail();
    const wantPass = String(process.env.ADMIN_PASSWORD || "");
    const tryEmail = String(req.body?.email || "").trim().toLowerCase();
    const tryPass = String(req.body?.password || "");
    const emailOk = wantEmail.length > 0 && tryEmail === wantEmail;
    // Constant-time password compare even when the email is wrong.
    const a = Buffer.from(tryPass, "utf8");
    const b = Buffer.from(wantPass, "utf8");
    const passOk = a.length === b.length && timingSafeEqual(a, b);
    if (!emailOk || !passOk) {
      return res.status(401).json({ error: "Invalid admin credentials." });
    }
    const token = randomBytes(32).toString("hex");
    await writeAdminState({
      token,
      email: wantEmail,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ADMIN_TTL_MS).toISOString()
    });
    res.setHeader("Set-Cookie", adminCookieHeader(token, req));
    console.log(`[admin] login success for ${wantEmail} from ${req.ip}`);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/logout", async (req, res, next) => {
  try {
    await writeAdminState({});
    res.setHeader("Set-Cookie", clearAdminCookieHeader());
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/api/admin/me", requireAdmin, (req, res) => {
  res.json({ ok: true, admin: { email: req.adminEmail } });
});

adminRouter.get("/api/admin/users", requireAdmin, async (req, res, next) => {
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

// Per-user drill-down: full safe projection + recent campaigns + recent logs
// + subscription timeline. Never passwordHash, sessions, or keys.
adminRouter.get("/api/admin/users/:id", requireAdmin, async (req, res, next) => {
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

adminRouter.post("/api/admin/users/:id/suspend", requireAdmin, async (req, res, next) => {
  try {
    const user = findUserById(req.params.id);
    if (!user) return res.status(404).json({ error: "User not found." });
    // Reuses the billing suspension path: flips status, persists, and
    // disconnects WhatsApp without restarting it.
    await suspendUserAccount(user, `manual suspend by ${req.adminEmail}`);
    console.log(`[admin] ${req.adminEmail} suspended ${user.email} (${user.id})`);
    res.json({ ok: true, status: "suspended" });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/users/:id/unsuspend", requireAdmin, async (req, res, next) => {
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
    console.log(`[admin] ${req.adminEmail} unsuspended ${user.email} (${user.id}) -> ${sub.status}`);
    res.json({ ok: true, status: sub.status });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/users/:id/extend", requireAdmin, async (req, res, next) => {
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
    console.log(`[admin] ${req.adminEmail} extended ${user.email} (${user.id}) by ${days}d -> ${sub.currentPeriodEnd}`);
    res.json({ ok: true, status: "active", currentPeriodEnd: sub.currentPeriodEnd });
  } catch (error) {
    next(error);
  }
});

adminRouter.get("/api/admin/stats", requireAdmin, async (req, res, next) => {
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
        // MRR estimate: monthly actives at full price, yearly actives / 12.
        mrr += r.subscription.period === "yearly"
          ? PLAN.prices.yearly.ghs / 12
          : PLAN.prices.monthly.ghs;
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

adminRouter.get("/api/admin/announcement", requireAdmin, async (req, res, next) => {
  try {
    res.json({ ok: true, ...(await readAnnouncement()) });
  } catch (error) {
    next(error);
  }
});

adminRouter.post("/api/admin/announcement", requireAdmin, async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").slice(0, 500);
    const data = {
      text,
      updatedAt: new Date().toISOString(),
      updatedBy: req.adminEmail
    };
    await mkdir(BASE_DATA_DIR, { recursive: true });
    const tmp = ANNOUNCE_FILE + ".tmp";
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await rename(tmp, ANNOUNCE_FILE);
    console.log(`[admin] ${req.adminEmail} set announcement: ${text ? text.slice(0, 80) : "(cleared)"}`);
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
