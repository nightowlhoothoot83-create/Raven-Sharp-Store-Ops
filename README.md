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
- Publishing only after explicit owner confirmation, with session, CSRF, ownership and draft-readiness checks
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

## Active entrypoint and publish safety

`wrangler.jsonc` selects `src/agent-publish.js`. This wraps the listing-management and agent-create layers. `src/index.js` is an older implementation, not the configured deployment entrypoint; `src/publish.js` is an alternative implementation and is not selected either.

The active source includes `POST /agent/listings/:id/publish` and a final-review button. It can request `state=active` only after the connected-shop session, same-origin/CSRF checks, explicit `confirm_publish=yes`, listing ownership, draft state and required content checks pass. Listing creation starts as a draft. This is not an autonomous publishing schedule.

After an accepted publish request, Raven reads the listing back and confirms that the same owned listing is active before displaying success. If verification fails or returns no listing, Raven reports an uncertain result and asks the owner to check Etsy before retrying. It does not automatically repeat publication.

Source configuration does not prove which version is currently deployed. Live Etsy OAuth and posting require separate owner-approved testing; no real listing publication is performed by the offline tests.

## Offline verification

Run `npm test` with a current Node.js runtime. The tests use synthetic encrypted sessions and mocked Etsy responses; they never contact Etsy, generate paid content or publish a listing.

