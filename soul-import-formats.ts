// Pure, bounded agent-file conversion. No file references, hooks, executors,
// tools, MCP servers, or permissions are ever loaded or run.
import { parseDocument } from "yaml";
import stripJsonComments from "strip-json-comments";
import { z } from "zod";
import {
  MAX_AGENT_IMPORT_LENGTH, MAX_AGENTS_PER_IMPORT, PERSONALITY_MAX_LENGTH,
  soulDraftSchema, type AgentImportFormat, type SoulDraftValue,
} from "./shared.ts";
import { importAgentToml } from "./soul-import.ts";

export type ImportedAgent = { draft: SoulDraftValue; warnings: string[]; sourceName?: string };
export type AgentImportResult = { agents: ImportedAgent[] };

const metadataSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  description: z.string().trim().max(240).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.string().trim().min(1).max(40).optional(),
  reasoningEffort: z.string().trim().min(1).max(40).optional(),
});
const promptSchema = z.string().max(PERSONALITY_MAX_LENGTH)
  .refine((text) => text.trim() !== "", "Provide non-empty agent instructions.");
const IMPORTED_KEYS = new Set(Object.keys(metadataSchema.shape));

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function error(format: string, detail: string): Error {
  return new Error(`Invalid agent ${format}: ${detail.slice(0, 500)}`);
}

function ignoredSettings(document: Record<string, unknown>, imported: Set<string>, format: string): string[] {
  const ignored = Object.keys(document).filter((key) => !imported.has(key));
  if (ignored.length === 0) return [];
  // Unknown keys may contain arbitrary input; bound diagnostic amplification.
  const keys = ignored.slice(0, 30).map((key) => key.slice(0, 80)).join(", ");
  return [`${format} settings not imported: ${keys}${ignored.length > 30 ? ` (and ${ignored.length - 30} more)` : ""}.`];
}

