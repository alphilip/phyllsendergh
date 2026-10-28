# WhatsApp Marketing SaaS — Phase 1 build notes

Multi-tenant core of the SaaS. New app in `app/`; the single-user bot at
`~/workspace/phyllhost-whatsapp-marketing/` was copied once and never touched again.

## Files changed / added

- **`store.js`** — rewritten. The module singleton became a `UserStore` class.
  `getUserStore(userId)` returns a cached instance per user backed by
  `<DATA_DIR>/<userId>/marketing.json` (same store shape as v1.9), with
  `<userId>/uploads` and `<userId>/whatsapp-session` dirs. Pure helpers
  (`identifierFor`, `newId`, `utcDateString`, `tzParts`, `isQuietNow`) are still
  plain module exports. `readUpload` now refuses paths escaping the user's own
  data dir (path-traversal guard — new for multi-tenant).
- **`auth.js`** — new. Email + password signup/login/logout. Passwords hashed
  with bcryptjs (cost 10). Sessions are random 256-bit tokens stored in
  `<DATA_DIR>/users.json`, delivered as an HMAC-SHA256-signed HttpOnly cookie
  (`SESSION_SECRET` env; the server refuses to boot without it). 30-day expiry.
  `requireUser` (401 JSON for `/api/*`) and `requireUserPage` (redirect to
  `/login.html` for pages) both attach `req.user` + `req.userStore` and lazily
  load the user's store. Signup requires the ToS checkbox (`tosAcceptedAt`
  stored). Login never reveals whether an email exists. Light in-memory
  rate-limit on the auth endpoints (30 attempts / 15 min / IP).
- **`whatsapp.js`** — rewritten. Module-level socket became a `UserConnection`
  class; `getConn(userId)` keeps one per user in a `Map`. Every export now takes
  `userId` first (`deliverToContact(userId, …)`, `isConnected(userId)`, …).
  Each connection has its own Baileys socket, auth state dir, QR, chat cache,
  contact-name cache, and event handlers — incoming DMs, STOP handling,
  auto-replies, welcome rules and missed-call text-backs all load **that
  user's** store via `getUserStore(userId)`. Reconnect uses backoff; `disconnect`
  wipes only that user's session. `getStatus(userId)` lazy-starts the socket on
  first dashboard visit (skipped when `SKIP_WHATSAPP=1`).
- **`scheduler.js`** — rewritten. The minute tick lists users from `users.json`
  and runs `processUser(userId)` per user **without awaiting**, so a slow sender
  can never stall another user's campaigns. Busy flags and the missed-schedule
  set are keyed per user. All sends use the user's own settings (quiet hours,
  delays, daily/hourly caps, cooldowns) and their own store/logs. One user's
  exception is caught and logged; others continue.
- **`server.js`** — `ADMIN_TOKEN` / `x-admin-token` removed entirely. All 51
  `requireAdmin` usages became `requireUser`; every store call now goes through
  `req.userStore` (mechanical rename, verified no leftovers). Image uploads save
  to the user's own `uploads/` dir. `/` and `/index.html` require login and
  redirect to `/login.html`; `/login.html` and `/signup.html` are public.
  Boot: `loadAuthStore()` (fails fast without `SESSION_SECRET`), then starts one
  WhatsApp connection per registered user, then the scheduler.
- **`public/`** — new `login.html`, `signup.html` (match `styles.css`). `app.js`:
  token header logic removed, cookies are same-origin so nothing is sent
  explicitly; any 401 redirects to `/login.html`. `index.html`: token box
  replaced with signed-in email + Log out button.
- **`package.json`** — added `bcryptjs`; **`Dockerfile`** — documents the
  required `SESSION_SECRET` env var and the `/data` volume layout.

## How auth sessions work

`POST /api/auth/signup|login` → bcrypt verify → `createSession()` stores
`{token, userId, expiresAt}` in `users.json` → `Set-Cookie:
wa_saas_session=<token>.<hmac>` (HttpOnly, SameSite=Lax, Secure in production).
Every request re-verifies the HMAC with `timingSafeEqual`, looks up the session,
checks expiry, and attaches the user. Logout destroys the server-side session
and clears the cookie. Stealing the DB alone is useless without `SESSION_SECRET`.

## How per-user WhatsApp isolation works

`Map<userId, UserConnection>` — separate socket, separate
`<DATA_DIR>/<userId>/whatsapp-session` auth files, separate QR/status, separate
chat caches. Event handlers are closures over the connection, so an incoming
message on user A's number can only ever read/write user A's
`marketing.json`. Scheduler and dashboard resolve everything from
`req.user.id` / the tick's user id; there is no global store anymore.

## Test results (all against `SKIP_WHATSAPP=1`, `DATA_DIR=./testdata`)

- `node --check` on all 7 JS files (incl. `public/app.js`): pass.
- Boot with `SESSION_SECRET` set: clean, scheduler tick runs with no errors
  (multiple ticks, 2 users).
- Boot **without** `SESSION_SECRET`: throws immediately, refuses to start.
- `GET /` without cookie → 302 to `/login.html`; `/api/auth/me` → 401 JSON.
- Signup A → 200 + session cookie; `/api/auth/me` → A; A imports 1 contact;
  A dry-run campaign → 1 recipient; A sets hourly cap 40 + cooldown 20.
