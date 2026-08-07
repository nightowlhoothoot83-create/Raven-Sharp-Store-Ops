# Raven Sharp Store Ops

A private, phone-friendly Cloudflare Worker for managing an Etsy seller shop through Etsy's official Open API v3.

## Version 1

- Secure Etsy OAuth 2.0 + PKCE connection
- View active shop listings
- View and create shop sections
- Move existing listings into sections
- Refresh expiring Etsy access tokens automatically
- No automatic publishing
- No Etsy credentials stored in GitHub

## Cloudflare deployment

Connect this repository to **Workers & Pages → Create → Continue with GitHub**.

Use:

- Build command: leave blank
- Deploy command: `npx wrangler deploy`

After the first deployment, open the Worker URL. It shows the exact Etsy callback URL and which secrets still need to be added.

## Required Cloudflare secrets

Add these under **Worker → Settings → Variables and Secrets**:

- `ETSY_KEYSTRING`
- `ETSY_SHARED_SECRET`
- `SESSION_SECRET` — a long random value used to encrypt the browser session

Never commit those values to GitHub.

## Etsy callback URL

After Cloudflare deploys the Worker, register this exact callback in the Etsy developer app:

`https://YOUR-WORKER.workers.dev/auth/callback`

The URL is case-sensitive and must match exactly, including the absence of a trailing slash.

## Safety

Version 1 can organise listings but cannot publish a listing. Later versions can add draft creation, image uploads, digital-file uploads, metadata generation, and bulk editing while keeping final publication manual.
