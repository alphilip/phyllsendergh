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

- `pending_payment` — can log in; every `/api/*` (except `/api/billing/*`
  and `/api/auth/me`) returns **402** with `billingRequired: true`; the
  dashboard shows a full-screen paywall with the Paystack popup.
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

Built Oct 10 2026 on top of the Phase 2 app. The owner gets a separate,
standalone admin surface at `/admin.html` — never inside the user dashboard.

## Design decisions

- **Separate auth, secure by default.** Admin credentials come from
  `ADMIN_EMAIL` + `ADMIN_PASSWORD` env vars. The `/api/admin/*` router is
  only mounted when both are set; otherwise those paths 404 and the panel's
  existence is never hinted. `/admin.html` itself is a static file and always
  serves (it just shows a login form that can't succeed without the backend).
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
- **`public/admin.html`** — new standalone page: own login form, stat cards,
  users table (status pills, WhatsApp ✓/—, ⚠ flags), per-row
  Suspend/Unsuspend/Extend, announcement editor. Same `styles.css` look.
  Not behind `requireUserPage`, so it never redirects to `/login.html`.
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