- Signup B → B's contacts = 0, B's settings = defaults (A's data invisible).
- Duplicate signup → 400; wrong password → 401; missing ToS → 400;
  tampered cookie → 401.
- Logout A → subsequent API calls 401.
- Kill + reboot: on-disk data intact (contacts, settings), old sessions still
  valid, and the store-lazy-load fix verified (first reboot exposed
  "Store not loaded yet", fixed in `requireUser`/`requireUserPage`).
- `GET /api/{lists,autoreplies,schedules,followups,welcome,callreply,logs}`,
  campaign dry-run, spin preview: all 200 as the logged-in user.

## Simplified / left out (Phase 1 scope)

- No billing/Paystack, no plans/limits enforcement, no owner admin panel —
  Phase 2/3 as per `SAAS-PLAN.md`.
- No per-user WhatsApp **suspension** yet (comes with the admin panel).
- Scheduler tick loads the user list from `users.json` each minute (cheap at
  this scale; fine until hundreds of users).
- `users.json` has no password-reset flow yet (Phase 2 or later).

## Run it

```
cd app && npm install
SKIP_WHATSAPP=1 DATA_DIR=./testdata SESSION_SECRET=<long-random> PORT=3210 node server.js
```

Production (Coolify): new app from this repo, persistent volume at `/data`,
env `SESSION_SECRET` (required), `PORT=3000`. No `ADMIN_TOKEN`.

---

# Phase 2 — plans + Paystack billing + subscription enforcement

Built Oct 10 2026 on top of the Phase 1 app. No changes to the Phase 1
feature set; billing wraps around it.

## The plan

Single paid plan, decided by the owner — **`plans.js`**:
- **Pro — GH₵4.99/month or GH₵39.99/year** (499 / 3999 pesewas; 30 / 365 days).
- No free plan, no trial. Signup creates the account as `pending_payment`.
- Limits: 1 linked WhatsApp number, 5,000 contacts, 500 DMs/day,
  40 DMs/hour, 50 contact lists. 3-day grace period after expiry,
  Renew button shown within 7 days of expiry.

## Design decisions

- **Renewal is MANUAL, not auto-recurring.** Paystack's automatic recurring
  charges only work for cards — mobile money (how most Ghanaian customers
  pay) cannot be auto-debited. So every period is a fresh one-off checkout
  via the Paystack Inline popup; the `charge.success` webhook extends
  `currentPeriodEnd` (extending from the existing end date when still active,
  so early renewals never lose days). Nothing auto-renews; the dashboard
  nags with a Renew button instead.
- **The webhook is the source of truth.** The browser popup callback only
  starts polling — access is granted when the signature-verified webhook
  (or the manual `/api/billing/verify` fallback, which checks the reference
  against Paystack's API with the secret key) confirms `charge.success`.
  Amount + currency are re-checked server-side before activation; mismatches
  are logged and ignored. Processed references are remembered for idempotency.
- **Raw body for the webhook.** `POST /api/billing/webhook` is mounted with
  `express.raw()` *before* `express.json()` — otherwise the HMAC-SHA512
  signature could never verify.
- **Fail-soft without keys.** Unlike `SESSION_SECRET` (fail-fast), missing
  Paystack keys don't stop the boot: the gate is bypassed, plan ceilings
  don't apply, and billing endpoints return clear "not configured" errors.
  The signup page explains payments aren't set up yet. This is the owner's
  testing mode.
- **Keys never touch the repo.** `PAYSTACK_PUBLIC_KEY` / `PAYSTACK_SECRET_KEY`
  are read from env only. The public key reaches the browser via
  `GET /api/billing/config`; the secret never leaves the server.

## Subscription states & enforcement

Stored on the user record (`users.json`): `status`, `planId`, `period`,
`currentPeriodEnd`, `lastReference`, `processedRefs[]`, `updatedAt`.
Effective status is always recomputed from the dates:

- `pending_payment` — can log in and see the dashboard; **connecting
  WhatsApp is free setup**: `GET /api/status`, `POST /api/link`, and
  `POST /api/disconnect` pass the gate. Every other `/api/*` (except
  `/api/billing/*` and `/api/auth/me`) returns **402** with
  `billingRequired: true`; the paywall overlay appears when a paid
  feature is used, with a dismiss button back to the dashboard.
- `active` — everything works.
- `past_due` (expired, within 3-day grace) — dashboard shows a banner and a
  Renew button; **scheduler skips all their jobs**; send endpoints
  (campaigns, schedules, follow-ups resume, test-send, polls, status posts)
  return 402; reads still work.
- `suspended` (past grace) — WhatsApp is **disconnected automatically**;
  every API returns 402 "account suspended — renew to reactivate".

Enforcement points: `subscriptionGate` (Express middleware on `/api/*`),
`requireSendAllowed` / `sendBlockedReason` (send routes), settings API
rejects caps above plan max, contact import rejects beyond 5,000 total,
`POST /api/link` rejects a second linked number with 409 ("disconnect the
current number first" — the one-socket-per-user architecture makes a second
simultaneous number impossible anyway), scheduler `processUser` skips
non-active users, and `runOutboundJob` applies
`min(user setting, plan ceiling)` as a backstop.

## Files changed / added (Phase 2)

- **`plans.js`** — new. Plan id/name/prices (GHS + pesewas + days)/limits/
  grace/renew-warning config.
- **`billing.js`** — new. `billingConfigured()`, `effectiveStatus()`,
  `refreshSubscription()` (persists transitions, disconnects WhatsApp on
  suspend), `subscriptionGate`, `requireSendAllowed`/`sendBlockedReason`,
  `effectiveLimits()`, `assertCanLinkNumber()`, and the billing router:
  `GET /api/billing/config` (public key + plan, never the secret),
  `GET /api/billing/status`, `POST /api/billing/checkout` (popup params),
  `POST /api/billing/verify` (manual fallback), plus
  `paystackWebhookHandler` and `applySuccessfulCharge`.
- **`auth.js`** — signup now stamps `subscription: { status:
  "pending_payment", … }`; exported `attachUser`, `findUserByEmail`,
  `persistAuthNow` for the billing module.
- **`server.js`** — webhook mounted with `express.raw()` before the JSON
  parser; `app.use("/api", …)` subscription gate (skips `/api/billing/*`
  and `/api/auth/me`); `setAuthPersister(persistAuthNow)`; settings caps
  clamped to plan max; contact import capped at 5,000; `requireSendAllowed`
  on campaign/schedule/followup-resume/test-send/poll/status-post routes;
  list cap now reads the plan constant; new `POST /api/link` with the
  1-number gate.
- **`scheduler.js`** — `processUser` (now exported) skips non-active
  subscriptions; `runOutboundJob` uses `effectiveLimits()` (plan ceilings).
- **`public/signup.html`** — rewritten: Pro pricing card with
  monthly/yearly toggle, plan limits list, then post-signup Paystack Inline
  v2 popup (`https://js.paystack.co/v2/inline.js`,
  `new PaystackPop().newTransaction({…})`), polls `/api/billing/status`
  until the webhook activates, manual "check payment status" fallback.
- **`public/index.html`** — subscription pill + Renew button in the header,
  past-due banner, full-screen paywall overlay with period toggle.
- **`public/app.js`** — `api()` shows the paywall on 402+billingRequired;
  `loadBilling()` renders pill/banner/Renew; dashboard-side Paystack
  checkout + activation polling.

## Test results (all pass, Oct 10 2026)

Boot with and without Paystack keys (both boot; without keys
`/api/billing/config` → `{configured:false}`, gate bypassed, no clamping).
Signup → `pending_payment`; pending user gets 402 on `/api/contacts`,
200 on `/api/billing/status`. Checkout returns popup params
(499 pesewas, GHS, unique ref, metadata). Webhook: forged signature → 401
with no state change; valid HMAC-SHA512 `charge.success` → 200, user
active, `currentPeriodEnd` +30 days; duplicate reference → 200, no
double-extend; wrong amount (999 vs 499) → 200 ack, **not** activated.
Settings clamp: daily 2000 / hourly 100 → 400 with plan message; within
plan → 200. Import at 5,000 contacts → 400. `assertCanLinkNumber(1)` →
409 `NUMBER_LIMIT`; `(0)` → allowed. past_due (end=yesterday): reads 200,
test-send/campaign/schedule creation → 402 with message; scheduler
`processUser` leaves their queued campaign untouched, zero logs.
Suspended (end=5 days ago): status transitions, API 402 "suspended —
renew", transition persisted. Renewal while suspended (yearly webhook,
new ref) → active, 365 days, API unblocked.

**One real bug found and fixed during testing:** `effectiveStatus()`
mapped a *stored* `past_due` back to `pending_payment` (the fallthrough
`status !== "active"` branch), so the grace state never stuck. It now
recomputes from the period-end date for both `active` and stored
`past_due`, and `refreshSubscription()` persists any transition
(e.g. past_due → suspended, with WhatsApp disconnect).

**Second bug found via the suspend path:** `UserConnection.disconnect()`
threw "Store not loaded yet" on its `addLog` call when the user's store
wasn't loaded in that process (the billing suspend path runs before any
store load), and it unconditionally restarted WhatsApp afterwards — wrong
for a suspension. `disconnect()` now loads-then-logs defensively inside
try/catch and takes `{ restart }` (default true for manual dashboard
disconnects); the billing suspend path passes `{ restart: false }`. The
server boot loop also skips `startWhatsApp` for suspended accounts.

