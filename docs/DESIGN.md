# Souls: design notes

An architecture map for maintainers. The user-facing story is in
[README.md](../README.md), and the agent-facing interview protocol is in
[skills/souls/](../skills/souls/).

## Files

| File | Owns |
| --- | --- |
| `shared.ts` | The soul data model (zod), the persona renderer, the interview kickoff prompt. Imported by both bundles; keep it free of BB imports. |
| `soul-import.ts` | Pure Codex agent TOML conversion to a validated soul draft, with warnings for ignored runtime settings. No file reads or writes. |
| `soul-import-formats.ts` | Bounded format detection and Markdown/YAML + JSON/JSONC conversion. Returns candidate drafts for explicit selection, preserves instructions and never resolves file references or imports runtime settings. |
| `soul-import-github.ts` | Server-only public GitHub URL validation and download: fixed raw host, no redirects/credentials, 10-second timeout and streaming byte limit, then the same converter. |
| `eval.ts` | Persona grade, the comparison prompt, and the run record. Pure. Starting the threads is `server.ts`. |
| `portrait.ts` | The 24×24 pixel-art portrait: traits from `look`, the emoji and a seed, then drawing. Pure. |
| `motion.ts` | Thread activity and mood, and the animation frames for each mood. Pure. |
| `store.ts` | SQLite access. **Synchronous on purpose**: `bb.agents.configure` cannot await. |
| `server.ts` | RPC contract, agent tools, `configure`, the review and delete cards, the dispatch hook, activity and compaction, the CLI. |
| `app.tsx` | Slot registration only. |
| `components/souls-page.tsx` | Library orchestration, profile/actions, comparison dialog and title-bar creation chooser. |
| `components/soul-library.tsx` | Library cards, loading/empty states, creation options and readable profile sections. |
| `soul-library.ts` | Pure summary search, natural/recent sorting and visible selection. No storage or thread authority. |
| `components/soul-form.tsx` | The hand-editing dialog (create/update), including review of imported drafts. |
| `components/soul-import.tsx` | GitHub URL, file upload or pasted definition → format detection/override → read-only candidate RPC → agent selection when needed → the existing editor's explicit Create soul action. |
| `components/soul-picker.tsx` | The picker dialog, the composer banner, the app-overlay fallback, and the window-event handshake between them. |
| `components/soul-review.tsx` | The `pendingInteraction` renderers: the review card for `souls_propose` and `souls_update`, and the delete confirmation for `souls_delete`. |
| `components/soul-embed.tsx` | The `::soul{id="…"}` message directive. |
| `components/soul-bits.tsx` | Portrait and aura, pills, chips, fields, line-list inputs, read-only soul body. |
| `hooks/use-souls.ts` | RPC reads kept current by `souls-changed`, `souls-activity` and thread-filtered `souls-session-changed` signals. |
| `skills/souls/SKILL.md` | Triggers, tool map, rules. Injected into every thread, so keep it short. |
| `skills/souls/references/interview.md` | The interview protocol; loaded on demand by the skill. |

`shared.ts` has two renderers. `renderSoulPersona` is the whole persona,
returned by `souls_get`, `souls_select` and `souls_propose`, and previewed by
the editor. `renderSoulInstructions` is the pointer `configure` injects,
previewed by the picker with thread-scoped consent.

## Library UI

The host title bar owns one New soul chooser: interview, import or manual editor.
The page keeps import as a secondary shortcut. The portrait library searches name,
tagline, job and expertise, sorts without mutating RPC data, and filters only known
positive thread selections. Usage loading/failure is unknown, never a zero count.
The profile reads the matching full soul or shows a skeleton/error, never the
previous selection's instructions. Compare and Delete are explicit dialogs;
merely opening the page or either dialog starts no comparison or deletion.

Named container queries switch below 48rem of panel width (not viewport width)
to list/profile drill-down. Back retains query and list scroll; keyboard focus
moves to the profile heading and back to the selected card without opening a
keyboard. Portraits are 48px in cards/compact profiles and 72px in wide profiles.
Deep links open the requested soul; missing links never fall back to a different
persona. Native BB bottom sheets, modal focus handling and theme tokens remain
shared with the import/editor surfaces. Loading/empty/error are distinct states.

## Import review UI

The import dialog owns a read-only two-step flow: source (and optional agent
selection), then editable review. Upload, Paste and GitHub retain their inputs
when switching tabs. Source/format changes invalidate previews; Back preserves
source and separate edits for every candidate. Closing invalidates pending file
reads/RPCs and clears the session. Only the editor's explicit Create soul action
writes to storage.