function convertAgent(document: unknown, prompt: unknown, filename: string, format: string, json = false): ImportedAgent {
  if (!object(document)) throw error(format, "Agent metadata must be an object.");
  const metadata = metadataSchema.safeParse(document);
  const instructions = promptSchema.safeParse(prompt);
  if (!metadata.success || !instructions.success) {
    const issues = [
      ...(!metadata.success ? metadata.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`) : []),
      ...(!instructions.success ? instructions.error.issues.map((issue) => `instructions: ${issue.message}`) : []),
    ];
    throw error(format, issues.join("; "));
  }
  const agent = metadata.data;
  const name = agent.name ?? filename.split(/[\\/]/).pop()?.replace(/(?:\.agent)?\.md$|\.jsonc?$|\.toml$/i, "").trim() ?? "";
  if (name === "" || name.length > 60)
    throw error(format, "name must contain 1–60 characters. Add a name field or supply an agent filename.");

  const body = instructions.data;
  // Kiro and OpenCode can reference external prompts. Do not mistake an
  // unresolved reference for the agent's actual instructions.
  if (json && (/^file:\/\//i.test(body.trim()) || /^\{file:[^}]+\}$/.test(body.trim())))
    throw error(format, "Referenced prompt files are not read. Supply an agent with inline instructions instead.");
  const warnings = ignoredSettings(document, json ? new Set([...IMPORTED_KEYS, "prompt"]) : IMPORTED_KEYS, format);
  if (/\{file:[^}]+\}/.test(body))
    warnings.push("Instructions contain a file reference; referenced content was not loaded.");
  if (agent.effort !== undefined && agent.reasoningEffort !== undefined && agent.effort !== agent.reasoningEffort)
    throw error(format, "effort and reasoningEffort conflict. Supply only one reasoning preference.");
  const model = agent.model === "inherit" ? undefined : agent.model;
  const reasoning = agent.effort ?? agent.reasoningEffort;
  if (agent.model === "inherit")
    warnings.push("Model 'inherit' keeps the thread's current model; no model id was imported.");
  if (model !== undefined || reasoning !== undefined)
    warnings.push("Model preferences are harness-specific. Review the BB provider, model and reasoning level before saving.");
  const description = agent.description ?? "";
  return {
    draft: soulDraftSchema.parse({
      name, role: description, tagline: description.length <= 160 ? description : "",
      personality: body,
      // Model vendors/names do not identify a BB harness. Never guess one.
      model: model === undefined && reasoning === undefined ? null
        : { providerId: null, model: model ?? null, reasoningLevel: reasoning ?? null },
    }),
    warnings,
  };
}

function importMarkdown(source: string, filename: string): ImportedAgent {
  const opening = /^---[ \t]*(?:\r\n|\n)/.exec(source);
  if (opening === null) throw error("Markdown", "Use an agent Markdown file beginning with YAML frontmatter (---).");
  const delimiter = /^---[ \t]*(?:\r\n|\n|$)/gm;
  delimiter.lastIndex = opening[0].length;
  const closing = delimiter.exec(source);
  if (closing === null) throw error("Markdown", "YAML frontmatter is missing its closing --- line.");
  let metadata: unknown;
  try {
    const document = parseDocument(source.slice(opening[0].length, closing.index), { uniqueKeys: true, strict: true });
    if (document.errors.length > 0 || document.warnings.length > 0)
      throw new Error([...document.errors, ...document.warnings].map((issue) => issue.message).join("; "));
    // Reject aliases rather than expanding an untrusted YAML alias graph.
    metadata = document.contents === null ? {} : document.toJS({ maxAliasCount: 0 });
  } catch (cause) {
    throw error("Markdown", `YAML frontmatter: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  // Slice the original source, keeping every body character and line ending.
  return convertAgent(metadata, source.slice(closing.index + closing[0].length), filename, "Markdown");
}

function readJson(source: string): unknown {
  try {
    const json = stripJsonComments(source, { trailingCommas: true });
    // Native JSON parsing is the syntax and value authority, including escapes.
    const value: unknown = JSON.parse(json);
    // JSON is a YAML 1.2 subset. Reuse the YAML parser only to detect duplicate
    // object keys at every depth; JSON.parse alone would silently take the last.
    const document = parseDocument(json, { schema: "json", uniqueKeys: true, strict: true });
    if (document.errors.length > 0)
      throw new Error(document.errors.map((issue) => issue.message).join("; "));
    return value;
  } catch (cause) {
    throw error("JSON", cause instanceof Error ? cause.message : String(cause));
  }
}

function importJson(source: string, filename: string): AgentImportResult {
  const document = readJson(source);
  if (!object(document)) throw error("JSON", "Use an agent object or a configuration containing agent definitions.");
  let definitions: Record<string, unknown> | undefined;
  let warnings: string[] = [];
  if (Object.hasOwn(document, "agent")) {
    if (!object(document.agent)) throw error("JSON", "agent must be an object keyed by agent name.");
    definitions = document.agent;
    warnings = ignoredSettings(document, new Set(["agent"]), "Top-level JSON");
  } else if (!Object.hasOwn(document, "prompt") && Object.values(document).length > 0
    && Object.values(document).every(object) && Object.values(document).some((value) => object(value) && Object.hasOwn(value, "prompt"))) {
    // Claude Code's --agents JSON is a direct name → definition dictionary.
    definitions = document;
  }
  if (definitions === undefined)
    return { agents: [convertAgent(document, document.prompt, filename, "JSON", true)] };
  const entries = Object.entries(definitions);
  if (entries.length > MAX_AGENTS_PER_IMPORT)
    throw error("JSON", `A configuration can contain at most ${MAX_AGENTS_PER_IMPORT} agents.`);
  const agents: ImportedAgent[] = [];
  const skipped: string[] = [];
  for (const [name, definition] of entries) {
    try {
      agents.push({ ...convertAgent(object(definition) ? { name, ...definition } : definition, object(definition) ? definition.prompt : undefined, "", "JSON", true), sourceName: name });
    } catch (cause) {
      skipped.push(`Skipped agent '${name.slice(0, 60)}': ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  if (agents.length === 0)
    throw error("JSON", `No importable agents with inline prompts. ${skipped.join("; ")}`);
  return { agents: agents.map((agent) => ({ ...agent, warnings: [...warnings, ...skipped, ...agent.warnings] })) };
}

export function importAgentFile(source: string, filename = "", format: AgentImportFormat = "auto"): AgentImportResult {
  if (source.length > MAX_AGENT_IMPORT_LENGTH)
    throw new Error(`Agent file is too large (maximum ${MAX_AGENT_IMPORT_LENGTH} characters).`);
  const text = source.replace(/^\uFEFF/, "");
  let selected = format;
  if (selected === "auto") {
    if (/\.toml$/i.test(filename)) selected = "toml";
    else if (/\.md$/i.test(filename)) selected = "markdown";
    else if (/\.jsonc?$/i.test(filename)) selected = "json";
    else if (/^---[ \t]*(?:\r\n|\n)/.test(text)) selected = "markdown";
    else if (/^(?:\{|\[|\/\/|\/\*)/.test(text.trimStart())) selected = "json";
    else selected = "toml";
  }
  switch (selected) {
    case "toml": return { agents: [importAgentToml(text, filename)] };
    case "markdown": return { agents: [importMarkdown(text, filename)] };
    case "json": return importJson(text, filename);
  }
}
