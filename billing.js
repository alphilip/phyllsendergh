// Paystack billing: plan config, subscription state, enforcement gates.
//
// Renewal model: MANUAL per-period renewal. Paystack's automatic recurring
// charges only work for cards — mobile money (how most Ghanaian customers
// pay) cannot be auto-debited. So every period is a fresh one-off checkout
// (Paystack Inline popup); the charge.success webhook extends the period.
// Nothing auto-renews.

import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { Router } from "express";

import { PLAN, priceFor } from "./plans.js";
import { attachUser, findUserByEmail, findUserById } from "./auth.js";
import { disconnect } from "./whatsapp.js";

export function billingConfigured() {
  return !!(process.env.PAYSTACK_PUBLIC_KEY && process.env.PAYSTACK_SECRET_KEY);
}

function blankSubscription() {
  return {
    status: "pending_payment",
    planId: PLAN.id,
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
  return sub;
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
  if (now <= end + PLAN.graceDays * 86400000) return "past_due";
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
  sub.updatedAt = new Date().toISOString();
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

// Plan ceilings applied on top of the user's own settings. When billing is
// not configured (owner testing mode) the user's settings stand alone.
export function effectiveLimits(settings) {
  if (!billingConfigured()) {
    return { dailyCap: settings.dmDailyCap, hourlyCap: settings.dmHourlyCap };
  }
  return {
    dailyCap: Math.min(settings.dmDailyCap, PLAN.limits.dailyDmCap),
    hourlyCap: settings.dmHourlyCap > 0
      ? Math.min(settings.dmHourlyCap, PLAN.limits.hourlyDmCap)
      : PLAN.limits.hourlyDmCap
  };
}

// Gate for all /api/* routes (except /api/billing/*, handled separately).
// - billing unconfigured -> everything passes (owner testing mode)
// - pending_payment / suspended -> 402 with billingRequired flag
// - past_due -> passes through; dashboard shows a banner, scheduler skips
//   jobs, and send endpoints are blocked by requireSendAllowed.
export async function subscriptionGate(req, res, next) {
  try {
    if (!billingConfigured()) return next();
    if (!attachUser(req)) return next(); // route's requireUser will 401
    const user = findUserById(req.user.id);
    if (!user) return next();
    const status = await refreshSubscription(user);
    req.subStatus = status;
    if (status === "pending_payment") {
      return res.status(402).json({
        error: "Complete your payment to unlock the dashboard.",
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

// Explicit gate for linking a WhatsApp number (plan: 1 number per account).
export function assertCanLinkNumber(linkedCount) {
  if (billingConfigured() && linkedCount >= PLAN.limits.maxNumbers) {
    const err = new Error(
      "Your Pro plan includes 1 linked WhatsApp number. Disconnect the current number first to link a different one."
    );
    err.code = "NUMBER_LIMIT";
    throw err;
  }
}

/* =========================
   Billing API router
========================= */

export const billingRouter = Router();

// Public key + plan info for the checkout page. NEVER the secret key.
billingRouter.get("/api/billing/config", (req, res) => {
  const base = { id: PLAN.id, name: PLAN.name, prices: PLAN.prices, limits: PLAN.limits };
  if (!billingConfigured()) {
    return res.json({ configured: false, plan: base });
  }
  res.json({ configured: true, publicKey: process.env.PAYSTACK_PUBLIC_KEY, plan: base });
});

billingRouter.get("/api/billing/status", async (req, res, next) => {
  try {
    if (!attachUser(req)) return res.status(401).json({ error: "Not signed in." });
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    const status = billingConfigured() ? await refreshSubscription(user) : "active";
    const sub = getSubscription(user);
    const endMs = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).getTime() : NaN;
    const daysLeft = Number.isNaN(endMs) ? null : Math.ceil((endMs - Date.now()) / 86400000);
    res.json({
      ok: true,
      status,
      billingConfigured: billingConfigured(),
      planId: sub.planId,
      period: sub.period,
      currentPeriodEnd: sub.currentPeriodEnd,
      daysLeft,
      renewSoon: daysLeft !== null && daysLeft <= PLAN.renewWarningDays
    });
  } catch (error) {
    next(error);
  }
});

// Build a one-off checkout (Paystack Inline popup params).
billingRouter.post("/api/billing/checkout", (req, res, next) => {
  try {
    if (!billingConfigured()) {
      return res.status(503).json({ error: "Billing is not configured yet. Please try again later." });
    }
    if (!attachUser(req)) return res.status(401).json({ error: "Not signed in." });
    const user = findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Not signed in." });
    const period = req.body?.period === "yearly" ? "yearly" : "monthly";
    const price = priceFor(period);
    const reference = `pro-${period}-${user.id.slice(0, 8)}-${Date.now()}-${randomBytes(4).toString("hex")}`;
    res.json({
      ok: true,
      key: process.env.PAYSTACK_PUBLIC_KEY,
      email: user.email,
      amount: price.pesewas,
      currency: "GHS",
      reference,
      channels: ["card", "mobile_money", "bank_transfer"],
      metadata: { userId: user.id, email: user.email, period, planId: PLAN.id }
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
  const user = (meta.userId && findUserById(meta.userId)) ||
    findUserByEmail(String(meta.email || ""));
  if (!user) {
    console.error("[billing] charge.success for unknown user:", JSON.stringify({ reference: data.reference, meta }));
    return { activated: false, status: "unknown_user" };
  }
  const sub = getSubscription(user);
  if (sub.processedRefs.includes(data.reference)) {
    return { activated: false, status: effectiveStatus(user), duplicate: true };
  }
  const period = meta.period === "yearly" ? "yearly" : "monthly";
  const price = priceFor(period);
  // Never grant access for the wrong amount or currency.
  if (data.currency !== "GHS" || Number(data.amount) !== price.pesewas) {
    console.error("[billing] amount/currency mismatch:", JSON.stringify({
      reference: data.reference, got: `${data.amount} ${data.currency}`, expected: `${price.pesewas} GHS`
    }));
    return { activated: false, status: effectiveStatus(user), mismatch: true };
  }
  const now = Date.now();
  const currentEnd = new Date(sub.currentPeriodEnd).getTime();
  // Renewals extend from the current period end when still active.
  const base = sub.status === "active" && !Number.isNaN(currentEnd) && currentEnd > now ? currentEnd : now;
  sub.status = "active";
  sub.planId = PLAN.id;
  sub.period = period;
  sub.currentPeriodEnd = new Date(base + price.days * 86400000).toISOString();
  sub.lastReference = data.reference;
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
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("[billing] webhook error:", error.message);
    return res.status(200).json({ received: true });
  }
}
