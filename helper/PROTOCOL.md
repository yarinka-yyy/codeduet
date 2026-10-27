# Helper — connection, binding, interaction, inspection and review

## Command reference

Use only the operation sections needed: [connection](#connection),
[binding and reuse](#binding-and-reuse),
[preflight](#preflight),
[explicit adoption](#explicit-existing-session-adoption),
[submit intent](#submit-intent), [wait](#wait), [resume observation](#resume-observation), [reply](#reply),
[completion](#completion), [inspection](#inspect-and-sessions) and
[plan transitions](#plan-review-transitions). Read
[diagnostics](#diagnostics) when interpreting a failure. Existing-session
discovery/adoption is conditional on the user's explicit recipient selection.

Node 24, built-in APIs only. The packaged skill still needs full live acceptance. All
commands emit one JSON outcome; STOPPED outcomes exit nonzero. The specific
kind distinguishes executor failure, interruption and connection uncertainty.
`admitted` means the engine accepted an inbox message, **not** completed work.

```text
node helper/cli.mjs inspect
node helper/cli.mjs inspect <absolute-workspace>
node helper/cli.mjs sessions <absolute-workspace> [--cursor <cursor>]
node helper/cli.mjs preflight <absolute-workspace> <absolute-plan.md> [--session <exact-id>] [--correction-count <0..20>] [--non-git-baseline <declaration>]
node helper/cli.mjs adopt <absolute-workspace> <absolute-plan.md> <exact-session-id> [--correction-count <0..20>]
node helper/cli.mjs bind <absolute-workspace> <absolute-plan.md>
node helper/cli.mjs bind <absolute-workspace> <absolute-plan.md> --correction-count <0..20>
node helper/cli.mjs submit <absolute-workspace> <absolute-plan.md> <assignment-id> <absolute-packet-file>
node helper/cli.mjs next <absolute-workspace> <absolute-plan.md> <block|correction>
node helper/cli.mjs submit <absolute-workspace> <absolute-plan.md> <fresh-assignment-id> <absolute-packet-file> --kind <block|correction>
node helper/cli.mjs finish <absolute-workspace> <absolute-plan.md>
node helper/cli.mjs wait <absolute-workspace> <absolute-plan.md> [--timeout-ms <ms>]
node helper/cli.mjs resume-watch <absolute-workspace> <absolute-plan.md> <assignment-id> <message-id> --session <exact-session-id> [--timeout-ms <ms>]
node helper/cli.mjs reply <absolute-workspace> <absolute-plan.md> <question|permission> <request-id> <absolute-answer.json>
```

Workspace, plan and packet arguments are passed as data; no shell interpolation
is used. Quote paths containing spaces/`&` when invoking the CLI. Plan and packet
must resolve to regular files inside the selected physical workspace. The
actual `CODEX_THREAD_ID` is required; there is no CLI override for chat identity.
Read-only inspect, sessions and preflight are exceptions: inspect reports binding
unknown without that variable; sessions returns directory-scoped candidates only.
Preflight uses the real current chat ID when available and never accepts an ID
that substitutes for it.
This helper sends packet contents only after an authorized caller chooses them;
it does not infer execution authorization from the mere existence of a plan.

## Connection

The shared `connection.mjs` also serves the original transport probe. It reads
the current user's `.local/state/opencode/service.json`, accepts loopback HTTP
only, rejects redirects, validates installed/API version 2.1.4 or 2.2.0 and the enabled
`opencode-go/deepseek-v4.1-flash` model. Credentials stay inside HTTP closures;
the exposed client, state, results and errors contain no auth/response-body data.
The default model variant is left unchanged. No second engine or fallback is
started, and no service/global configuration is changed.

Ordinary JSON requests use fetch with a twenty-second deadline. SSE alone uses
a dedicated node:http connection and a web-readable body; it does not inherit
fetch/Undici's body-idle timeout. The wait owns its handshake/total lifetime.
No SSE redirects, automatic reconnects or extra dependency are introduced.

Bootstrap retries are limited to registration plus parallel GET `/api/info` and
`/api/model`: at most three attempts total, with 500/1000 ms delays and a
30-second budget. The 20-second request timeout is clipped to that budget.
Only explicit timeout/reset/refused transport codes and HTTP 502/503/504 retry;
each attempt rereads registration. Access, malformed registration, 400/401/403/
429, schema/version/model/identity errors and unknown transport errors are
single-attempt failures. A failed parallel GET aborts its sibling. These retries
never replay create/prompt/reply POSTs and do not reconnect SSE.

Only the exact validated releases 2.1.4 and 2.2.0 are accepted; registration and
GET info versions must agree. A mismatch is a single-attempt `engine-version`
diagnostic with expectedVersions, observedVersion (numeric release or unknown)
and versionSource (registration or server-info). Inspect and preflight expose
the same safe fields; preflight names the mismatch and requires API revalidation,
rather than suggesting a connection retry. Untrusted version text is not echoed.

## Identity and persistence

One technical file: `~/.local/state/code-duet/state.json`, schema 1. It stores
bindings by Codex chat and counters by exact physical plan path/workspace. Each
binding contains workspace/checkout paths and filesystem identities, engine and
OpenCode session IDs, current plan, phase, and current assignment/message IDs.
There is no task transcript, password, Git baseline history or second task list.
Existing counter values are validated and preserved. The advisor imports an
established count when first adopting a plan; conflicting imports stop without
overwriting saved history. Count policy and operating contract are below.

Writes use a same-directory temporary file and atomic rename. The global
`state.lock` covers only synchronous store reload, validation and atomic update;
it never covers HTTP or SSE. Acquisition gets at most 7 exclusive-open attempts
under a 120 ms monotonic deadline, with nominal 1 ms waits between attempts, and only
retries `EEXIST` while acquiring this short lock. A persistent or crash-left lock
remains untouched and fails busy. Access and other filesystem errors are
single-attempt failures.
This does not lock the OS or prevent user edits to the project.

Long operations hold a separate per-checkout ownership lease. The lease prevents
a second observer/writer on the same binding or an overlapping checkout while
unrelated workspaces can proceed. It is released only by its owner after the
operation; a crash or unknown owner leaves it in place for explicit inspection.
Every post-network save reloads the store under `state.lock` and validates the
saved chat/session/assignment/message/phase before applying only its own change,
so another workspace's binding and counter are retained. Schema-1 bindings and
counters remain readable.

Lock acquisition fails before reading/changing state or any engine mutation.
Only EEXIST from exclusive lock creation means state-locked. Access failures
(EACCES/EPERM/EROFS/ERR_ACCESS_DENIED) report state-access; other directory/lock
failures report state-io. The validated diagnostic includes state-directory or
state-lock and an allowlisted errorCode, never raw paths, exception text or
credentials. An unknown code is omitted rather than echoed. These are local
stopped outcomes, not a replacement/reset of a saved STOPPED/uncertain binding.
A later stateLocked=false snapshot proves neither past lock ownership nor
current writability. No command/network retry, automatic unlock or alternate
store is introduced; the bounded state-lock acquisition above does not repeat an
operation.
See [runtime](../references/runtime.md) for host-approved access to the same shared store.

Git root discovery is read-only (`git rev-parse --show-toplevel`). Different
physical clones are not interchangeable; filesystem identities catch directory
replacement. For a non-Git project add `--non-git-baseline <declaration>` to
bind/submit: that exact, explicit baseline declaration must already occur in
the selected plan. The advisor owns its correctness and acceptance; the helper
does not initialize Git or treat declaration text as proof of file contents.

### Binding and reuse

First bind creates a new OpenCode session at the physical workspace. Explicit
existing-recipient selection instead uses adopt; see the conditional
[existing-session procedure](../references/existing-session.md). Repeated
bind in the same Codex chat validates/reuses that exact session. A new actual
Codex chat creates a new pair only if previous work is not executing, uncertain
or under review. Another selected workspace/plan is not silently substituted.
Plan reassignment requires FINISHED and another confirmation of stopped
execution. It reuses the same session only in the same physical workspace;
each plan retains its own counter. Changing workspace requires a fresh actual
Codex chat/pair, not silent reassociation.

Before submit, the helper verifies session/model/directory, forms, saved phase,
and all active session directory metadata. An active session anywhere within
the same Git checkout (including sibling subdirectories) blocks another writer;
unrelated projects are not touched. It reads their directory metadata only.

## Explicit existing-session adoption

sessions reads one page (limit 50) for the physical directory, returning bounded
ID/title/model metadata, nextCursor and exhausted. A truncated title is marked;
never infer an exact unique title match from it. Follow nonempty cursors until
exhausted, including on short pages. No current chat, store, lock, transcript
read or engine mutation is needed. Discovery is not binding or authorization.

adopt requires an exact session ID and a canonical plan. With no saved plan
counter, --correction-count N is required; with one, an omitted count preserves
it and a conflicting import fails. The advisor establishes the actual count.
Adoption checks physical/model identity and idle/interactive/overlapping writer
state, and reads only the latest exchange back to its user prompt with bounded
pagination. The shared completion gate must accept its final/idle/tools and
known shells. Empty history requires never-executed status. Unknown, archived,
failed/interrupted or changed state stops; no takeover or automatic recovery.

Message history uses limit=100/order=desc only for the first page; subsequent
requests retain limit=100 and pass the opaque cursor without order. OpenCode
2.1.4 rejects combining message cursor and order with InvalidCursorError/400.
The same reader serves adoption and current-assignment observation/review.

Native compaction records remain in that exchange: completed status, known
reason/time, fixed model/summary shape and a later successful terminal idle
are required before ownership transfer. A running compaction cannot complete;
a failed compaction remains a failure despite a later successful idle. Its
summary never replaces the assignment's final response or earlier tool checks.
Prior synthetic input is accepted only by existing-session adoption, with
known text/time and a completed final after that input. The reader still goes
back to the user prompt and checks every earlier tool. During a bound assignment,
only native AGENTS.md loading is recognized: exact instruction.paths metadata,
nested workspace paths and the native text envelope must match a preceding read
tool of this assignment and its running/completed time interval. A running read
may inject instructions before its completion is recorded; it still cannot pass
the final tool-completion gate. Other synthetic input stops coordination with
history-uncertain/history-correlation, known historyType and errorCode, without
private text, paths or metadata. This is correlation, not authenticated author
identity: arbitrary API/plugin metadata is not proof of origin. Unsupported history
diagnostics name only known API types; arbitrary type values are not echoed.
Foreground shell checks distinguish numeric stream redirection (2>&1) and
PowerShell call operators at statement/block starts from a trailing background
ampersand. Detached launchers, including Start-Process with an unverified wait/
kill branch, remain blocked; no general shell parser or process monitor is added.

An adopt failure inside the helper reports adoption.bindingState unchanged
until the final binding save is attempted; afterwards it is unconfirmed.
Both report adoption.engineMutation none: adoption never sends to the executor.
This refers to this call's binding JSON, not directory/lock creation or a
promise that other writers are idle. Inspect unconfirmed persistence before
any explicit continuation; no retry/reset is automatic. Exhausted bootstrap
failure leaves PREPARING/FINISHED unchanged, stops an active/review assignment
with its diagnostic, and never overwrites an existing STOPPED diagnostic.
If releasing the operation lease fails after the checks, the result keeps the
same adoption annotation: a new binding is unconfirmed, while reuse is
unchanged. The separate `ownershipReleaseFailure` does not replace the operation
outcome, and the lease remains for explicit inspection.

The short store lock encloses checks and atomic local saves; the ownership lease
spans the network checks. Identity, execution and latest message are reconfirmed.
No OpenCode create/prompt/rename
or model/config mutation occurs. A different/STOPPED/uncertain current pair or
another chat's binding to the selected session cannot be replaced. Repeating
the same valid prepared/finished adoption returns reused without rewriting it.

Legacy schema-1 bindings remain valid. An adopted binding adds optional adoption
with exactly variant (null or bounded string), lastMessageID and idleAt
(both null for a never-used session, otherwise ID and timestamp). No title,
prompt, response or transcript is persisted. Its saved variant must match the
live model before subsequent operations. An older package may reject this field.

Before each adopted submit, recheck the latest completed exchange and compare
the saved boundary, then normal identity/forms/ownership checks. External work
after preparation blocks dispatch even if it has already become idle. Accepted
next/new-plan transitions advance the boundary through the same review gate.
The new assignment/message ID excludes old finals/forms from wait/reply.
Count reservation, STOP, next/finish and completion policy are shared unchanged.
The remaining check-to-POST race against manual OpenCode actions is outside the
cooperative lock guarantee; there is no engine-wide session reservation.

### Submit intent

Create/submit intent is persisted as `STOPPED` with an uncertainty marker
**before** HTTP mutation. A lost response, crash, invalid ID or failed state
write cannot silently allow a duplicate. Only a confirmed response advances to
`PREPARING` (bind) or `EXECUTING` (submit). No automatic retries or recovery.
If the intent write was attempted but cannot be confirmed, the result is
`unconfirmed` and no POST is sent. If a POST succeeds but its final state save
fails, the result stays STOPPED/unconfirmed with the reserved IDs/count; later
calls cannot resend it.
An idle engine alone cannot authorize another submit: a recorded assignment
remains `EXECUTING` until the later completion/review gate accepts it.

## Wait

`wait` holds the per-checkout ownership lease and subscribes to the bound
session. It holds the global state lock only for short reload/check/save steps;
SSE and ordinary reconciliation requests run without it.
It returns one compact outcome: `question`, `permission`, `completed-for-review`,
`failed`, `interrupted`, `history-uncertain`, `connection-uncertain`, or an already persisted `stopped`.
Token deltas and foreign events do not return to the advisor. Events wake
ordinary HTTP reconciliation; old terminal events never prove a new outcome.
Native nested `form.created` payloads are supported. Five-second supplementary
checks read execution/form/permission metadata. Message history is read at entry,
for a request/failure hint or terminal candidate, paging backwards only as far
as the identified prompt. It is not fetched on each ordinary timer tick.

Default total deadline is one hour, selectable with --timeout-ms from 1 to
3600000 milliseconds. The request/initial event-handshake limits remain twenty
seconds. A deadline is STOPPED/uncertain, never completed. Keep the CLI process
inside an active Codex tool turn, continuing the same process handle through
bounded host waits. The helper emits no heartbeat/token/tool progress output.
A host yield does not reconnect or send another DeepSeek prompt; it may still
return control to GPT. Do not add advisor history reads or narrate progress.
A received stream gap stops coordination without reconnect/resubmit.
Exhausted CLI bootstrap between calls leaves PREPARING/FINISHED byte-for-byte
unchanged. In EXECUTING, WAITING_FOR_ANSWER or REVIEWING it records STOPPED with
the connection diagnostic; an existing STOPPED binding remains sticky. Library
callers use `connectionLost(error)` for the same state-only transition; it never
sends a mutation or releases a persisted uncertainty marker.

## Resume observation

Use `resume-watch` only after an explicit user request to continue observing an
already delivered assignment. Run it in the original owner Codex chat with the
same workspace, plan, session, assignment and message IDs from inspect/checkpoint.
The real CODEX_THREAD_ID and shared store remain unchanged. Dispatch preflight
still blocks STOPPED; it is not the entrypoint for this observation-only route.

Only a STOPPED binding with an admitted assignment and no uncertain create,
submit or reply mutation, or prepared next assignment, can enter this route.
The command acquires the existing per-checkout lease, verifies identity/model/
variant, reads history back to the exact assignment prompt and validates fresh
execution/form/permission state. It performs GET/SSE only: no prompt, engine
resume/cancel, answer, new session, count import/reset or automatic retry.

A verified active execution becomes EXECUTING and continues the same wait;
a correlated pending request becomes WAITING_FOR_ANSWER without answering it;
a confirmed completed result passes the unchanged final/tool/shell gate before
REVIEWING. This does not accept the implementation or authorize project edits
while the executor is active. Unknown/failed/interrupted execution, missing or
changed history, foreign ownership and failed validation leave the original
STOPPED state/diagnostic byte-for-byte unchanged. A later observation failure
after successful resumption records a new STOPPED diagnostic normally.

Successful/reconciled outcomes include observationOnly=true and taskSent=false.
The saved correction count and delivery IDs are preserved, including count 20.
Another resume-watch cannot attach concurrently; ordinary wait remains sticky
on STOPPED. Do not spoof a chat ID or remove a lock to enter this route.
An isolated tool-error record may be observed while the engine remains running;
it does not prove terminal failure or success. It remains a failure at the
completion boundary, and a pending request on that failed history stops for
inspection. Hard execution failures/interruption still block continuation.

## Diagnostics

A failed wait includes diagnostic alongside its existing kind/phase/error,
executorStopped false and retried false. The same optional diagnostic is saved
on its schema-1 STOPPED binding and appears on later stopped outcomes/inspection.
Older schema-1 records without it remain valid; invalid/extra diagnostic fields
are rejected rather than silently copied.

Outcomes report `stateChange` as `saved`, `unchanged` or `unconfirmed`. Bootstrap
failures include bounded attempt count and the last validated typed diagnostic.
If a STOPPED diagnostic cannot be saved, the result keeps the original operation
diagnostic and reports a separate `persistenceFailure`; it never claims `saved`.
An operation-lease release failure is reported separately as
`ownershipReleaseFailure`; it does not replace an earlier operation result or
diagnostic. For a completed operation it produces a stopped outcome while
retaining the known state-change result. The lease is never auto-cleared.
Pre-intent local rejections preserve the current phase, pending request and
counter. A correction-limit result at 20 is unchanged and sends no prompt.

Fields: category, stage, elapsedMs, lastEvent (null or timestamp at plus a
bounded event type). Optional httpStatus/errorName/errorCode use explicit
allowlists. Request diagnostics also include allowlisted operation/method and,
for message lists, page first or cursor. Never include raw URLs, session IDs,
query values or request bodies. HTTP 400 may retain a checked InvalidCursorError
or InvalidRequestError tag from at most 8192 response bytes; other server text,
unknown tags, malformed/oversized bodies are discarded. Categories distinguish
HTTP request read/timeout/status/JSON,
event opening/handshake/status/content-type, EOF/read/JSON/shape/frame limit,
engine shutdown, user interruption, total deadline and unknown. Last event is
for the bound session; unrecognized names become other, and foreign events do
not replace it. Diagnostics are not a transcript or an authenticated event log.
No raw exception message/cause/stack, response body, event payload, credentials
or prompt is stored in this diagnostic. The safe public error text remains.
A transport code identifies an observation, not the root cause of an old failure.
Later discovery failures do not overwrite an already STOPPED binding's first
diagnostic/stop reason.

## Preflight

preflight <workspace> <plan> [--session <exact-id>] [--correction-count N]
[--non-git-baseline <declaration>] is the ordinary read-only gate after the
advisor has selected a canonical plan and physical workspace. Without an
explicit session it checks the current chat's saved pair or proposes new-bind.
--session is only for an exact existing recipient the user selected; it checks
that candidate before adoption and needs no additional confirmation. If the ID
already matches this chat's saved pair, preflight validates the saved physical
workspace/plan identity and uses the supported reuse or released plan-switch
route; it does not recommend adopting that binding again. A selected ID cannot
authorize adoption into a different physical workspace/plan or transfer
ownership. Preflight never
searches titles or selects a session.

It returns one JSON result with connection/bootstrap attempts, proposed route,
physical workspace/plan, effective count and checks marked pass, blocked or
unknown. It collects independent blockers; checks that depend on an unavailable
connection or uncreated recipient remain unknown. The result includes blockers,
an exact next step, a structured nextCommand with command/argument values when a
safe bind/adopt step is ready, taskSent: false, snapshotOnly: true and
stateChange: unchanged. The helper does not claim that every possible issue was
found.

Per-check API/IO failures retain only validated bounded diagnostics. A permanent
HTTP 4xx includes the checked operation, method, page and allowlisted error code;
preflight blocks the unchanged request and tells the user to correct it before
rerunning, rather than encouraging a retry loop.

Preflight performs only reads and engine GETs. It does not mkdir, acquire or
release locks, save/repair state, probe writability or send POSTs, even when
offline or invalid state is observed. Store write access remains unknown until an
authorized write command; use normal host approval if the existing store is
outside writable roots. A pass is not an adoption token or dispatch permission:
adopt and submit repeat their own fresh identity, history, execution and
ownership checks. Inspect remains a read-only diagnostic when a plan is not
ready or after an error; do not require it redundantly when preflight covers the
ordinary route.

## Inspect and sessions

inspect [absolute-workspace] reports connection/version/required model, binding
for the actual current Codex chat, and a live snapshot of that exact session
when available. Binding status is bound/unbound/unknown; a missing thread ID
is unknown, not a selected chat. Optional workspace must match the saved
physical directory. It never discovers/adopts an arbitrary existing session.

Session data includes title/ID/directory and observed model/variant. Live data
includes active status, outcome, form/permission counts and known shell state.
Unknown shapes/identity mismatch return a stopped diagnostic outcome. Private
history and shell commands are not read for this snapshot; hidden OS processes
remain unobserved. Blockers are advisory; snapshotOnly never grants ownership
or replaces assignment correlation/completion before review.

This path reads the existing store without mkdir, lock acquisition, cleanup
or save. `stateLocked` reports only a current short store transaction;
`ownershipLocked` reports a retained per-checkout lease, including an active wait.
A failed engine connection
retains readable saved binding/diagnostic while marking live state unverified;
inspect exits nonzero for an unavailable engine or invalid snapshot. A valid
snapshot of a STOPPED binding can succeed, but cannot clear STOPPED/uncertainty,
retry delivery, resume events or authorize implementation. Use it after an
error only when the user requests that read-only diagnosis.

## Reply

Questions preserve the full form, keys, values, descriptions, custom allowance
and single/multiselect rules. The answer file contains, for example,
`{"answer":{"q0":"Beta"}}` or `{"answer":{"q0":["Alpha","Gamma"]}}`.
The helper correlates the request to an actual tool after the current assignment
prompt. It fingerprints the observed request, checks pending status before
reply, and checks again immediately before POST. A user-answered request returns
`stale-request` with no mutation. A changed/uncorrelated request stops.

Permissions use their own request and reply routes. Payload is an explicit
`{"decision":"once"}` or `{"decision":"reject","message":"reason"}`.
Persistent `always` is refused. The advisor must assess the exact action,
resources, operation details, authorized plan and governing runtime approvals;
the helper never grants authority or decides that an operation is safe.
OpenCode must not be used to bypass the caller's sandbox/permission boundary.
A rejected request stops coordination; it does not assert process termination.

Reply intent is persisted STOPPED/uncertain before POST, just as create/submit.
A lost reply response cannot authorize a duplicate. State stores only request
kind/ID/fingerprint, not a form transcript or answer. STOPPED persists across
late successful idle observations; explicit recovery belongs to later work.
If the reply POST succeeds but its final state write fails, the result is
STOPPED/unconfirmed and retains the pending request; a later call cannot resend
the reply. This also applies to permission rejection finalization.

## Completion

`completed-for-review` means REVIEWING, not accepted/FINISHED. It requires:
the current identified prompt with no later user prompt; the fixed model;
a completed final assistant response and successful terminal idle after it;
ended execution in this session; no outstanding tools/forms/permissions;
and known shell/background operations ended. Completion is confirmed with a
second execution/interactive snapshot before saving REVIEWING.

Foreground checks are required in the assignment packet. The helper reads
the selected workspace's shell registry, rejects running/unknown operations,
and requires shell completion metadata or an explicitly tracked, ended shell.
Detached launch syntax, unknown background results and
unrecognized execution history stop conservatively. This is not a general
shell interpreter or OS process supervisor: hidden descendants and arbitrary
user/third-party processes are outside the cooperative ownership guarantee.

## Plan review transitions

See ../references/workflow.md and ../references/assignment-template.md for
canonical-directory selection, authorization, baseline, protected files,
questions/permissions, independent review, cross-route handoff and checkpoints.
The helper has no Markdown parser/writer or automatic acceptance decision.

After completed-for-review, the advisor inspects actual changes and records
its checkpoint. next ... correction or next ... block rechecks the stopped
assignment and prepares the selected kind. The following submit must use the
matching --kind and a different assignment ID. The old assignment stays in the
technical record until a new identified submission replaces it.

Initial implementation defaults to --kind initial. A fresh pair adopting
unfinished work explicitly uses block or correction according to the existing
checkpoint; a new chat never turns corrections into initial implementation.
For a new technical plan record, bind --correction-count imports its established
0..20 count. It never resets an existing record. Missing/conflicting history
is an advisor STOP condition, not permission to guess zero.

Only corrective submission increments the count. Reservation is atomic with
STOPPED/uncertain submit intent immediately before its one POST; local invalid
arguments, preparing a task, questions/replies and independent checks spend no
cycle. Uncertain delivery retains the one possible cycle; no automatic refund
or resubmit. At 20, review is still allowed; a further correction produces an
unchanged `correction-limit` result before intent or prompt. Do not disguise
fixes as a block.

finish rechecks ended execution and releases this adapter assignment as
FINISHED; it sends no engine prompt and changes no plan/index. The advisor may
leave the MD plan ACTIVE/BLOCKED because required runtime/visual/owner gates
are missing. Only the advisor can mark all required work DONE.
FINISHED can explicitly continue via next in the same plan, or bind can select
a new plan after checking the previous assignment. Neither resets counters.
STOPPED has no automatic recovery; next/finish do not bypass it.

## Deliberate boundaries

The advisor runs in the calling Codex turn; there is no background orchestrator,
automatic global installation or proven Desktop navigation. Active
work in any related checkout blocks new assignment; stopping coordination does
not guarantee killing OpenCode. OpenCode tests must always use a newly created
test chat/project, never a user's current conversation.

The portable package excludes development fixtures/harnesses. They are not
runtime dependencies. Live smoke evidence does not establish full autonomous
operation; do not test in a user's existing OpenCode conversations.
