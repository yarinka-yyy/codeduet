# Plan 001: preserve trimming and add uppercase

> **Executor instructions**: Implement only assigned block 2 after authorization.
> The advisor owns canonical plan/index/checkpoints. Do not commit, push,
> merge, change branches, delegate or implement later blocks.
>
> **Drift check (run first)**: Read Git status and the accepted checkpoint.
> Preserve the user's existing dirty protected.txt and all accepted block 1.

## Status

- Status: ACTIVE; Priority: P1; Effort: S; Risk: LOW.
- Depends on: none; Category: dx.
- Planned at: fixture Git HEAD recorded by the walkthrough before dispatch.

## Why this matters

The accepted trim behavior must survive adding uppercase output. A passing
source check does not prove the separate required runtime/owner acceptance.

## Current state

label.mjs exports label(value) using String(value).trim().
protected.txt is user-owned and already dirty at dispatch.

## Connected assignment and prerequisites

Block 1 (trim) is accepted. Block 2 adds uppercase while preserving whitespace
trimming. Historical route: improve_executor / gpt-6-luna / max. This is history,
not a substantive executor requirement or DeepSeek model configuration.
The next selected route is recorded by the advisor in the existing checkpoint.

## Commands you will need

Import label.mjs and assert label(' alpha ') equals 'ALPHA'.
The walkthrough executes this real assertion independently of engine claims.

## Scope

Only label.mjs may be changed by the executor. protected.txt, plans/ and packets
are protected. Later runtime/owner gate remains outside this fixture assignment.

## Git workflow

Use the provided current checkout. No branch changes, commits, pushes or merge.
Return an uncommitted diff for advisor review.

## Steps

1. Accepted block 1: trim the input. Preserve it.
2. Assigned block 2: uppercase the trimmed string.
3. Required later runtime/owner acceptance: NOT_RUN; advisor/user owns it.

## Test plan

Assert both plain and padded input. Check actual diff and protected-file hash.
A build-only result does not satisfy step 3.

### Verification schedule

| Gate | Owner / when | Procedure / expected result | Evidence path |
|------|--------------|-----------------------------|---------------|
| Step | Executor | label(' alpha ') -> ALPHA | fixture report |
| Review | Codex / ended assignment | independent import/assert + diff | checkpoint |
| Final | Owner / later runtime | NOT_RUN; keep ACTIVE | checkpoint |

## Communication contract

Return assigned/completed steps, files, contracts, commands/results, background
operations and missing gates. An executor claim is not acceptance.

## Done criteria

- [x] Accepted block 1: trimming.
- [ ] Block 2 independently reviewed.
- [ ] Runtime/owner acceptance.

## STOP conditions

Unexpected drift, protected files at risk, new permission/scope or lost history.
Do not weaken missing gates after reaching the correction limit.

## Review checkpoint (advisor-owned)

- Accepted history: block 1 trim, ordinary route improve_executor/gpt-6-luna/max.
- Correction count: 0 (initial fixture baseline).
- Protected state: user dirty protected.txt; hash captured before dispatch.
- Pending: block 2; runtime/owner gate NOT_RUN.
- Next: authorized block 2 through the selected route.

## Maintenance notes

Keep the canonical paths and accepted history during route changes. Missing
runtime/owner evidence keeps this plan unfinished.
