// Single paid plan: Pro. Amounts are duplicated in GHS and pesewas
// (Paystack charges the lowest currency unit).
export const PLAN = {
  id: "pro",
  name: "Pro",
  prices: {
    monthly: { ghs: 4.99, pesewas: 499, days: 30, label: "GH₵4.99/month" },
    yearly: { ghs: 39.99, pesewas: 3999, days: 365, label: "GH₵39.99/year" }
  },
  limits: {
    maxNumbers: 1, // linked WhatsApp numbers per account
    maxContacts: 5000,
    dailyDmCap: 500, // hard ceiling; user setting is min(setting, 500)
    hourlyDmCap: 40, // hard ceiling; user setting is min(setting, 40)
    maxLists: 50
  },
  // Paystack Plan metadata for automatic card renewals (billing.js creates
  // the plans via API on first card checkout and caches the codes).
  paystack: {
    monthly: { name: "Pro Monthly", interval: "monthly" },
    yearly: { name: "Pro Yearly", interval: "annually" }
  },
  // Days after currentPeriodEnd during which the account is "past_due"
  // (banner + sends paused) before it becomes "suspended".
  graceDays: 3,
  // Show the Renew button when this many days (or fewer) remain.
  renewWarningDays: 7
};

export function priceFor(period) {
  return PLAN.prices[period] || null;
}
