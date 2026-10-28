// Paystack billing: tier config, subscription state, enforcement gates.
//
// Renewal model: MANUAL per-period renewal. Paystack's automatic recurring
// charges only work for cards — mobile money (how most Ghanaian customers
// pay) cannot be auto-debited. So every period is a fresh one-off checkout
// (Paystack Inline popup); the charge.success webhook extends the period.
// Nothing auto-renews.
//
// Tiers: Starter / Pro / Business (plans.js). A checkout always names its
// tier; the webhook resolves the tier from metadata first, then from the
// paying user's stored tier + amount, then from the amount alone over
// current + grandfathered prices — so a price change never breaks an
// existing subscriber's renewal.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { Router } from "express";

import {
  GRACE_DAYS,
  RENEW_WARNING_DAYS,
  getTier,
  isKnownTier,
  limitsFor,
  priceFor,
  priceMatches,
  publicTiers,
  resolveAmount
} from "./plans.js";
import { attachUser, findUserByEmail, findUserById, getAllUsers, isAdminUser } from "./auth.js";
import { disconnect } from "./whatsapp.js";

export function billingConfigured() {
  return !!(process.env.PAYSTACK_PUBLIC_KEY && process.env.PAYSTACK_SECRET_KEY);
}

// ---- Paystack Plans (automatic card renewals) ----

import {
  mkdir as _mkdirPlans,
  readFile as _readPlans,
  rename as _renamePlans,
  writeFile as _writePlans
} from "node:fs/promises";
import _pathPlans from "node:path";

const PLANS_CACHE_FILE = _pathPlans.join(process.env.DATA_DIR || "/data", "paystack-plans.json");
let paystackPlansCache = null;

async function readPlansCache() {
  if (paystackPlansCache) return paystackPlansCache;
  try {
    const raw = await _readPlans(PLANS_CACHE_FILE, "utf8");
    paystackPlansCache = JSON.parse(raw);
  } catch {
    paystackPlansCache = {};
  }
  return paystackPlansCache;
}

async function writePlansCache(codes) {
  paystackPlansCache = codes;
  try {
    await _mkdirPlans(_pathPlans.dirname(PLANS_CACHE_FILE), { recursive: true });
    const tmp = PLANS_CACHE_FILE + ".tmp";
    await _writePlans(tmp, JSON.stringify(codes, null, 2), "utf8");
    await _renamePlans(tmp, PLANS_CACHE_FILE);
  } catch (error) {
    console.error("[billing] could not persist Paystack plan codes:", error.message);
  }
}

// Drop a cached Paystack plan code (called when the admin changes that
// tier+period's price, so the next checkout finds or creates the plan
// for the NEW amount instead of reusing the old-price plan).
export async function invalidatePaystackPlan(tierId, period) {
  const cached = await readPlansCache();
  if (cached[`${tierId}:${period}`]) {
    delete cached[`${tierId}:${period}`];
    await writePlansCache(cached);
  }
}

function paystackHeaders() {
  return {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
    "Content-Type": "application/json"
  };
}

// Find or create the Paystack Plan for a tier+period. Returns the plan
// code or null — callers MUST fall back to the manual one-off flow on
// null. Cache keys are tier:period (an old period-only cache file is
// simply ignored — the list-and-match below re-finds the right plan).
export async function ensurePaystackPlan(tierId, period) {
  if (!billingConfigured()) return null;
  const tier = getTier(tierId);
  const price = priceFor(tier.id, period);
  if (!price) return null;
  const meta = tier.paystack[period];
  const cacheKey = `${tier.id}:${period}`;
  try {
    const cached = await readPlansCache();
    if (cached[cacheKey]) return cached[cacheKey];
    // Look for an existing matching plan first (never create duplicates).
    const listResp = await fetch("https://api.paystack.co/plan?perPage=100", { headers: paystackHeaders() });
    const listBody = await listResp.json().catch(() => ({}));
    if (listResp.ok && Array.isArray(listBody.data)) {
      const found = listBody.data.find(
        (p) => p.name === meta.name && Number(p.amount) === price.pesewas && p.interval === meta.interval && p.currency === "GHS"
      );
      if (found && found.plan_code) {
        cached[cacheKey] = found.plan_code;
        await writePlansCache(cached);
        return found.plan_code;
      }
    }
    const createResp = await fetch("https://api.paystack.co/plan", {
      method: "POST",
      headers: paystackHeaders(),
      body: JSON.stringify({
        name: meta.name,
        amount: price.pesewas,
        interval: meta.interval,
        currency: "GHS",
        description: `WhatsApp Marketing SaaS — ${tier.name} ${period}`
      })
    });
    const createBody = await createResp.json().catch(() => ({}));
    if (createResp.ok && createBody.data && createBody.data.plan_code) {
      cached[cacheKey] = createBody.data.plan_code;
      await writePlansCache(cached);
      console.log(`[billing] Paystack plan ready: ${meta.name} (${createBody.data.plan_code})`);
      return createBody.data.plan_code;
    }
    console.error("[billing] Paystack plan create failed:", createBody.message || createResp.status);
    return null;
  } catch (error) {
    console.error("[billing] ensurePaystackPlan failed:", error.message);
    return null;
  }
}

