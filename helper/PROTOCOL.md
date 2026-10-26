# Helper — connection and binding (Plan 002)

Node 24, built-in APIs only. This is not yet a complete Code Duet skill. All
commands emit one JSON outcome; failures exit nonzero with `kind: stopped`.
`admitted` means the engine accepted an inbox message, **not** completed work.

```text
node helper/cli.mjs inspect
node helper/cli.mjs bind <absolute-workspace> <absolute-plan.md>
node helper/cli.mjs submit <absolute-workspace> <absolute-plan.md> <assignment-id> <absolute-packet-file>
node --test tests/helper.test.mjs tools/transport-proof/probe.test.mjs
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
Existing counter values are validated and preserved; increment policy is 004.

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
Plan reassignment after acceptance belongs to workflow integration in 004.

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

## Deliberate boundaries

This increment has no wait, form reply, completion acceptance, correction loop,
global installation or Desktop navigation. Those remain later plans. Active
work in any related checkout blocks new assignment; stopping coordination does
not guarantee killing OpenCode. OpenCode tests must always use a newly created
test chat/project, never a user's current conversation.

The live smoke fixture is `tests/fixtures/binding space & test/`. It requests a
single harmless marker through the actual fixed model. Cross-chat identity,
fault responses, locks and preserved counters are checked with isolated offline
fixtures; no fake current Codex ID is used for live calls.