Reuse BB theme tokens and shared dialog primitives. On compact viewports these
become native bottom sheets, not centered desktop dialogs. Headers and actions
are fixed while bodies scroll. Agent cards and prompt previews have matching
desktop heights. Import notes, appearance and persona details are disclosures;
instructions stay prominent and the complete live persona remains available.
Source and save errors appear directly above the actions, never below the fold.
Keyboard source tabs, native radio groups and focusable prompt previews preserve
accessible navigation without importing runtime authority.

## Invariants worth protecting

1. **The store is the only writer.** UI, CLI, and tools all go through it. The
   dispatch hook is the other place that binds a thread: a compose-screen
   pending soul onto a brand-new thread a person starts in the app (origin
   `app`, no sender thread), or an armed child soul
   onto the next child that parent spawns. Both land before the first session.
2. **`configure` never throws.** It fails closed for the whole plugin if it
   does, which would strip the tools from every thread. It is wrapped in a
   try/catch that logs and contributes nothing.
3. **`configure` always returns the full tool list and the `souls` skill.**
   Returning `[]` deselects them for that resolution: the selection *is* the
   return value.
4. **The dispatch hook never rejects.** A throwing hook fails the user's
   message attempt; it swallows everything and always returns `proceed`.
5. **An agent changes a soul only through a card the user approves.** A soul
   is shared: an edit reaches every thread running it, so a prompt injection
   in one thread must not be able to rewrite a persona the others load.
   `souls_propose` and `souls_update` wait on the review card (an edit lists
   the fields it changes), `souls_delete` on a confirmation. The editor and the
   CLI outside a thread are the user's own hands and save directly. Inside a
   thread the CLI is usually that thread's agent, so `bb souls create`,
   `update` and `delete` refuse there. An agent binds only its own thread or a
   child it spawned (`souls_select`, `bb souls select|unbind`); any other
   thread's soul is chosen in that thread.
6. **A thread is injected a pointer, never the persona.** BB cuts plugin
   instructions at 4096 characters, so `renderSoulInstructions` emits only the
   soul's identity, consent, and an instruction to load `renderSoulPersona`
   through `souls_get` and post `::soul{id}`. The pointer is bounded by
   `INSTRUCTION_BUDGET` (3800). The persona is never cut.
7. **Model pins are advisory.** Only the composer can apply them (a provider
   change is a handoff). The backend never writes `threads.update` model
   fields. A comparison leaves the pin off so every arm uses the project's model.
8. **A comparison binds before the first turn.** Each arm is spawned with the
   prompt held, marked as an eval thread, then selected, then released. The
   dispatch hook skips eval threads, so a parent's armed child is not consumed.
   Opening the Souls page does not start a run. The optional delegation probe
   explicitly authorises one child per arm; actual child counts are evidence,
   while independent verification still needs transcript review.
9. **Consent is separate from personality.** Only explicit user selection or
   review approval sets per-thread delegation consent. Tool/CLI selections
   preserve consent for the same soul, reset it for a different one, and never
   grant it. Forks and armed children do not inherit it. This does not widen
   provider permission modes or other approvals.
10. **Prepared is not injected.** `configure` records changed fingerprints.
    `souls_thread_get`/`bb souls status` correlate these with recorded session
    identity timestamps. Later live-turn resolutions cannot relabel an old
    session as updated. Missing evidence stays unknown. Thread deletion removes
    tracking; clearing a soul records an explicit no-soul selection.

## Injection versus behaviour

BB cuts a plugin's dynamic instructions at 4096 characters, so a soul is not
injected whole. **What the next session receives** in the picker previews the
pointer a thread gets: the soul's name, tagline and id, thread consent, and an
instruction to call `souls_get` before the first reply, adopt the persona it
returns, start that reply with `::soul{id="…"}`, and call it again after
context compaction. The persona itself is never cut, whatever the soul's size;
the editor previews it in full. Consent stays inline because it is a
permission, not persona, and must hold even if the agent never loads the
persona.

The trade-off: a persona depends on the agent making that call. The `::soul`
card in the thread shows that it did.

## Session-construction semantics (bb 0.45 / pi; unit-tested lifecycle correlation)