// Server-side transaction initialize WITH a plan code. Card payments on this
// transaction auto-create a Paystack subscription (auto-renewal). Returns
// { accessCode, reference } or null on any failure (caller falls back).
export async function initializeCardTransaction({ email, period, userId, tierId }) {
  const tier = getTier(tierId);
  const planCode = await ensurePaystackPlan(tier.id, period);
  if (!planCode) return null;
  const price = priceFor(tier.id, period);
  const reference = `${tier.id}-${period}-${String(userId).slice(0, 8)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    const resp = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: paystackHeaders(),
      body: JSON.stringify({
        email,
        amount: price.pesewas,
        currency: "GHS",
        reference,
        plan: planCode,
        channels: ["card"],
        metadata: { userId, email, period, planId: tier.id, autoRenew: true }
      })
    });
    const body = await resp.json().catch(() => ({}));
    if (resp.ok && body.data && body.data.access_code) {
      return { accessCode: body.data.access_code, reference };
    }
    console.error("[billing] transaction initialize failed:", body.message || resp.status);
    return null;
  } catch (error) {
    console.error("[billing] transaction initialize failed:", error.message);
    return null;
  }
}

function blankSubscription() {
  return {
    status: "pending_payment",
    planId: null,
    period: null,
    currentPeriodEnd: null,
    lastReference: null,
    processedRefs: [],
    updatedAt: new Date().toISOString()
  };
}

export function getSubscription(user) {
  if (!user.subscription || typeof user.subscription !== "object") {
    user.subscription = blankSubscription();
  }
  const sub = user.subscription;
  if (!Array.isArray(sub.processedRefs)) sub.processedRefs = [];
  if (!Array.isArray(sub.history)) sub.history = [];
  return sub;
}

// Append-only subscription timeline for the admin per-user detail view.
// Events: "activated:monthly", "renewed:yearly", "suspended:…", "unsuspended",
// "extended:15d". Capped at 50 entries.
export function addSubHistory(user, event) {
  const sub = getSubscription(user);
  sub.history.push({ ts: new Date().toISOString(), event: String(event) });
  if (sub.history.length > 50) sub.history = sub.history.slice(-50);
  sub.updatedAt = new Date().toISOString();
}

// Pure computation — no side effects. Returns one of:
// pending_payment | active | past_due | suspended
export function effectiveStatus(user) {
  const sub = getSubscription(user);
  if (sub.status === "pending_payment") return "pending_payment";
  if (sub.status === "suspended") return "suspended";
  // "active" or "past_due": always recompute from the period end date, so a
  // stored past_due can still age into suspended (or be renewed to active).
  const end = new Date(sub.currentPeriodEnd).getTime();
  if (Number.isNaN(end)) return "active";
  const now = Date.now();
  if (now <= end) return "active";
  if (now <= end + GRACE_DAYS * 86400000) return "past_due";
  return "suspended";
}

// The auth module owns the users.json write path; server.js registers it.
let persistAuth = () => {};
export function setAuthPersister(fn) {
  if (typeof fn === "function") persistAuth = fn;
}

// Single source of truth for suspending an account: flip the status,
// persist, and disconnect WhatsApp without restarting it. Used by the
// time-based refresh below AND by the owner admin panel (manual suspend).
export async function suspendUserAccount(user, reason) {
  const sub = getSubscription(user);
  sub.status = "suspended";
  addSubHistory(user, `suspended:${reason || "expired"}`);
  persistAuth();
  try {
    await disconnect(user.id, { restart: false });
  } catch (error) {
    console.error(`[billing] failed to disconnect WhatsApp for suspended user ${user.id}:`, error.message);
  }
  console.log(`[billing] suspended ${user.email} (${user.id})${reason ? " — " + reason : ""}`);
}

// Advance time-based transitions, persist them, and disconnect WhatsApp the
// moment an account becomes suspended. Returns the effective status.
export async function refreshSubscription(user) {
  const sub = getSubscription(user);
  const before = sub.status;
  const now = effectiveStatus(user);
  if (now !== before) {
    if (now === "suspended") {
      await suspendUserAccount(user, "subscription expired past grace period");
    } else {
      sub.status = now;
      sub.updatedAt = new Date().toISOString();
      persistAuth();
    }
  }
  return now;
}

// A user's effective tier: admins work at Business limits (they use the
// platform too, without paying); a stored tier id wins; anything else
// (pending users, legacy rows) falls back to Pro for limit purposes.
export function tierIdForUser(user) {
  if (user && isAdminUser(user)) return "business";
  const pid = user && user.subscription && user.subscription.planId;
  return pid && isKnownTier(pid) ? pid : "pro";
}

export function tierForUser(user) {
  return getTier(tierIdForUser(user));
}

export function limitsForUser(user) {
  return limitsFor(tierIdForUser(user));
}

// Plan ceilings applied on top of the user's own settings. When billing is
// not configured (owner testing mode) the user's settings stand alone.
export function effectiveLimits(settings, tierId = "pro") {
  const limits = limitsFor(tierId);
  if (!billingConfigured()) {
    return { dailyCap: settings.dmDailyCap, hourlyCap: settings.dmHourlyCap };
  }
  return {
    dailyCap: Math.min(settings.dmDailyCap, limits.dailyDmCap),
    hourlyCap: settings.dmHourlyCap > 0
      ? Math.min(settings.dmHourlyCap, limits.hourlyDmCap)
      : limits.hourlyDmCap
  };
}

// Scheduler convenience: resolve the tier from the user id.
export function effectiveLimitsForUserId(userId, settings) {
  return effectiveLimits(settings, tierIdForUser(findUserById(userId) || null));
}

// Gate for all /api/* routes (except /api/billing/*, handled separately).
// - billing unconfigured -> everything passes (owner testing mode)
// - pending_payment -> 402 with billingRequired flag, EXCEPT the free
//   WhatsApp-setup routes (GET /status, POST /link, POST /disconnect):
//   connecting WhatsApp is setup, not a plan feature. Users sign up,
//   log in, link their number via QR, and only pay when they want to
//   use a feature.
// - suspended -> 402 with billingRequired flag (full block, no free routes)
// - past_due -> passes through; dashboard shows a banner, scheduler skips
//   jobs, and send endpoints are blocked by requireSendAllowed.
export async function subscriptionGate(req, res, next) {
  try {
    if (!billingConfigured()) return next();
    if (!attachUser(req)) return next(); // route's requireUser will 401
    const user = findUserById(req.user.id);
    if (!user) return next();
    // Admins use the platform too and are never paywalled.
    if (isAdminUser(user)) return next();
    const status = await refreshSubscription(user);
    req.subStatus = status;
    if (status === "pending_payment") {
      // Exact method+path matches only, so POST /status (create a status
      // post) and POST /status/:id/toggle stay blocked.
      const freeSetup =
        (req.method === "GET" && req.path === "/status") ||
        (req.method === "POST" && req.path === "/link") ||
        (req.method === "POST" && req.path === "/disconnect");
      if (freeSetup) return next();
      return res.status(402).json({
        error: "Upgrade to Pro to use this feature.",
        subscriptionStatus: status,
        billingRequired: true
      });
    }
    if (status === "suspended") {
      return res.status(402).json({
        error: "Your account is suspended. Renew your subscription to reactivate it.",
        subscriptionStatus: status,
        billingRequired: true
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

// Returns null when sending is allowed, otherwise { status, error }.
export function sendBlockedReason(req) {
  if (!billingConfigured()) return null;
  const user = req.user && findUserById(req.user.id);
  if (user && isAdminUser(user)) return null;
  const status = user ? effectiveStatus(user) : "pending_payment";
  if (status === "active") return null;
  return {
    subscriptionStatus: status,
    error:
      status === "past_due"
        ? "Sending is paused while your subscription is past due. Renew to resume."
        : "Complete your payment before sending messages."
  };
}

// Blocks send-triggering endpoints while past due / suspended / unpaid.
export function requireSendAllowed(req, res, next) {
  const blocked = sendBlockedReason(req);
  if (!blocked) return next();
  return res.status(402).json({ ...blocked, billingRequired: true });
}

// Explicit gate for linking a WhatsApp number (every tier: 1 number).
export function assertCanLinkNumber(linkedCount, tierId = "pro") {
  const tier = getTier(tierId);
  if (billingConfigured() && linkedCount >= tier.limits.maxNumbers) {
    const err = new Error(
      `Your ${tier.name} plan includes ${tier.limits.maxNumbers} linked WhatsApp number. Disconnect the current number first to link a different one.`
    );
    err.code = "NUMBER_LIMIT";
    throw err;
  }
}

/* =========================
   Billing API router
========================= */

export const billingRouter = Router();

// Public key + tier list for the checkout pages. NEVER the secret key.
billingRouter.get("/api/billing/config", (req, res) => {
  if (!billingConfigured()) {
    return res.json({ configured: false, tiers: publicTiers() });
  }
  res.json({ configured: true, publicKey: process.env.PAYSTACK_PUBLIC_KEY, tiers: publicTiers() });
});

billingRouter.get("/api/billing/status", async (req, res, next) => {
  try {
    if (!attachUser(req)) return res.status(401).json({ error: "Not signed in." });
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    // Admins: full access at Business tier, no renewal pressure.
    if (isAdminUser(user)) {
      return res.json({
        ok: true,
        status: "active",
        billingConfigured: billingConfigured(),
        planId: "business",
        tierId: "business",
        tierName: "Business",
        period: null,
        currentPeriodEnd: null,
        daysLeft: null,
        renewSoon: false,
        isAdmin: true
      });
    }
    const status = billingConfigured() ? await refreshSubscription(user) : "active";
    const sub = getSubscription(user);
    const endMs = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : NaN;
    const daysLeft = Number.isNaN(endMs) ? null : Math.ceil((endMs - Date.now()) / 86400000);
    const tier = getTier(sub.planId);
    res.json({
      ok: true,
      status,
      billingConfigured: billingConfigured(),
      planId: sub.planId,
      tierId: sub.planId && isKnownTier(sub.planId) ? sub.planId : null,
      tierName: sub.planId && isKnownTier(sub.planId) ? tier.name : null,
      period: sub.period,
      currentPeriodEnd: sub.currentPeriodEnd,
      daysLeft,
      renewSoon: daysLeft !== null && daysLeft <= RENEW_WARNING_DAYS
    });
  } catch (error) {
    next(error);
  }
});

// Build a checkout. method "card" tries the automatic-renewal flow (server
// initializes the transaction WITH the Paystack plan code, frontend opens it
// with resumeTransaction); anything else (momo/bank) uses the manual one-off
// popup params. Any failure in the plan flow falls back to manual — checkout
// never breaks.
billingRouter.post("/api/billing/checkout", async (req, res, next) => {
  try {
    if (!billingConfigured()) {
      return res.status(503).json({ error: "Billing is not configured yet. Please try again later." });
    }
    if (!attachUser(req)) return res.status(401).json({ error: "Not signed in." });
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    const period = req.body?.period === "yearly" ? "yearly" : "monthly";
    const tierId = isKnownTier(req.body?.tierId) ? req.body.tierId : "pro";
    const tier = getTier(tierId);
    const method = req.body?.method === "card" ? "card" : "momo";
    const price = priceFor(tier.id, period);

    if (method === "card") {
      const init = await initializeCardTransaction({ email: user.email, period, userId: user.id, tierId: tier.id });
      if (init) {
        return res.json({
          ok: true,
          flow: "plan",
          accessCode: init.accessCode,
          reference: init.reference,
          email: user.email,
          amount: price.pesewas,
          currency: "GHS",
          autoRenew: true,
          metadata: { userId: user.id, email: user.email, period, planId: tier.id, autoRenew: true }
        });
      }
      // Fall through to the manual flow below.
      console.log("[billing] card plan flow unavailable, falling back to manual checkout");
    }

    const reference = `${tier.id}-${period}-${user.id.slice(0, 8)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    res.json({
      ok: true,
      flow: "manual",
      key: process.env.PAYSTACK_PUBLIC_KEY,
      email: user.email,
      amount: price.pesewas,
      currency: "GHS",
      reference,
      channels: ["card", "mobile_money", "bank_transfer"],
      metadata: { userId: user.id, email: user.email, period, planId: tier.id }
    });
  } catch (error) {
    next(error);
  }
});

