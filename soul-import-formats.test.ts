import assert from "node:assert/strict";
import { test } from "node:test";
import { importAgentFile } from "./soul-import-formats.ts";
import { MAX_AGENT_IMPORT_LENGTH, MAX_AGENTS_PER_IMPORT, PERSONALITY_MAX_LENGTH } from "./shared.ts";

const body = '\n  Keep "quotes", café and indentation.\n\nNever reformat.\n';
const markdown = `---\nname: Reviewer\ndescription: Review changes.\n---\n${body}`;

test("auto-detects TOML, Markdown, JSON and commented JSONC without a filename", () => {
  for (const source of [
    'name = "Reviewer"\ndeveloper_instructions = "Be precise."',
    '---\nname: Reviewer\n---\nBe precise.',
    '{"name":"Reviewer","prompt":"Be precise."}',
    '// Configuration\n{"name":"Reviewer","prompt":"Be precise.",}',
    '/* Configuration */\n{"name":"Reviewer","prompt":"Be precise."}',
  ]) {
    const result = importAgentFile(source);
    assert.equal(result.agents.length, 1);
    assert.equal(result.agents[0]!.draft.name, "Reviewer");
    assert.equal(result.agents[0]!.draft.personality, "Be precise.");
  }
});

test("filename detection is explicit, and the format override can resolve misleading names", () => {
  assert.throws(() => importAgentFile(markdown, "reviewer.toml"), /Invalid agent TOML/);
  assert.equal(importAgentFile(markdown, "reviewer.toml", "markdown").agents[0]!.draft.name, "Reviewer");
  assert.throws(() => importAgentFile(markdown, "reviewer.md", "json"), /Invalid agent JSON/);
});

test("Markdown preserves every body character, including BOM input, Unicode and CRLF", () => {
  for (const source of [markdown, "\uFEFF" + markdown, markdown.replaceAll("\n", "\r\n")]) {
    const { draft } = importAgentFile(source).agents[0]!;
    assert.equal(draft.personality, source.includes("\r\n") ? body.replaceAll("\n", "\r\n") : body);
    assert.equal(draft.role, "Review changes.");
    assert.equal(draft.tagline, "Review changes.");
    assert.deepEqual(draft.principles, []);
  }
});

test("Claude, Cursor, Copilot, Gemini, Qwen and OpenCode frontmatter converts without runtime permissions", () => {
  const cases = [
    ['model: sonnet\neffort: high\ntools: [Read, Grep]\npermissionMode: bypassPermissions\nhooks: {Stop: [{command: do-not-run}]}', "sonnet", "high", "tools, permissionMode, hooks"],
    ['model: inherit\nreadonly: true\nis_background: true', null, null, "readonly, is_background"],
    ['tools: [read, search]\nmcp-servers: {custom: {command: do-not-run}}', null, null, "tools, mcp-servers"],
    ['kind: local\nmodel: gemini-3-flash-preview\ntemperature: 0.2\nmax_turns: 10', "gemini-3-flash-preview", null, "kind, temperature, max_turns"],
    ['model: openai:gpt-4o\nexecutor: {kind: acp, command: do-not-run}\napprovalMode: yolo', "openai:gpt-4o", null, "executor, approvalMode"],
    ['model: anthropic/claude-sonnet-4\nmode: subagent\nreasoningEffort: medium\npermission: {edit: deny}', "anthropic/claude-sonnet-4", "medium", "mode, permission"],
  ] as const;
  for (const [settings, model, reasoning, ignored] of cases) {
    const result = importAgentFile(`---\nname: Reviewer\n${settings}\n---\n${body}`).agents[0]!;
    assert.equal(result.draft.personality, body);
    assert.deepEqual(result.draft.model, model === null && reasoning === null ? null
      : { providerId: null, model, reasoningLevel: reasoning });
    assert.ok(result.warnings.includes(`Markdown settings not imported: ${ignored}.`));
    assert.equal("allowDelegation" in result.draft, false);
    assert.equal("executor" in result.draft, false);
  }
});

test("Markdown filename names strip .agent.md, support paths, and allow metadata-free frontmatter", () => {
  for (const filename of ["reviewer.agent.md", "/tmp/reviewer.md", "C:\\agents\\reviewer.AGENT.MD"]) {
    assert.equal(importAgentFile("---\ndescription: Review changes.\n---\nBe precise.", filename).agents[0]!.draft.name, "reviewer");
  }
  assert.equal(importAgentFile("---\n---\nBe precise.", "reviewer.md").agents[0]!.draft.name, "reviewer");
  assert.throws(() => importAgentFile("---\n---\nBe precise."), /name/);
});