## Left for later (per plan)

No owner admin panel (users, plans, suspend controls) — Phase 3. No
password-reset flow. No automatic card subscriptions (manual renewal is
the model; a Paystack Plan could be added later for card payers if the
owner wants it).

---

# Phase 3 — owner admin panel

> **Oct 12 2026 — hidden owner URL.** `/admin.html` is retired: the owner page
> moved from `public/admin.html` (publicly guessable) to
> `private/admin.html`, served ONLY at the secret `ADMIN_LOGIN_PATH` env var
> (e.g. `/phyll-owner-9f3k2x-login`; strict validation in
> `admin.js::adminLoginPath()` — must start with `/`, 2–120 chars,
> letters/digits/`- _ . ~ /` only, never a real page path, never `/api/*`).
> `adminEnabled()` now requires all three env vars. Old URL hard-404s in
> `server.js`. Page title is the neutral "Owner sign in". Login flow itself
> (cookie, 12h TTL, single-token rotation, 401 "Not signed in as admin.")
> unchanged — after login the dashboard renders in-page via
> `/api/admin/me`.

Built Oct 10 2026 on top of the Phase 2 app. The owner gets a separate,
standalone admin surface — never inside the user dashboard. (Since Oct 12
2026 it lives at the secret `ADMIN_LOGIN_PATH`, not `/admin.html`.)

## Design decisions

- **Separate auth, secure by default.** Admin credentials come from
  `ADMIN_EMAIL` + `ADMIN_PASSWORD` + a valid `ADMIN_LOGIN_PATH` env var
  (Oct 12 2026). The `/api/admin/*` router is only mounted when all three are
  set; otherwise those paths 404 and the panel's existence is never hinted.
  The owner page is served only at the secret path from `private/admin.html`
  (never from public static files); `/admin.html` always 404s. Successful
  login renders the dashboard in-page via `/api/admin/me`.
- **Single-owner session model.** One HMAC-signed `admin_session` cookie
  (HttpOnly, SameSite=Lax, Secure in production, 12h TTL), backed by one
  token in `/data/admin.json` rotated on every login — a second login
  invalidates the first. Fine for one owner; documented here.
- **No socket starts from the panel.** The users table shows WhatsApp link
  state via a new `peekStatus(userId)` export in `whatsapp.js` that reads
  the connection object without lazy-starting the socket (the regular
  `getStatus()` would connect on demand).
- **Suspend reuses the billing path.** `billing.js` gained an exported
  `suspendUserAccount(user, reason)` (flip status → persist → disconnect
  WhatsApp with `{ restart: false }`); `refreshSubscription()` now calls it
  for time-based suspensions too — one code path, no duplication.
- **Unsuspend restores, never rewards.** If paid time remains →
  `"active"`; otherwise `"past_due"`, so the normal expiry flow
  (grace → suspended) applies and the user must renew. Documented choice:
  unsuspend never grants days; use Extend for goodwill.
- **Extend** (`{days: 1–365}`) grows `currentPeriodEnd` from the existing
  end when time remains (early extensions never lose days), reactivates
  suspended/expired accounts from now, and sets `"active"`.
- **Abuse flag.** A user is `flagged` when they sent >3× the plan daily cap
  in the last 24h (>1,500 DMs) OR have >10 consecutive send failures in the
  last hour (likely restriction/ban). Shown as ⚠ in the table and counted
  in stats. Thresholds are inline constants in `admin.js`.
- **Announcements** live in `/data/announcement.json` (`{text, updatedAt,
  updatedBy}`); owner sets/clears via `/api/admin/announcement`; logged-in
  users fetch `GET /api/announcement` (mounted before the subscription gate,
  so even `pending_payment` accounts see owner broadcasts) and the dashboard
  shows a dismissible banner (dismissal keyed by `updatedAt` in
  localStorage).
