// Tier registry + admin-editable plan settings.
//
// Three tiers. Pro keeps the exact prices and limits the single plan had
// (GH₵4.99/mo, GH₵39.99/yr; 1 number, 5,000 contacts, 500 DMs/day,
// 40/hour, 50 lists) so existing Pro subscribers map over unchanged.
// Starter sits below it, Business above it. Every tier allows exactly
// ONE linked WhatsApp number — multi-number accounts would need a
// connection-per-number refactor, so maxNumbers is never editable.
//
// Prices and limits are editable from the Admin tab and stored in
// DATA_DIR/plan-settings.json (survives redeploys via the /data volume).
// The values below are only the defaults used when no override exists.
// Tier NAMES are not editable: Paystack plan matching keys on them, and
// renaming a tier would orphan its Paystack plans and create duplicates.
//
// Grandfathering: when the admin changes a price, the OLD price is kept
// in previousPrices. The webhook still accepts old amounts (renewals
// charged under an old price keep working); only amounts matching
// neither a current nor a previous price are rejected.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const GRACE_DAYS = 3;
export const RENEW_WARNING_DAYS = 7;

export const TIER_ORDER = ["starter", "pro", "business"];

export const TIER_DEFAULTS = {
  starter: {
    id: "starter",
    name: "Starter",
    prices: {
      monthly: { ghs: 2.99, pesewas: 299, days: 30, label: "GH₵2.99/month" },
      yearly: { ghs: 23.99, pesewas: 2399, days: 365, label: "GH₵23.99/year" }
    },
    limits: {
      maxNumbers: 1,
      maxContacts: 1000,
      dailyDmCap: 100,
      hourlyDmCap: 20,
      maxLists: 10
    },
    paystack: {
      monthly: { name: "Starter Monthly", interval: "monthly" },
      yearly: { name: "Starter Yearly", interval: "annually" }
    }
  },
  pro: {
    id: "pro",
    name: "Pro",
    prices: {
      monthly: { ghs: 4.99, pesewas: 499, days: 30, label: "GH₵4.99/month" },
      yearly: { ghs: 39.99, pesewas: 3999, days: 365, label: "GH₵39.99/year" }
    },
    limits: {
      maxNumbers: 1,
      maxContacts: 5000,
      dailyDmCap: 500,
      hourlyDmCap: 40,
      maxLists: 50
    },
    paystack: {
      monthly: { name: "Pro Monthly", interval: "monthly" },
      yearly: { name: "Pro Yearly", interval: "annually" }
    }
  },
  business: {
    id: "business",
    name: "Business",
    prices: {
      monthly: { ghs: 9.99, pesewas: 999, days: 30, label: "GH₵9.99/month" },
      yearly: { ghs: 79.99, pesewas: 7999, days: 365, label: "GH₵79.99/year" }
    },
    limits: {
      maxNumbers: 1,
      maxContacts: 20000,
      dailyDmCap: 2000,
      hourlyDmCap: 100,
      maxLists: 200
    },
    paystack: {
      monthly: { name: "Business Monthly", interval: "monthly" },
      yearly: { name: "Business Yearly", interval: "annually" }
    }
  }
};

export function isKnownTier(tierId) {
  return Object.prototype.hasOwnProperty.call(TIER_DEFAULTS, tierId);
}

const SETTINGS_FILE = path.join(process.env.DATA_DIR || "/data", "plan-settings.json");

// In-memory effective settings. Defaults apply until loadPlanSettings()
// reads the file; every read path works off defaults alone, so a missing
// or corrupt file can never break pricing — it just means "no overrides".
let settingsCache = { tiers: {}, previousPrices: [] };

function sanitizeSettings(raw) {
  const out = { tiers: {}, previousPrices: [] };
  if (!raw || typeof raw !== "object") return out;
  if (raw.tiers && typeof raw.tiers === "object") {
    for (const id of TIER_ORDER) {
      const t = raw.tiers[id];
      if (!t || typeof t !== "object") continue;
      const entry = {};
      if (t.prices && typeof t.prices === "object") {
        const prices = {};
        for (const period of ["monthly", "yearly"]) {
          const p = t.prices[period];
          if (p && Number.isFinite(Number(p.ghs)) && Number(p.ghs) > 0) {
            prices[period] = { ghs: Number(p.ghs), pesewas: Math.round(Number(p.ghs) * 100) };
          }
        }
        if (Object.keys(prices).length) entry.prices = prices;
      }
      if (t.limits && typeof t.limits === "object") {
        const limits = {};
        for (const [key, max] of [
          ["maxContacts", 100000],
          ["dailyDmCap", 10000],
          ["hourlyDmCap", 1000],
          ["maxLists", 1000]
        ]) {
          const v = Math.round(Number(t.limits[key]));
          if (Number.isFinite(v) && v >= 0 && v <= max) limits[key] = v;
        }
        if (Object.keys(limits).length) entry.limits = limits;
      }
      if (Object.keys(entry).length) out.tiers[id] = entry;
    }
  }
  if (Array.isArray(raw.previousPrices)) {
    for (const e of raw.previousPrices) {
      if (
        e && isKnownTier(e.tierId) && (e.period === "monthly" || e.period === "yearly") &&
        Number.isFinite(Number(e.pesewas)) && Number(e.pesewas) > 0
      ) {
        out.previousPrices.push({
          tierId: e.tierId,
          period: e.period,
          pesewas: Math.round(Number(e.pesewas))
        });
      }
    }
  }
  return out;
}

