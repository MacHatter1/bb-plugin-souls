import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTRUCTION_BUDGET, renderSoulInstructions, renderSoulPersona, soulDirective, soulSchema } from "./shared.ts";

const soul = (patch = {}) => soulSchema.parse({
  id: "soul_test", name: "Marshal", origin: "manual", createdAt: "", updatedAt: "",
  role: "Delegate the work and independently verify the result.",
  personality: "Be clipped and exacting.", expertise: ["Review"],
  boundaries: ["Never deploy without approval."], principles: ["Verify before accepting."],
  ...patch,
});

const longest = () => soul({
  name: "n".repeat(60), emoji: "✨", tagline: "t".repeat(160), role: "j".repeat(240),
  personality: "v".repeat(2000), expertise: Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(60, "e")),
  principles: Array.from({ length: 12 }, (_, i) => `Always ${i} `.padEnd(200, "a")),
  boundaries: Array.from({ length: 12 }, (_, i) => `Never ${i} `.padEnd(200, "b")),
  model: { providerId: "p".repeat(80), model: "m".repeat(200), reasoningLevel: "r".repeat(40) },
});

test("job and behavioral rules precede voice and expertise in the persona", () => {
  const text = renderSoulPersona(soul());
  const headings = ["**Job**", "**Never**", "**Always**", "**Voice and temperament**", "**Expertise**"];
  const positions = headings.map((heading) => text.indexOf(heading));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("the persona is never cut, even with every field at its maximum", () => {
  const value = longest();
  const text = renderSoulPersona(value);
  assert.ok(text.length > INSTRUCTION_BUDGET, "the fixture should be larger than BB's instruction limit");
  for (const line of [...value.boundaries, ...value.principles]) assert.ok(text.includes(`- ${line}`));
  assert.ok(text.includes(value.personality));
  assert.ok(text.includes(value.expertise.join(", ")));
  assert.ok(text.includes("p".repeat(80)));
  assert.doesNotMatch(text, /omitted|shortened|…/);
});

test("the injected instructions only point at the persona and fit BB's limit", () => {
  const value = longest();
  for (const consent of [false, true]) {
    const text = renderSoulInstructions(value, consent);
    assert.ok(text.length <= INSTRUCTION_BUDGET, `${text.length} characters`);
    assert.match(text, /souls_get/);
    assert.ok(text.includes(value.id));
    assert.ok(text.includes(soulDirective(value.id)));
    assert.ok(!text.includes(value.role));
    assert.ok(!text.includes(value.personality));
    assert.ok(!text.includes(value.boundaries[0]));
  }
});

test("a tagline's own full stop is not doubled", () => {
  for (const render of [renderSoulInstructions, renderSoulPersona]) {
    const text = render(soul({ tagline: "Ships small changes." }));
    assert.match(text, /— Ships small changes\. /);
    assert.doesNotMatch(text, /\.\./);
  }
});

test("the embed directive names the soul by id", () => {
  assert.equal(soulDirective("soul_abc123"), '::soul{id="soul_abc123"}');
});

test("consent is explicit, scoped to this thread and never widens other permissions", () => {
  for (const render of [renderSoulInstructions, renderSoulPersona]) {
    assert.doesNotMatch(render(soul()), /explicitly authorized/);
    const text = render(soul(), true);
    assert.match(text, /user.*explicitly authorized/i);
    assert.match(text, /this thread/);
    assert.match(text, /not inherited/i);
    assert.match(text, /push|deploy/);
  }
});
