# Event observer

After an authorized delivery, use this route instead of keeping GPT in repeated
foreground waits. It uses the existing helper completion/interaction checks and
checkout lease, then [Codex queue](https://learn.chatgpt.com/docs/cli/reference#codex-queue)
to continue the **same** actual Codex chat. Node 24; no new dependencies, service,
hooks, scheduled model calls or global settings. The command does not submit tasks.

## Arm and end the turn

```text
node helper/observer.mjs arm <absolute-workspace> <absolute-plan.md> --codex-exe <absolute-Desktop-bundled-codex.exe> [--non-git-baseline <declaration>] [--timeout-ms <1..3600000>]
node helper/observer.mjs status [receipt-id]
node helper/observer.mjs consume <receipt-id>
node helper/observer.mjs cancel <receipt-id>
```

Resolve the current Desktop CLI, not an arbitrary executable with the same name.
On Windows its running app-server process identifies the versioned bundled path;
`queue --help` must describe --thread/--message. Arm validates that capability
without starting a model and pins its binary hash. If unavailable, stop and
report the missing capability; do not install/restart Codex or bypass ownership.

Use the real CODEX_THREAD_ID; no CLI identity/store overrides exist. The command
needs normal host-approved access to the existing shared store and permission to
leave one hidden Node process running. Request that exact approval if the sandbox
requires it; do not relocate state, spoof HOME or weaken permissions.

Arm requires a confirmed delivered EXECUTING binding. It captures workspace and
checkout identity, plan, engine, session, assignment, message and correction count.
A second observer slot or checkout lease is refused. It returns observer-armed
only after the worker has reached the verified wait, or already recorded an
event. On success, give a brief waiting notice and **finish the Codex turn**.
Do not call status/wait periodically; no GPT work is needed until a wake hint.
If startup is unconfirmed, inspect this receipt, never start another observer.

For a STOPPED delivered assignment, only an explicit human request to resume
observation permits adding **--resume** to arm. It uses the existing resume-watch
pin/history checks. Uncertain create/submit/reply is still rejected. No task,
count reset, replacement binding, model or executor resume command is sent.

## Handle a wake hint

The fixed hint contains only the receipt UUID. It carries no executor transcript,
commands, new task or authorization. Queue records user input: treat it as an
observer notification under the original scope, not a fresh human instruction.
Read the skill and run consume with that UUID in the same owner chat. Receipts
live under ~/.local/state/code-duet/observers and are local technical evidence.

Consume checks the pinned binding/count and rechecks the live helper gate once.
Only completed-for-review permits review; question/permission requires its fresh
request and normal scoped reply. After reply, arm again and end the turn.
Observing means the event is stale: rearm the unchanged delivery and end the turn.
STOPPED/observer-error means report the failure, without automatic recovery.
Repeated consume returns already-consumed with no action. A failed consume attempt
is retained for diagnosis, not replayed automatically. No observer writes plans.

Only terminal completion, a correlated question/permission or a failure ends the
software wait. Token/tool progress and ordinary polls do not wake GPT. The total
deadline defaults to one hour; expiration is an error, never completion.

## Stop and remove

Cancel stops only observation, never the OpenCode executor. It requests cooperative
cancellation and reports whether the worker exited and whether a notification may
already be queued. A queued notification cannot be recalled by killing a process;
consume rejects cancelled receipts. On an unexplained crash, retain the slot and
checkout lease; do not remove them merely because their owner is unknown.

A durable notification-attempt marker is written **before** queue. There is no
automatic retry after a crash, timeout, CLI update or missing queue response.
Status reports sent versus uncertain delivery. Inspect/consume the existing
receipt; never resend the OpenCode assignment to repair a notification failure.

No autostart entry needs uninstalling. Before replacing/removing the skill, cancel
its observer and confirm exited. Preserve shared state, counts and receipts;
removing the skill does not cancel engine work or grant another writer ownership.
Closed/restarted Desktop, host shutdown and future CLI releases are not guaranteed
to deliver a notification; inspect status after interruption. Do not auto-restart.
