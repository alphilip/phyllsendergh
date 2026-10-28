import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import bcrypt from "bcryptjs";

import { getUserStore } from "./store.js";

const BASE_DATA_DIR = process.env.DATA_DIR || "/data";
const AUTH_FILE = path.join(BASE_DATA_DIR, "users.json");
const SECRET_FILE = path.join(BASE_DATA_DIR, ".session-secret");
const COOKIE_NAME = "wa_saas_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// ---- session secret resolution ----
// Priority: SESSION_SECRET env var → a secret persisted in the data dir
// → a freshly generated secret that is then persisted. The old behaviour
// (throw at boot when the env var is missing) meant a first deploy that
// forgot one env var served NOTHING — the whole site was down and the
// only clue was a container log line. Sessions stay HMAC-signed either
// way; the fallback secret is 384-bit random and stored mode 0600.
let resolvedSecret = null; // { value, source: "env"|"file"|"generated-file"|"ephemeral", weak }

export function getSessionSecret() {
  if (resolvedSecret) return resolvedSecret.value;
  const env = process.env.SESSION_SECRET || "";
  if (env) return env;
  throw new Error("SESSION_SECRET is not configured on the server.");
}

export function sessionSecretInfo() {
  if (resolvedSecret) return resolvedSecret;
  const env = process.env.SESSION_SECRET || "";
  return env
    ? { source: "env", weak: env.length < 32 }
    : { source: "unresolved", weak: false };
}

async function resolveSessionSecret() {
  if (resolvedSecret) return resolvedSecret;
  const env = String(process.env.SESSION_SECRET || "");
  if (env) {
    resolvedSecret = { value: env, source: "env", weak: env.length < 32 };
    if (resolvedSecret.weak) {
      console.warn("[auth] WARNING: SESSION_SECRET is short (< 32 chars). Use a long random string (64 chars recommended).");
    }
    return resolvedSecret;
  }
  try {
    const raw = (await readFile(SECRET_FILE, "utf8")).trim();
    if (raw.length >= 32) {
      resolvedSecret = { value: raw, source: "file", weak: false };
      return resolvedSecret;
    }
  } catch { /* no persisted secret yet — generate one below */ }
  const generated = randomBytes(48).toString("hex");
  let persisted = false;
  try {
    await ensureBaseDir();
    await writeFile(SECRET_FILE, generated, { encoding: "utf8", mode: 0o600 });
    persisted = true;
  } catch (error) {
    console.error("[auth] Could not persist a generated session secret:", error.message);
  }
  resolvedSecret = { value: generated, source: persisted ? "generated-file" : "ephemeral", weak: false };
  console.warn(
    "[auth] SESSION_SECRET is not set — using a " +
    (persisted
      ? `generated secret saved to ${SECRET_FILE} (logins will survive restarts). `
      : "temporary in-memory secret — ALL sessions reset on every restart. ") +
    "Set SESSION_SECRET in the app environment for production."
  );
  return resolvedSecret;
}

function blankAuth() {
  return { version: 1, users: [], sessions: [] };
}

let auth = null;

async function ensureBaseDir() {
  await mkdir(BASE_DATA_DIR, { recursive: true });
}

export async function loadAuthStore() {
  // Resolve the signing secret first (env → persisted → generated).
  await resolveSessionSecret();
  await ensureBaseDir();
  try {
    const raw = await readFile(AUTH_FILE, "utf8");
    const parsed = JSON.parse(raw);
    auth = { ...blankAuth(), ...parsed };
    if (!Array.isArray(auth.users)) auth.users = [];
    if (!Array.isArray(auth.sessions)) auth.sessions = [];
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Could not read auth store, starting fresh:", error.message);
    }
    auth = blankAuth();
    await saveAuthNow();
  }
  return auth;
}

function getAuth() {
  if (!auth) throw new Error("Auth store not loaded yet.");
  return auth;
}

async function saveAuthNow() {
  const tmp = AUTH_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(getAuth(), null, 2), "utf8");
  await rename(tmp, AUTH_FILE);
}

let authSaveTimer = null;
function saveAuth() {
  if (authSaveTimer) return;
  authSaveTimer = setTimeout(async () => {
    authSaveTimer = null;
    try {
      await saveAuthNow();
    } catch (error) {
      console.error("Failed to save auth store:", error.message);
    }
  }, 500);
}

