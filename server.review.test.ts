import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

type Soul = { id: string; name: string; personality: string; boundaries: string[] };

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  harness.inspection.sdk.stub("threads.get", (() => ({ status: "idle" })) as (...args: never[]) => unknown);
  await plugin(bb);
  const { soul } = (await harness.behavior.callRpc("souls_create", {
    draft: { name: "Hazel", personality: "Blunt.", boundaries: ["Never approve a change she has not run."] },
    origin: "manual",
  })) as { soul: Soul };
  const read = async (idOrName = soul.id) =>
    ((await harness.behavior.callRpc("souls_get", { idOrName })) as { soul: Soul | null }).soul;
  /** The card a tool call is waiting on, once it is up. */
  const card = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [open] = harness.inspection.pendingInteractions;
      if (open !== undefined) return open;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("no card was shown");
  };
  const text = (result: unknown) => {
    if (typeof result === "string") return result;
    const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
    return content.map((part) => part.text ?? "").join("\n");
  };
  return { harness, soul, read, card, text };
}

test("souls_update changes nothing until the user approves the card", async () => {
  const x = await setup();
  try {
    // The thread runs as Hazel with consent; approving an edit keeps it.
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "thread-1", soulId: x.soul.id, allowDelegation: true });
    const call = x.harness.behavior.callAgentTool(
      "souls_update",
      { idOrName: "Hazel", patch: { personality: "Warm, but exact." }, summary: "You asked for a softer voice." },
      { threadId: "thread-1" },
    );
    const open = await x.card();
    assert.equal(open.rendererId, "soul-review");
    assert.equal(open.threadId, "thread-1");
    const payload = open.payload as { changes: string[]; runsHere: boolean; allowDelegation: boolean; draft: Soul };
    assert.deepEqual(payload.changes, ["Voice"]);
    assert.equal(payload.runsHere, true);
    assert.equal(payload.allowDelegation, true, "the card starts from the consent the thread has");
    assert.equal(payload.draft.personality, "Warm, but exact.");
    assert.equal((await x.read())?.personality, "Blunt.", "nothing saved while the card waits");

    x.harness.behavior.submitInteraction(open.id, { action: "approve", selectHere: true, allowDelegation: true });
    assert.match(x.text(await call), /Saved the changes to/);
    assert.equal((await x.read())?.personality, "Warm, but exact.");
    const state = (await x.harness.behavior.callRpc("souls_thread_get", { threadId: "thread-1" })) as { allowDelegation: boolean };
    assert.equal(state.allowDelegation, true);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a dismissed or revised update leaves the soul as it was", async () => {
  const x = await setup();
  try {
    const dismissed = x.harness.behavior.callAgentTool(
      "souls_update",
      { idOrName: "Hazel", patch: { boundaries: [] } },
      { threadId: "thread-1" },
    );
    x.harness.behavior.cancelInteraction((await x.card()).id);
    assert.match(x.text(await dismissed), /Nothing was changed/);
    assert.deepEqual((await x.read())?.boundaries, ["Never approve a change she has not run."]);

    const revised = x.harness.behavior.callAgentTool(
      "souls_update",
      { idOrName: "Hazel", patch: { personality: "Chirpy." } },
      { threadId: "thread-1" },
    );
    x.harness.behavior.submitInteraction((await x.card()).id, { action: "revise", notes: "Not chirpy. Dry." });
    const reply = x.text(await revised);
    assert.match(reply, /Not chirpy\. Dry\./);
    assert.equal((await x.read())?.personality, "Blunt.");
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("souls_update refuses a taken name or a change that changes nothing, without a card", async () => {
  const x = await setup();
  try {
    await x.harness.behavior.callRpc("souls_create", { draft: { name: "Pip" }, origin: "manual" });
    const taken = await x.harness.behavior.callAgentTool("souls_update", { idOrName: "Hazel", patch: { name: "pip" } }, { threadId: "thread-1" });
    assert.match(x.text(taken), /already exists/);
    const same = await x.harness.behavior.callAgentTool("souls_update", { idOrName: "Hazel", patch: { personality: "Blunt." } }, { threadId: "thread-1" });
    assert.match(x.text(same), /Nothing to change/);
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("souls_delete deletes only after the user confirms", async () => {
  const x = await setup();
  try {
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "thread-2", soulId: x.soul.id });
    const kept = x.harness.behavior.callAgentTool("souls_delete", { idOrName: "Hazel" }, { threadId: "thread-1" });
    const first = await x.card();
    assert.equal(first.rendererId, "soul-delete");
    assert.deepEqual((first.payload as { threads: number }).threads, 1);
    x.harness.behavior.cancelInteraction(first.id);
    assert.match(x.text(await kept), /Nothing was deleted/);
    assert.notEqual(await x.read(), null);

    const removed = x.harness.behavior.callAgentTool("souls_delete", { idOrName: "Hazel" }, { threadId: "thread-1" });
    x.harness.behavior.submitInteraction((await x.card()).id, { action: "delete" });
    assert.match(x.text(await removed), /Deleted/);
    assert.equal(await x.read(), null);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("souls_propose saves a new soul only on approval", async () => {
  const x = await setup();
  try {
    const call = x.harness.behavior.callAgentTool(
      "souls_propose",
      { draft: { name: "Quill", role: "Edits release notes." }, summary: "From the interview." },
      { threadId: "thread-1" },
    );
    const open = await x.card();
    assert.deepEqual((open.payload as { changes: string[] }).changes, []);
    assert.equal(await x.read("Quill"), null);
    x.harness.behavior.submitInteraction(open.id, { action: "approve", selectHere: false, allowDelegation: false });
    assert.match(x.text(await call), /Saved the new soul/);
    assert.equal((await x.read("Quill"))?.name, "Quill");
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("inside a thread, bb souls cannot create, update or delete a soul", async () => {
  const x = await setup();
  try {
    for (const argv of [["create", "Imp"], ["update", "Hazel", "--data", '{"personality":"Sly."}'], ["delete", "Hazel"]]) {
      const result = await x.harness.behavior.runCli(argv, { threadId: "thread-1" });
      assert.equal(result.exitCode, 1, argv.join(" "));
      assert.match(result.stderr ?? "", /card the user approves/);
    }
    assert.equal((await x.read())?.personality, "Blunt.");
    assert.equal(await x.read("Imp"), null);
    // Outside a thread it is the user at their own terminal.
    const own = await x.harness.behavior.runCli(["update", "Hazel", "--data", '{"personality":"Sly."}']);
    assert.equal(own.exitCode, 0, own.stderr);
    assert.equal((await x.read())?.personality, "Sly.");
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a slug two souls share names neither of them", async () => {
  const x = await setup();
  try {
    await x.harness.behavior.callRpc("souls_create", { draft: { name: "Ada!" }, origin: "manual" });
    assert.equal((await x.read("ada"))?.name, "Ada!", "one match is found by slug");
    await x.harness.behavior.callRpc("souls_create", { draft: { name: "Ada?" }, origin: "manual" });
    assert.equal(await x.read("ada"), null, "two matches are ambiguous");
    assert.equal((await x.read("Ada?"))?.name, "Ada?", "an exact name still works");
  } finally {
    await x.harness.lifecycle.dispose();
  }
});
