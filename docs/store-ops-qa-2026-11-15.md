# Store Ops cross-site repair — independent QA

Date: 2026-11-15. Read-only inspection of `/workspace/store-ops-fix`; parent owns source/test changes. No live listing writes, OAuth, publication or paid jobs executed.

## Baseline and instructions

Read README, `docs/manager-hub-integration-contract.md`, active worker and security source. No AGENTS.md was found in the workspace recursive search or target checkout. Main starts at `4b6b1f3`, merging reviewed publish verification work. `wrangler.jsonc` selects `src/agent-publish.js`, which wraps agent-create → agent → app. Older index/publish alternatives are not deployment entrypoints. Existing branch-only documentation does not independently authorize mutations.

Baseline `npm test` passed one file-level Node test report; direct `node test/publish-verification.test.mjs` passed seven cases. Existing tests mock Etsy and never contact live services.

## Cause assessment

Exact error `Cross-site requests are blocked.` originates in `verifySameOrigin(request)`: every nonempty Origin different from `new URL(request.url).origin` is rejected. All inspected forms use relative same-origin action URLs. Active HTML `pageHeaders()` in app.js sets `Referrer-Policy: no-referrer`; wrappers preserve it. Independently reproduced the mechanism in real Chromium using intercepted synthetic HTTPS pages and native form posts: `no-referrer` produced `Origin: null` without Referer; `same-origin` produced `Origin: https://store.test` and the same-origin page Referer. Repro script: `/workspace/qa-work/store-origin-repro.cjs`. No external network or Etsy/model call was made. This confirms the code defect's browser mechanism; it is not a captured trace of the user's earlier session.

Recommended minimal repair: use `Referrer-Policy: same-origin` for the app document and preserve strict same-origin checks. This retains same-origin browser request identity while withholding Referer on external destinations. No null-Origin exception or trusted-origin list is needed. Avoid accepting arbitrary origins, forwarded host headers, wildcard subdomains, or `Origin: null` merely because session cookies exist. Keep session-bound CSRF and listing ownership checks on every mutation.

## Required regression scope

- Allow same-origin valid form submission; preserve relative action targets and correct redirect.
- Reject foreign non-null Origin even if Referer or Fetch Metadata claims same-origin.
- For opaque/null Origin, exercise correct same-origin Referer, wrong Referer, missing Referer, malformed URL and conflicting Fetch Metadata.
- Cover absent Origin, explicit `Sec-Fetch-Site: cross-site`, scheme/port differences, malformed and lookalike origin strings, userinfo and comma-separated values.
- Assert rejected context produces zero Etsy mutations and zero paid model calls.
- Keep missing/wrong CSRF, invalid session, unowned listing, absent explicit publish confirmation, missing draft assets and uncertain publish read-back rejected.
- Test the configured wrapper entrypoint, not only the helper or historical implementation.

## Limits

No production deployment version, real logged-in browser Origin/Referer headers, live edit/save or Etsy draft delivery verified by this report yet. A passing mocked route establishes regression coverage only.

## Reviewed repair and independent results

Reviewed parent changes in `/workspace/store-ops-fix`: sole runtime change in app.js is `Referrer-Policy: no-referrer` → `same-origin` plus explanatory comment. `src/security.js` is unchanged. No arbitrary-origin acceptance, null-Origin exception, proxy header trust, session or CSRF weakening introduced. Existing CSP/form-action/frame protections retained. Development-only Playwright is pinned with a lockfile; CI runs ordinary software regression testing, not commercial content jobs.

Independently ran `npm test` (two file-level reports pass), then direct files for accurate case counts: same-origin suite **2 passed**, publish verification suite **9 passed**. Hostile, opaque, scheme-mismatched and port-mismatched origins cannot publish with otherwise valid session/CSRF; missing session and wrong CSRF remain blocked. Existing explicit confirmation, ownership and uncertain-read-back cases pass.

Independently ran `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`: **passed**. This exercises configured agent-publish entrypoint through a real local HTTP bridge and native browser form submission: GET listing editor → title edit → POST update → one mocked Etsy PATCH → saved-without-publishing notice. Asserted PATCH lacks `state`; native POST Origin equals local app origin. Then GET dashboard → native logout → session cookie removed. Global provider fetch is mocked and browser external requests aborted; no Etsy/AI calls escaped. This is stronger than helper-only testing but still not a live authenticated shop write.

No blocking finding in reviewed cross-site repair. Parent's release/deployment and handoff additions remain outside this acceptance until separately inspected. No QA source changes, live writes or production modifications were made by reviewer.

## Bounded export handoff review

Read `tools/prepare_runable_handoff.py`, `test/runable_handoff_test.py`, and `docs/runable-handoff.md` at `07788e8`. Independently ran Python unittest discovery: nine tests passed. Inspected actual prepared kit `c7846d05e670c1ccdfb2d1485ddfd65148756afee36030ddea483fc13882bef1`: product ZIP is 147,037 bytes, CRC passes, its exact six members match manifest, every product/preview/ZIP byte count and SHA-256 matches, previews are separate, and manifest correctly retains prepared/unuploaded/unpublished/null-income states. Tool has no network, execution, extraction or upload functionality. Documentation correctly limits checks to basic signatures/bounded ZIP-document structure rather than full content validation or real Runable integration.

One reproducible overlap bug was sent to parent: raw argument intersection missed repeated-slash aliases such as product `nested//art.png` plus preview `nested/art.png`. Parent corrected the intersection to normalized selected names and added a regression confirming rejection before output. Independently reviewed the correction and reran **ten tests: passed**. Existing actual kit has no overlap. No remaining blocker found for the bounded local packaging capability; this is not signoff for real Runable integration or Etsy upload.

Parent reports PR #2 deployed automatically and live root has corrected header; independent QA here verified local runtime/browser behavior, not Cloudflare deployment metadata. No live shop save/delivery or Runable account API/schema was verified.
