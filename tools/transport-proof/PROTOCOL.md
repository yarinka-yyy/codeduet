# Transport proof — Plan 001

This is an installation-specific research probe, not the Code Duet skill or a
general adapter. It targets the existing OpenCode **2.1.4** engine and only
`opencode-go/deepseek-v4.1-flash`. Node **24.19.0** was used; no packages are
required. No service is started, and no mouse/keyboard input is generated.

## Run deliberately

Run from the repository root, in an active Codex desktop turn. Live commands
use the existing Go access. The actual `CODEX_THREAD_ID` must be present. Only
the new session created in `tests/fixtures/transport space & test/` is used;
existing user chats must never receive test messages.

```text
node --test tools/transport-proof/probe.test.mjs
node tools/transport-proof/probe.mjs inspect
node tools/transport-proof/probe.mjs create
node tools/transport-proof/probe.mjs submit completion
node tools/transport-proof/probe.mjs wait
node tools/transport-proof/probe.mjs submit question
node tools/transport-proof/probe.mjs wait
node tools/transport-proof/probe.mjs reply selection
node tools/transport-proof/probe.mjs wait
node tools/transport-proof/probe.mjs submit question
node tools/transport-proof/probe.mjs wait
node tools/transport-proof/probe.mjs reply custom
node tools/transport-proof/probe.mjs wait
node tools/transport-proof/probe.mjs status
```

Inspect each result before the next command. `wait` returns a pending question
or confirmed completion; it is not an automatic answerer. A long command can
yield a host process session ID: continue waiting on that **same process**, do
not submit the assignment again. The fixture's wait script runs for 75 seconds
in the foreground, writes an ignored completion record, then exits.

`create` refuses an existing local binding. Do not delete state to work around
an uncertain run. Stop, inspect the exact session and operations, and obtain
explicit continuation after a real transport/interruption failure. A clean
isolated checkout/fixture is appropriate for an intentionally authorized new
experiment. There is no retry/reconnect/recovery implementation.

## Observed contract

Credentials are read only into memory from the current user's
`.local/state/opencode/service.json`. Only a loopback HTTP registration is
accepted; redirects are rejected. State/results are ignored by Git, contain
no password, and must not be published as raw session transcripts.

| Operation | Verified HTTP interface |
|-----------|-------------------------|
| Inspect | `GET /api/info`, `GET /api/model` |
| Create | `POST /api/session`, body `{title, location:{directory}, model:{providerID,id}}` |
| Verify binding | `GET /api/session/{sessionID}`; check physical directory and model |
| Submit once | `POST /api/session/{sessionID}/prompt`, body `{id,text}`; response identifies admitted inbox message |
| Events | `GET /api/event`, SSE `data` decoded to `{id,type,data}`; filter exact session values |
| Reconcile | `GET /api/session/active`, `GET /api/session/{sessionID}/form` |
| Read final evidence | `GET /api/session/{sessionID}/message?limit=50&order=asc` |
| Reply | `POST /api/session/{sessionID}/form/{formID}/reply`, body `{answer:{[field.key]:value}}` |

Observed question fields were `type: string`, four `options` with distinct
`value`/`label`/`description`, and `custom: true`. The actual field/request IDs
are read and checked while pending. Replies used the second option's value
and, in a separate assignment, `CUSTOM_PROOF_001`.

Completion requires: no active execution/form, a newer successful session idle,
the admitted user message, its marked final assistant response with `finish:
stop` and completion time, completed tools, and a successful idle message. The
long fixture additionally checks its completion record and that the exact
foreground process has exited. This is not an OS-wide process supervisor.

The stream showed `form.created` and `session.execution.succeeded`, among other
events. The probe also reconciles state every five seconds in ordinary code;
it reads the bounded message page only when terminal state is a candidate.
Ordinary events and tokens are not printed to GPT. The page's `cursor.next`
is a position, not a guarantee of more messages: short pages can include it.
This probe conservatively stops at 50 messages instead of adding pagination.

## Evidence and limits (2026-10-26)

- One foreground assignment: 75,013 ms process time, 82,045 ms assignment time.
  The first wait ran 75,123 ms, performed 16 small state reconciliations and
  one bounded message read. A local cursor assertion initially failed; after
  fixing it and adding a regression test, the existing completed result was
  manually verified without resubmitting the assignment.
- Two actual question-tool assignments: `Beta` and `CUSTOM_PROOF_001` were
  returned by the model after the corresponding form replies. Question waits
  read no transcript; terminal waits read one bounded page each.
- Long waiting returned through the current active Codex tool process. Host
  yields required bounded continuation; this does not prove zero model cost
  or background wakeup of an idle chat. Waits longer than this experiment and
  interruption/failure scenarios remain later acceptance work.
- API creation did not open/select a new Desktop tab. Read-only accessibility
  observation found the existing tabs unchanged; no focus/input actions were
  taken. Pointer-free automatic selection is unproven. The HTTP `/view` route
  marks an idle transition viewed; it is not a navigation command. The captured
  screenshot was not a reliable rendering of the target window and was not
  accepted as visual evidence.
- Permissions, arbitrary background jobs, multi-select forms, full skill
  packaging, and production orchestration are outside this proof.

References: [OpenCode HTTP API](https://dev.opencode.ai/v2/docs/api),
[OpenAPI contract](https://dev.opencode.ai/v2/openapi.json),
[Codex background-hook behavior](https://learn.chatgpt.com/docs/hooks#how-background-hooks-run).
The installed engine responses, not moving development documentation alone,
established the tested field shapes.