// Fallback for when the webhook is delayed: verify a reference directly
// with Paystack and activate if it succeeded. Uses the SECRET key server-side.
billingRouter.post("/api/billing/verify", async (req, res, next) => {
  try {
    if (!billingConfigured()) {
      return res.status(503).json({ error: "Billing is not configured yet." });
    }
    if (!attachUser(req)) return res.status(401).json({ error: "Not signed in." });
    const reference = String(req.body?.reference || "").trim();
    if (!reference) return res.status(400).json({ error: "Payment reference is required." });
    const verified = await verifyPaystackTransaction(reference);
    if (!verified.ok) return res.status(400).json({ error: verified.error });
    const result = await applySuccessfulCharge(verified.data);
    res.json({ ok: true, activated: result.activated, status: result.status });
  } catch (error) {
    next(error);
  }
});

async function verifyPaystackTransaction(reference) {
  try {
    const resp = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || body.status !== true) {
      return { ok: false, error: "Could not verify this payment with Paystack yet. The webhook may still be on its way — try again in a minute." };
    }
    return { ok: true, data: body.data };
  } catch (error) {
    return { ok: false, error: "Verification request failed: " + error.message };
  }
}

// Shared by the webhook and the manual verify endpoint.
export async function applySuccessfulCharge(data) {
  const meta = data.metadata || {};
  const cust = data.customer || {};
  // First payment: matched by our own metadata. Subscription renewals carry
  // no metadata of ours — match by stored Paystack customer code, then email.
  let user = (meta.userId && findUserById(meta.userId)) ||
    findUserByEmail(String(meta.email || ""));
  if (!user && cust.customer_code) {
    user = getAllUsers().find((u) => getSubscription(u).paystackCustomerCode === cust.customer_code) || null;
  }
  if (!user && cust.email) {
    user = findUserByEmail(String(cust.email || ""));
  }
  if (!user) {
    console.error("[billing] charge.success for unknown user:", JSON.stringify({ reference: data.reference, meta }));
    return { activated: false, status: "unknown_user" };
  }
  const sub = getSubscription(user);
  if (sub.processedRefs.includes(data.reference)) {
    return { activated: false, status: effectiveStatus(user), duplicate: true };
  }
  // Tier + period, in order of reliability:
  // 1. Explicit metadata on first payments (checkout always sends tierId).
  // 2. The paying user's stored tier + amount (renewal charges carry no
  //    metadata, and two tiers can share an amount after an admin edit —
  //    the user's own tier disambiguates).
  // 3. Amount alone over current + grandfathered prices (last resort).
  let tierId = isKnownTier(meta.planId) ? meta.planId : null;
  let period = meta.period === "yearly" ? "yearly" : meta.period === "monthly" ? "monthly" : null;
  if (!tierId || !period) {
    const userTier = sub.planId && isKnownTier(sub.planId) ? sub.planId : null;
    const candidates = [];
    if (tierId) candidates.push(tierId); // metadata tier, period unknown
    if (userTier && !candidates.includes(userTier)) candidates.push(userTier);
    for (const cand of candidates) {
      if (period && priceMatches(cand, period, data.amount)) {
        tierId = cand;
        break;
      }
      if (!period) {
        for (const per of ["monthly", "yearly"]) {
          if (priceMatches(cand, per, data.amount)) {
            tierId = cand;
            period = per;
            break;
          }
        }
        if (period) break;
      }
    }
  }
  if (!tierId || !period) {
    const resolved = resolveAmount(data.amount);
    if (resolved) {
      tierId = resolved.tierId;
      period = resolved.period;
    }
  }
  if (!tierId || !period) {
    console.error("[billing] charge.success with unrecognized amount:", JSON.stringify({
      reference: data.reference, amount: data.amount, currency: data.currency
    }));
    return { activated: false, status: effectiveStatus(user), mismatch: true };
  }
  const price = priceFor(tierId, period);
  // Never grant access for the wrong amount or currency. priceMatches
  // accepts grandfathered amounts, so old-price renewals still pass.
  if (data.currency !== "GHS" || !priceMatches(tierId, period, data.amount)) {
    console.error("[billing] amount/currency mismatch:", JSON.stringify({
      reference: data.reference, got: `${data.amount} ${data.currency}`, expected: `${price.pesewas} GHS`
    }));
    return { activated: false, status: effectiveStatus(user), mismatch: true };
  }
  const now = Date.now();
  const currentEnd = new Date(sub.currentPeriodEnd).getTime();
  // Renewals extend from the current period end when still active.
  const wasActive = sub.status === "active" && !Number.isNaN(currentEnd) && currentEnd > now;
  const base = wasActive ? currentEnd : now;
  sub.status = "active";
  sub.planId = tierId;
  sub.period = period;
  sub.currentPeriodEnd = new Date(base + price.days * 86400000).toISOString();
  sub.lastReference = data.reference;
  // Remember the Paystack customer so subscription renewals (which carry no
  // metadata of ours) can be matched to this account later.
  const custCode = data.customer && data.customer.customer_code;
  if (custCode) sub.paystackCustomerCode = custCode;
  const paystackSub = data.subscription && data.subscription.subscription_code;
  if (paystackSub) sub.paystackSubCode = paystackSub;
  addSubHistory(user, `${wasActive ? "renewed" : "activated"}:${period}`);
  sub.processedRefs.push(data.reference);
  if (sub.processedRefs.length > 50) sub.processedRefs = sub.processedRefs.slice(-50);
  sub.updatedAt = new Date().toISOString();
  persistAuth();
  console.log(`[billing] activated ${period} for ${user.email} until ${sub.currentPeriodEnd} (ref ${data.reference})`);
  return { activated: true, status: "active" };
}

