# Changelog

All notable changes to Souls are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## 0.1.0 - 2026-10-06

### Added

- **Souls:** reusable agent personas with a name, emoji, tagline, job, voice,
  expertise, principles, hard limits and an optional model preference, kept in
  the plugin's own SQLite store.
- **The AI-led interview:** the bundled `souls` skill interviews you, then
  `souls_propose` shows a review card with **Approve**, **Request changes**
  and **Dismiss**. Nothing is saved until you approve.
- **Every agent change waits for you.** `souls_update` shows the same card,
  listing the fields it changes, and `souls_delete` asks you to confirm. An
  agent binds only its own thread or a child it spawned, and `bb souls create`,
  `update` and `delete` refuse when run inside a thread.
- **Choose a soul…** in the composer's `+` menu, for an existing thread or the
  one you are about to start. *Apply from the next turn* releases an idle
  runtime so the next message carries the persona.
- **A banner above the composer** while a soul is active: whether it applies
  from the next session, whether it can delegate, and **Change** to reopen the
  picker. Its name opens a peek at the job and hard limits, and its pills fold
  to icons when the composer is narrow.
- **Pixel-art portraits:** each soul gets a 24×24 character (a human, robot,
  owl, cat or ghost) generated from its emoji and a seed pinned when it is
  created, so it keeps its face. The editor's **Look** panel pins a species,
  hair, headwear, accessory or palette, offering only what that species can
  wear, and **Shuffle** rerolls the rest.
- **Animated portraits in the banner:** a thought bubble while the thread
  thinks, a speech bubble while it writes, a terminal while a command runs, a
  pencil for edits, a magnifier for reading, a bouncing "!" while it waits for
  you, a sweat drop on an error, and closed eyes while it starts up. Reduced
  motion gets a still frame.
- **The persona survives a compaction.** While the agent works with tools, it
  is steered back into the turn, agent-only. Otherwise the banner shows
  **Compacted** and attaches it to your next message as a pill you can see and
  remove, so it never starts a turn of its own.
- **`@` a soul** in the composer to attach its persona to a message.
- **The Souls page** in the sidebar: search, hand-edit, delete and compare
  souls, see which threads run as which soul, and start an interview.
- **A `::soul` persona card** an agent posts once it has loaded its persona,
  tinted with the soul's colours, with tabs for its hard limits, principles,
  expertise and voice, and **Open in Souls**.
- **Child threads:** `souls_arm_child` and `bb souls select --next-child` bind
  a soul to the next child a thread spawns, before its first session.
- **Delegation consent:** an explicit, thread-scoped checkbox that only you can
  tick. Selecting a soul never grants it, and children do not inherit it.
- **Session evidence:** `bb souls status` and the picker separate selection
  from recorded session injection, and show **unknown** rather than guess.
- **Comparisons:** run a soul against no soul, or up to three other souls, on
  the same prompt and project model, plus an optional delegation probe. Runs
  start only when you ask.
- Agent tools `souls_list`, `souls_get`, `souls_eval`, `souls_propose`,
  `souls_update`, `souls_delete`, `souls_select` and `souls_arm_child`.
- `bb souls` with `list`, `show`, `eval`, `create`, `update`, `delete`,
  `current`, `status`, `select`, `unbind` and `threads`.