export function listUsers() {
  return getAuth().users.map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt }));
}

// Full records — for server-side use only (never send to clients).
export function getAllUsers() {
  return getAuth().users;
}

export function findUserById(id) {
  return getAuth().users.find((u) => u.id === id) || null;
}

export function findUserByEmail(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return null;
  return getAuth().users.find((u) => u.email === clean) || null;
}

// Public base URL for emailed links. Coolify sets the real host via the
// Host header; PUBLIC_BASE_URL overrides when set.
export function publicBaseUrl(req) {
  const env = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (env) return env;
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() || "https";
  return `${proto}://${req.headers.host}`;
}

// ---- referrals ----

const REF_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

export function generateReferralCode() {
  const users = getAuth().users;
  let code;
  do {
    const bytes = randomBytes(8);
    code = Array.from(bytes, (b) => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
  } while (users.some((u) => u.referralCode === code));
  return code;
}

export function findUserByReferralCode(code) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return null;
  return getAuth().users.find((u) => u.referralCode === clean) || null;
}

// Backfill for accounts created before referrals existed.
export function ensureReferralCode(user) {
  if (!user.referralCode) {
    user.referralCode = generateReferralCode();
    saveAuth();
  }
  return user.referralCode;
}

export function getReferrals(userId) {
  return getAuth()
    .users.filter((u) => u.referredBy === userId)
    .map((u) => ({ email: u.email, referredAt: u.referredAt || u.createdAt }))
    .sort((a, b) => String(b.referredAt).localeCompare(String(a.referredAt)));
}

// Immediate (non-debounced) persist for billing transitions.
export async function persistAuthNow() {
  await saveAuthNow();
}

// ---- admin-only account maintenance (called only from requireAdmin
// routes in admin.js) ----

// Set a user's password (admin reset): hashes, invalidates every
// session for the account, persists immediately. Returns false when
// the user does not exist. A pending self-reset link dies with it.
export async function setUserPassword(userId, plainPassword) {
  const user = findUserById(userId);
  if (!user) return false;
  user.passwordHash = await bcrypt.hash(plainPassword, 10);
  delete user.pwReset;
  getAuth().sessions = getAuth().sessions.filter((s) => s.userId !== userId);
  await persistAuthNow();
  return true;
}

// Remove a user account entirely: user row + sessions. Callers must
// disconnect WhatsApp and delete the user's /data dir separately.
export async function removeUserAccount(userId) {
  const auth = getAuth();
  const idx = auth.users.findIndex((u) => u.id === userId);
  if (idx === -1) return false;
  auth.users.splice(idx, 1);
  auth.sessions = auth.sessions.filter((s) => s.userId !== userId);
  await persistAuthNow();
  return true;
}

// ---- signed session cookies ----

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

