---
name: code-duet
description: Coordinate authorized implementation through DeepSeek in the local OpenCode Desktop while Codex plans and reviews the shared working tree. Use when the user selects Code Duet or asks for this OpenCode execution route; ordinary coding requests alone do not select it.
---

# Code Duet

Use this route only after an explicit $code-duet or $code-duet:code-duet invocation. The invocation
selects a route; it does not authorize an old plan, installation or publication.
Codex is the advisor and DeepSeek is the sole implementation executor. Do not
invoke Improve Codex or create Codex subagents; keep OpenCode/DeepSeek as the
sole implementation executor.

## Choose the route

For observation of work already sent manually to an explicitly selected OpenCode
session, use [external observation](helper/OBSERVER.md#observe-manually-started-work).
This GET/SSE-only route does not bind, adopt, submit or transfer old ownership.

Use the real current Codex chat ID. Reuse its valid saved pair. If there is no
pair, bind a new OpenCode session in the selected workspace unless the user
explicitly selected an existing recipient; only then read
[existing-session routing](references/existing-session.md). Late entry in an
already-used Codex chat is supported. The user creates fresh Codex chats
manually; never spoof identity, rotate chats or reset a plan count.
Before the ordinary helper route, run [read-only preflight](helper/PROTOCOL.md#preflight)
for the selected workspace and plan. It uses the current chat's saved pair, or
proposes a new bind; pass --session only when the user explicitly selected that
exact existing recipient. A preflight snapshot does not grant dispatch authority;
adopt and submit repeat their own fresh checks. Use inspect for diagnosis when no
plan is ready or after an error; do not require it in addition to a complete preflight.
Before that preflight, run `node helper/cli.mjs task-maintenance <absolute-workspace>
<absolute-plan.md>` to update this task's activity and perform local lifecycle
maintenance. This sends no OpenCode request. It restores a requested archived
counter before preflight, and skips active or uncertain ownership.

Use only opencode-go/deepseek-v4.1-flash with existing/default options. Never
start another engine, switch models or change global settings.

## Assign and review

Read [workflow](references/workflow.md) as the single source for authorization,
baseline, assignment, ownership, waiting, review, corrections, handoff and
checkpoints. Use the [assignment packet](references/assignment-template.md)
only when preparing a packet.
For authorized new planning, use the [plan template](references/plan-template.md)
and reuse the established canonical directory.

Before a helper operation, read the [command reference](helper/PROTOCOL.md#command-reference)
and only its relevant technical sections. Submit one identified assignment
once. After delivery use the [event observer](helper/OBSERVER.md): arm it for
this actual chat, confirm observer-armed, report briefly and **end the turn**.
Do not loop on wait/status tools or narrate unchanged progress. On its wake hint,
consume that receipt once and revalidate the live assignment before acting.
If arm returns observer-terminal, consume its receipt now; it is not a running
observer. Passive completion grants read-only review, never correction dispatch;
use the [guarded transition](references/existing-session.md#from-passive-observation-to-a-new-correction).
Historical exchange errors do not end observation while the selected executor is
running or suppress a fresh correlated question/permission. Keep their failure
evidence. Only the documented binary-read and webfetch GET429 rejections can
permit review with read-only warnings; unknown errors and uncertain writes still
block completion. Inspect every toolErrors entry and independently verify missing
evidence; a warning, fallback exit0 or successful idle does not prove recovery or
acceptance. Review permission never authorizes another dispatch.
While execution or a question is active, DeepSeek owns project edits and
checks. Start review only after completed-for-review, inspect the
actual changes, then send at most one consolidated correction at a time. An
uncertain mutation is STOPPED; never resend it.
Only on an explicit request to resume observation of an already delivered
assignment, use [observer arm --resume](helper/OBSERVER.md). This is a
separate route from dispatch preflight; inspect alone does not authorize it.
A foreground lease blocking that transition uses the [owner diagnosis and
migration route](helper/OBSERVER.md#migrate-a-foreground-wait); never delete a lock.
If the user explicitly abandons an old task blocked by a legacy observation lease,
the same route describes `retire-legacy`; preserve its evidence and count.
Handle scoped questions and permission requests within the user's and runtime
authority. Send source corrections to the executor; do not implement them yourself.

If the Node runtime or helper location is unknown, use the short
[installed-helper check](references/runtime.md#check-an-installed-helper).
Package/build/discovery sections are for explicitly assigned packaging work.
