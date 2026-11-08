# Connected assignment packet

Fill this template from the existing canonical plan and latest checkpoint.
Do not create another plan or copy the whole conversation. Store the resulting
packet inside the physical workspace. The advisor records route/baseline in
the plan before dispatch; the executor does not edit that checkpoint.
Include the executor instructions and final report requirements below in the
packet. For a manual handoff, see [manual assignment and review](workflow.md#manual-assignment-and-review).

Start the packet with one machine-readable line. Use JSON escaping for paths.

```text
Code Duet packet: {"planPath":"<exact absolute plan>","assignmentID":"<fresh ID>","kind":"<initial|block|correction>"}
```

- Assignment ID: <fresh ID, different from the reviewed assignment>.
- Kind: <initial | block | correction>; correction count before send: <0..20>;
  corrective submission requires fewer than 20 prior corrections.
- Canonical index / plan: <exact absolute existing paths>.
- Workspace / physical checkout: <exact absolute paths>.
- Route: OpenCode session <actual ID>, opencode-go/deepseek-v4.1-flash,
  High reasoning. Read applicable AGENTS.md.
- Overall goal and accepted prerequisites: <concise facts>.
- Assigned connected block / ordered steps: <only authorized steps>.
- Allowed paths and contracts: <exact paths, existing mechanisms to reuse,
  and caller behavior and accepted contracts to preserve>.
- Pre-dispatch baseline: <HEAD/status or explicit non-Git declaration>;
  protected dirty/untracked files: <paths, owners, evidence/hashes or none>.
- Required acceptance criteria: <give each criterion an ID, the real entry
  point or layer to exercise, command or steps, and observable expected result>.
  Add only relevant negative cases, such as dependency failure, invalid input,
  concurrent requests, retry after failure or restart. Specify any side effect
  that must be absent. Example: send two concurrent PUTs that change different
  fields, expect two HTTP 200 responses, and verify both changes in memory and
  storage.
- Remaining runtime/visual/owner gates: <what this block can establish;
  what remains for the advisor/user and cannot be claimed complete>.
- Correction assignment only: <one consolidated actionable list from review;
  preserve accepted changes and fix all listed issues within scope>.
- STOP: <actual scope/permission/baseline/contract uncertainties>.

Read the canonical plan as reference; implement only this assignment.
Do not edit canonical plan/index/checkpoints, commit, push, merge, change branches,
delegate, install without authority, broaden scope or execute unassigned blocks.
A skill mentioned in a Codex plan is not proof it exists in OpenCode: preserve
the contract and report unavailable required capabilities.

Before adding a contract, dependency or shared mechanism, check whether the
existing code or a smaller change covers the requirement. Explain why that
option falls short. Before handoff, reread the actual diff including new files,
compare it with the assignment and trace callers of new functions. Justify
any new abstraction or copied dependency by the gap in existing code.

Finish edits and ordinary foreground checks before final response. Do not
detach project-changing commands. If any known operation remains, report its
identifier/status and do not claim ownership can transfer.
Use actual question/permission tools when needed, wait for their replies and
do not bypass denied permissions.

Final report:

- Separate this round's changes from the cumulative diff. Give changed paths,
  contract choices, preserved prerequisites, source state, and retained
  resources or operations with their identifiers and status.
- For each required criterion give its ID, `PASS`, `FAIL`, `NOT RUN` or
  `BLOCKED`, the entry point actually exercised, exact command or steps,
  observation, and log path if available. Distinguish function, API, built
  application and UI coverage. Use `FAIL` for an observed mismatch,
  `NOT RUN` for an unexecuted check, and `BLOCKED` when a named obstacle
  prevented verification. A required scenario skipped inside a green test
  is still open, even when the process exits 0.
- List all open criteria and remaining runtime, visual and owner gates.
  Give exact artifact paths and confirm cited logs exist before handoff.
  `READY FOR REVIEW` means the report is ready for the advisor. The advisor
  decides acceptance and plan status. Stop after this connected assignment.
