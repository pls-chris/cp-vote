---
title: CP Lineup Vote
author: Christoforos Pliatsikas
---

# CP Lineup Vote

Vote page for the L2 Reborn Legacy constant party. Members rank Mage / Melee / Archer, pick 2–3 classes for each, tick the support groups they are ok to play, and the page scores every lineup and shows who to recruit.

- **Page:** GitHub Pages (`site/`), plain HTML/CSS/JS.
- **Votes:** a Cloudflare Worker (`worker/`) with one SQLite Durable Object. Free plan is enough.
- **Deploy:** both deploy from GitHub Actions on every push to `main`. You don't need Node or wrangler on your PC.

```
site/                       GitHub Pages
  index.html  app.js  style.css
  config.js                 Worker URL (written by the Pages workflow)
worker/                     Cloudflare Worker
  src/index.js
  wrangler.toml             member list, Durable Object binding
.github/workflows/
  pages.yml                 deploys site/
  worker.yml                deploys worker/ and sets the keys
```

## One-time setup (about 15 minutes)

### 1. GitHub repo

Create a **public** repo (GitHub Pages on a private repo needs a paid plan; nothing secret is in the code) and push this folder to `main`.

### 2. Cloudflare

1. Make a free account at dash.cloudflare.com.
2. Workers & Pages → open it once, so your `*.workers.dev` subdomain gets created. Note the **Account ID** (right side of the Workers overview).
3. My Profile → API Tokens → Create Token → template **Edit Cloudflare Workers** → limit it to your account → create. Copy the token.

### 3. Repo secrets and variables

Repo → Settings → Secrets and variables → Actions.

**Secrets:**

| Name                    | Value |
|-------------------------|-------|
| `CLOUDFLARE_API_TOKEN`  | the token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | your Account ID |
| `PARTY_KEY`             | the key you give to the members (8+ characters) |
| `ADMIN_KEY`             | a long random key only for you (for deleting votes) |

**Variables:**

| Name           | Value |
|----------------|-------|
| `PAGES_ORIGIN` | `https://<your-github-user>.github.io` (no path, no trailing slash) |
| `WORKER_URL`   | set it after step 5 |

### 4. Turn on Pages

Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**.

### 5. First deploy

Actions → **Deploy worker** → Run workflow. When it finishes, the log shows the Worker URL, like `https://cp-vote.<your-subdomain>.workers.dev`.

Put that URL in the `WORKER_URL` variable, then Actions → **Deploy page** → Run workflow.

The page is at `https://<your-github-user>.github.io/<repo-name>/`. Send that link and the party key to the members.

## Everyday use

- **Results** refresh by themselves every 15 seconds.
- A member votes again with the same name to change his vote.
- **New members:** edit `MEMBERS` in `worker/wrangler.toml` and push. The dropdown takes the list from the Worker.
- **Change the party key:** update the `PARTY_KEY` secret, then run **Deploy worker** again.

## Admin

```sh
W=https://cp-vote.<your-subdomain>.workers.dev
curl -s $W/api/votes | jq                                           # all votes
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" $W/api/votes/gx          # delete one vote
curl -X DELETE -H "X-Admin-Key: $ADMIN_KEY" $W/api/votes             # reset for a new round
```

## API

| Method | Path                | Auth          | What it does |
|--------|---------------------|---------------|--------------|
| GET    | `/api/votes`        | none          | `{members, votes}` |
| PUT    | `/api/votes/<name>` | `X-Party-Key` | Save or replace that member's vote |
| DELETE | `/api/votes/<name>` | `X-Admin-Key` | Delete one vote |
| DELETE | `/api/votes`        | `X-Admin-Key` | Delete all votes |
| GET    | `/healthz`          | none          | `ok` |

## Security notes

- Anyone with the link can read the votes. Saving needs the party key, deleting needs the admin key. Keys are compared in constant time.
- The Worker checks each vote: known member, the three party types once each, 2–3 known classes per type, no duplicates, body max 8 KB.
- Rate limit: 20 writes per minute per IP.
- CORS allows only `PAGES_ORIGIN`. The page has a CSP that allows connections only to your Worker.
- Votes are in a Durable Object, so two members saving at the same moment never overwrite each other.
- Any member with the party key can overwrite another member's vote. For one party of friends this is fine.
- The page loads Google Fonts. To avoid that third-party request, remove the two `fonts.googleapis.com` lines in `site/index.html`.

## Costs

Cloudflare Workers Free: 100k requests per day. Nine people with the page open all day stay far below that. GitHub Pages and Actions are free for public repos.

## Changing the party compositions

Slots and classes are in `site/app.js` (`COMPS`, `NUKERS`, `ARCHERS`, `TANKS`, `DDS`). The Worker keeps the allowed classes per party type in `worker/src/index.js` (`COMP_CLASSES`). Change both and push.

## Local test (optional)

```sh
cd worker
printf 'PARTY_KEY=testkey123\nADMIN_KEY=adminkey123\n' > .dev.vars
npx wrangler@4.20.0 dev --port 8787
# in another shell, serve site/ on http://localhost:8000 with config.js set to http://127.0.0.1:8787
# and connect-src in index.html changed to the same URL
```
