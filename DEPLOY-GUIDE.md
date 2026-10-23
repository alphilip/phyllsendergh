# Deploy Guide — WhatsApp Marketing SaaS

Browser-only deploy. No terminal needed. This is a **brand-new** app — it does
not touch your personal marketing bot.

## What this is

Multi-user SaaS version of the WhatsApp marketing bot. Each marketer signs up,
logs in, and links **their own** WhatsApp number with a QR scan. Everyone's
contacts, campaigns, and WhatsApp sessions are fully isolated. Includes
signup/login/logout, per-user dashboards with every feature (campaigns,
follow-ups, auto-replies, lists, scheduled promos, status, polls, welcomes,
missed-call replies, message spinning), per-user WhatsApp linking, Paystack
billing with the single Pro plan, and the hidden owner admin panel.

## Step 1 — Create the GitHub repo

1. Go to github.com → **New repository**.
2. Name it something like `phyllsbulksaas` (your choice).
3. Set it to **Private**.
4. Create the repository.

## Step 2 — Upload the files

1. Extract the zip on your Chromebook (Files app → double-click the zip).
2. In the new repo, click **Add file → Upload files**.
3. Drag in everything from the extracted `app` folder:
   - `server.js`, `scheduler.js`, `whatsapp.js`, `store.js`, `spintax.js`,
     `auth.js`, `billing.js`, `plans.js`, `admin.js` — **all of them**; the
     server will not boot if any one is missing
   - `package.json`, `package-lock.json`, `Dockerfile`
   - the whole `public` folder (drag the folder itself — `index.html`,
     `login.html`, `signup.html`, `reset.html`, `app.js`, `styles.css` must
     land in `public/`)
   - the whole `private` folder (the owner panel page lives there)
   - `BUILD-NOTES.md`, `DEPLOY-GUIDE.md` (optional, harmless)
4. Click **Commit changes** (directly to main).

## Step 3 — Create the Coolify app

