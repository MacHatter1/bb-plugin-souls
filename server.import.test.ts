import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import type { Soul } from "./shared.ts";
import type { AgentImportResult } from "./soul-import-formats.ts";

const source = `name = "Hazel"
description = "Review changes."
model = "gpt-5"
model_reasoning_effort = "high"
developer_instructions = '''${"Read before reviewing.\n".repeat(150)}'''
sandbox_mode = "read-only"`;

test("import preview is read-only; explicit create preserves the draft and never binds a thread", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  await plugin(bb);
  try {
    const result = await harness.behavior.callRpc("souls_import_preview", { source, filename: "reviewer.toml" }) as AgentImportResult;
    const preview = result.agents[0]!;
    assert.equal(preview.draft.name, "Hazel");
    assert.ok(preview.draft.personality.length > 2000);
    assert.deepEqual(preview.warnings, ["TOML settings not imported: sandbox_mode."]);
    assert.deepEqual(await harness.behavior.callRpc("souls_list", null), { souls: [] });
    assert.equal(harness.inspection.realtimeSignals.length, 0);

    // The same save path the editor uses, after the user reviews and edits.
    const { soul } = await harness.behavior.callRpc("souls_create", {
      draft: { ...preview.draft, name: "Hazel imported" }, origin: "manual",
    }) as { soul: Soul };
    assert.equal(soul.personality, preview.draft.personality);
    assert.deepEqual(soul.model, preview.draft.model);
    assert.equal(soul.origin, "manual");
    const loaded = await harness.behavior.callRpc("souls_get", { idOrName: soul.id }) as { soul: Soul };
    assert.equal(loaded.soul.personality, preview.draft.personality);
    assert.deepEqual(await harness.behavior.callRpc("souls_thread_get", { threadId: "thread-1" }), {
      soul: null, allowDelegation: false, status: "unknown", session: null,
    });
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.update").length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("GitHub import uses the same read-only draft preview and never writes or starts threads", async (context) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls" });
  await plugin(bb);
  const fetchMock = context.mock.method(globalThis, "fetch", async () => new Response(source));
  try {
    const result = await harness.behavior.callRpc("souls_import_github", {
      url: "https://github.com/example/repo/blob/main/reviewer.toml",
    }) as AgentImportResult;
    const preview = result.agents[0]!;
    assert.equal(preview.draft.name, "Hazel");
    assert.ok(preview.draft.personality.length > 2000);
    assert.deepEqual(preview.warnings, ["TOML settings not imported: sandbox_mode."]);
    assert.equal(fetchMock.mock.callCount(), 1);
    await assert.rejects(harness.behavior.callRpc("souls_import_github", { url: "https://localhost/reviewer.toml" }), /GitHub/);
    assert.equal(fetchMock.mock.callCount(), 1, "invalid URLs are rejected before fetching");
    assert.deepEqual(await harness.behavior.callRpc("souls_list", null), { souls: [] });
    assert.equal(harness.inspection.realtimeSignals.length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("Markdown and JSON previews, including multi-agent selection, have no storage or thread side effects", async (context) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls" });
  await plugin(bb);
  const documents = [
    { source: "---\nname: Reviewer\nmodel: sonnet\ntools: [Read]\n---\nBe precise.", filename: "reviewer.agent.md" },
    { source: '{"name":"Reviewer","prompt":"Be precise.","tools":["*"]}', filename: "reviewer.json" },
    { source: '{"agent":{"reviewer":{"prompt":"Review."},"planner":{"prompt":"Plan."}}}', filename: "opencode.jsonc" },
  ];
  const fetchMock = context.mock.method(globalThis, "fetch");
  try {
    for (const document of documents) {
      const local = await harness.behavior.callRpc("souls_import_preview", document) as AgentImportResult;
      fetchMock.mock.mockImplementation(async () => new Response(document.source));
      const remote = await harness.behavior.callRpc("souls_import_github", {
        url: `https://github.com/example/repo/blob/main/${document.filename}`,
      }) as AgentImportResult;
      assert.deepEqual(remote, local);
      assert.deepEqual(await harness.behavior.callRpc("souls_list", null), { souls: [] });
    }
    assert.equal(harness.inspection.realtimeSignals.length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(harness.inspection.sdk.callsTo("threads.update").length, 0);

    const result = await harness.behavior.callRpc("souls_import_preview", documents[2]) as AgentImportResult;
    const selected = result.agents[1]!;
    const { soul } = await harness.behavior.callRpc("souls_create", {
      draft: { ...selected.draft, name: "Edited planner" }, origin: "manual",
    }) as { soul: Soul };
    assert.equal(soul.name, "Edited planner");
    assert.equal(soul.personality, "Plan.");
    const library = await harness.behavior.callRpc("souls_list", null) as { souls: Soul[] };
    assert.equal(library.souls.length, 1, "only the explicitly selected and edited agent is created");
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("format validation and invalid Markdown/JSON imports never write or fetch referenced files", async (context) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls" });
  await plugin(bb);
  const fetchMock = context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
  try {
    for (const input of [
      { source: "---\nname: Reviewer\n---\n", format: "markdown" },
      { source: '{"name":"Reviewer","prompt":"file://local-prompt.md"}', format: "json" },
      { source: '{"agent":{"reviewer":false}}', format: "json" },
      { source, format: "xml" },
    ]) await assert.rejects(harness.behavior.callRpc("souls_import_preview", input));
    await assert.rejects(harness.behavior.callRpc("souls_import_github", {
      url: "https://github.com/example/repo/blob/main/reviewer.md", format: "xml",
    }));
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.deepEqual(await harness.behavior.callRpc("souls_list", null), { souls: [] });
    assert.equal(harness.inspection.realtimeSignals.length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("invalid imports leave storage untouched and duplicate names never overwrite souls", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls" });
  await plugin(bb);
  try {
    for (const input of [{ source: 'name = "broken' }, { source: 'name = "Hazel"' }, { source: " ".repeat(128_001) }]) {
      await assert.rejects(harness.behavior.callRpc("souls_import_preview", input));
    }
    assert.deepEqual(await harness.behavior.callRpc("souls_list", null), { souls: [] });
    const result = await harness.behavior.callRpc("souls_import_preview", { source }) as AgentImportResult;
    const { draft } = result.agents[0]!;
    const { soul } = await harness.behavior.callRpc("souls_create", { draft, origin: "manual" }) as { soul: Soul };
    await assert.rejects(harness.behavior.callRpc("souls_create", { draft, origin: "manual" }), /already exists/);
    const loaded = await harness.behavior.callRpc("souls_get", { idOrName: soul.id }) as { soul: Soul };
    assert.equal(loaded.soul.personality, draft.personality);
  } finally {
    await harness.lifecycle.dispose();
  }
});
