# Code Duet plan and review workflow

This is the operating contract for the advisor, not an automatic Markdown
orchestrator. Use the existing helper; do not invoke Improve Codex, install a
skill or start an executor merely because a plan exists.

## Select the canonical files

1. Read the user's execution authorization, project AGENTS.md, the existing
   index, active plan, latest checkpoint and actual working tree.
2. Reuse an established plans/README.md and plans/NNN-short-slug.md. Use
   advisor-plans/ only when plans/ has a different, established project purpose.
   Do not create a second directory for DeepSeek. If both directories appear
   to own ordinary plans, ownership is unclear, or neither has an established
   index, STOP and resolve the choice before dispatch.
3. Keep index columns Plan, Title, Priority, Effort, Depends on, Status and
   statuses TODO, ACTIVE, DONE, BLOCKED, STALE. Require one ACTIVE plan for
   execution. No ACTIVE or multiple ACTIVE means STOP; do not pick by recency.
   A TODO plan becomes ACTIVE only by the advisor under user authorization.
4. Read the actual prerequisites/checkpoint; preserve numbering, accepted blocks
   and missing gates. Historical improve_executor/gpt-6-luna/max is provenance,
   not DeepSeek settings. A substantive requirement for a specific executor
   must be resolved before dispatch, rather than silently reinterpreted.
5. Read the plan's correction count. A fresh, never-executed plan starts at 0.
   When adopting an existing plan from the other route or after missing state,
   import its established count with bind --correction-count N. Never invent
   zero for missing history. A conflicting saved/imported count stops; the
   helper does not overwrite it. Keep the count in the canonical checkpoint.

## Prepare one connected assignment

Confirm that the prior writer and known project-changing operations ended.
Runtime STOPPED or uncertain delivery is a blocker, not a reason to start a
fresh chat or another executor. On an explicit continuation request, first read
the checkpoint/diff and inspect old execution; no automatic recovery is supplied.

Record the pre-dispatch baseline in the plan: physical workspace/checkout, Git
HEAD and status, assigned paths, pre-existing dirty/untracked files and hashes
where needed, their owners, exact checks, acceptance gates and current route.
For non-Git work, record an explicit alternative baseline; never initialize Git
for the product. Ordinary source inspection and evidence collection are advisor
work before dispatch; capture enough to detect changes outside assignment.

Bind the actual current Codex chat to a new OpenCode session on first use;
reuse that same pair thereafter. Only opencode-go/deepseek-v4.1-flash with the
existing/default options. No model/billing fallback, automatic chat rotation,
subagents, new service or global agent configuration. The user creates a new
Codex chat manually; it does not reset the plan's correction count.

Use assignment-template.md for the next connected block. Fill all placeholders
and preserve the canonical plan path; the plan is reference, not permission for
unassigned steps. Keep the packet inside the chosen workspace, as helper submit
requires. Do not include the full GPT conversation, raw transcript or unrelated
plans. The route record names the actual OpenCode session/model/default options;
historical ordinary routes remain unchanged in the checkpoint.

Submit exactly once. Initial implementation uses --kind initial. A genuinely
new accepted block uses --kind block; a consolidated review correction uses
--kind correction. A new chat/continuation does not change a correction into
initial implementation. Never relabel fixes as a block to bypass the limit.

## Ownership and waiting

PREPARING: advisor prepares the next bounded assignment.
EXECUTING or WAITING_FOR_ANSWER: DeepSeek owns edits/checks. Codex does not edit
shared project files, plans or index, or run interfering checks. Only separate
technical bookkeeping and noninterfering investigation may continue.
Answer ordinary questions autonomously within scope; assess permissions against
the actual operation and governing approvals. Recheck pending requests and use
their exact reply route. Do not use OpenCode to bypass a sandbox/approval rule.

Keep wait in the same active tool turn with bounded host waits and required user
updates. Token deltas, submit admission, silence, timeout and final text alone
do not transfer ownership. Errors/limits/uncertain delivery stop; no automatic
reconnect, resubmit, service restart, model switch or rollback.

REVIEWING starts only with completed-for-review from gate 003: identified current
assignment final, ended bound execution, no pending tool/form/permission and all
known project-changing operations ended. Unknown status means STOP.
The helper rechecks that gate for next/finish and for changing plans; it does
not certify correctness of changes or authorize editing during execution.

## Review, correct or release

After the gate, compare actual diff/untracked files and the executor report with
the recorded baseline. Verify assigned behavior, preserve accepted work and
protected dirty files, and run proportionate independent checks. Record exact
commands, outcomes, source state, accepted contracts, missing gates and next task.
Passing a build/fixture does not satisfy required runtime/visual/owner acceptance.
The advisor alone decides acceptance; no helper operation changes Markdown.

For corrections: write one actionable consolidated list and updated checkpoint,
then next <workspace> <plan> correction and submit with --kind correction and
a fresh assignment ID. next only prepares; submit reserves the cycle immediately
before its one POST. Questions, checks, preparation and accepted new blocks do
not increment it. Up to 20 corrections after initial implementation, shared by
the physical plan across blocks/chats/explicit continuation.
An uncertain POST reserves one possibly delivered cycle and leaves STOPPED;
it is not automatically refunded/retried. Report that uncertainty in the plan.
After correction 20, still review normally. Accept if every applicable gate
passes; otherwise stop incomplete, with no cycle 21. Do not substitute the
ordinary two-failure correction threshold or weaken scope/acceptance criteria.

For a next accepted connected block: checkpoint the acceptance and remaining
gates, call next ... block, then submit --kind block with a fresh assignment ID.
For releasing this confirmed-ended assignment: checkpoint its actual acceptance
or explicit handoff, then finish <workspace> <plan>. FINISHED releases only this
adapter assignment, not the whole MD plan. Missing gates keep the plan ACTIVE
(or BLOCKED with a reason), never DONE. finish sends no engine prompt.

A later plan in the same physical workspace reuses the pair: finish the previous
assignment, update the canonical files, then bind the new plan. Counts for both
plans remain; other workspaces/checkouts are not silently substituted.

## Handoff to or from the ordinary route

Handoff is a deliberate advisor decision within user authority, never fallback
after failure. Confirm the former writer ended, inspect the same files/diff,
preserve accepted blocks/protected changes/count/pending gates, and append the
new route and exact next assignment to the existing checkpoint. Release the old
adapter assignment with finish only after that confirmation. The ordinary route
receives those same canonical files; do not copy plans, fake a live Codex ID,
transfer a session, invoke another agent, or erase prior history.
Use the ordinary route's own authority/constraints when it is later selected.

## Final checkpoint and report

Record assigned/accepted blocks, executor claims versus verified results, changed
files, baseline/protected-file outcome, route/model/session/options, correction
count (including uncertain reserved delivery), commands/results/source state,
all missing gates/blockers and one exact continuation point.
Mark DONE only after all required acceptance; update the canonical index then.
Do not invent defect counts or accept a claim solely because DeepSeek reports it.

Report what was accepted, what corrections were made, actual checks and missing
work. Stop at the user's authorized boundary. The adapter does not commit, push,
merge or switch branches in operated projects; those need separate authority.
