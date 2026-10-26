# Plan 003 interaction smoke

Status: ACTIVE. Baseline: dedicated, advisor-prepared fixture in the Code Duet
checkout. Files remain unchanged throughout the assignment.

Use your real question tool, in sequence (wait for each answer):

1. One single-select question with exactly Alpha, Beta, Gamma, Delta options,
   descriptions, and custom answers allowed.
2. Another single-select question with the same four options and custom enabled.
3. A multiple-select question with the same four options and custom enabled.

Then execute the existing wait.mjs once with the Node executable specified in
the packet. Work in this exact directory. Use the normal foreground shell tool,
background false, timeout at least 120000 ms. Do not detach or launch another
process to avoid its real permission prompt. Do not read service credentials.

After it exits, report CODE_DUET_INTERACTION_SMOKE_003, all three actual
answers, the command's exit status and whether any background operations remain.
No edits, installs, Git, settings changes, delegation or other sessions.
