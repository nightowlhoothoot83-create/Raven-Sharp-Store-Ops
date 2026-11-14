# Publish-result verification repair

Validated 12 November 2026 against the configured `src/agent-publish.js` entrypoint. No real Etsy requests, publication, paid generation or deployment occurred.

The old code treated an accepted publish request as successful when the follow-up listing read failed or returned no content. Tests reproduced two false-success cases before the repair. The repaired route requires a non-empty response, matching listing/shop ownership and state `active` before showing the success notice. Unknown results tell the owner to check Etsy before retrying; no automatic retry is introduced. A verification failure does not prove the publication failed, and must not be treated as permission to publish again.

Seven offline route tests pass using encrypted synthetic sessions and mocked HTTP responses. They cover verified success, network failure/empty read-back, inactive state, changed ownership, absent confirmation, wrong CSRF and an unowned draft. Tests against the original code passed five and failed two; repaired code passes seven. Syntax check passed. README now describes the real selected entrypoint and manually approved publish path; the older index.js and alternative publish.js are left untouched.

The PR retains the pre-existing Manager Hub integration-contract document. That document remains a design proposal, not a working hub integration. Live deployment version, OAuth refresh, owner login and real listing behaviour still require separately approved verification.
