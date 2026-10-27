# Helper — connection, binding, interaction, inspection and review

Node 24, built-in APIs only. The packaged skill still needs full live acceptance. All
commands emit one JSON outcome; STOPPED outcomes exit nonzero. The specific
kind distinguishes executor failure, interruption and connection uncertainty.
`admitted` means the engine accepted an inbox message, **not** completed work.

```text
node helper/cli.mjs inspect
node helper/cli.mjs inspect <absolute-workspace>
node helper/cli.mjs sessions <absolute-workspace> [--cursor <cursor>]
node helper/cli.mjs adopt <absolute-workspace> <absolute-plan.md> <exact-session-id> [--correction-count <0..20>]
node helper/cli.mjs bind <absolute-workspace> <absolute-plan.md>
node helper/cli.mjs bind <absolute-workspace> <absolute-plan.md> --correction-count <0..20>
node helper/cli.mjs submit <absolute-workspace> <absolute-plan.md> <assignment-id> <absolute-packet-file>
node helper/cli.mjs next <absolute-workspace> <absolute-plan.md> <block|correction>
node helper/cli.mjs submit <absolute-workspace> <absolute-plan.md> <fresh-assignment-id> <absolute-packet-file> --kind <block|correction>
node helper/cli.mjs finish <absolute-workspace> <absolute-plan.md>
node helper/cli.mjs wait <absolute-workspace> <absolute-plan.md> [--timeout-ms <ms>]
node helper/cli.mjs reply <absolute-workspace> <absolute-plan.md> <question|permission> <request-id> <absolute-answer.json>
```

Workspace, plan and packet arguments are passed as data; no shell interpolation
is used. Quote paths containing spaces/`&` when invoking the CLI. Plan and packet
must resolve to regular files inside the selected physical workspace. The
actual `CODEX_THREAD_ID` is required; there is no CLI override for chat identity.
Read-only inspect and sessions are exceptions: inspect reports binding unknown
without that variable; sessions returns directory-scoped candidates only.
This helper sends packet contents only after an authorized caller chooses them;
it does not infer execution authorization from the mere existence of a plan.

The shared `connection.mjs` also serves the original transport probe. It reads
the current user's `.local/state/opencode/service.json`, accepts loopback HTTP
only, rejects redirects, validates installed/API version 2.1.4 and the enabled
`opencode-go/deepseek-v4.1-flash` model. Credentials stay inside HTTP closures;
the exposed client, state, results and errors contain no auth/response-body data.
The default model variant is left unchanged. No second engine or fallback is
started, and no service/global configuration is changed.

Ordinary JSON requests use fetch with a twenty-second deadline. SSE alone uses
a dedicated node:http connection and a web-readable body; it does not inherit
fetch/Undici's body-idle timeout. The wait owns its handshake/total lifetime.
No SSE redirects, automatic reconnects or extra dependency are introduced.

## Identity and persistence

One technical file: `~/.local/state/code-duet/state.json`, schema 1. It stores
bindings by Codex chat and counters by exact physical plan path/workspace. Each
binding contains workspace/checkout paths and filesystem identities, engine and
OpenCode session IDs, current plan, phase, and current assignment/message IDs.
There is no task transcript, password, Git baseline history or second task list.
Existing counter values are validated and preserved. The advisor imports an
established count when first adopting a plan; conflicting imports stop without
overwriting saved history. Count policy and operating contract are below.

Writes use a same-directory temporary file and atomic rename. A cooperative
`state.lock` serializes helper operations and is removed only by its owner.
A stale lock/corrupt file stops work; it is never automatically replaced or
unlocked. This does not lock the OS or prevent user edits to the project.

Lock acquisition fails before reading/changing state or any engine mutation.
Only EEXIST from exclusive lock creation means state-locked. Access failures
(EACCES/EPERM/EROFS/ERR_ACCESS_DENIED) report state-access; other directory/lock
failures report state-io. The validated diagnostic includes state-directory or
state-lock and an allowlisted errorCode, never raw paths, exception text or
credentials. An unknown code is omitted rather than echoed. These are local
stopped outcomes, not a replacement/reset of a saved STOPPED/uncertain binding.
A later stateLocked=false snapshot proves neither past lock ownership nor
current writability. No automatic retry, unlock or alternate store is introduced.
See [runtime](../references/runtime.md) for host-approved access to the same shared store.

Git root discovery is read-only (`git rev-parse --show-toplevel`). Different
physical clones are not interchangeable; filesystem identities catch directory
replacement. For a non-Git project add `--non-git-baseline <declaration>` to
bind/submit: that exact, explicit baseline declaration must already occur in
the selected plan. The advisor owns its correctness and acceptance; the helper
does not initialize Git or treat declaration text as proof of file contents.

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

### Explicit existing-session adoption

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

The cooperative lock encloses the checks and atomic local save; identity,
execution and latest message are reconfirmed. No OpenCode create/prompt/rename
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

Create/submit intent is persisted as `STOPPED` with an uncertainty marker
**before** HTTP mutation. A lost response, crash, invalid ID or failed state
write cannot silently allow a duplicate. Only a confirmed response advances to
`PREPARING` (bind) or `EXECUTING` (submit). No automatic retries or recovery.
An idle engine alone cannot authorize another submit: a recorded assignment
remains `EXECUTING` until the later completion/review gate accepts it.

## Waiting, replies and completion

`wait` holds the cooperative state lock and subscribes to the bound session.
It returns one compact outcome: `question`, `permission`, `completed-for-review`,
`failed`, `interrupted`, `connection-uncertain`, or an already persisted `stopped`.
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
CLI connection/discovery failure between calls also persists STOPPED for the
current chat binding. Library callers use connectionLost(error) on discovery failure;
that state-only operation never calls the engine or releases project ownership.

### Sanitized diagnostics

A failed wait includes diagnostic alongside its existing kind/phase/error,
executorStopped false and retried false. The same optional diagnostic is saved
on its schema-1 STOPPED binding and appears on later stopped outcomes/inspection.
Older schema-1 records without it remain valid; invalid/extra diagnostic fields
are rejected rather than silently copied.

Fields: category, stage, elapsedMs, lastEvent (null or timestamp at plus a
bounded event type). Optional httpStatus/errorName/errorCode use explicit
allowlists. Categories distinguish HTTP request read/timeout/status/JSON,
event opening/handshake/status/content-type, EOF/read/JSON/shape/frame limit,
engine shutdown, user interruption, total deadline and unknown. Last event is
for the bound session; unrecognized names become other, and foreign events do
not replace it. Diagnostics are not a transcript or an authenticated event log.
No raw exception message/cause/stack, response body, event payload, credentials
or prompt is stored in this diagnostic. The safe public error text remains.
A transport code identifies an observation, not the root cause of an old failure.
Later discovery failures do not overwrite an already STOPPED binding's first
diagnostic/stop reason.

### Read-only inspection

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
or save. An active wait's lock is only reported. A failed engine connection
retains readable saved binding/diagnostic while marking live state unverified;
inspect exits nonzero for an unavailable engine or invalid snapshot. A valid
snapshot of a STOPPED binding can succeed, but cannot clear STOPPED/uncertainty,
retry delivery, resume events or authorize implementation. Use it after an
error only when the user requests that read-only diagnosis.

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
or resubmit. At 20, review is still allowed; a further correction produces
correction-limit / STOPPED before any prompt. Do not disguise fixes as a block.

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