- A binding applies when BB constructs the thread's provider session.
- A live session keeps its old instructions; `bb thread stop` on an idle thread
  plus the next turn constructs a fresh session that carries the new persona.
  The picker's *Apply from the next turn* checkbox and `bb souls select --now`
  do exactly that, and check for idle before stopping. Clearing a soul in the
  picker follows the same path. The SDK has no atomic idle-only stop, so a turn
  racing between the status check and stop remains a host-level limitation.
- `message.dispatch` admission runs before provisioning, so a binding made
  there is present for a new thread's first session.
- A soul picked on the compose screen waits server-side for five minutes, in
  memory and mirrored to kv. The dispatch hook binds it to the next thread a
  person starts in the app. Plugin workers, CLI and SDK starts also dispatch
  with initiator `user`, so the hook also requires origin `app` and no sender
  thread; without that, a background recap thread took the choice. The RPC
  reports `expiresAt`, and the composer banner refetches then, so it never
  outlives the choice.
- `souls_arm_child` queues a soul on the parent for five minutes, at most
  eight at a time. The dispatch hook binds it to the next child that parent
  spawns. An arm matches a child created after it (with a two-second clock
  allowance), and a child that already has its own soul is left alone.

## Evidence

Configuration fingerprints are preparation, not proof of injection. Status
correlates the latest recorded `thread/identity` event with the configuration
prepared before it. Later live-turn resolutions never mark a new version
injected into an older session, and equal timestamps are reported as unknown
rather than applied. Missing history is **unknown**. The display names the
recorded session; it cannot certify model compliance or detect an external
idle-runtime release for which BB publishes no session event.

## Comparisons

A comparison spawns one thread per arm in the chosen project with the prompt
held for two minutes, binds each soul arm, then releases the held messages.
Prompts are capped at 8000 characters, a run compares with at most three other
souls, `bb souls eval show` trims each reply to 4000 characters, and the store
keeps the newest 30 runs. An arm's thread is marked as a comparison thread
for a day (the mark matters only around its first turn) and unmarked when
the thread is deleted.

The **Delegation and verification probe** sends a fixed task (17 × 19 = 323):
delegate it, calculate it independently, and report the child id and the
verification command and output. **Authorize and run delegation probe**
permits one child per arm, and the child may not spawn further children. **Check recorded evidence** shows session injection and actual child
counts separately from the transcript. Verification is reviewed by you, not
certified by the static persona grade.

## Portraits

`portrait.ts` draws every soul's 24×24 pixel-art portrait; nothing is stored
but the soul's optional `look`. It is pure, so the server, the UI and the
tests share it.

- **Traits** come from, in order: the pinned `look`, hints from the emoji (🦉
  an owl, 🛰️ a robot, ☁️ a ghost, 🎩 a top hat…), then a PRNG seeded by
  `look.seed`, or by the soul id when there is none. Every roll happens in the
  same order whatever is pinned, so pinning one trait never reshuffles the
  others. Hints match base code points, so an emoji with or without its
  U+FE0F variation selector hints the same.
- **What a species can wear:** `accessoriesFor` lists it (no beard on a cat,
  no glasses on an owl or robot). `resolveLook` turns an accessory the species
  cannot wear into `none`, so what it reports is what is drawn, and the
  editor offers only what fits. Only humans draw hair.
- **Seeds:** a draft has no id, so its preview is seeded by name, and
  `store.insert` pins `look.seed` to that name. The face on the review card is
  the face the soul keeps, through renames. A proposed update without a look
  keeps the soul's existing one.
- **Drawing:** layered shapes on a sprite, then a rim-light and shadow pass per
  surface (details like eyes are painted over a surface and shading looks
  through them), then a one-pixel outline. Colours come from PICO-8's palette;
  they are the art, not UI chrome, so they do not use theme tokens.
- **Rendering:** `SoulPortrait` emits crisp SVG runs. Keep its size a multiple
  of 24px (36, 48, 72, 96) so pixels stay square on 2× screens. `SoulAura`
  blurs the portrait to tint the card cover and the banner.

## Motion

`motion.ts` turns what a thread is doing into a looping pixel animation for
the banner portrait.

- **Activity (server):** while a soul thread is active, the
  `experimental_thread.events` listener reads its latest `item/started` or
  `item/completed` event. A started item maps to an activity (a background
  task is a long command, so it is `running`); a completed one means the model
  is working out its next step (`thinking`). Changes go out on
  `souls-activity`, and `souls_activity_get` serves the current one. Each
  read is numbered per thread, so a slow read never overwrites a newer one,
  and an archived or deleted thread is forgotten.
