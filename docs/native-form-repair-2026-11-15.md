# Native form repair — 15 November 2026

The live app served `Referrer-Policy: no-referrer`. Chromium applies this to native non-CORS form POSTs by sending `Origin: null`, including same-origin submissions. The existing strict Origin check correctly rejected that value, producing the owner's “Cross-site requests are blocked” error. This was reproduced with a real browser and synthetic session before changing source. It does not prove Etsy OAuth was disconnected.

Changed the page policy to `same-origin`: same-origin forms retain their real Origin, while navigation to external sites does not include a Referer. `security.js` is unchanged: hostile origins and `null` are rejected, even with a forged Referer. CSRF, encrypted sessions, shop ownership and explicit reviewed publication controls remain intact. No CORS wildcard, Runable origin allowlist or embedded-frame bypass was introduced.

## Evidence

- 11 Node route/security regressions pass, including hostile/opaque/scheme/port origins, missing session, bad CSRF, ownership, explicit confirmation and publication readback failures.
- `npm run test:browser` uses the selected production entrypoint, real browser/native forms, synthetic encrypted session and in-memory Etsy fixtures. It saves an edited listing through the real UI/route, asserts exactly one mocked PATCH without a publication state, and signs out. All outbound provider network calls are intercepted in memory; no Etsy or AI call occurs.
- Before repair the browser sent `Origin: null` and the regression failed. Afterwards it sends the actual app origin and the route completes. Independent QA reproduced the browser mechanism and verified the repaired full journey.
- CI installs locked tools and runs the same browser regression. `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser` uses a preinstalled compatible browser locally; CI installs Playwright's pinned browser.
- Wrangler dry-run packaging passes using locally resolved 4.162.0 (existing `^4.0.0` range, now lockfile-backed). No runtime compatibility-date change.
- Live baseline source-map SHA-256 values for all seven included source files exactly matched Git main before this repair. Prior live version: `7b8efc04-a1f8-4745-9997-6078a6e10dad`, deployment `5faab1be-3643-4a62-8ce0-ccbfb144d65a`. Retain for rollback. Code rollback does not undo Etsy mutations.

## Release and limits

Target only existing `raven-sharp-store-ops` Worker and its existing workers.dev route. Preserve secret bindings, runtime configuration, observability and routes; no new subscriptions, secrets or account permissions. Record the new version and verify live HTML headers/health after deployment. Actual owner-authenticated Etsy editing must still be verified separately; synthetic browser tests do not establish real Etsy delivery or publication.

To retry after release, open the listing editor directly and refresh it so the new document policy is applied. An already-open tab can retain its old policy until reloaded. Do not disable browser security or disconnect/reconnect Etsy solely because of this error.

Runable is separate from this browser-session API. Its account consent and actual connector schemas are not available here. Do not share session cookies or API secrets in workflow files, import/rebuild the whole application, relax same-origin checks, or equate a generated file with a verified Etsy draft. See the compatibility evidence and file handoff documentation for supported preparation work.