- **Audit trail.** Every admin mutation logs
  `[admin] <email> <action> <user-email> (<id>) [details]` to console.
- **Projection discipline.** The users endpoint builds explicit safe objects
  — `passwordHash`, session tokens, and keys can never leak through it.

## Files changed / added (Phase 3)

- **`admin.js`** — new. `adminEnabled()`, admin login/logout/me, `requireAdmin`
  (401 JSON), `GET /api/admin/users`, `POST /api/admin/users/:id/{suspend,
  unsuspend, extend}`, `GET /api/admin/stats` (totals + MRR estimate:
  monthly actives × 4.99 + yearly actives × 39.99/12 + platform DMs/24h),
  `GET|POST /api/admin/announcement`, and `announcementRouter`
  (`GET /api/announcement`, user session required).
- **`billing.js`** — added exported `suspendUserAccount()`; refactored
  `refreshSubscription()` to call it (behavior unchanged).
- **`whatsapp.js`** — added exported `peekStatus(userId)` (no socket start).
- **`server.js`** — imports admin module; mounts `adminRouter` only when
  `adminEnabled()` (logs which mode); mounts `announcementRouter` before the
  subscription gate.
- **`private/admin.html`** — the owner page (moved from `public/admin.html`
  Oct 12 2026): own login form, stat cards,
  users table (status pills, WhatsApp ✓/—, ⚠ flags), per-row
  Suspend/Unsuspend/Extend, announcement editor. Not behind `requireUserPage`, so it never redirects to `/login.html`. Served only at the hidden `ADMIN_LOGIN_PATH`; the title is the neutral "Owner sign in".
- **`public/index.html`** — announcement banner div above the past-due banner.
- **`public/app.js`** — `loadAnnouncement()` fetches `/api/announcement`,
  shows it dismissibly.
- **`DEPLOY-GUIDE.md`** — Step 4 now lists optional `ADMIN_EMAIL` /
  `ADMIN_PASSWORD`.

## Test results (all pass, Oct 10 2026)

- `node --check` on all JS incl. `admin.js` and `public/app.js`.
- Boot **without** `ADMIN_EMAIL`/`PASSWORD`: `/admin.html` → 200,
  `/api/admin/me` and `/api/admin/login` → 404, user signup unaffected.
- Boot **with** creds: login wrong password → 401; login → 200 + cookie;
  `/api/admin/me` → email; no cookie → 401; **user session cookie** on
  `/api/admin/users` → 401 (cross-auth rejected).
- Two users signed up; one activated via locally-signed `charge.success`
  webhook. `/api/admin/users` → correct rows (status, WhatsApp
  disconnected, counts), no `passwordHash` in output.
- Suspend → user APIs 402; unsuspend (time left) → active, reads 200;
  unsuspend (period ended 10d ago) → `past_due` (documented behavior);
  extend +30d → active with extended end; extend 999d → 400; unknown
  user → 404.
- Stats: 2 users, 1 active / 1 pending_payment, MRR ₵4.99, DMs/24h and
  flagged counts correct (synthetic 1,600-DM log injection → flagged=true).
- Announcements: set → visible to logged-in user via `/api/announcement`;
  anon → 401; clear → empty.
- Admin logout → subsequent `/api/admin/*` → 401.
- Scheduler tick clean; boot log shows `[admin] admin panel enabled`.

## Left out / known limits

- No per-user drill-down page (logs, campaigns) in the panel — table-level
  actions only.
- `peekStatus` reports the last known state; a number linked on another
  boot shows `disconnected` until the socket starts (it never auto-starts
  from the panel by design).
- Stats/users endpoints load every user's store per call — fine at this
  scale; revisit past a few hundred users.

---

# Feature batch (Oct 10, 2026)

Eleven features added on top of Phases 1–3, all per-user scoped and behind
the existing subscription gate for anything that sends. Twi/English templates
were explicitly excluded. No zip was packaged for this batch.

## A. Password reset (auth.js, public/login.html, public/reset.html)

- `POST /api/auth/forgot` `{email}` → always HTTP 200 (no account enumeration).
  If the user exists **and** SMTP is configured, emails a reset link
  `https://<host>/reset.html?token=<token>` (`PUBLIC_BASE_URL` env overrides the
  Host header). Token = 256-bit random, stored as SHA-256 hex, 1h expiry,
  single-use. If SMTP is unset → 503 "not configured".
- `POST /api/auth/reset` `{token, password}` → timing-safe hash compare, expiry
  check, bcrypt the new password (min 8), delete the token, destroy **all**
  sessions for that user.
- SMTP via `SMTP_HOST/PORT/USER/PASS/SECURE`, `FROM_EMAIL` (nodemailer, new dep).
  Send failures are caught and logged — the endpoint still returns 200.
- New `public/reset.html` (request form + set-password form); "Forgot password?"
  link on `login.html`.

## B. Admin per-user detail (admin.js, private/admin.html — was public/admin.html before Oct 12 2026)

- `billing.js`: `addSubHistory(user, event)` appends `{ts, event}` to
  `subscription.history` (cap 50) on activate/renew/suspend/unsuspend/extend.
- `GET /api/admin/users/:id` → safe projection: profile (id/email/createdAt,
  referralCode, referredBy), subscription (+history), WhatsApp state, counts,
  last 10 campaigns (with progress), last 20 logs. No passwordHash/sessions.
  Unknown id → 404.
- `admin.html`: "Details" button per row opens a modal with the above plus the
  existing Suspend/Unsuspend/Extend actions (working inside the modal).

## C. Automatic card renewals (billing.js, plans.js)

Paystack flow (verified against official docs Oct 10, 2026): create Plan via
`POST /plan` → `POST /transaction/initialize` **with the plan code** → the card
payment auto-creates a Paystack subscription; renewals arrive as `charge.success`
events (no metadata of ours on renewals).
- `ensurePaystackPlan(period)`: reuses a cached plan code (`/data/paystack-plans.json`),
  else finds a matching plan (`GET /plan`), else creates one (`POST /plan`).
  Any failure → `null` → caller falls back to the manual flow. Never breaks checkout.