test("ordinary repository instruction files and fork restriction profiles are not agent definitions", () => {
  assert.throws(() => importAgentFile("# Repository instructions\nBe precise.", "AGENTS.md"), /frontmatter/);
  assert.throws(() => importAgentFile("---\nname: read-only\ntools: [read_file]\n---\n", "read-only.md"), /non-empty agent instructions/);
});

test("invalid frontmatter, duplicate keys, wrong shapes, unknown tags and YAML aliases are rejected", () => {
  for (const source of [
    "---\nname: Reviewer\nBe precise.",
    "---\nname: [unfinished\n---\nBe precise.",
    "---\nname: One\nname: Two\n---\nBe precise.",
    "---\n- name: Reviewer\n---\nBe precise.",
    "---\nname: false\n---\nBe precise.",
    "---\nname: !!js/function function(){}\n---\nBe precise.",
    "---\nname: &name Reviewer\ndescription: *name\n---\nBe precise.",
    "---\nname: Reviewer\nprompt: hidden instructions\n---\n   ",
  ]) assert.throws(() => importAgentFile(source), /Invalid agent Markdown/);
});

test("multiline YAML descriptions become the full job; oversized fields are rejected", () => {
  const result = importAgentFile("---\nname: Reviewer\ndescription: |\n  Review changes.\n  Cite evidence.\n---\nBe precise.").agents[0]!;
  assert.equal(result.draft.role, "Review changes.\nCite evidence.");
  assert.throws(() => importAgentFile(`---\nname: Reviewer\ndescription: ${"x".repeat(241)}\n---\nBe precise.`), /description/);
  assert.throws(() => importAgentFile(`---\nname: Reviewer\n---\n${"x".repeat(PERSONALITY_MAX_LENGTH + 1)}`), /instructions/);
  assert.throws(() => importAgentFile("---\n---\nBe precise.", "x".repeat(61) + ".md"), /name/);
});

test("Kiro-style JSON imports inline prompts verbatim and ignores runtime configuration", () => {
  const result = importAgentFile(JSON.stringify({
    name: "Reviewer", description: "Review changes.", prompt: body, model: "claude-sonnet-4",
    tools: ["*"], allowedTools: ["*"], mcpServers: { private: { command: "do-not-run" } }, hooks: { agentSpawn: ["do-not-run"] },
  })).agents[0]!;
  assert.equal(result.draft.personality, body);
  assert.equal(result.draft.role, "Review changes.");
  assert.deepEqual(result.draft.model, { providerId: null, model: "claude-sonnet-4", reasoningLevel: null });
  assert.ok(result.warnings.includes("JSON settings not imported: tools, allowedTools, mcpServers, hooks."));
});

test("JSON profiles can use their filename and explicit names win", () => {
  assert.equal(importAgentFile('{"prompt":"Be precise."}', "reviewer.JSONC").agents[0]!.draft.name, "reviewer");
  assert.equal(importAgentFile('{"name":"Hazel","prompt":"Be precise."}', "reviewer.json").agents[0]!.draft.name, "Hazel");
  assert.throws(() => importAgentFile('{"prompt":"Be precise."}'), /name/);
});

test("OpenCode JSONC configurations return each inline agent for explicit selection", () => {
  const result = importAgentFile(`{
    // No runtime configuration is activated
    "$schema": "https://opencode.ai/config.json",
    "permission": {"bash": "allow"},
    "agent": {
      "reviewer": {"description": "Review changes.", "prompt": "Be precise.", "model": "anthropic/claude-sonnet-4", "mode": "subagent"},
      "planner": {"name": "Hazel", "prompt": "Plan first.", "reasoningEffort": "high",},
    },
  }`, "opencode.jsonc");
  assert.deepEqual(result.agents.map((agent) => [agent.sourceName, agent.draft.name, agent.draft.personality]),
    [["reviewer", "reviewer", "Be precise."], ["planner", "Hazel", "Plan first."]]);
  assert.ok(result.agents.every((agent) => agent.warnings.includes("Top-level JSON settings not imported: $schema, permission.")));
  assert.deepEqual(result.agents[1]!.draft.model, { providerId: null, model: null, reasoningLevel: "high" });
});

test("Claude --agents dictionaries are selectable, and definition keys are names, not filenames", () => {
  const result = importAgentFile(JSON.stringify({
    reviewer: { description: "Review changes.", prompt: "Be precise.", model: "sonnet" },
    "planner.json": { prompt: "Plan first." },
  }));
  assert.deepEqual(result.agents.map((agent) => agent.draft.name), ["reviewer", "planner.json"]);
});

