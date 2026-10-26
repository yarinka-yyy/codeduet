# Ordinary shared plan template

Use only for authorized new planning after resolving canonical-directory
ownership. Preserve existing plans in place; do not replace their history.
Fill the fields with project facts and commands before assignment. This follows
ordinary Improve Codex sections, with the external route recorded explicitly.
No installed Improve Codex files or agent profile are required.

```markdown
# Plan NNN: <concrete intended result>

> **Executor instructions**: Implement only the assigned connected block.
> The advisor owns plan/index/checkpoints. No commit, push, merge, branch
> change, delegation, scope expansion or unassigned blocks.
>
> **Drift check (run first)**: Compare actual status, assigned-path diff and
> untracked files with <baseline SHA/declaration> and the accepted checkpoint.
> Protect <pre-existing changes/owners>; stop on unexplained drift.

## Status
- Status: TODO; Priority: <P1/P2/P3>; Effort: <S/M/L>; Risk: <LOW/MED/HIGH>.
- Depends on: <canonical paths or none>; Category: <project category>.
- Planned at: <actual commit/declaration and date>.

## Why this matters
<Problem, concrete cost and intended improvement.>

## Current state
<Relevant exact files/symbols, actual behavior/excerpts and existing conventions.>

## Connected assignment and prerequisites
<Overall goal, accepted prerequisites/contracts, assigned steps/allowed paths,
protected dirty state, exact physical checkout and canonical plan path.>
Route: OpenCode <actual session>, opencode-go/deepseek-v4.1-flash, default options.
Preserve prior ordinary executor/profile records as history.

## Commands you will need
<Exact verified commands and expected results; install only if authorized.>

## Scope
<Allowed files/contracts, protected files and explicit assignment boundary.>

## Git workflow
<User-selected physical checkout. Return uncommitted diff; no publication
or branch switching by the executor. Advisor publication needs user authority.>

## Steps
1. <Concrete action on named files/symbols>. Verify: <command/result>.
2. <Next connected action and verify>. Stop at the assigned boundary.

## Test plan
<Meaningful behavior/regression checks, existing test pattern and edge cases.>

### Verification schedule
| Gate | Owner / when | Command or procedure / expected result | Evidence path |
|------|--------------|----------------------------------------|---------------|
| Step | Executor | <targeted check> | <path> |
| Block | Executor | <block check> | <path> |
| Review | Advisor / confirmed-ended assignment | <actual diff + independent check> | <path> |
| Final | <runner>; advisor accepts | <integration/runtime/visual/owner checks> | <path> |

## Communication contract
Report assigned/completed steps, files, contracts, exact checks/source state,
known operations, remaining work and blockers. Claims alone are not acceptance.

## Done criteria
- [ ] Assigned behavior independently verified; protected changes preserved.
- [ ] Required integration/runtime/visual/owner gates satisfied.
- [ ] Advisor accepts all required work and updates the canonical index.

## STOP conditions
<Concrete drift, scope, ownership and permission risks. At most 20 consolidated
corrections after initial implementation; never weaken gates or send cycle 21.>

## Review checkpoint (advisor-owned)
- Accepted blocks/history: <facts>; current assignment/route: <exact IDs/options>.
- Correction count: 0 for a genuinely new plan; preserve/import existing count.
- Baseline/protected changes: <facts>; claims versus verified results: <facts>.
- Checks/evidence/source state: <commands/results>; pending gates: <facts>.
- Next: <one bounded continuation>; ownership: <confirmed current status>.

## Maintenance notes
<Relevant future interactions and explicitly deferred work.>
```

The advisor creates/updates the same canonical <plan-dir>/README.md index:

```markdown
# Implementation Plans
| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | <title> | P1 | S | — | TODO |
```

Keep TODO/ACTIVE/DONE/BLOCKED/STALE, one ACTIVE for execution, existing numbering
and accepted history. Add a reason for BLOCKED/STALE; runtime phases are not
index statuses. Missing required gates leave work unfinished.
