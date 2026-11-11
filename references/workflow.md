# Code Duet plan and review workflow

This is the operating contract for the advisor, not an automatic Markdown
orchestrator. Use the existing helper for managed delivery. Do not invoke
Improve Codex, install a skill or start an executor merely because a plan exists.

This file is the single source for authorization, route, baseline, assignment,
ownership, waiting, review, corrections, handoff and checkpoints. The helper's
API, state and error behavior live in [the protocol](../helper/PROTOCOL.md).
Use its command index and only the technical sections needed for the operation.
The [runtime check](runtime.md#check-an-installed-helper) is for an unknown
Node/helper path or connection; package procedures are for assigned packaging
work. Read [existing-session routing](existing-session.md) only when the user
explicitly selected an existing recipient, and the assignment template only
when preparing a packet.

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
5. A new explicit Code Duet selection starts its own correction cycle at zero
   through `start-cycle` after task maintenance. Older plan corrections remain
   history; never import them into the new cycle. An observer wake or automatic
   continuation is not a new selection and must not reset the count. Keep the
   current cycle count in the canonical checkpoint.

## Prepare one connected assignment

Before submit, choose how the result will return to this chat. Pass
`--codex-exe <absolute Desktop-bundled Codex executable>` for observer delivery,
or `--manual-observation` for the foreground wait/resume route. An invalid chat
ID or unavailable queue capability blocks automatic submission before an OpenCode request.

Confirm that the prior writer and known project-changing operations ended.
Runtime STOPPED or uncertain delivery is a blocker, not a reason to start a
fresh chat or another executor. On an explicit continuation request, first read
the checkpoint and inspect old execution. For observation of a delivered
assignment, use explicitly authorized [observer arm --resume](../helper/OBSERVER.md).
It preserves delivery and count. For a retained PostgreSQL log, use the
[evidence route](../helper/PROTOCOL.md#resume-observation) in the original chat.
For explicit closure without acceptance, use [close-assignment](../helper/PROTOCOL.md#close-assignment).
It prepares a separate correction in the same binding. Use a fresh assignment
ID and the existing counter, and record the old run as closed without acceptance.

Record the pre-dispatch baseline in the plan: physical workspace/checkout, Git
HEAD and status, assigned paths, pre-existing dirty/untracked files and hashes
where needed, their owners, exact checks, acceptance gates and current route.
For non-Git work, record an explicit alternative baseline; never initialize Git
for the product. Ordinary source inspection and evidence collection are advisor
work before dispatch; capture enough to detect changes outside assignment.

Run the helper's read-only preflight <workspace> <plan> after selecting the
canonical plan and physical workspace. It checks the actual current Codex chat,
the saved pair or proposed new-bind route, plan/count/baseline and available live
state in one result. With no pair it proposes a new OpenCode session unless the
user explicitly selected an existing recipient; for that case pass the exact ID
with --session and follow [existing-session routing](existing-session.md).
Beginning in an already-used Codex chat is supported. Code Duet dispatches with
opencode-go/deepseek-v4.1-flash at High reasoning. No model/billing fallback, automatic chat rotation,
subagents, new service or global agent configuration. The user creates a new
Codex chat manually; only a new explicit selection starts a new cycle.

Preflight is read-only and reports pass, blocked and unknown checks plus the
exact next step. It does not create a recipient, change helper state, test
writability or send a task. A pass is a snapshot, not authority: bind/adopt and
submit recheck current state. An explicit exact recipient needs no second
confirmation.
For an accepted but unavailable prior session, follow preflight's
[replacement route](../helper/PROTOCOL.md#replace-an-unavailable-accepted-session).
Continue from the accepted checkpoint in the empty project session.

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

For an explicitly selected task sent manually outside the helper, use the
[passive observer](../helper/OBSERVER.md#observe-manually-started-work).
It notifies without acquiring implementation ownership or changing helper state;
ordinary adoption, submission and correction gates remain unchanged.

PREPARING: advisor prepares the next bounded assignment.
EXECUTING or WAITING_FOR_ANSWER: DeepSeek owns edits/checks. Codex does not edit
shared project files, plans or index, or run interfering checks. Only separate
technical bookkeeping and noninterfering investigation may continue.
Answer ordinary questions autonomously within scope; assess permissions against
the actual operation and governing approvals. Recheck pending requests and use
their exact reply route. Do not use OpenCode to bypass a sandbox/approval rule.

After delivery arm the [event observer](../helper/OBSERVER.md) in this same chat.
Once it confirms readiness, finish with a short waiting notice and end the turn.
Do not keep a tool wait or schedule model heartbeats/status polls. The ordinary
Node process waits; only a result, question, permission request or failure queues
one wake hint. Consume its receipt, recheck live state and handle the actual
outcome. After a scoped answer/reply, rearm and end the turn again. A stale event
may return observing: rearm the unchanged assignment without resending it.
A failed startup or uncertain queue result requires diagnosis, not another launch.
If a read is temporarily unavailable or the execution snapshot changes during
consume, retry with the same receipt. If the receipt returns observing, rearm
for the same delivery.
Token deltas, submit admission, silence, timeout and final text alone
do not transfer ownership. Follow the helper's diagnostic and [wait and phase
rules](../helper/PROTOCOL.md#wait). The helper can continue through HTTP after a
recoverable SSE disconnect. Let it check the same delivery without polling it
yourself. Never retry a delivery POST, restart services, switch models or roll back.
The foreground wait/resume-watch commands remain diagnostic/manual alternatives;
do not silently use them when event waiting is unavailable. No Windows service,
autostart, recurring automation or changes to Codex settings are required.

REVIEWING starts only with completed-for-review from gate 003: identified current
assignment final, ended bound execution, no pending tool/form/permission and all
known project-changing operations ended. Unknown status means STOP.
The helper rechecks that gate for next/finish and for changing plans; it does
not certify correctness of changes or authorize editing during execution.
The documented binary-read, webfetch GET429 and confirmed prelaunch file-search
warnings can pass this gate while
remaining in toolErrors with semanticRecoveryVerified:false. Check all warnings
against actual evidence before accepting work or preparing a correction. A
completed fallback, successful idle or empty search result does not prove that
the missing information was obtained. Unknown errors and uncertain writes block.
When a blocked delivery includes `report`, read it for diagnosis and planning.
Keep the process guard and wait for `completed-for-review` before acceptance or
another assignment.

## Review evidence and decide acceptance

For helper-managed work, begin after the review gate above. Apply the same
checks to [manual handoffs](#manual-assignment-and-review).

1. Compare the report with the actual diff and untracked files against the
   recorded baseline. Confirm scope, accepted work and protected dirty files.
   Trace the changed path from its entry point to the observed effect. Check
   existing callers, especially error handling, fallbacks and when writes occur.
2. Match each required criterion to what the check actually exercised and
   asserted. Keep separate claims separate: memory and database agreement can
   hold after one of two concurrent writes was lost, and trusting a proxy CA
   says nothing about whether the proxy rejects an untrusted upstream certificate.
   Function, API, built application, UI and owner checks each cover their own
   layer. A skipped required scenario remains open even with exit 0.
3. For material risks, independently rerun the key scenario or write a minimal
   probe. Check the intended outcome and any required absence of side effects
   using isolated resources, such as a second local server that receives no
   secret or an isolated database instead of someone else's database. Record
   the commands, outcomes, source state and evidence. Distinguish product
   failures from unavailable fixtures, permissions or other environment blockers.
4. In the same review, trace calls to new functions and check for duplicate
   rules or validation, unnecessary parameters and copies, and unjustified
   dependencies. Check whether an existing mechanism or standard API suffices.
   For each actionable finding name the file, consequence and smallest fix.
   Style preferences and unrelated refactors do not warrant a correction round.

Give one verdict: accepted, corrections required, or blocked with the missing
prerequisite. Accept only when all mandatory criteria and applicable gates are
satisfied. `READY FOR REVIEW` leaves any unmet criterion open. Record positive
results with their actual coverage and give one consolidated list if fixes are
needed. The advisor alone decides acceptance; no helper operation changes Markdown.

## Manual assignment and review

When the user chooses to carry the assignment and report by hand, use the
[assignment template](assignment-template.md) with the same scope, baseline,
criteria and executor instructions. Use the canonical plan if supplied,
otherwise use the agreed assignment. Omit transport fields (packet header,
OpenCode session/model and helper correction count). The user handles the
transfer. Codex applies the review above to the supplied report and actual
changes once the executor and any project-changing operations have ended.
Missing evidence keeps the affected criterion open.

This route uses no helper or OpenCode calls. It does not release, adopt or
change any existing assignment, status, ownership or counter. Work under an
existing helper-managed delivery still follows its ownership and review gates.

## Correct or release

For corrections: write one actionable consolidated list and updated checkpoint,
then next <workspace> <plan> correction and submit with --kind correction and
a fresh assignment ID. next only prepares; submit reserves the cycle immediately
before its one POST. Questions, checks, preparation and accepted new blocks do
not increment it. Up to 20 corrections are counted in the current explicit
selection, not from the task's earlier history.
An uncertain POST reserves one possibly delivered cycle and leaves STOPPED;
it is not automatically refunded/retried. Report that uncertainty in the plan.
Run `reconcile <workspace> <plan>` from the owning chat to check an uncertain
create, prompt, reply or model selection against OpenCode. It sends no task.
If the exact session, delivery, answer or model change cannot be established,
preserve STOPPED and the saved reservation.
After correction 20, still review normally. Accept if every applicable gate
passes; otherwise report the limit and remaining work, then stop. A new explicit
selection starts the next cycle at zero; do not silently continue or send a 21st
correction in the old cycle. Do not substitute the
ordinary two-failure correction threshold or weaken scope/acceptance criteria.

For the next authorized block or plan, checkpoint the actual result and run
preflight for the destination plan in the chat that will continue. When preflight
offers `transition`, use the reported prior message ID and the recorded disposition.
Use `accepted` only after review confirms acceptance. If the user explicitly leaves
the prior work without acceptance, record `blocked` for a BLOCKED result or
`without-acceptance` otherwise. Starting another task alone does not decide review.
When preflight reports a blocker, keep the old owner and resolve that fact before dispatch.

`transition` prepares the authorized block or plan in the same physical workspace
from either chat, with the existing OpenCode session. Repeat preflight, then submit
separately with a fresh ID and the prepared kind. A new plan starts with `initial`.
The previous plan's history, status and correction count are preserved. No manual
`finish` or counter reset is part of this route. Use `finish` for a standalone
release after review when there is no next Code Duet assignment to prepare.

After an OpenCode restart changes the engine registration, use
`rebind-engine <workspace> <plan> <message-id> --session <session-id>` to
verify the exact delivery and resume in the same phase with the same count.
A running legacy delivery without a saved prompt checksum requires review of
the original session before switching engines.

Use `acceptance-status <workspace> <plan> <message-id> [--index <index.md>]`
to verify the runtime receipt, the `<!-- code-duet-accepted msg_… -->` line
and the plan index independently. For a moved accepted plan, pass
`--moved-prior-plan <absolute-path>` to `transition` after verifying the
receipt and plan identity.

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

After accepting a delivery through `finish`, `next`, or an accepted `transition`,
add `<!-- code-duet-accepted msg_... -->` to its Markdown review checkpoint.
If interrupted between edits, run `acceptance-status <workspace> <plan> <message-id>
--index <index.md>` to compare the exact runtime receipt, checkpoint marker, and
index row. Complete the missing edit only after confirming the review and all
remaining gates. For a FINISHED prior plan moved within the workspace, pass its
new absolute path as `transition --moved-prior-plan`; the original acceptance
receipt and unchanged plan identity are required.

Record assigned/accepted blocks, executor claims versus verified results, changed
files, baseline/protected-file outcome, route/model/session/options, correction
count (including uncertain reserved delivery), commands/results/source state,
all missing gates/blockers and one exact continuation point.
Mark DONE only after all required acceptance; update the canonical index then.
Do not invent defect counts or accept a claim solely because DeepSeek reports it.

Report what was accepted, what corrections were made, actual checks and missing
work. Stop at the user's authorized boundary. The adapter does not commit, push,
merge or switch branches in operated projects; those need separate authority.