export async function loadPlanSettings() {
  try {
    const raw = await readFile(SETTINGS_FILE, "utf8");
    settingsCache = sanitizeSettings(JSON.parse(raw));
  } catch {
    settingsCache = { tiers: {}, previousPrices: [] };
  }
  return settingsCache;
}

// Effective tier: defaults + stored overrides. Unknown ids fall back to Pro
// (the legacy tier), so a stale planId can never break limit checks.
export function getTier(tierId) {
  const base = TIER_DEFAULTS[tierId] || TIER_DEFAULTS.pro;
  const over = settingsCache.tiers[base.id] || {};
  const prices = {};
  for (const period of ["monthly", "yearly"]) {
    prices[period] = { ...base.prices[period], ...(over.prices?.[period] || {}) };
  }
  return {
    id: base.id,
    name: base.name,
    prices,
    limits: { ...base.limits, ...(over.limits || {}) },
    paystack: base.paystack
  };
}

export function getAllTiers() {
  return TIER_ORDER.map(getTier);
}

// Public shape for the API (no Paystack metadata, no internal fields).
export function publicTier(tier) {
  return {
    id: tier.id,
    name: tier.name,
    prices: {
      monthly: {
        ghs: tier.prices.monthly.ghs,
        pesewas: tier.prices.monthly.pesewas,
        days: tier.prices.monthly.days,
        label: `GH₵${tier.prices.monthly.ghs.toFixed(2)}/month`
      },
      yearly: {
        ghs: tier.prices.yearly.ghs,
        pesewas: tier.prices.yearly.pesewas,
        days: tier.prices.yearly.days,
        label: `GH₵${tier.prices.yearly.ghs.toFixed(2)}/year`
      }
    },
    limits: { ...tier.limits }
  };
}

export function publicTiers() {
  return getAllTiers().map(publicTier);
}

export function priceFor(tierId, period) {
  const tier = getTier(tierId);
  return tier.prices[period] || null;
}

export function limitsFor(tierId) {
  return getTier(tierId).limits;
}

// True when the amount equals the tier+period's CURRENT price or any of
// its grandfathered previous prices.
export function priceMatches(tierId, period, pesewas) {
  const price = priceFor(tierId, period);
  if (price && price.pesewas === Number(pesewas)) return true;
  return settingsCache.previousPrices.some(
    (e) => e.tierId === tierId && e.period === period && e.pesewas === Number(pesewas)
  );
}

// Amount -> { tierId, period } over current prices first, then
// grandfathered prices. Returns null for unrecognized amounts.
// NOTE: two tiers can share an amount after an admin edit; callers that
// know the user must prefer the user's own tier (see billing.js) and use
// this only as the last-resort fallback.
export function resolveAmount(pesewas) {
  const amt = Number(pesewas);
  for (const tier of getAllTiers()) {
    for (const period of ["monthly", "yearly"]) {
      if (tier.prices[period].pesewas === amt) return { tierId: tier.id, period };
    }
  }
  for (const prev of settingsCache.previousPrices) {
    if (prev.pesewas === amt) return { tierId: prev.tierId, period: prev.period };
  }
  return null;
}

function validateTierInput(id, value) {
  if (!value || typeof value !== "object") throw new Error(`Tier ${id} is missing.`);
  const prices = {};
  for (const period of ["monthly", "yearly"]) {
    const ghs = Number(value[`${period}Ghs`]);
    if (!Number.isFinite(ghs) || ghs <= 0 || ghs > 100000) {
      throw new Error(`${id} ${period} price must be a number above 0.`);
    }
    prices[period] = { ghs: Math.round(ghs * 100) / 100, pesewas: Math.round(ghs * 100) };
  }
  const limits = {};
  for (const [key, max] of [
    ["maxContacts", 100000],
    ["dailyDmCap", 10000],
    ["hourlyDmCap", 1000],
    ["maxLists", 1000]
  ]) {
    const v = Math.round(Number(value[key]));
    if (!Number.isFinite(v) || v < 0 || v > max) {
      throw new Error(`${id} ${key} must be a whole number between 0 and ${max}.`);
    }
    limits[key] = v;
  }
  return { prices, limits };
}

// Admin save: validates every tier, records each CHANGED price's old value
// as a grandfathered price, persists, and returns the changed
// (tier, period) pairs so billing can invalidate Paystack plan caches.
export async function savePlanSettings(input) {
  if (!input || typeof input !== "object" || !input.tiers || typeof input.tiers !== "object") {
    throw new Error("tiers object is required.");
  }
  const validated = {};
  for (const id of TIER_ORDER) {
    validated[id] = validateTierInput(id, input.tiers[id]);
  }
  const changed = [];
  const next = { tiers: {}, previousPrices: [...settingsCache.previousPrices] };
  const seenPrev = new Set(next.previousPrices.map((e) => `${e.tierId}:${e.period}:${e.pesewas}`));
  for (const id of TIER_ORDER) {
    const current = getTier(id);
    next.tiers[id] = validated[id];
    for (const period of ["monthly", "yearly"]) {
      if (current.prices[period].pesewas !== validated[id].prices[period].pesewas) {
        changed.push({ tierId: id, period });
        const key = `${id}:${period}:${current.prices[period].pesewas}`;
        if (!seenPrev.has(key)) {
          seenPrev.add(key);
          next.previousPrices.push({ tierId: id, period, pesewas: current.prices[period].pesewas });
        }
      }
    }
  }
  await mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmp = SETTINGS_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, SETTINGS_FILE);
  settingsCache = next;
  return { tiers: publicTiers(), changed };
}
