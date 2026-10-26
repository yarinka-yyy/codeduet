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
Only the real host CODEX_THREAD_ID is accepted for binding; inspect needs none.

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
and poll the same returned process/session handle. Keep host waits at most
55 seconds for user updates. Do not interrupt/relaunch the helper at a host
yield or treat that yield as execution completion. A real helper deadline,
connection loss or interruption is STOPPED; no automatic reconnect/resubmit.
Stopping coordination does not guarantee stopping DeepSeek or OS processes.
