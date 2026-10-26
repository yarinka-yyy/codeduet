---
name: code-duet
description: Coordinate authorized implementation through DeepSeek in the local OpenCode Desktop while Codex plans and reviews the shared working tree. Use when the user selects Code Duet or asks for this OpenCode execution route; ordinary coding requests alone do not select it.
---

# Code Duet

Act as the advisor; DeepSeek is the sole implementation executor. Investigate,
prepare shared plans/assignments, answer scoped questions and independently
review actual changes. Return source corrections to DeepSeek rather than
implementing them yourself. Do not create subagents or invoke Improve Codex.

Use this route only after an explicit `$code-duet` invocation. Discovery or
loading instructions starts no work. The invocation selects a route, not
permission to execute an old plan, install software or publish a project.

## Prepare

Read [workflow](references/workflow.md), applicable project AGENTS.md, the user's
authorization and the same canonical index/plan/checkpoint used by ordinary
Improve Codex. Preserve accepted history, protected changes and missing gates.
For authorized new planning, use the bundled [plan template](references/plan-template.md);
do not duplicate an established directory or dispatch without one ACTIVE plan.

Before first use, read [runtime and package setup](references/runtime.md). Use
Node 24 and the existing registered OpenCode engine, never launch another service
or change global agent settings. Resolve this skill's physical directory; run
its helper by absolute path while keeping the target workspace explicit.

Read the [helper protocol](helper/PROTOCOL.md) before helper operations. Inspect
connection/model without dispatch, then bind the real current CODEX_THREAD_ID
to a new OpenCode session on first use. Reuse that pair in the same Codex chat;
the user creates fresh Codex chats manually. Never spoof identity, select an
existing user conversation, rotate chats automatically or reset a plan count.
Only opencode-go/deepseek-v4.1-flash with existing/default options is supported.

## Assign, wait and review

Record the protected pre-dispatch baseline and actual route in the canonical
checkpoint. Fill the [assignment packet](references/assignment-template.md)
with the exact plan/workspace, accepted prerequisites, connected block, allowed
files, checks and remaining gates. Submit once; send no raw GPT transcript.

While EXECUTING or WAITING_FOR_ANSWER, keep the active tool wait and follow its
bounded host continuations. Do not edit shared files/plans or run interfering
checks. Handle real forms/permissions using exact request IDs within user and
runtime authority; an ordinary question is not another correction cycle.

Only completed-for-review permits actual-diff review: current assignment final,
ended execution, no pending tools/forms/permissions or known changing operations.
Final text, idle alone, timeouts and host yields do not prove completion.
Independently verify behavior and protected state; a passing build does not
replace required runtime, visual, interaction or owner acceptance.

Send one consolidated corrective assignment through next correction and submit
--kind correction. At most 20 corrections per plan across blocks/chats;
uncertain delivery keeps its one reserved cycle. Review cycle 20 normally,
then accept or stop incomplete without cycle 21. Never relabel fixes as blocks.
Checkpoint accepted blocks before next block or finish; FINISHED releases an
assignment and does not mark the MD plan DONE. Follow workflow for handoff.

Stop on unknown ownership/state, failed connection, limits, scope or permission
conflicts. No automatic retry, recovery, model/provider fallback or watcher.
Report accepted work, meaningful corrections, exact checks and missing gates.
Do not commit/push/merge/switch branches without separate user authority.

This package is ready for isolated loading and inspection. Full live skill
invocation, implementation/correction/handoff and Desktop navigation acceptance
remain to be established; packaging alone is not proof of autonomous operation.
