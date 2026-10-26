# Local runtime and portable package

Requires Windows, Node.js 24 available to the calling shell, Git for an existing
Git checkout, and a running OpenCode Desktop engine 2.1.4 with enabled
opencode-go/deepseek-v4.1-flash. The helper uses Node built-ins; no npm install.
If prerequisites/access are absent, report them; do not install, launch a
service, change a model or edit global settings automatically.

The helper reads the current user's ~/.local/state/opencode/service.json at
execution time. Credentials stay on that machine inside the HTTP client; never
copy registration, helper state, transcripts or private session IDs into a package.
Bindings/counts live separately in ~/.local/state/code-duet/state.json.
Only the real host CODEX_THREAD_ID is accepted for binding. Inspect without it
still checks connection, but reports binding unknown rather than unbound.

## Build a folder without installing it

From the source checkout, using Node 24 in PowerShell:

```powershell
node .\tools\package.mjs "C:\temporary package space & test\code-duet"
```

The destination must be an absolute, new folder named code-duet whose parent
already exists. No overwrite, runtime registration or dispatch occurs.
The allowlist in tools/package.mjs copies only SKILL.md, agents/openai.yaml,
helper modules/protocol, focused references and that packager. Source tests,
development docs/Git, fixture sessions and local state are excluded. The same
command can copy an existing portable folder to another new destination.

## Inspect from the copied package

Resolve Node through the host's configured runtime; if it is not on PATH, use
its actual absolute executable path. Resolve the selected skill location too:

```powershell
$duetNode = (Get-Command node -ErrorAction Stop).Source
$duetRoot = "C:\temporary package space & test\code-duet"
$duetCli = Join-Path $duetRoot 'helper\cli.mjs'
& $duetNode $duetCli inspect
```

Expected: JSON kind connected, version 2.1.4 and the exact Go/Flash model.
Missing engine registration yields kind stopped with a sanitized explanation
and nonzero exit; it does not launch OpenCode or create helper state.

To check the intended workspace as well, append its quoted absolute path:

```powershell
& $duetNode $duetCli inspect "C:\target project"
```

The snapshot separates connection, saved binding and verified live session
(title/ID/directory/model/variant, execution and pending counts). The top-level
model is the required model; session.model is the observed one. Unbound means
no recipient was assigned; a discovered/visible chat is not selected. Offline
inspection preserves local binding information but marks live state unverified.
Inspect never creates the store, takes its lock, repairs a binding or resumes
STOPPED. Its blockers and snapshotOnly flag do not authorize submission or
replace the completion gate. Use the same source/installed package version for
execution against one store; an older package may reject newer diagnostic fields.

For execution commands use that absolute CLI path, separately quoted absolute
target workspace/plan/packet paths, and the [protocol](../helper/PROTOCOL.md).
Do not change the target project just to locate the helper.
For non-Git targets, every operation requiring context must pass the recorded
--non-git-baseline declaration; the helper never initializes their Git.

## Load only in the intended scope

A copied skill folder alone is a portable artifact, not a global installation.
For an explicitly authorized repository-local installation the conventional
location is <project>/.agents/skills/code-duet/. Do not install it automatically.
Metadata requests explicit-only invocation; select $code-duet explicitly.

Isolated verification uses the installed Codex app-server's skills/list against
a test workspace and a temporary CODEX_HOME. It sends no thread/start or
turn/start and performs no model call. That demonstrates metadata discovery;
actual skill invocation and full behavior need separate live acceptance.
The installed skills/list schema does not expose invocation policy; do not
claim its effective filtering was tested by metadata discovery alone.

During a real helper wait, allow its process to stay alive through host yields
and continue the same returned process/session handle. Use the longest bounded
wait permitted by the host and its interruption/update rules; do not impose a
separate short progress cadence. Do not interrupt/relaunch the helper at a
yield or treat that yield as execution completion. Do not add separate history
reads, inspect calls or step-by-step commentary merely because control returned.
If a host update is required, use the already known waiting state.

The helper produces one meaningful outcome, without routine heartbeat output.
Its Node SSE/metadata checks do not call GPT. A host yield can nevertheless
return control to GPT; silence in stdout/chat does not prove zero model requests.
Background hooks do not start an idle turn, so they are not a substitute for
this active wait. Strict event-only model wakeup is not established in this host.

Default total wait deadline is one hour, with --timeout-ms selectable from 1
to 3600000. Initial HTTP requests and the event handshake retain 20-second
limits. Host yields, request timeouts, total deadline and stream EOF are
different events. Choose a shorter deadline explicitly for a bounded task;
unchanged execution alone is not a failure. A real deadline, connection loss
or interruption is STOPPED with sanitized diagnostics, no reconnect/resubmit.
Stopping coordination does not guarantee stopping DeepSeek or OS processes.

The SSE connection uses node:http rather than fetch so a silent event body is
not cut off by Undici's separate idle timer. It still stops on real EOF/read
failure or the explicit wait deadline. No server heartbeat is assumed.
