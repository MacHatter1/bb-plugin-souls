# Import an agent file

[Back to the README](../README.md#where-to-find-it)

Open **Souls → Import agent file** and choose **Upload file**, **Paste text**
or **GitHub URL**. Drop or choose a file, paste a definition, or provide a public
GitHub link. Click **Review draft** (or **Fetch and review** for GitHub).
The format is detected from the filename or contents; **Import options** lets
you override it. Supply an optional filename when pasting an unnamed agent.

<div align="center">

<img src="screenshots/import.png" alt="The import review for a fictional agent named Reviewer. The instructions are kept verbatim, and nothing is saved yet." width="900">

</div>

| Format | Supported definitions |
| --- | --- |
| TOML (`.toml`) | Codex agent files with `developer_instructions`. |
| Markdown (`.md`, `.agent.md`) | YAML-frontmatter agent files from Claude Code, Cursor, Copilot, Gemini CLI, Qwen Code, OpenCode and Kiro. The body supplies the instructions. |
| JSON / JSONC (`.json`, `.jsonc`) | Inline `prompt` profiles such as Kiro's, OpenCode's `agent` configuration object, and Claude Code's `--agents` name-to-definition dictionary. Comments and trailing commas are supported. |

For configurations with multiple agents, search or select an agent card to
preview its instructions, then click **Review agent**. Definitions without valid
inline prompts are skipped with warnings; a file with none reports an error.
Configurations are limited to 50 definitions.

The review editor puts **Agent instructions** first and previews what the agent
will see. Use the **Persona**, **Team** and **Appearance** tabs to adjust the draft.
The **Team** tab holds permissions, the preferred model picker, roster, limits
and handoff instructions. **Import details** explains ignored settings and
warnings. **Back** retains the source and each agent's unsaved persona,
permissions and team settings. Changing the source or import options
starts a new preview.

Nothing is saved until you click **Create soul**; cancelling leaves the library
unchanged. Only the selected agent is created, not the whole configuration.

### Codex TOML

```toml
name = "Reviewer"
description = "Review changes for correctness."
model = "gpt-5"
model_reasoning_effort = "high"
developer_instructions = """
Read the code before suggesting changes.
Report only findings you can substantiate.
"""
```

- `name` becomes the soul's name; if absent, the uploaded or remote filename supplies it.
- `description` becomes the job, and the tagline when it fits (160 characters).
- `developer_instructions` is required and preserved verbatim in **Voice and
  temperament**, up to 32,000 characters. No model rewrites or splits the prompt.
- `model` and `model_reasoning_effort` become an advisory Codex model preference.

### Markdown with YAML frontmatter

```markdown
---
name: Reviewer
description: Review changes for correctness.
model: inherit
---

Read the code before suggesting changes.
Report only findings you can substantiate.
```

The Markdown body is preserved verbatim in **Voice and temperament**, including
blank lines and indentation. JSON imports preserve the inline `prompt` string.
Both use `name` and `description` like TOML; Markdown names derived from
`reviewer.agent.md` become `reviewer`. Optional `model`, `effort` and
`reasoningEffort` values are advisory preferences without a guessed BB provider.
`model: inherit` leaves the current model unchanged. Review harness-specific
model names and reasoning levels in the editor.

Other settings are listed as not imported. Sandbox, approval, tool, hook,
executor and MCP settings cannot grant permissions or delegation consent.
Referenced files are never read or fetched. JSON profiles whose entire prompt
is a file reference report an error; embedded references produce a warning.
Use an agent with inline instructions, not Codex's top-level `config.toml`.
Plain repository instructions such as `AGENTS.md` and frontmatter-only fork
restriction profiles are not agent definitions.

GitHub links can use `https://github.com/owner/repo/blob/ref/path/agent.md`
or `https://raw.githubusercontent.com/owner/repo/ref/path/agent.md`;
`.toml`, `.md`, `.agent.md`, `.json` and `.jsonc` files are supported.
Downloads are public-only, time out after 10 seconds, and never follow redirects
or forward URL credentials/query tokens. For private repositories, upload or
paste the file instead.

Uploads and downloads are limited to 128,000 bytes, pasted definitions to
128,000 characters, and individual prompts to 32,000 characters. Invalid
syntax, duplicate keys, oversized fields and duplicate soul names report
errors rather than silently cutting content or overwriting an existing soul.
YAML aliases and unsupported tags are rejected. Imports are saved as manually
created souls and do not bind or start a thread.