- Checkout (`POST /api/billing/checkout`) takes `method: "card"|"momo"`. Card →
  server initializes with the plan code (channels locked to card) and returns
  `{flow:"plan", accessCode}`; frontend opens it with `PaystackPop.resumeTransaction`.
  MoMo → existing manual popup params (no plan code, per-period manual renewal).
- Webhook: `charge.success` now also matches by stored `paystackCustomerCode` /
  customer email for renewals; period inferred from amount (499→monthly,
  3999→yearly) when metadata is absent; amount/currency re-checked; idempotent via
  `processedRefs`. `subscription.create` stores the subscription code;
  `subscription.disable` is logged (date-based status ages the account naturally).

## D. Win-back campaigns (server.js, scheduler.js, public/app.js)

- Campaign `audienceType: "inactive"` + `inactiveDays` (1–365, default 30):
  targets contacts whose `lastInboundAt` is older than N days **or null**
  (never engaged). Reuses the normal pipeline, scheduler, caps, rails.
- UI: "Inactive (win-back)" audience radio + days input.

## E. Referral tracking (auth.js, server.js, public/app.js, admin.js)

- `referralCode` (8 chars, unambiguous alphabet, unique) assigned at signup
  (backfilled lazily for older accounts). Signup accepts `ref` (body or
  `?ref=` on signup.html → hidden field) → stores `referredBy`/`referredAt`.
  Bad codes are ignored, never block signup.
- `GET /api/referrals` → code, shareable link (`/signup.html?ref=CODE`), referred
  list. Dashboard "Referrals" tab. Admin stats gains `topReferrers` (top 5).
- **Tracking only — no monetary rewards** (stated in UI + admin panel).

## F. A/B testing (server.js, scheduler.js, public/app.js)

- Campaigns accept `variants`: 2–3 message strings. Recipients are assigned at
  send time to the least-loaded variant (stays even across pause/resume/edit);
  each recipient stores `variantIdx` + send timestamp (`variantOf` map).
- **Attribution rule**: a reply = inbound DM from that contact within 72h of
  their variant's send (uses `contact.lastInboundAt` vs recorded send time).
- `GET /api/campaigns` includes `ab: {stats, winner}` for variant campaigns;
  `GET /api/campaigns/:id` too. Winner = highest reply rate, declared only when
  **every** variant has ≥10 sends. Dashboard shows per-variant sent/replies/rate
  with a 🏆 badge.

## G. Smart send times (server.js, scheduler.js, public/app.js)

- Inbound DMs are now logged (`kind: "inbound"`) — powers this feature.
- `GET /api/smart-times` → replies per hour (0–23) in the user's timezone,
  top 3 with counts; `enough` flag (≥10 inbound). Falls back gracefully.
- Campaign `sendMode: "smart"` (+ optional `smartDate` YYYY-MM-DD): server
  computes the next upcoming top-3 hour and sets `scheduledStartAt` — the normal
  scheduled pipeline takes it from there. Fallback hours (18/12/9) when data is
  thin. **Account-level best hours only — no per-contact optimization.**
- Dashboard: "Send at smart time" checkbox (mutually exclusive with manual
  start) + live "best times" hint.

## H. Voice-note campaigns (whatsapp.js, server.js, public/app.js)

- `audioPath` upload (mp3/ogg/wav ≤5MB) on campaigns, follow-ups, test sends.
  Baileys: ogg → voice note (`ptt: true`), mp3/wav → regular audio.
  **No ffmpeg — we send what the user uploads** (documented in UI + notes).
  Audio carries no caption: the message text follows as a separate DM.
- Same replace/remove UX pattern as images.

## I. PDF/document sending (whatsapp.js, server.js, public/app.js)

- `docPath` upload (PDF ≤10MB) → Baileys document message with the **original
  filename**. One attachment max per message (image XOR audio XOR pdf —
  validated 400 otherwise). Text follows as a separate DM (documents have no
  caption).

## J. Payment reminders (server.js, scheduler.js, public/app.js)

- New per-user `reminders` entity: name, message template (`{name}` per contact
  via spintax; `{amount}`/`{due}` substituted once per reminder — single
  amount + dueDate per reminder), audience (all/groups/list/ids), schedule
  (`once` at datetime | `weekly` weekday+HH:MM), active flag.
- CRUD API (`GET/POST/PATCH/DELETE /api/reminders`, `POST /:id/toggle`),
  dashboard "Reminders" tab, scheduler `processReminders` runs due reminders
  through `runOutboundJob` — **same safety rails** (delays, caps, quiet hours,
  opt-outs, no sends unless subscription active). `sentKeys` slot dedup prevents
  double-fires.

## K. Product promos (public/app.js)

- Campaign composer helper: product name/price/link → generates a spintax-ready
  promo message (`{Hi|Hello|Hey} {name} …`) into the composer, with an opt-out
  footer line. Reuses the normal campaign pipeline; no new backend entity.

## Test results (Oct 10, 2026)

`node --check` on all JS + inline HTML scripts: clean. Clean boot verified.
API tests against a local server (`SKIP_WHATSAPP=1`):

- **Phase 1 suite — 39/39**: reset 503 without SMTP; referral code assigned/unique,
  `referredBy`/`referredAt` stored, bad ref ignored, `/api/referrals` link+list;
  admin detail 200/404, safe projection (no passwordHash), history array,
  `topReferrers`; checkout 503 without keys; A/B 1-variant rejected, 2-variant
  created; audio/PDF mime + one-attachment validation; ogg→ptt, PDF filename
  stored; reminder CRUD (create once/weekly, validation, toggle, patch, delete).
- **Phase 2 suite — 19/19**: win-back targets only quiet(60d)+never-engaged (2/3),
  bad days rejected, default 30d; A/B stats (3 sent, 1 reply on variant 0,
  winner null <10 sends); smart-times top hours 18 (20) / 9 (10); smart campaign
  queued with future `scheduledStartAt` at a top hour.
- **Reset suite — 9/9**: bad token/short pw → 400; valid token → 200; old session
  killed; old password dead; new works; single-use enforced. Plus: `/forgot`
  with SMTP → 200 for known **and** unknown emails (no enumeration; send failure
  caught/logged); expired token → 400.
