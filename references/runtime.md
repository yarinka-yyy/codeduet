# Local runtime and portable package

## Check an installed helper

Routine use requires Windows, Node.js 24 and the already-running OpenCode
Desktop engine 2.1.4 or 2.2.0 with the enabled opencode-go/deepseek-v4.1-flash model.
The helper uses Node built-ins; no npm install is needed. If access is missing,
report it; do not install software, start a service or change global settings.

When the Node or helper path is unknown, resolve Node from the configured host
runtime and set duetRoot to the absolute folder containing SKILL.md:
Set duetNode to Get-Command's path when Node is on PATH; otherwise use the
configured runtime's absolute executable path.

    $duetNode = (Get-Command node -ErrorAction Stop).Source
    $duetRoot = "C:\path\to\code-duet"
    $duetCli = Join-Path $duetRoot 'helper\cli.mjs'
    & $duetNode $duetCli inspect

Expected: JSON kind connected, version 2.1.4 or 2.2.0 and the exact Go/Flash model.
Only these validated releases are accepted. A version mismatch reports safe
expected/observed versions and registration versus server-info origin; revalidate
a later release before using it, without disabling the guard or retrying dispatch.
Missing registration or connection produces a sanitized nonzero result without
starting OpenCode, creating helper state or sending a task. To inspect the
saved pair and live snapshot for a workspace, append its quoted absolute path;
see [inspect](../helper/PROTOCOL.md#inspect-and-sessions). This check does not
select a session or authorize dispatch.

Once the physical workspace and plan are known, use the single read-only
preflight <workspace> <plan> result as the ordinary route check. Add
--correction-count N when importing an established count, --session <exact-id>
only for a user-selected existing recipient, and --non-git-baseline <declaration>
for a non-Git workspace. Preflight reports connection attempts and all available
blockers; it does not prove store writability or authorize a later mutation.

Only bootstrap registration and the safe `/api/info` and `/api/model` GETs have
bounded retry rules; POSTs and an established SSE wait do not reconnect. An
exhausted bootstrap leaves a PREPARING/FINISHED pair unchanged and stops an
active assignment conservatively. See the [connection protocol](../helper/PROTOCOL.md#connection).

For routine assignments, consult only this check when the runtime/helper path
or connection needs verification. The remaining sections apply to explicit
package work or a shared-store access blocker.

## Shared-store access

Bindings and correction counts use the same external store at
~/.local/state/code-duet/state.json across projects. Write commands need its
directory and short state lock; acquisition can wait up to about 120 ms for a
concurrent store update. Read-only inspection does not prove write access. If the host
excludes it, request normal approval for the exact authorized helper command.
Keep the real CODEX_THREAD_ID and store. If approval is unavailable, stop and
report the boundary. Never disable sandboxing, change ACLs, spoof HOME or move
the store into a project or temporary directory. Approval does not clear a
STOPPED or uncertain assignment. The protocol defines lock and failure behavior.
A `history-uncertain` result with `history-correlation` identifies unverified
synthetic input, not a connection failure. Do not resend a delivered assignment
or clear STOPPED; preserve the assignment/message IDs for diagnosis.

## Build a folder without installing it

From the source checkout, using Node 24 in PowerShell:

    node .\tools\package.mjs "C:\temporary package space & test\code-duet"

The destination must be an absolute, new folder named code-duet whose parent
already exists. No overwrite, runtime registration or dispatch occurs. The
allowlist in tools/package.mjs copies only the skill metadata, helper, protocol,
focused references and packager. Source tests, development docs, Git, fixtures
and local state are excluded. The same command can copy an existing portable
folder to another new destination.

## Verify a copied package

Use the [installed-helper check](#check-an-installed-helper) with the copied
folder as duetRoot. An optional workspace path checks its saved binding and live
snapshot but does not authorize dispatch.

Isolated discovery verification uses the installed Codex app-server skills/list
against a test workspace and temporary CODEX_HOME. It sends no thread/start or
turn/start and performs no model call. This proves metadata discovery only:
the installed schema does not expose invocation policy. Full live invocation
and behavior require separate acceptance.

## Repository-local installation

A copied skill folder is a portable artifact, not a global installation. The
conventional repository-local location is
<project>/.agents/skills/code-duet/. Do not install it automatically; metadata
requests explicit-only invocation.

Wait timing, ownership and host-yield behavior are defined once in the
[workflow](workflow.md) and [helper protocol](../helper/PROTOCOL.md#wait).