test("non-importable definitions are skipped with explicit warnings; no valid agents is an error", () => {
  const result = importAgentFile(JSON.stringify({ agent: {
    build: { tools: { edit: true } },
    reviewer: { prompt: "Be precise." },
    remote: { prompt: "file://prompts/remote.md" },
    malformed: false,
  } }));
  assert.equal(result.agents.length, 1);
  assert.equal(result.agents[0]!.draft.name, "reviewer");
  for (const name of ["build", "remote", "malformed"])
    assert.ok(result.agents[0]!.warnings.some((warning) => warning.startsWith(`Skipped agent '${name}'`)));
  assert.throws(() => importAgentFile('{"agent":{"build":{"tools":{}}}}'), /No importable agents/);
  assert.throws(() => importAgentFile('{"agent":{}}'), /No importable agents/);
});

test("external prompt references are never fetched, loaded or silently treated as instructions", () => {
  for (const prompt of ["file://prompts/reviewer.md", "{file:./prompts/reviewer.txt}"]) {
    assert.throws(() => importAgentFile(JSON.stringify({ name: "Reviewer", prompt })), /Referenced prompt files are not read/);
  }
  const result = importAgentFile('{"name":"Reviewer","prompt":"Read {file:./guide.md} first."}').agents[0]!;
  assert.equal(result.draft.personality, "Read {file:./guide.md} first.");
  assert.ok(result.warnings.some((warning) => warning.includes("referenced content was not loaded")));
});

test("malformed JSON, wrong shapes and duplicate keys at any depth fail instead of being repaired", () => {
  for (const source of [
    '{"name":"Reviewer","prompt":', '{"name":"A","name":"B","prompt":"Be precise."}',
    '{"name":"Reviewer","prompt":"Be precise.","tools":{"read":true,"read":false}}',
    '{"agent":{"a":{"prompt":"One"},"a":{"prompt":"Two"}}}',
    "[]", "null", '{"name":"Reviewer","prompt":["Be precise."]}', '{"name":"Reviewer","prompt":" "}',
    '{"agent":[]}', '{"model":"gpt-5"}',
  ]) assert.throws(() => importAgentFile(source, "", "json"), /Invalid agent JSON/);
});

test("JSONC comments and trailing commas never modify strings or hide invalid syntax", () => {
  const prompt = 'Quotes: "café". https://example.com/ // not a comment /* literal */ , } \\n';
  const result = importAgentFile(JSON.stringify({ name: "Reviewer", prompt, value: 1e-10 }) + "// trailing comment").agents[0]!;
  assert.equal(result.draft.personality, prompt);
  for (const source of [
    '{"name":"Reviewer","prompt":"Be precise."}/* unterminated',
    '{"name":"Reviewer",, "prompt":"Be precise."}',
    '{"name":"Reviewer","prompt":"Be precise."} true',
  ]) assert.throws(() => importAgentFile(source), /Invalid agent JSON/);
});

test("model inheritance, optional reasoning and conflicting preferences are handled explicitly", () => {
  const inherited = importAgentFile('{"name":"Reviewer","prompt":"Be precise.","model":"inherit"}').agents[0]!;
  assert.equal(inherited.draft.model, null);
  assert.ok(inherited.warnings.some((warning) => warning.includes("keeps the thread")));
  assert.deepEqual(importAgentFile('{"name":"Reviewer","prompt":"Be precise.","effort":"high"}').agents[0]!.draft.model,
    { providerId: null, model: null, reasoningLevel: "high" });
  assert.throws(() => importAgentFile('{"name":"Reviewer","prompt":"Be precise.","effort":"high","reasoningEffort":"low"}'), /conflict/);
});

test("import limits apply to every format and multi-agent configurations are bounded", () => {
  assert.throws(() => importAgentFile(" ".repeat(MAX_AGENT_IMPORT_LENGTH + 1)), /too large/);
  assert.throws(() => importAgentFile(JSON.stringify({ name: "Reviewer", prompt: "x".repeat(PERSONALITY_MAX_LENGTH + 1) })), /instructions/);
  const agent = Object.fromEntries(Array.from({ length: MAX_AGENTS_PER_IMPORT + 1 }, (_, index) => [`agent-${index}`, { prompt: "Be precise." }]));
  assert.throws(() => importAgentFile(JSON.stringify({ agent })), /at most 50 agents/);
  assert.equal(importAgentFile(`---\nname: Reviewer\n---\n${"x".repeat(PERSONALITY_MAX_LENGTH)}`).agents[0]!.draft.personality.length, PERSONALITY_MAX_LENGTH);
});

test("prototype-like keys are inert metadata and cannot alter the draft or global objects", () => {
  const result = importAgentFile('{"name":"Reviewer","prompt":"Be precise.","__proto__":{"polluted":true},"constructor":{"polluted":true}}').agents[0]!;
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.hasOwn(result.draft, "__proto__"), false);
  assert.ok(result.warnings.includes("JSON settings not imported: __proto__, constructor."));
});