- **Mood (client):** `useThreadMood` adds the host's live thread view
  (`experimental_useSidebarThreads`): a pending approval or question is
  `waiting`, an errored thread `error`, a provisioning one `starting`.
- **Animation:** each mood has an overlay sprite with frames, a figure motion
  (nod, hop, shake) and an eye state (blink or closed). `SoulPortrait` draws
  them with SMIL `animate`/`animateTransform` in `discrete` mode, so pixels
  never blur, and keys its layers by mood so a change mounts fresh timelines.
  With `prefers-reduced-motion` it shows one still frame. Activity changes at
  most once a second, so a tool call shorter than that may not show.

## Compaction

The injected pointer survives a compaction; the persona `souls_get` returned is
summarised away with the conversation, and agents do not reliably reload it
themselves. The `experimental_thread.events` listener checks each soul thread's
latest `thread/compacted` event and keeps `{ seenAt, seenSeq, pending,
attachedAt }` in kv. A compaction from before Souls first watched (a time kept
in kv, so a reload does not move it) or before the thread took its soul is
history, not new. One settle runs per thread at a time; an event that arrives
meanwhile is settled straight after.

- **While a turn uses tools:** if the running turn's latest item is tool work
  (not an agent message, reasoning or plan), `renderCompactionReminder` is sent
  with `threads.send` in `steer` mode as agent-only text. Claude Code reads it
  at the next tool step. This covers the turn that compacted and any later
  one, so a message sent from the CLI or another client is covered too.
- **Otherwise:** the reminder stays pending, and the composer banner inserts a
  `soul` mention (`<soulId>~<threadId>`) into the draft, once per compaction
  across windows and panes (local storage, and any existing pill is removed
  first). The mention provider resolves it at send time to the reminder,
  attached agent-only to the user's own message, and records `attachedAt`. The
  reminder is settled when a turn start or accepted input at or after that
  time reaches the thread. A send that never lands is owed again after ten
  minutes.
- **Let go:** if the turn that compacted ends and then a whole later turn runs
  without the reminder (the user removed the pill, or no tool was used), it is
  no longer owed and the banner stops showing **Compacted**. The pointer still
  tells the agent to reload after a compaction.

Two traps this avoids, both seen live. A manual compaction runs as its own
short turn, so the thread is `active` while it settles. And Claude Code reads
a steer that arrives during a tool-free answer only after that answer, as an
extra turn with an unprompted reply. `steer` and `steer-if-active` both start
a turn on an idle thread, so nothing here sends to an idle one. The status
check and the send are separate calls, and the SDK has no atomic
"steer only if still running", so a turn ending in between is a host-level
race this cannot close.

## Realtime

Selection and persona writes publish `souls-changed`. Preparation and recorded
session events publish thread-filtered `souls-session-changed`. Open pages and
pickers refetch whether a change came from the UI, the CLI or an agent.
Handlers go through `useSignal`, which reads the latest render through a ref,
so a pane that switches threads never filters on the old thread id.

## Frontend gotchas

- There is no composer action. BB folds plugin actions into a "More plugin
  actions" overflow when the row is crowded, where a soul chip is easy to miss.
  The `+` menu row (**Choose a soul…**) is the entry point, and a banner above
  the composer shows the active soul.
- The `+` row calls `requestSoulPicker` with its composer. Mounted banners
  register themselves (they stay mounted even when they show nothing), and the
  picker opens in one banner only: the asking composer's when the host hands
  both the same composer object, else the one whose composer holds focus,
  else the newest. That keeps one picker when the same thread is open in two
  panes. With no banner mounted, a `souls:open-picker` window event opens the
  app overlay.
- The banner uses `chrome: "bare"`, so a thread with no soul shows nothing.
- A soul's colour comes from `SoulAura`: its portrait, enlarged and blurred
  behind the card cover and the banner. It gives each soul a distinct tint
  without a colour literal in the UI, which plugin styling forbids.
- `SoulPortrait` is memoised on the face, mood and size, and the banner keeps
  the live mood in a small `BannerIdentity` child: the sidebar thread list and
  the composer view both re-render the banner often.
- Do not use `dark:` variants. The plugin build compiles them to
  `prefers-color-scheme`, not BB's `.dark` theme class, so they follow the OS
  rather than BB's theme. Pick values that read in both modes.
- `useComposer()` is only valid inside a composer surface (actions and
  banners). The overlay deliberately cannot apply model pins and says so in a
  toast.
- The `+` row reads its scope from `composer.scope`, which every SDK since
  0.5.29 provides; SDK 0.6 dropped the `view` argument.
