# Teams, permissions and versions

[Back to the README](../README.md#where-to-find-it)

## Set up a soul

Open a soul in **Souls**, click **Edit soul**, then select **Team**. Save the
permissions and settings you want that persona to use.

| Setting | Default | Effect |
| --- | --- | --- |
| Allow child threads by default | Off | New bindings copy this delegation choice. Existing bindings retain their own choice. |
| Allow hiring | Off | Allows automatic creation of specialists with `souls_hire`. Existing threads follow the current setting unless you gave them an override. |
| Preferred model | No preference | Use BB's provider picker to save a provider, model and reasoning level. Applied by the composer and managed child starts. |
| Preferred specialists | Empty | Save up to 20 role/soul pairs. Managers are instructed to reuse a suitable member before hiring. |
| New hires per task | Blank: unlimited | Set 0–100. Zero prevents new hires; deleted hires still count against their original task. |
| Concurrent children | Blank: unlimited | Set 0–50. Zero holds new child admission; excess children wait in the queue. |
| Briefing | Empty | Extra context for every managed child assignment. |
| Expected deliverable | Complete the assigned work and explain the result. | Required result description in each handoff. |
| Required evidence | Report the checks you ran and their results. | Evidence requested from each child. |
| Questions to report | List blockers, uncertainties and decisions still needed. | Questions and blockers requested with each result. |

The thread picker can override delegation and hiring for one thread. An
explicit off choice wins over a saved on choice. Reselecting the same soul
preserves the override; choosing a different soul starts from its defaults.
Children use their chosen soul's own delegation default. Side chats can read
a source persona but do not inherit delegation or hiring permission.

Hiring and delegation are separate. Hiring saves a persona; delegation allows
child work. Agents, imported prompts and draft fields cannot change either
permission. New hires start with both off. Edits and deletes still need a user
review card.

## Assign work

An authorised manager reads `souls_team` and `souls_list`, then reuses an
existing specialist or calls `souls_hire` when one is missing. It assigns work
with `souls_spawn_child`, providing a stable assignment `key`, `soulId`, task
and `access` of `read-only` or `write`.

The plugin checks the specialist's saved model preference on the parent's
environment. An unavailable or incompatible preference falls back visibly to
the parent's execution settings. Permission mode stays inherited. The child
is bound before its first session, and normal queue admission respects the
saved concurrency limit. An explicit host **Send now** remains an override.

Read-only assignments reuse the parent's workspace. That brief asks the child
to inspect and report; it is not a filesystem restriction. Write assignments
get a managed worktree based on the parent's host and branch, so the parent
must have a Git workspace with a known branch.

Repeated assignment keys within the same manager-thread task return the saved
receipt. If the outcome is uncertain, inspect the receipt and parent's children;
never invent a new key to retry an uncertain start. A known failure before any
spawn request can be retried with the same key after its cause is corrected.

For CLI child starts, call `souls_arm_child` immediately before
`bb thread spawn --parent-self`. One arm binds one child and expires after five
minutes. Managed starts do not consume these CLI arms.

## Finish a task

Hires default to **task-only**. The manager calls `souls_finish_task` explicitly
once its children have no queued or running work. This closes its current task,
archives its temporary hires and gives the next task a fresh hiring allowance.
It does not stop or delete threads.

Permanent hires remain available. Use **Keep permanently** on a temporary
hire's profile to retain it. **Show archived** reveals archived personas, and
**Restore to library** makes one assignable again. Existing thread bindings
remain usable, including permission and version edits, while archived personas
are excluded from new assignments. Archived personas cannot hire.

## Use persona versions

**History** shows persona revisions, field changes, hiring provenance and
thread usage. Compare a revision with the current persona, or restore it as a
new revision. Restore copies persona fields and preserves current permissions,
team settings and lifecycle state.

The thread picker's **Persona version** follows latest by default. A pin freezes
persona text, including the selected voice and hard limits, while keeping current
permissions, limits and lifecycle settings. Persona loading, compaction recovery,
the banner and the chat card use the pinned revision. The active session still
keeps its starting instructions until a new session begins.

Session evidence records injection, not behaviour. There is no reply or action
monitor that checks whether a soul is staying in character, and the local grade
makes no model calls.
