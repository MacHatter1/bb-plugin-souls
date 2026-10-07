import assert from "node:assert/strict";
import { test } from "node:test";
import { importAgentToml } from "./soul-import.ts";
import { MAX_AGENT_IMPORT_LENGTH, PERSONALITY_MAX_LENGTH, renderSoulPersona, soulSchema } from "./shared.ts";

const source = `
name = "Hazel"
description = "Review changes for correctness."
model = "gpt-5"
model_reasoning_effort = "high"
developer_instructions = '''Read the code first.
Never approve untested changes.
Keep findings concise.'''
`;

test("agent TOML becomes a complete, editable soul draft", () => {
  const { draft, warnings } = importAgentToml(source, "reviewer.toml");
  assert.deepEqual(draft, {
    name: "Hazel",
    tagline: "Review changes for correctness.",
    emoji: "✨",
    role: "Review changes for correctness.",
    personality: "Read the code first.\nNever approve untested changes.\nKeep findings concise.",
    expertise: [],
    principles: [],
    boundaries: [],
    model: { providerId: "codex", model: "gpt-5", reasoningLevel: "high" },
    look: null,
  });
  assert.deepEqual(warnings, []);
});

test("older agent configs can use their filename as the name", () => {
  for (const filename of ["reviewer.toml", "/tmp/reviewer.toml", "C:\\agents\\reviewer.TOML"]) {
    const { draft } = importAgentToml('developer_instructions = "Be precise."', filename);
    assert.equal(draft.name, "reviewer");
    assert.equal(draft.model, null);
  }
  assert.throws(() => importAgentToml('developer_instructions = "Be precise."'), /name/);
});

test("model and reasoning preferences are optional and independent", () => {
  const instructions = 'name = "Hazel"\ndeveloper_instructions = "Be precise."\n';
  assert.deepEqual(importAgentToml(`${instructions}model = "gpt-5"`).draft.model,
    { providerId: "codex", model: "gpt-5", reasoningLevel: null });
  assert.deepEqual(importAgentToml(`${instructions}model_reasoning_effort = "medium"`).draft.model,
    { providerId: "codex", model: null, reasoningLevel: "medium" });
  assert.equal(importAgentToml(instructions).draft.model, null);
});

test("multiline instructions, Unicode and TOML escapes survive unchanged", () => {
  const { draft } = importAgentToml('\uFEFFname = "Zoë"\ndeveloper_instructions = """\n  Keep \\\"quotes\\\" and café.\n\n  Do not reformat.\n"""');
  assert.equal(draft.personality, '  Keep "quotes" and café.\n\n  Do not reformat.\n');
});

test("long instructions are not silently truncated or split into rules", () => {
  const instructions = "x".repeat(PERSONALITY_MAX_LENGTH);
  const { draft } = importAgentToml(`name = "Hazel"\ndeveloper_instructions = '${instructions}'`);
  const soul = soulSchema.parse({ ...draft, id: "preview", origin: "manual", createdAt: "", updatedAt: "" });
  assert.equal(soul.personality, instructions);
  assert.ok(renderSoulPersona(soul).includes(instructions));
  assert.deepEqual(soul.principles, []);
});

test("long descriptions keep the full job without cutting a picker tagline", () => {
  const description = "d".repeat(240);
  const { draft } = importAgentToml(`name = "Hazel"\ndescription = "${description}"\ndeveloper_instructions = "Be precise."`);
  assert.equal(draft.role, description);
  assert.equal(draft.tagline, "");
});

test("runtime settings are reported but never imported as permissions", () => {
  const { draft, warnings } = importAgentToml(`${source}
sandbox_mode = "danger-full-access"
approval_policy = "never"
[mcp_servers.example]
command = "do-not-run"
`);
  assert.deepEqual(warnings, ["TOML settings not imported: sandbox_mode, approval_policy, mcp_servers."]);
  assert.ok(!("allowDelegation" in draft));
  assert.ok(!("sandbox_mode" in draft));
});

test("invalid TOML and duplicate keys return useful parse errors", () => {
  for (const invalid of ['name = "unfinished', 'name = "A"\nname = "B"']) {
    assert.throws(() => importAgentToml(invalid), /Invalid agent TOML/);
  }
});

test("unrelated configs, blank instructions and wrong field types are rejected", () => {
  const invalid = [
    'model = "gpt-5"',
    'name = "Hazel"\ndeveloper_instructions = "   "',
    'name = "Hazel"\ndeveloper_instructions = ["Be precise."]',
    'name = 1\ndeveloper_instructions = "Be precise."',
    'name = " "\ndeveloper_instructions = "Be precise."',
    'name = "Hazel"\nmodel_reasoning_effort = 1\ndeveloper_instructions = "Be precise."',
    'name = "Hazel"\nmodel = 1\ndeveloper_instructions = "Be precise."',
    'name = "Hazel"\ndescription = false\ndeveloper_instructions = "Be precise."',
    'name = "Hazel"\nmodel = ""\ndeveloper_instructions = "Be precise."',
  ];
  for (const value of invalid) assert.throws(() => importAgentToml(value), /Invalid agent TOML/);
});

test("oversized fields and input fail rather than losing content", () => {
  assert.throws(() => importAgentToml(" ".repeat(MAX_AGENT_IMPORT_LENGTH + 1)), /too large/);
  for (const [field, length] of [["name", 61], ["description", 241], ["developer_instructions", PERSONALITY_MAX_LENGTH + 1]] as const) {
    const base = field === "developer_instructions" ? 'name = "Hazel"' : 'developer_instructions = "Be precise."';
    assert.throws(() => importAgentToml(`${base}\n${field} = "${"x".repeat(length)}"`, "reviewer.toml"), new RegExp(field));
  }
});
