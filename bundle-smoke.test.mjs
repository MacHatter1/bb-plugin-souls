// Run with npm run test:bundle. Source tests cannot catch dependencies whose
// internal requires survive BB's bundler and fail in the deployed artifact.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";

test("the built server loads and converts TOML, Markdown and JSONC without unresolved runtime dependencies", async () => {
  const { default: plugin } = await import("./dist/server.js");
  const { bb, harness } = createFakePluginHost({ pluginId: "souls" });
  await plugin(bb);
  try {
    for (const source of [
      'name = "Reviewer"\ndeveloper_instructions = "Be precise."',
      "---\nname: Reviewer\n---\nBe precise.",
      '// A commented profile\n{"name":"Reviewer","prompt":"Be precise.",}',
    ]) {
      const result = await harness.behavior.callRpc("souls_import_preview", { source });
      assert.equal(result.agents[0].draft.name, "Reviewer");
      assert.equal(result.agents[0].draft.personality, "Be precise.");
    }
    assert.deepEqual(await harness.behavior.callRpc("souls_list", null), { souls: [] });
  } finally {
    await harness.lifecycle.dispose();
  }
});
