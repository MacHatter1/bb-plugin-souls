You want a thread to work like a particular colleague: a careful reviewer who
reads the tests first, or a specialist who knows when to ask for help. Souls
saves that persona so you can choose it for any BB thread, without maintaining
a separate copy of its instructions each time.

## What you get

- **Interview, import or write.** Ask for an interview about the job, voice,
  expertise, principles and hard limits, then approve the draft on a review
  card. Or use the manual editor, upload or paste an agent definition, or
  import a public GitHub file. Codex TOML, Markdown with YAML frontmatter and
  JSON/JSONC profiles are supported. Imported instructions stay verbatim until
  you edit them; only **Create soul** saves the selected draft.
- **A recognisable persona.** Every soul has a stable pixel portrait. Search
  the Souls library by name, job or expertise, filter by use, and open its
  **Persona**, **Team** or **History** tabs. Choose it from the composer's `+`
  menu before a thread starts or during an existing thread.
- **Visible selection and session state.** The composer banner shows the
  selected soul and thread activity. An agent posts a compact `::soul` card
  after loading its persona, with expandable voice, limits and expertise.
  These surfaces report selection and versions; they do not certify behaviour.
- **Teams with your permission.** Save a roster, per-task hiring allowance,
  concurrent-child limit and handoff instructions. Enable **Allow hiring** to
  let a manager save missing specialists automatically. New hires start with
  hiring and delegation off. Managed children apply model preferences with a
  visible fallback, inherit permissions and bind their soul before dispatch.
- **Task cleanup and history.** Explicit task completion archives task-only
  hires after child work settles. Keep useful hires permanently, restore
  archived souls, and inspect hiring and thread history. Compare persona
  revisions, restore one as a new revision, or pin a revision for one thread.
- **Comparisons when requested.** Run a soul against no soul or up to three
  others on the same prompt and project model. The local persona grade starts
  no runs. `bb souls` and the bundled tools and skill cover the same workflows.

## Permissions you control

Save **Allow child threads by default** once for new bindings; the thread
picker can override it, and existing choices stay put. Hiring follows the
current soul setting unless you override it for a thread. Children use their
chosen soul's own default; side chats inherit no authority. Tools, drafts and
imports cannot grant permissions. Edits and deletes always require approval;
creation requires approval unless you enabled hiring. Imported runtime, tool,
sandbox and MCP settings are ignored.

## How it works

A short session pointer tells the agent to load the full persona with
`souls_get`. It uses the thread's pinned revision when present, while current
permissions and team limits still apply. Changes take effect at the next
session; **Apply from the next turn** releases only an idle runtime.

After compaction, Souls restores the persona during tool work or attaches it
to your next message as a removable pill, without starting a turn. Session
evidence records injection, not compliance. No reply or action drift monitor
runs, and browsing, grading and recovery make no model calls. Comparisons and
authorised child work start runs.

## Requirements

bb 0.44 or later, with Plugin SDK 0.5.29 or later. Personas and task records
stay in the plugin's SQLite database on your BB server. Public GitHub imports
fetch only the chosen file; uploads and pasted definitions need no download.
