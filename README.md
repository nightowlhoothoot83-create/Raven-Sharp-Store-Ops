# Raven Sharp Store Ops

A private, phone-friendly Cloudflare Worker for managing an Etsy seller shop through Etsy's official Open API v3.

## Current version

- Secure Etsy OAuth 2.0 + PKCE connection
- View active, draft, inactive, expired, and sold-out listings
- Create shop sections and move listings between them
- Create new digital download listings as drafts
- Edit title, description, price, quantity, Etsy category, shop section, maker, made date, renewal, tax, and supply settings
- Edit up to 13 keywords/tags, materials, and styles
- Upload listing images and choose their rank
- Upload up to five Etsy digital files, with a maximum of 20MB each
- Refresh expiring Etsy access tokens automatically
- No automatic publishing
- No Etsy credentials stored in GitHub

## Cloudflare deployment

Connect this repository to **Workers & Pages → Create → Continue with GitHub**.

Use:

- Production branch: `main`
- Root directory: `/`
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

## Publish safety lock

The application contains no publish route or publish button. It never sends `state=active` to Etsy. New listings are created as drafts. Existing active listings can have their content updated, but their state is not changed.