// Raw-body webhook handler. MUST be mounted with express.raw() BEFORE the
// JSON body parser, otherwise the signature can never verify.
export function paystackWebhookHandler(req, res) {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) return res.status(503).json({ error: "Billing is not configured." });
  try {
    const signature = req.headers["x-paystack-signature"];
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    const expected = createHmac("sha512", secret).update(raw).digest("hex");
    const a = Buffer.from(String(signature || ""), "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return res.status(401).json({ error: "Invalid signature." });
    }
    const event = JSON.parse(raw.toString("utf8"));
    if (event.event === "charge.success" && event.data && event.data.status === "success") {
      // Activate asynchronously; always ack fast so Paystack doesn't retry.
      applySuccessfulCharge(event.data).catch((error) =>
        console.error("[billing] webhook activation failed:", error.message)
      );
    } else if (event.event === "subscription.create" && event.data) {
      // Card auto-renewal subscription created. Store the code so we can
      // correlate future renewal charges even without metadata.
      try {
        const d = event.data;
        const code = d.subscription_code;
        const custCode = d.customer && d.customer.customer_code;
        const email = d.customer && d.customer.email;
        const user = (custCode && getAllUsers().find((u) => getSubscription(u).paystackCustomerCode === custCode)) ||
          (email && findUserByEmail(String(email))) || null;
        if (user && code) {
          const sub = getSubscription(user);
          sub.paystackSubCode = code;
          if (custCode) sub.paystackCustomerCode = custCode;
          persistAuth();
          console.log(`[billing] subscription ${code} linked to ${user.email}`);
        }
      } catch (error) {
        console.error("[billing] subscription.create handling failed:", error.message);
      }
    } else if (event.event === "subscription.disable" && event.data) {
      // A disabled subscription stops renewing; the date-based
      // effectiveStatus() ages the account into past_due -> suspended
      // naturally. Just log it for the audit trail.
      const code = event.data.subscription_code;
      console.log(`[billing] subscription disabled by Paystack: ${code || "(unknown)"}`);
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("[billing] webhook error:", error.message);
    return res.status(200).json({ received: true });
  }
}