function readSessionToken(req) {
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

// Did THIS request arrive over HTTPS (directly, or via the proxy's
// X-Forwarded-Proto)? The session cookie's Secure flag must follow the
// scheme the browser actually used — NOT NODE_ENV. The Dockerfile sets
// NODE_ENV=production, so the old rule stamped Secure on every cookie;
// on a first deploy still served over plain HTTP (no domain/HTTPS yet),
// browsers silently DISCARD Secure cookies from http:// origins — the
// login POST returned 200, the browser stored nothing, and the redirect
// to / bounced straight back to the login page with no error shown.
export function requestIsHttps(req) {
  if (!req) return false;
  if (req.secure) return true;
  const proto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  return proto === "https";
}

export function cookieSecure(req) {
  const mode = String(process.env.COOKIE_SECURE || "auto").trim().toLowerCase();
  if (mode === "always") return true;
  if (mode === "never") return false;
  return requestIsHttps(req); // "auto": Secure only when this request is HTTPS
}

function sessionCookieHeader(token, maxAgeSec, req) {
  const value = `${token}.${signToken(token)}`;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`
  ];
  if (cookieSecure(req)) parts.push("Secure");
  return parts.join("; ");
}

export function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  getAuth().sessions.push({
    token,
    userId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString()
  });
  // Cap stored sessions to keep the file small.
  const sessions = getAuth().sessions;
  if (sessions.length > 2000) getAuth().sessions = sessions.slice(-2000);
  saveAuth();
  return token;
}

export function destroySession(token) {
  const before = getAuth().sessions.length;
  getAuth().sessions = getAuth().sessions.filter((s) => s.token !== token);
  if (getAuth().sessions.length !== before) saveAuth();
}

function lookupSession(token) {
  if (!token) return null;
  const now = Date.now();
  const session = getAuth().sessions.find((s) => s.token === token);
  if (!session) return null;
  if (new Date(session.expiresAt).getTime() <= now) {
    destroySession(token);
    return null;
  }
  return session;
}

// ---- middleware ----

export function attachUser(req) {
  const token = readSessionToken(req);
  const session = lookupSession(token);
  if (!session) return null;
  const user = findUserById(session.userId);
  if (!user) {
    destroySession(token);
    return null;
  }
  req.user = { id: user.id, email: user.email };
  req.userStore = getUserStore(user.id);
  req.sessionToken = token;
  return req.user;
}

// JSON APIs: 401 when not signed in.
export async function requireUser(req, res, next) {
  if (!attachUser(req)) {
    return res.status(401).json({ error: "Not signed in. Please log in." });
  }
  try {
    await req.userStore.load(); // no-op when already loaded
  } catch (error) {
    return res.status(500).json({ error: "Could not load your data: " + error.message });
  }
  next();
}

// HTML pages: redirect to the login page when not signed in.
export async function requireUserPage(req, res, next) {
  if (!attachUser(req)) {
    return res.redirect("/login.html");
  }
  try {
    await req.userStore.load(); // no-op when already loaded
  } catch {
    return res.redirect("/login.html");
  }
  next();
}

// ---- admin role (merged admin: no separate admin login anymore) ----
// The admin is a normal user account with role "admin". The role is set
// ONLY by the one-time claim route (admin.js), which checks the
// ADMIN_PASSWORD env var — never by signup, login, or any user-facing
// endpoint, so signing up with a known email alone can never become admin.
export function isAdminUser(user) {
  return !!(user && user.role === "admin");
}

export function hasAnyAdmin() {
  return getAuth().users.some((u) => u.role === "admin");
}

// Same session cookie as any user; the role check is what makes it admin.
export async function requireAdminUser(req, res, next) {
  if (!attachUser(req)) {
    return res.status(401).json({ error: "Not signed in. Please log in." });
  }
  const user = findUserById(req.user.id);
  if (!user || !isAdminUser(user)) {
    return res.status(403).json({ error: "Admin access required." });
  }
  req.adminUser = user;
  next();
}

// ---- validation ----

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email || "").trim());
}

// Simple in-memory brute-force brake for the auth endpoints.
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
  // Prune occasionally.
  if (attempts.size > 5000 && Math.random() < 0.05) {
    for (const [k, v] of attempts) if (v.resetAt < now) attempts.delete(k);
  }
  return entry.count > 30;
}

// ---- routes ----

export const authRouter = Router();

authRouter.post("/api/auth/signup", async (req, res, next) => {
  try {
    if (tooManyAttempts(req.ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const tosAccepted = req.body?.tosAccepted === true;
    if (!validEmail(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    if (!tosAccepted) {
      return res.status(400).json({ error: "Please accept the Terms of Service to continue." });
    }
    if (getAuth().users.some((u) => u.email === email)) {
      return res.status(400).json({ error: "An account with that email already exists." });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: randomBytes(16).toString("hex"),
      email,
      passwordHash,
      role: "user",
      tosAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      referralCode: generateReferralCode(),
      // Billing (Phase 2): every new account starts unpaid; the
      // charge.success webhook flips this to active. planId stays null
      // until checkout, when the user picks a tier.
      subscription: {
        status: "pending_payment",
        planId: null,
        period: null,
        currentPeriodEnd: null,
        lastReference: null,
        processedRefs: [],
        updatedAt: new Date().toISOString()
      }
    };
    // Optional referral: ?ref=CODE on the signup page.
    const referrer = findUserByReferralCode(req.body?.ref);
    if (referrer && referrer.id !== user.id) {
      user.referredBy = referrer.id;
      user.referredAt = new Date().toISOString();
    }
    getAuth().users.push(user);
    saveAuth();
    // Provision the user's data dirs + store eagerly so the dashboard works immediately.
    const userStore = getUserStore(user.id);
    await userStore.load();
    const token = createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000), req));
    res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/api/auth/login", async (req, res, next) => {
  try {
    if (tooManyAttempts(req.ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const user = getAuth().users.find((u) => u.email === email);
    // Same-shaped failure for unknown emails (no account enumeration).
    const hash = user ? user.passwordHash : await bcrypt.hash("dummy", 10);
    const ok = await bcrypt.compare(password, hash);
    if (!user || !ok) {
      return res.status(401).json({ error: "Invalid email or password." });
    }
    const token = createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000), req));
    res.json({ ok: true, user: { id: user.id, email: user.email } });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/api/auth/logout", (req, res) => {
  const token = readSessionToken(req);
  if (token) destroySession(token);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
  res.json({ ok: true });
});

authRouter.get("/api/auth/me", requireUser, (req, res) => {
  const user = findUserById(req.user.id);
  res.json({
    ok: true,
    user: { id: req.user.id, email: req.user.email, isAdmin: isAdminUser(user) }
  });
});

/* =========================
   Password reset (email link)
========================= */

const RESET_TTL_MS = 3600 * 1000; // 1 hour, single-use

function smtpConfigured() {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.FROM_EMAIL
  );
}

let mailer = null;
async function getMailer() {
  if (mailer) return mailer;
  const nodemailer = (await import("nodemailer")).default;
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "").toLowerCase() === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return mailer;
}

function sha256hex(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex");
}

// Always 200 — never reveal whether the email exists.
authRouter.post("/api/auth/forgot", async (req, res, next) => {
  try {
    if (tooManyAttempts(req.ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }
    if (!smtpConfigured()) {
      return res.status(503).json({ error: "Password reset is not configured on this server yet." });
    }
    const email = String(req.body?.email || "").trim().toLowerCase();
    const user = validEmail(email) ? findUserByEmail(email) : null;
    if (user) {
      const token = randomBytes(32).toString("hex"); // 256-bit
      user.pwReset = {
        hash: sha256hex(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MS).toISOString(),
        createdAt: new Date().toISOString()
      };
      saveAuth();
      const link = `${publicBaseUrl(req)}/reset.html?token=${token}`;
      try {
        const m = await getMailer();
        await m.sendMail({
          from: process.env.FROM_EMAIL,
          to: user.email,
          subject: "Reset your password",
          text:
            `You asked to reset your WhatsApp Marketing password.\n\n` +
            `Use this link within 1 hour (one-time use):\n${link}\n\n` +
            `If you didn't ask for this, just ignore this email.`,
          html:
            `<p>You asked to reset your WhatsApp Marketing password.</p>` +
            `<p><a href="${link}">Reset your password</a> (valid 1 hour, one-time use).</p>` +
            `<p>If you didn't ask for this, just ignore this email.</p>`
        });
      } catch (error) {
        console.error("[auth] password-reset email failed:", error.message);
      }
    }
    res.json({ ok: true, message: "If an account exists for that email, a reset link has been sent." });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/api/auth/reset", async (req, res, next) => {
  try {
    if (tooManyAttempts(req.ip)) {
      return res.status(429).json({ error: "Too many attempts. Try again in a few minutes." });
    }
    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    const want = sha256hex(token);
    let target = null;
    for (const u of getAuth().users) {
      const h = u.pwReset && u.pwReset.hash;
      if (typeof h === "string" && h.length === want.length) {
        const a = Buffer.from(h, "utf8");
        const b = Buffer.from(want, "utf8");
        if (timingSafeEqual(a, b)) {
          target = u;
          break;
        }
      }
    }
    if (
      !target ||
      !target.pwReset ||
      new Date(target.pwReset.expiresAt).getTime() <= Date.now()
    ) {
      return res.status(400).json({ error: "This reset link is invalid or has expired." });
    }
    target.passwordHash = await bcrypt.hash(password, 10);
    delete target.pwReset; // single-use
    // Invalidate every session for this account.
    getAuth().sessions = getAuth().sessions.filter((s) => s.userId !== target.id);
    saveAuth();
    res.json({ ok: true, message: "Password updated. Please log in again." });
  } catch (error) {
    next(error);
  }
});
