import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import bcrypt from "bcryptjs";

import { getUserStore } from "./store.js";

const BASE_DATA_DIR = process.env.DATA_DIR || "/data";
const AUTH_FILE = path.join(BASE_DATA_DIR, "users.json");
const COOKIE_NAME = "wa_saas_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

function sessionSecret() {
  const s = process.env.SESSION_SECRET || "";
  if (!s) throw new Error("SESSION_SECRET is not configured on the server.");
  return s;
}

function blankAuth() {
  return { version: 1, users: [], sessions: [] };
}

let auth = null;

async function ensureBaseDir() {
  await mkdir(BASE_DATA_DIR, { recursive: true });
}

export async function loadAuthStore() {
  // Fail fast when the session secret is missing — never boot unsigned.
  sessionSecret();
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

export function findUserById(id) {
  return getAuth().users.find((u) => u.id === id) || null;
}

export function findUserByEmail(email) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean) return null;
  return getAuth().users.find((u) => u.email === clean) || null;
}

// Immediate (non-debounced) persist for billing transitions.
export async function persistAuthNow() {
  await saveAuthNow();
}

// ---- signed session cookies ----

function signToken(token) {
  return createHmac("sha256", sessionSecret()).update(token, "utf8").digest("hex");
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

function sessionCookieHeader(token, maxAgeSec) {
  const value = `${token}.${signToken(token)}`;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
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
      tosAcceptedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      // Billing (Phase 2): every new account starts unpaid; the
      // charge.success webhook flips this to active.
      subscription: {
        status: "pending_payment",
        planId: "pro",
        period: null,
        currentPeriodEnd: null,
        lastReference: null,
        processedRefs: [],
        updatedAt: new Date().toISOString()
      }
    };
    getAuth().users.push(user);
    saveAuth();
    // Provision the user's data dirs + store eagerly so the dashboard works immediately.
    const userStore = getUserStore(user.id);
    await userStore.load();
    const token = createSession(user.id);
    res.setHeader("Set-Cookie", sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)));
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
    res.setHeader("Set-Cookie", sessionCookieHeader(token, Math.floor(SESSION_TTL_MS / 1000)));
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
  res.json({ ok: true, user: req.user });
});