- **Webhook suite — 14/14** (dummy Paystack keys, real HMAC): bad signature 401;
  first payment activates (`activated:monthly` in history); renewal without
  metadata matched by customer code → `renewed:monthly`, period extended;
  duplicate reference ignored; wrong amount rejected; `subscription.create`
  stored; card checkout with unreachable Paystack API → falls back to manual
  flow (never breaks); MoMo stays manual.
- **Scheduler suite — 9/9** (stubbed WhatsApp in a throwaway copy): due reminder
  picked up, 2/2 sends, `{amount}`/`{due}`/`{name}` substituted per contact,
  no duplicate on re-tick, full tick clean.

**Bug found & fixed by tests**: `inactiveDays` omitted → 400 instead of default
30 (now defaults correctly).

**Honest limits**: live WhatsApp sends, real Paystack charges/renewals, and real
SMTP delivery were **not** tested (need his keys + deploy). Voice-note/PDF
delivery depends on Baileys accepting the buffers — structure follows Baileys
`sendMessage` shapes. Smart-times needs ≥10 inbound DMs before `enough=true`.

## Oct 14 2026 — free WhatsApp connect, pay to use features

User flow is now: signup → login → dashboard → connect WhatsApp via QR
(**free setup**) → upgrade to Pro to use features. `subscriptionGate`
(`billing.js`) lets `pending_payment` accounts through `GET /api/status`,
`POST /api/link`, `POST /api/disconnect` (exact method+path matches; the
suspended block is unchanged). Client: `api()` gained `opts.quiet`
(no paywall overlay on 402, error carries `billingRequired = true`); the
init block no longer depends on the never-defined `getToken()` and runs
unconditionally with quiet loaders; new **Connect WhatsApp** button
(`#linkBtn`) polls status every 3s while `qr`/`starting`/`connecting`
(stops on `connected` or after 120s); new upgrade banner (`#upgradeBanner`)
shown by `loadBilling()` for `pending_payment`; paywall copy is now
"Upgrade to Pro" with a **Back to dashboard** dismiss button
(`#paywallClose`). There is still no free plan and no trial — connecting is
setup, not a plan; every feature stays paywalled.

## Oct 23 2026 — first-login fixes + premium redesign

**Why:** the owner reported "I was not able to login in the first instance"
and that the site "looks too simple". The login audit found real defects,
not user error:

- **BUG (primary) — Secure cookie on HTTP first runs.** The Dockerfile sets
  `NODE_ENV=production`, and both session-cookie builders stamped `Secure`
  whenever `NODE_ENV === "production"`. On any first deploy still reached
  over plain HTTP (no domain/HTTPS attached yet, `http://` URL, IP:port),
  browsers silently DISCARD Secure cookies — the login POST returned 200,
  the browser stored nothing, `/` bounced straight back to the login page
  with no error shown. Exactly the reported symptom.
  **Fix:** the `Secure` flag now follows the scheme of the request that
  sets the cookie (`auth.js` `cookieSecure()`/`requestIsHttps()`, honouring
  `X-Forwarded-Proto`; `COOKIE_SECURE=always|never` overrides; default
  `auto`). HTTPS deploys still get Secure cookies; HTTP first runs work.
  Applied to the user cookie AND the owner `admin_session` cookie.
- **Owner panel "doesn't exist".** It never did at any URL when
  `ADMIN_LOGIN_PATH` (never chosen) or `ADMIN_EMAIL`/`ADMIN_PASSWORD` was
  unset — the router simply isn't mounted. **Fix:** boot now logs one line
  naming exactly which vars are missing/invalid (`adminConfigStatus()`),
  while HTTP behaviour is unchanged (panel invisible, `/admin.html` 404).
- **SESSION_SECRET fragility.** Unset → `loadAuthStore()` threw → the
  whole server never booted (site fully down, clue only in logs).
  **Fix:** secret resolution is now env → persisted `/data/.session-secret`
  (0600) → generated+persisted, with loud warnings; short env secrets warn
  too. Sessions stay HMAC-signed throughout; a fresh deploy works out of
  the box and logins survive restarts while the volume persists.
- **Shared rate-limit bucket.** No `trust proxy` → behind Coolify/Traefik
  every visitor's `req.ip` was the proxy's IP, so the 30-attempts/15-min
  auth brake was effectively global and could lock everyone out.
  **Fix:** `app.set("trust proxy", 1)` (also makes `req.secure` correct).
