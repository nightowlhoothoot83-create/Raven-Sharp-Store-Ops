# Store Ops / QA Manager Hub Integration Contract

Branch-only specification. No publishing, listing mutation, pricing change, ad spend, merge, deploy, or destructive action is authorised by this file.

## Goal

Store Ops and QA should appear inside Ascension Manager Hub as existing capability sources, not be rebuilt as duplicate automation systems.

## Manager Hub data

Expose, where available:

- service/job health;
- last run;
- next run or manual-only state;
- findings;
- evidence;
- repair state;
- repo/commit reference;
- safe available actions.

## Contextual controls

Manager Hub may offer only actions supported by the underlying job and current state:

- Run / Rerun
- Retest
- Review evidence
- Create repair
- Dismiss
- Already fixed
- Pause / Resume where supported
- Schedule safe checks where supported
- Protect / Require Approval where enforceable
- Approve only at an actual approval gate

Publish, merge, deploy, spend and destructive listing changes remain gated and must never be inferred from a successful QA result.

## Repair lifecycle

Store/QA failures should map into the common Hub repair states:

Open → In Review → Repair Proposed → Testing → Ready for Approval → Resolved

Alternative terminal state: Dismissed.

`Already fixed` and `Dismiss` preserve history/evidence.

## Acceptance criteria

- Store Ops and QA status can be viewed from Manager Hub.
- Failed QA can create/update a repair request.
- Rerun/retest can be triggered only where the underlying workflow is safe and configured.
- No duplicate scheduler is introduced when an existing workflow already owns the schedule.
- Any publishing or external mutation remains separately approval-gated.
