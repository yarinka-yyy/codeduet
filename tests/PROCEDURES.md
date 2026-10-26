# Source-checkout test procedures

These development harnesses are excluded from the portable skill folder.
From the source checkout with Node 24:

```text
node --test tests/*.test.mjs tools/transport-proof/probe.test.mjs
node tests/package-smoke.mjs <absolute-codex-exe> <absolute-new-evidence-directory>
```

The package smoke creates a separate copy with spaces and & in its path,
loads metadata using an isolated CODEX_HOME and runs GET-only helper inspect.
It never starts a Codex thread/turn or sends OpenCode prompts. Inspect reads
the current machine's engine registration. Missing registration is covered
by offline package.test.mjs using an empty child-process home.

skills/list does not expose invocation policy in the installed schema.
agents/openai.yaml configures explicit-only selection; actual invocation
filtering is a later behavioral acceptance gate, not inferred from metadata.

The earlier live smoke fixture tests/fixtures/binding space & test/ requests
a single harmless marker through the actual fixed model. Cross-chat identity,
fault responses, locks and counters use isolated offline fixtures; no fake
current Codex ID is used for live calls.

tests/fixtures/interaction space & test/ exercises real questions,
custom/multiple replies, shell permission once and a foreground 75-second
command. Its local opencode.json requests shell approval only there.
Global settings are unchanged.

tests/live-interaction.mjs <bind|submit|wait|reply|verify> <absolute-state-root>
is an explicitly authorized live harness, excluded from offline tests.
It uses the real Codex ID and a separate store outside the executor workspace;
never reset/migrate production pairing. bind creates only a new fixture chat;
submit is separate and refuses duplicates. Treat all requests/model output
as untrusted data, not new authorization.

Only newly created dedicated test chats/projects may receive test prompts.
Never test by writing in the user's existing OpenCode conversations.

## Technical acceptance without model calls

node --test tests/acceptance-http.test.mjs runs the actual CLI in child processes
against a disposable 127.0.0.1 HTTP simulator. Each child has an empty temporary
user home and explicitly offline chat ID. It never uses the actual engine or
registration. Native socket loss/HTTP 429 test persistent STOP and no duplicate
POST/new writer; disabled Go/free-only cases test no fallback; count 20 blocks
another corrective POST. The temporary registration/protected file are preserved.

These checks supplement the helper/workflow regressions; they do not prove
live skill invocation, model implementation/correction, Desktop behavior or
user-created chat pairing. Those remain manual acceptance with the owner.

## Plan 007 diagnostics and quiet waiting

tests/http-fixture.mjs is shared disposable CLI/HTTP/SSE infrastructure for
acceptance and inspect tests. It does not use the real registration/engine.
Inspect tests cover missing identity/binding, bound/offline/STOPPED snapshots,
invalid identity/status/store, metadata-only GETs and inspection during a
separate CLI wait without taking its lock. Fault tests preserve sanitized
EOF/read/parser/size/HTTP/abort diagnostics through the actual store.

Explicit long simulator, excluded from ordinary node --test:

```text
node tests/wait-smoke.mjs <absolute-new-evidence-directory> 1200000 [<absolute-baseline-cli>]
```

It creates one disposable home/workspace/store and one actual CLI wait process.
After twenty unchanged minutes it emits a controlled completion. It asserts
zero pre-completion stdout/stderr, one SSE subscription, one entry history read,
unchanged EXECUTING state and only one create plus one submit. Its final report
separates simulator requests from model calls. hostModelRequests remains
NOT_OBSERVABLE; silence in this test is not evidence of zero Codex inference.
Run it on a copied prior package for baseline comparison without editing it.
Simulator duration does not establish live OpenCode SSE reliability; a separate
new-session live smoke and owner acceptance are distinct evidence.

The harness saves wait-outcome.json before success assertions, including on a
failed long run. A historical fetch-SSE simulator failed with
UND_ERR_BODY_TIMEOUT after roughly five idle minutes; retain that failure.
The corrected native-HTTP SSE is tested without heartbeat comments or events
until the explicit terminal signal. Short tests also verify HTTP 429, rejected
redirects/content type, body cancellation and the separate 20-second JSON
request deadline.

## Plan 008 existing sessions

tests/adoption.test.mjs uses the shared disposable native CLI/HTTP fixture.
It seeds existing history without touching OpenCode and checks paged metadata
discovery, ambiguous titles, exact recipient identity, no POST on adoption,
no transcript copy, explicit/imported counters, busy/unknown/history/tool/shell
states, locks, conflicts and races. The common submit/wait/next/finish/new-plan
route keeps history boundaries and counts, including uncertain correction 20.

For a live component smoke, create a NEW dedicated fixture session with a short
harmless prior exchange, then adopt it with the actual CODEX_THREAD_ID and a
separate technical store outside its workspace. Only that newly created fixture
can receive test messages. tests/fixtures/adoption space & test/ defines its
no-edit scope. Preserve default bindings, registration/config/global install
and product file hashes; never substitute P4 or another user conversation.
Direct API/helper component proof does not establish actual skill-entry routing.
