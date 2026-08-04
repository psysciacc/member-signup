# PSA Member Signup Worker

Cloudflare Worker that backs the signup form in `index.html`. It:

1. `POST /submit` — stores a new signup in a private D1 database and emails the admin
   an Approve / Deny link (SendGrid).
2. `GET /decision` — the target of those email links. Verifies a signed token, then:
   - **Deny** marks the row denied. Nothing else happens.
   - **Approve** creates the person as a Canvas user under `CANVAS_ACCOUNT_ID` via the
     Canvas REST API (the same API `rcanvas` wraps), and marks the row approved. Canvas
     itself then emails the new user a confirmation/setup link.
3. `GET /export` — returns all signups as a CSV (protected by a bearer token), so you
   have a private CSV export if you want one, without it ever living in a public repo.

## One-time setup

You'll need a Cloudflare account (sign up with the PSA email) and Node installed.

```bash
cd worker
npm install
npx wrangler login
```

### 1. Create the D1 database

```bash
npx wrangler d1 create psa-member-signup
```

Copy the `database_id` it prints into `wrangler.toml` under `[[d1_databases]]`.

Apply the schema:

```bash
npx wrangler d1 execute psa-member-signup --remote --file=./schema.sql
```

### 2. Set secrets

```bash
npx wrangler secret put SENDGRID_API_KEY   # from your SendGrid account
npx wrangler secret put HMAC_SECRET        # any long random string, e.g. `openssl rand -hex 32`
npx wrangler secret put CANVAS_API_TOKEN   # Canvas admin token, generated at
                                            # canvas.psysciacc.org -> Account -> Settings -> New Access Token
```

`HMAC_SECRET` is also the bearer token for `/export` — keep it private.

### 3. Update the plain vars in `wrangler.toml`

- `ADMIN_EMAIL` — where the approve/deny email goes (currently psa.membersite@gmail.com)
- `FROM_EMAIL` — must be a sender verified in SendGrid
- `CANVAS_BASE_URL` — currently `https://canvas.psysciacc.org`
- `CANVAS_ACCOUNT_ID` — the Canvas account/sub-account ID new members should be created under
- `ALLOWED_ORIGIN` — the GitHub Pages origin the form is served from, e.g.
  `https://psysciacc.github.io`

### 4. Deploy

```bash
npx wrangler deploy
```

This prints the Worker's URL, e.g. `https://psa-member-signup.<your-subdomain>.workers.dev`.

### 5. Point the form at it

In `../index.html`, set:

```js
const WORKER_URL = "https://psa-member-signup.<your-subdomain>.workers.dev/submit";
```

Commit and push — GitHub Pages picks it up automatically.

## Spam mitigation

Three layers, all silent (rejected requests get the same `{ok:true}` response as a
real success, so scripted spam can't tell what tripped the filter and adapt):

- **Honeypot** — a hidden "website" field real users never see or fill in; the
  Worker discards anything that fills it.
- **Time-trap** (`MIN_SUBMIT_MS`) — the form records when it loaded and sends that
  timestamp; submissions faster than `MIN_SUBMIT_MS` (default 3s) are rejected as
  implausibly fast for a human filling out a form.
- **IP rate limit** (`RATE_LIMIT_PER_HOUR`) — each `/submit` attempt is logged with
  its IP in `submission_attempts`; an IP making more than `RATE_LIMIT_PER_HOUR`
  attempts in a rolling hour is rejected.

If spam gets past all of that, the Approve/Deny gate is the real backstop — nothing
reaches Canvas without a human click.

## Exporting a CSV

```bash
curl -H "Authorization: Bearer <HMAC_SECRET>" https://psa-member-signup.<your-subdomain>.workers.dev/export -o signups.csv
```
