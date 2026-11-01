# Saka Fleet — Landing Site Deployment Guide (Hostinger, shared hosting)

This walkthrough deploys the `landing/` directory (the sakafleet.com marketing
site) to Hostinger shared hosting over FTP via GitHub Actions. The backend
repository never reaches Hostinger — only static files do.

## What ships automatically

- `.github/workflows/deploy_landing.yml` runs on every push to `main` that
  touches `landing/**` (or the workflow itself), and can also be run manually
  from the Actions tab ("Deploy Landing to Hostinger" → Run workflow).
- It uploads **only `landing/**`** into the FTP root you configure, preserving
  folder structure (`assets/`, `data/`), then exits. Old files that were
  removed from the repo are not deleted by FTP (use the hPanel file manager
  once, then deletions are rare for a static site).
- Until the three GitHub secrets below exist, the job **self-skips** — nothing
  fails, nothing deploys.

## Step 1 — Hostinger side (once, ~10 minutes)

1. In hPanel, add `sakafleet.com` as the main domain for your hosting plan
   (Websites → Add Website). Choose "Upload a website" as the website type.
2. Make sure the domain's DNS points at Hostinger: either use Hostinger's
   nameservers for the domain (Domains → sakafleet.com → Nameservers) or add
   the A record shown in hPanel at your current DNS provider.
3. Create an FTP account: **Files → FTP Accounts**. Create a dedicated user
   (e.g. `sakadeploy`), note its password, and note the FTP hostname shown
   (e.g. `ftp.sakafleet.com` or the server IP). The account's folder is
   `public_html` — leave it as the default.
4. Install SSL: **Security → SSL** → install the free Let's Encrypt
   certificate for `sakafleet.com`, then enable **Force HTTPS**. The site's
   `.htaccess` also redirects HTTP → HTTPS as a safety net.
5. (Optional, later) If you want a WhatsApp welcome message sent from the
   backend when a signup verifies, approve a template named
   `web_signup_welcome` in Meta Business Manager and set
   `META_WELCOME_TEMPLATE_NAME=web_signup_welcome` in the Cloud Run env. The
   site works fully without it — the wa.me link and Saka's greeting carry the
   welcome.

## Step 2 — GitHub side (once)

Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
| --- | --- |
| `HOSTINGER_FTP_SERVER` | FTP hostname from Step 1.3 (no `ftp://` prefix) |
| `HOSTINGER_FTP_USERNAME` | FTP username, e.g. `sakadeploy@...` |
| `HOSTINGER_FTP_PASSWORD` | FTP password |

Then either push to `main` or run the workflow manually from the Actions tab.

## Step 3 — Verify

- https://sakafleet.com/ (hero, pricing, changelog, live status widget)
- https://sakafleet.com/privacy.html and /terms.html
- https://sakafleet.com/llms.txt (AI summary) and /sitemap.xml
- The status card should show "All systems operational" (it probes
  app.sakafleet.com/healthz; CORS is open for sakafleet.com only).
- Signup: fill the modal → consent → expect a 6-digit email from
  security@reports.sakafleet.com → verify → wa.me button opens WhatsApp.

## Troubleshooting

- **Workflow skipped:** secrets missing — check the names exactly.
- **FTP 530/connection error:** hPanel FTP account disabled or wrong
  hostname; recreate and re-save the secrets.
- **Site shows Hostinger default page:** the FTP root had a default
  `index.html`; delete it once from the hPanel file manager.
- **Signup fails with CORS error:** the deployed backend predates v1.39.0 —
  redeploy Cloud Run from `main`.

## Alternative (documented, not primary): hPanel Git integration

hPanel → Websites → Manage → **Git** supports cloning the repo directly and
serving a subfolder. Caveats: it clones the WHOLE backend repo onto shared
hosting, offers no build step and weaker secrets hygiene — the FTP workflow
above is the recommended path.
