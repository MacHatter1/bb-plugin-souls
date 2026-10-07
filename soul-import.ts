// Codex agent TOML → a soul draft. Pure conversion: no file reads, model
// calls, storage writes, or imported runtime/permission settings.
import { parse, type TomlTable } from "smol-toml";
import { z } from "zod";
import { MAX_AGENT_IMPORT_LENGTH, PERSONALITY_MAX_LENGTH, soulDraftSchema, type SoulDraftValue } from "./shared.ts";

const agentSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(240).optional(),
  developer_instructions: z.string().max(PERSONALITY_MAX_LENGTH)
    .refine((text) => text.trim() !== "", "Provide non-empty developer_instructions."),
  model: z.string().trim().min(1).max(200).optional(),
  model_reasoning_effort: z.string().trim().min(1).max(40).optional(),
});
const IMPORTED_KEYS = new Set(Object.keys(agentSchema.shape));

export function importAgentToml(source: string, filename = ""): {
  draft: SoulDraftValue;
  warnings: string[];
} {
  if (source.length > MAX_AGENT_IMPORT_LENGTH)
    throw new Error(`Agent TOML is too large (maximum ${MAX_AGENT_IMPORT_LENGTH} characters).`);
  let document: TomlTable;
  try {
    document = parse(source.replace(/^\uFEFF/, ""));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid agent TOML: ${message.slice(0, 500)}`);
  }
  const parsed = agentSchema.safeParse(document);
  if (!parsed.success)
    throw new Error(`Invalid agent TOML: ${parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);

  const agent = parsed.data;
  // Role configs predating Codex's name field use the role file's basename.
  // This is only a name hint: never read a referenced config/instructions file.
  const name = agent.name ?? filename.split(/[\\/]/).pop()?.replace(/\.toml$/i, "").trim() ?? "";
  if (name === "" || name.length > 60)
    throw new Error("Invalid agent TOML: name must contain 1–60 characters. Add a name field or use a shorter filename.");

  const description = agent.description ?? "";
  const draft = soulDraftSchema.parse({
    name,
    tagline: description.length <= 160 ? description : "",
    role: description,
    // Keep every character of the prompt; guessing at structured rules can
    // change its meaning. The existing editor and persona renderer own it.
    personality: agent.developer_instructions,
    model: agent.model === undefined && agent.model_reasoning_effort === undefined
      ? null
      : { providerId: "codex", model: agent.model ?? null, reasoningLevel: agent.model_reasoning_effort ?? null },
  });
  const ignored = Object.keys(document).filter((key) => !IMPORTED_KEYS.has(key));
  return {
    draft,
    warnings: ignored.length === 0 ? [] : [`TOML settings not imported: ${ignored.join(", ")}.`],
  };
}