- **HTML 404s for /api/*.** Unknown API paths fell to Express's default
  HTML page, which browser `fetch().json()` turns into an unreadable
  "Unexpected token" error. **Fix:** JSON 404 handler for `/api/*`.
  (For `pending_payment` users the subscription gate still answers 402
  JSON first — by design; it never emits HTML either.)
- **Boot self-check.** Each boot prints `[boot] session secret: …`,
  `[boot] data dir: … — N registered user(s)`, `[admin] owner panel …`,
  `[boot] billing: …` — the answers to "why can't I log in?" in the log.
- **Minor:** admin user rows now include `counts.lists` (the detail modal
  rendered "undefined lists" before).
- **DEPLOY-GUIDE** refreshed: complete upload file list (it omitted
  `billing.js`, `plans.js`, `admin.js`, `private/` — an upload by the old
  list would not boot), SESSION_SECRET fallback explained, new
  "First-run checks" + "I can't log in" troubleshooting sections.

**Redesign (no flow changes):** new `styles.css` design system — Inter
with system fallbacks, deep-green accent family (grown-up WhatsApp green,
no neon), layered surfaces, 14–20px radii, soft shadows, glassy sticky
top bar. Dashboard (`index.html`) is now an app shell: left sidebar nav
(same `.tabs`/`data-tab` hooks `app.js` drives), top bar, stat cards on
the Connection tab (existing `statusText`/`numberText` ids), restyled
banners and paywall. Login/signup/reset are split-screen pages with a
gradient hero (features + plan summary) beside the form; signup's pricing
is a proper card showing **GH₵4.99/mo · GH₵39.99/yr** and all plan limits.
Owner panel got the same shell + stat cards. Every existing element id,
form field, API route and behaviour is unchanged — verified by driving
the real server (below). Login page additionally redirects to `/` when a
valid session already exists, and network failures show a readable
message instead of "Failed to fetch".

**Tests (this build, dummy env, SKIP_WHATSAPP=1):**
- HTTP suite — **47/47**: signup→cookie→dashboard 200 with new shell;
  cookie has NO `Secure` over http and DOES over https-forwarded (the D1
  regression test); wrong password → 401 "Invalid email or password.",
  no cookie; logout → old cookie 401 + `/` redirects to login; unpaid
  `GET /api/status` 200 (connect-free) vs `GET /api/contacts` → 402
  `billingRequired`; `/admin.html` 404; owner login at the secret path →
  200 + `/api/admin/me`; unknown `/api/*` → JSON 404; restart with the
  same data dir → account AND pre-restart session still valid; bare boot
  with NO SESSION_SECRET/admin env → boots with warnings, signup/login
  work, admin disabled with the missing vars named in the log, and after
  a restart the persisted generated secret keeps the old session valid.
- Syntax — **14/14**: `node --check` on all 10 app JS files + inline
  scripts extracted from the served `/`, login, signup, reset and owner
  pages (0 inline on `/` — external `app.js` only, also checked).
- Previews: `preview-landing.html`, `preview-login.html`,
  `preview-dashboard.html` next to the app (real `styles.css`, demo data,
  working tab switching in the dashboard mock).

**Unchanged by design:** single Pro plan GH₵4.99/mo · GH₵39.99/yr, no
free plan/trial, connect-free flow + dismissible paywall, plan limits,
hidden owner path, Paystack flows and webhook. Live Paystack/WhatsApp/
SMTP still untested (need the real deploy + keys).

## Oct 23 2026 (later) — Bootstrap 5 conversion + self-contained previews

The hand-rolled design system is replaced by **Bootstrap 5.3.3** (official
jsDelivr CDN: CSS + Icons in `<head>`, bundle JS before `</body>`,
`data-bs-theme="dark"` on every page). Converted: the user dashboard
(`public/index.html` + everything `public/app.js` generates), login,
signup, reset, and the owner panel (`private/admin.html` + its inline
script). Layouts are Bootstrap primitives — grid sidebar shell that
stacks on mobile, cards, `.table` in `.table-responsive`, `.form-control`
/ `.form-floating` / `.form-check`, badges for every status pill, alerts
for the banners, real `.progress` bars, `btn-group` period toggles
(the paywall toggle's old inline styles are gone; `.active` carries the
state). `public/styles.css` is now a thin custom layer on top: brand
tokens (deep-green `--bs-*` overrides, `.btn-brand` gradient button,
`.text-bg-brand`), the Inter stack, the sidebar/tab behaviour rules, and
the few boxes Bootstrap has no primitive for (QR box, group checklist,
paywall veil, auth hero, pricing box).

The three previews next to the app (`preview-landing.html`,
`preview-login.html`, `preview-dashboard.html`) are now **fully
self-contained**: Bootstrap via CDN plus the ENTIRE custom layer inlined
in a `<style>` block — zero relative stylesheet references, so they
render styled from anywhere. (The previous previews linked
`app/public/styles.css` relatively, which does not resolve outside the
app — the app itself was never broken, Express serves `/styles.css`.)

**Carried over unchanged:** all of the Oct 23 auth fixes (scheme-aware
cookie `Secure` + `trust proxy`, SESSION_SECRET persistence fallback,
JSON 404s for `/api/*`, boot self-check, `adminConfigStatus`), every
route, flow, element id, field name, fetch call and JS hook, the
connect-free paywall (402 `billingRequired`), the hidden owner panel
(`/admin.html` 404s, `ADMIN_LOGIN_PATH`), and the single Pro plan
(GH₵4.99/mo · GH₵39.99/yr + limits). Server-side JS files are untouched.

**Tests (this build, dummy env, SKIP_WHATSAPP=1):**
- HTTP suite — **47/47** against the app AND against the extracted zip:
  signup→cookie→dashboard 200; cookie has NO `Secure` over http and DOES
  over https-forwarded; wrong password → 401 "Invalid email or
  password.", no cookie; logout → old cookie 401; unpaid
  `GET /api/status` 200 (connect-free) vs `GET /api/contacts` → 402
  `billingRequired`; `/admin.html` 404; owner login at the secret path →
  stats + users APIs; user cookie rejected by admin API; unknown
  `/api/*` → JSON 404; restarts keep account + pre-restart session valid
  on both the env-secret boot and the bare boot (generated secret
  persisted at mode 0600); bare boot logs the disabled owner panel with
  the missing vars named.
- Syntax — `node --check` clean on all 10 app JS files and on the
  inline scripts extracted from every served page + all three previews.
  `app.js` API endpoint set and DOM-hook set are byte-identical to the
  pre-conversion build (diff-verified); dashboard/admin `id` and `name`
  sets identical.
- Markup — served pages + previews grep-verified: Bootstrap 5.3.3 CDN
  present everywhere; previews contain ZERO relative stylesheet hrefs;
  dashboard markup uses container/row/card/btn/table classes
  (14 responsive tables, 53 buttons); no legacy classes remain
  (`pill`, `muted`, `error`, `danger`, `statgrid` all gone from markup
  and generated strings).

## Oct 28, 2026 — Owner admin upgrade: owner WhatsApp + plan controls + support tools

Owner-reported gaps: the admin could not link WhatsApp and could not add
or change a plan. Both are now in the owner panel, plus support/health
tooling. Single Pro plan is unchanged (no new tiers — see below).

- **`admin.js`** — new owner WhatsApp section: `GET /api/admin/whatsapp`
  (status + QR data URL, lazy-starts like the user dashboard),
  `POST /api/admin/whatsapp/link` (409 when already connected),
  `POST /api/admin/whatsapp/disconnect` (restart:true, so a fresh QR
  appears, like the user dashboard). The owner session lives under the
  reserved id `__owner__` (`OWNER_WA_ID`), which never appears in the
  users table, the scheduler, or referral counts — same Baileys session
  machinery as users, separate session dir.
- **`admin.js`** — new per-user plan controls: `POST /users/:id/plan`
  (period monthly|yearly only, no days granted or lost; the next renewal
  charges at the new period's price), `POST /users/:id/grant` (complimentary
  access: activates pending_payment accounts for N days at a chosen
  period — the "give them Pro free" button; same no-lost-days rule as
  extend). Invalid periods are 400, never silently re-priced.
- **`admin.js`** — new per-user support controls:
  `POST /users/:id/whatsapp/disconnect` (restart:false + session dir
  wiped, so the user's next link scans a fresh QR — the stuck-session
  fix), `POST /users/:id/reset-password` (server-generated 12-hex temp
  password, shown once; all live sessions die),
  `POST /users/:id/delete` (WA disconnect + user row + whole /data/<id>
  dir removed). Plus `GET /users/export` (CSV download) and
  `GET /health` (users, WA connected/awaiting-QR counts via peekStatus
  only, Paystack configured flag, owner WA status, uptime).
- **`auth.js`** — new admin-only helpers `setUserPassword` (bcrypt hash +
  invalidate all sessions + persist) and `removeUserAccount` (user row +
  sessions). Both return false for unknown users; callers are
  requireAdmin-guarded routes.
- **`server.js`** — boot now reconnects the owner WhatsApp session too
  (when the owner panel is enabled), so the admin's linked number
  survives restarts without opening the panel first.
- **`private/admin.html`** — Owner WhatsApp card (QR image, status,
  number, Link/Disconnect, auto-refreshes every 5s while a QR is shown),
  Platform health card, Users search + status filter (incl. Flagged),
  Export CSV button, and a Plan / Support / Danger section in the user
  detail modal (period select + save, grant days + period, WA
  disconnect, password reset with the temp shown once, delete with
  confirm). Table row buttons unchanged (Suspend/Extend/Details).
- **Not in this build:** creating extra plan tiers (Basic/Standard/…)
  with their own prices and limits. The product has one hardcoded Pro
  plan (`plans.js`) and every money path (Paystack plans, limits, MRR)
  reads it, so tiers are a bigger refactor that needs the owner's tier
  names, prices, and limits first. Per-user period + grant covers
  "add or change plan" for the single-plan product.
- **Verification** — `node --check` clean on admin.js, auth.js,
  server.js, and the admin page inline script. Integration test
  (`/tmp/saas-admin-test.mjs`, real server boot, temp DATA_DIR,
  SKIP_WHATSAPP=1): 22/22 — unauth 401, admin login + cookie, owner WA
  status/link/disconnect, signup, plan switch yearly + invalid 400,
  grant pending_payment -> active, reset-password (temp logs in, old
  password 401s), user WA disconnect, CSV export, health, delete
  (absent from list, detail 404s), owner page at the secret path.

## Merged admin + tiers + editable prices (Oct 28, 2026 evening)

- **Admin merged into the main platform.** The separate admin login,
  secret URL, `admin_session` cookie, and `__owner__` WhatsApp session
  are REMOVED. The admin is a normal user account with `role: "admin"`,
  set only by a one-time claim: log in normally, and while no admin
  exists the dashboard shows a "No admin yet" card — enter the
  `ADMIN_PASSWORD` env value once and that account becomes admin.
  After the claim, the Admin tab appears in the main dashboard (users,
  stats, announcement, plan settings, health). `ADMIN_EMAIL` and
  `ADMIN_LOGIN_PATH` are now unused; `ADMIN_PASSWORD` can be removed
  after claiming (keep it only if you may need to re-claim later).
  Admin accounts bypass the subscription gate and work at Business
  limits — the owner uses the platform like any user, without paying.
  The admin's own WhatsApp links through the normal QR flow (the old
  `__owner__` session is retired — one fresh QR scan after the merge).
- **Three tiers** (`plans.js`): Starter GH₵2.99/mo, GH₵23.99/yr
  (1 number, 1,000 contacts, 100 DMs/day, 20/hour, 10 lists); Pro
  GH₵4.99/mo, GH₵39.99/yr (unchanged — 1 number, 5,000 contacts,
  500/day, 40/hour, 50 lists); Business GH₵9.99/mo, GH₵79.99/yr
  (1 number, 20,000 contacts, 2,000/day, 100/hour, 200 lists).
  Every tier allows exactly 1 linked number (multi-number needs a
  connection-per-number refactor, deliberately not in this build).
  Existing Pro subscribers map over unchanged (same prices, limits,
  and Paystack plans — cache keys moved to tier:period and the old
  period-only cache entries are simply ignored and re-found).
- **Editable plan prices + limits** (Admin tab → Plan prices &
  limits): monthly/yearly prices and the four caps per tier, stored
  in `DATA_DIR/plan-settings.json` (survives redeploys via the volume).
  Tier names are NOT editable (Paystack plan matching keys on them).
  On a price change, the old price is kept as a grandfathered price:
  new checkouts use the new price immediately (Paystack plan cache
  for that tier+period is invalidated), and existing subscribers'
  renewals at the old price keep working — the webhook resolves tier
  from metadata first, then the user's stored tier + amount, then
  amount alone over current + grandfathered prices. Existing
  subscribers are NOT migrated to new prices (grandfathered).
- **Checkout/paywall/signup** all pick tier + period now (tier cards
  with a period toggle; Pro marked "Most popular"; renewals preselect
  the user's current tier+period). Admin per-user plan switch now
  takes tierId and/or period; grant takes an optional tierId.
  Login page headline prices load live from `/api/billing/config`.
- **Not in this build:** user self-service tier switching (users pick
  a tier at signup checkout and renew the same tier; the admin can
  switch any user's tier), migrating existing subscribers to new
  prices (grandfathering instead), multi-number accounts.
- **Verification** — `node --check` clean on every JS file + all HTML
  inline scripts. Integration test (`tests/merge-tiers-test.mjs`, real
  server boot, temp DATA_DIR, SKIP_WHATSAPP=1, dummy Paystack keys):
  44/44 — tier defaults, claim flow (wrong password 401, second claim
  409, claim closes after admin exists), non-admin 403s, plan save +
  changed-pair reporting + invalid 400, grandfather math (499 still
  resolves after the 5.99 change), tier checkout (amount, metadata,
  reference), plan switch + grant with tiers, gate bypass for admin
  vs 402 for pending users, admin-delete guard, full webhook
  activation (metadata tier) + grandfathered renewal at the old
  amount with no metadata, old secret-panel routes 404.
