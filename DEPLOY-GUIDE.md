# Deploy Guide — WhatsApp Marketing SaaS (Phase 1)

Browser-only deploy. No terminal needed. This is a **brand-new** app — it does
not touch your personal marketing bot.

## What this is

Multi-user SaaS version of the WhatsApp marketing bot. Each marketer signs up,
logs in, and links **their own** WhatsApp number with a QR scan. Everyone's
contacts, campaigns, and WhatsApp sessions are fully isolated.

Phase 1 includes: signup/login/logout, per-user dashboards with every v1
feature (campaigns, follow-ups, auto-replies, lists, scheduled promos, status,
polls, welcomes, missed-call replies, message spinning), and per-user WhatsApp
linking. Billing (Paystack) and the owner admin panel come in Phase 2/3.

## Step 1 — Create the GitHub repo

1. Go to github.com → **New repository**.
2. Name it something like `phyllsbulksaas` (your choice).
3. Set it to **Private**.
4. Create the repository.

## Step 2 — Upload the files

1. Extract the zip on your Chromebook (Files app → double-click the zip).
2. In the new repo, click **Add file → Upload files**.
3. Drag in everything from the extracted `app` folder:
   - `server.js`, `scheduler.js`, `whatsapp.js`, `store.js`, `spintax.js`, `auth.js`
   - `package.json`, `package-lock.json`, `Dockerfile`
   - the whole `public` folder (drag the folder itself — `index.html`,
     `login.html`, `signup.html`, `app.js`, `styles.css` must land in `public/`)
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
| `SESSION_SECRET` | a long random string — generate one here: https://www.random.org/strings/ (length 64, alphanumeric). Keep it secret; changing it later logs everyone out. |
| `PORT` | `3000` |
| `PAYSTACK_PUBLIC_KEY` | your Paystack **public** key (starts with `pk_`). Powers the checkout popup. |
| `PAYSTACK_SECRET_KEY` | your Paystack **secret** key (starts with `sk_`). Verifies payments — **never share it, never put it in code or GitHub.** |
| `ADMIN_EMAIL` | (optional) your email — enables the owner admin panel at `/admin.html`. |
| `ADMIN_PASSWORD` | (optional) a strong password for the admin panel. Without both, `/api/admin/*` returns 404. |

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

## How your customers will use it

1. They open your app URL and sign up.
2. They go to the WhatsApp/QR section and scan the code with **their**
   WhatsApp (Linked devices) — their number links, not yours.
3. They import contacts, build campaigns, and send — all inside their own
   account. They never see your data or anyone else's.

## Safety notes

- Each user's WhatsApp number carries its own ban risk — same rules as the
  personal bot: dedicated number, warm it up, 30–60s delays, hourly caps.
- The default safety rails (delays, daily/hourly caps, cooldowns, STOP
  opt-outs) apply to every account automatically.
- One user's heavy sending never blocks another user's scheduler.

## Coming next (Phase 2)

Plans, Paystack billing, and the owner admin panel. Before then, decide:
plan names, GHS prices and limits per plan, free-trial length, and have your
Paystack public + secret keys ready.
