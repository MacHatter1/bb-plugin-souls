You want a thread to work like a particular colleague: a blunt reviewer for the
payments service who never touches migrations. So you paste the same paragraph
into every new thread, it drifts between copies, and you cannot tell whether the
agent took it on. Souls turns that paragraph into a persona you pick per thread.

## What you get

- **An interview, not a form.** Ask any thread for a soul. The agent asks four
  to seven questions about the job, voice, expertise, principles and hard
  limits, with suggestions you can accept, then puts the draft on a review card:
  **Approve**, **Request changes** or **Dismiss**. Nothing is saved until you
  approve, and an agent's edits and deletes wait for you on a card too.
- **Choose a soul…** in the composer's `+` menu, for an existing thread or one
  you are about to start, and a banner above the composer while a soul is
  active. One soul can run in many threads, and an edit reaches all of them.
- **A pixel-art portrait for every soul**: a human, robot, owl, cat or ghost,
  drawn from its emoji and kept stable. Pin a hat, glasses or palette in the
  editor, or let the interviewing agent pick a look that fits. In the banner
  it animates with what the thread is doing: thinking, running a command,
  editing, or waiting for you.
- **A Souls page** in the sidebar: search a portrait library, filter to souls
  in use, and sort by name or recent use. Edit, delete and compare from there,
  see how many threads run as each, and start an interview.
- **Import an agent file.** Upload, paste, or give a public GitHub link for
  Codex TOML, Markdown with YAML frontmatter, or a JSON/JSONC profile.
  Instructions stay verbatim. Nothing is saved until you click **Create soul**,
  and sandbox, tool and MCP settings are not imported.
- **A `::soul` card** the agent posts once it has loaded its persona: its
  job, limits and expertise, with the full persona a click away.
- **Children that start in character.** An agent arms a soul just before it
  spawns a child, and the child is bound before its first session.
- **Souls can hire specialists.** Enable **Allow hiring** on a soul to let it
  create and save new souls automatically, or reuse an existing one for a child.
  New hires start with hiring and child-thread defaults off.
- **Reusable teams.** Save preferred specialists, hiring/concurrency limits
  and child handoff templates. Managed children apply model preferences with
  a visible fallback. Task-only hires archive on task completion; keep useful
  ones permanently. Profiles show hiring/usage and persona version history;
  the thread picker can pin a version and override hiring for one thread.
- **Comparisons.** Run a soul against no soul, or up to three other souls, on
  the same prompt and project model. A persona grade costs nothing.
- `bb souls` (`list`, `show`, `select`, `status`, `eval`, …) and agent tools
  from `souls_list` to `souls_arm_child`.

## Safe by default

A persona is not permission. Only you can let a soul spawn and coordinate child
threads. Save **Allow child threads by default** once on a soul for new bindings;
the thread picker can override it, and existing threads retain their choices.
Children use their chosen soul's own default rather than a parent's override;
side chats do not inherit consent. Imported prompts and agent drafts cannot
grant it. Automatic hiring needs your saved **Allow hiring** permission;
otherwise creation waits on a review card. Edits and deletes always need
approval. An agent cannot change the soul of a thread it did not spawn.
Applying a soul never stops a working thread. Comparisons start only when you
ask, and every persona says it never overrides BB's rules, your instructions or
safety.

## How it works

BB cuts a plugin's instructions at 4,096 characters, so a thread is given a
short pointer and the agent loads the whole persona with `souls_get`. The
persona is never cut. A soul applies when the thread's next agent session
starts; *Apply from the next turn* releases an idle runtime so that is the next
message. `bb souls status` separates a selected soul from one recorded in a
session, and says **unknown** rather than guess. After a context compaction,
Souls puts the persona back: into the running turn while the agent is still at
work, or with your next message as a pill you can see. Souls live in the
plugin's own SQLite database, shared by the page, the picker, the CLI and the
agent tools.

## Requirements

bb 0.44 or later, with Plugin SDK 0.5.29 or later. No account, no external
service: souls stay on your BB server.
