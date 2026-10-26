# Helper — connection, binding, interaction and review (Plans 002–004)

Node 24, built-in APIs only. The packaged skill still needs full live acceptance. All
commands emit one JSON outcome; STOPPED outcomes exit nonzero. The specific
kind distinguishes executor failure, interruption and connection uncertainty.
`admitted` means the engine accepted an inbox message, **not** completed work.

```text
node helper/cli.mjs inspect
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
This helper sends packet contents only after an authorized caller chooses them;
it does not infer execution authorization from the mere existence of a plan.

The shared `connection.mjs` also serves the original transport probe. It reads
the current user's `.local/state/opencode/service.json`, accepts loopback HTTP
only, rejects redirects, validates installed/API version 2.1.4 and the enabled
`opencode-go/deepseek-v4.1-flash` model. Credentials stay inside HTTP closures;
the exposed client, state, results and errors contain no auth/response-body data.
The default model variant is left unchanged. No second engine or fallback is
started, and no service/global configuration is changed.

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

Git root discovery is read-only (`git rev-parse --show-toplevel`). Different
physical clones are not interchangeable; filesystem identities catch directory
replacement. For a non-Git project add `--non-git-baseline <declaration>` to
bind/submit: that exact, explicit baseline declaration must already occur in
the selected plan. The advisor owns its correctness and acceptance; the helper
does not initialize Git or treat declaration text as proof of file contents.

First bind creates a new OpenCode session at the physical workspace. Repeated
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

Default deadline is ten minutes, selectable up to one hour. A deadline is
STOPPED/uncertain, never completed. Keep the CLI process inside an active Codex
tool turn, using bounded host waits and required progress updates. A host yield
continues the same process; it does not start another model prompt or reconnect.
A received stream gap stops coordination without reconnect/resubmit.
CLI connection/discovery failure between calls also persists STOPPED for the
current chat binding. Library callers use connectionLost() on discovery failure;
that state-only operation never calls the engine or releases project ownership.

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