1. In Coolify, add a **new Application** from your new GitHub repo (don't reuse
   the personal bot's app).
2. Build pack: **Dockerfile**.

## Step 4 — Environment variables

In the Coolify app → **Environment variables**, add:

| Key | Value |
|---|---|
| `SESSION_SECRET` | **Recommended:** a long random string — generate one here: https://www.random.org/strings/ (length 64, alphanumeric). Keep it secret; changing it later logs everyone out. If you skip it, the app no longer refuses to boot: it generates a secret and saves it to `/data/.session-secret` (so logins survive restarts as long as the volume in Step 5 exists) and prints a warning in the log. Setting it yourself is still the right thing for production. |
| `PORT` | `3000` |
| `PAYSTACK_PUBLIC_KEY` | your Paystack **public** key (starts with `pk_`). Powers the checkout popup. |
| `PAYSTACK_SECRET_KEY` | your Paystack **secret** key (starts with `sk_`). Verifies payments — **never share it, never put it in code or GitHub.** |
| `ADMIN_EMAIL` | (optional) your email — part of the owner-panel login. |
| `ADMIN_PASSWORD` | (optional) a strong password for the owner panel. |
| `ADMIN_LOGIN_PATH` | **REQUIRED for the owner panel.** A secret, unguessable URL path where your owner login page lives, e.g. `/phyll-owner-9f3k2x-login`. Rules: must start with `/`, 2–120 characters, letters/digits/`- _ . ~ /` only, must not be a real page (`/admin.html`, `/login.html`, …) and must not start with `/api/`. The owner panel lives ONLY at `https://<your-app-domain><path>` — bookmark it privately. `/admin.html` no longer exists (always 404). Without all three (`ADMIN_EMAIL` + `ADMIN_PASSWORD` + valid `ADMIN_LOGIN_PATH`), the owner panel and `/api/admin/*` are disabled. |
| `PUBLIC_BASE_URL` | (optional) your app's public URL, e.g. `https://wa.yourdomain.com`. Used for password-reset and referral links in emails. If unset, the app uses the request's Host header. |
| `SMTP_HOST` | (optional) SMTP server for password-reset emails, e.g. `smtp.gmail.com`. Without `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`FROM_EMAIL`, "Forgot password?" returns "not configured". |
| `SMTP_PORT` | (optional) SMTP port — `587` for STARTTLS, `465` for SSL. Defaults to `587`. |
| `SMTP_SECURE` | (optional) `true` if your SMTP uses implicit SSL (port 465), else `false`/unset. |
| `SMTP_USER` | (optional) SMTP username (often your full email address). |
| `SMTP_PASS` | (optional) SMTP password — for Gmail use an **App Password**, not your login password. **Never put it in code or GitHub.** |
| `FROM_EMAIL` | (optional) the From address on reset emails, e.g. `PhyllHost <noreply@yourdomain.com>`. |

> **⚠ REMINDER: add `PAYSTACK_PUBLIC_KEY` and `PAYSTACK_SECRET_KEY` in Coolify
> before you deploy.** Without them the app still boots, but nobody can pay —
> signups will see "payments aren't set up yet" instead of the checkout.
> Get both keys from your Paystack dashboard → Settings → API Keys & Webhooks.
> While you're there, add a webhook URL pointing at
> `https://<your-app-domain>/api/billing/webhook` and select the
> `charge.success` event — that's how the app learns a payment succeeded.

## Step 5 — Persistent storage

Add a **volume** (Coolify → the app → Storages/Persistent storage):

- Host path / volume name: anything, e.g. `saas-data`
- Container path: `/data`

Without this, every redeploy wipes all user accounts and WhatsApp sessions.

## Step 6 — Deploy

Hit **Deploy**. Open the app URL — you should see the **login page**.
Click "Sign up", create your account, accept the ToS, and you're in.

## First-run checks — read the boot log

Every boot prints a short self-check. In Coolify → the app → **Logs**, look
for these lines and confirm they match your intent:

- `[boot] session secret: …` — says where the signing secret came from. A
  `WARNING` here means SESSION_SECRET is short or auto-generated.
- `[boot] data dir: /data — N registered user(s) loaded` — if N resets to 0
  after every redeploy, your Step 5 volume is not attached and accounts are
  being wiped.
- `[admin] owner panel ENABLED at <your secret path>` — or `DISABLED —
  missing/invalid: …` naming **exactly** which of `ADMIN_EMAIL`,
  `ADMIN_PASSWORD`, `ADMIN_LOGIN_PATH` is wrong. Until all three are set,
  the owner panel exists at no URL at all (that is by design — `/admin.html`
  always 404s).
- `[boot] billing: …` — whether Paystack is configured.

### "I can't log in" — the three usual causes

1. **You get bounced straight back to the login page after a correct
   password.** Your session cookie was not stored. Current builds set the
   cookie's `Secure` flag from the scheme of *your* request, so this only
   happens if you open the app over `http://` and then get redirected to
   `https://` (or the other way round) mid-login — always use the final
   domain, over `https://`, for the real thing. Force a behaviour with
   `COOKIE_SECURE=always` (HTTPS-only deploys) or `COOKIE_SECURE=never`
   (plain-HTTP test boxes) if you ever need to.
2. **The owner panel 404s everywhere.** It is disabled — see the `[admin]`
   boot line for which env var is missing. The path must start with `/`,
   use only letters/digits/`- _ . ~ /`, and must not be a real page.
3. **"My account vanished."** The `/data` volume (Step 5) is missing, so a
   redeploy wiped every account. Attach the volume and sign up again.

## How your customers will use it

**Oct 14 2026 — flow: signup → login → dashboard → connect WhatsApp (FREE) → upgrade to Pro to use features.**

1. They open your app URL and sign up.
2. After login they land on their dashboard. Connecting WhatsApp is **free
   setup, not a plan**: they click **Connect WhatsApp**, scan the QR code
   with **their** WhatsApp (Linked devices) — their number links, not yours.
   No payment is needed to link.
3. When they want to actually *use* a feature — import contacts, build
   campaigns, send bulk DMs, auto-replies, schedules, anything — the
   paywall appears and they must **upgrade to Pro** (GH₵4.99/month or
   GH₵39.99/year). Until they pay, every feature route returns 402.
4. There is still **no free plan and no trial**: connecting is setup, not
   access. Every feature stays paywalled; unpaid accounts can only log in,
   link/unlink WhatsApp, and pay.

## Safety notes

- Each user's WhatsApp number carries its own ban risk — same rules as the
  personal bot: dedicated number, warm it up, 30–60s delays, hourly caps.
- The default safety rails (delays, daily/hourly caps, cooldowns, STOP
  opt-outs) apply to every account automatically.
- One user's heavy sending never blocks another user's scheduler.

## What's included

Accounts + per-user isolation, the full feature dashboard, Paystack billing
(single Pro plan — GH₵4.99/month or GH₵39.99/year, card auto-renew, MoMo
per-period), the hidden owner admin panel, password reset by email, and the
connect-free flow: users link their WhatsApp for free and hit the paywall
only when they use a feature. There is no free plan and no trial.
