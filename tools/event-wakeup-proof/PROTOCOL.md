# Event wakeup proof (2026-10-27)

This is an installation-specific experiment, not an installed Code Duet feature.
It never imports the production helper, accesses its shared state, or calls
OpenCode. Only the hard-coded disposable Codex thread is permitted. Do not
replace that ID with a production thread or rerun a possibly admitted event.

## Result

A detached hidden Node process waited 120 seconds, then called the bundled
`codex queue --thread <test UUID> --message <synthetic event>` exactly once.
The existing Desktop chat started a second turn and returned
`CODEDUET_EVENT_ACK_016`. A separate Desktop read confirmed the same thread ID,
two completed turns, and idle status. Model, reasoning effort and cwd matched
the initial turn. Neither the observer nor the test chat called any tools in
the idle interval; the parent research chat remained active independently.

Both two-minute idle trials retained exactly one completed initial turn and
one persisted token-usage record. This establishes no periodic generation in
the test chat during those intervals; it is not account-wide API telemetry.

The alternative temporary-stdio-App-Server route could read the chat, but
`thread/resume` failed with `already has an active writer` while Desktop owned
it. No `turn/start` was sent on that route. Do not remove writer locks or use
another store to bypass this refusal.

The successful `queue` event appears as **user input**, not standalone tool
output. A production observer must send only an authorized, fixed wake hint
and trusted receipt identifiers, never raw executor instructions. The hint
does not authorize new work or establish executor completion.

## Deliberate execution

Node 24.19.0 and the Desktop-bundled CLI 0.165.0-alpha.1.2 were used. The
unversioned launcher exposed a different command set; its presence alone does
not establish `queue` availability. No packages, daemon, autostart, hooks or
global skill changes were installed. Temporary observer and App Server
processes exited; the test chat remains idle for inspection.

```text
node --test tools/event-wakeup-proof/probe.test.mjs
node tools/event-wakeup-proof/probe.mjs CODEX_EXE TEST_ROLLOUT NEW_REPORT [tool-output|queue]
```

Live execution creates an exclusive receipt before launching any client.
An existing receipt is refused; no event is retried automatically. A distinct
receipt filename is not permission to retry an uncertain delivery. The
script also rejects a changed/wrong test chat, an unfinished initial turn,
extra turns or recorded usage during idle, and changed model/effort/cwd after
the event. It uses metadata reads and local file checks, not model polling.

The live proof was launched with Windows `Start-Process -WindowStyle Hidden`
and output redirection, not an active model waiting on repeated tool yields.
Its only wake trigger was its own one-shot timer, standing in for a future
significant OpenCode event. Do not use this script as a daemon or production
retry/deduplication implementation.

## Scope still open

Real completion/question/error correlation, ownership and permission handling,
durable notification deduplication after crashes, a busy destination chat,
Desktop restart/closure, long idle periods, CLI updates, installation and
uninstallation still need a separate bounded implementation and verification.
The currently installed skill retains its existing waiting behavior.

Official sources:
[CLI queue](https://learn.chatgpt.com/docs/cli/reference#codex-queue),
[App Server](https://learn.chatgpt.com/docs/app-server).
Internal machine evidence is in the project-root
`plans/evidence/016-event-wakeup-prototype/`, outside the product Git tree.
