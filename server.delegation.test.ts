import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createFakePluginHost, makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext, makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { soulSchema, threadSoulStateSchema } from "./shared.ts";

const savedSoul = z.object({ soul: soulSchema });

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  harness.inspection.sdk.stub("threads.get", () => makeThreadResponse({ status: "idle", parentThreadId: "parent" }));
  harness.inspection.sdk.stub("threads.events.list", () => []);
  await plugin(bb);
  const create = async (name: string, defaultAllowDelegation = false) => savedSoul.parse(
    await harness.behavior.callRpc("souls_create", { draft: { name }, origin: "manual", defaultAllowDelegation }),
  ).soul;
  const state = async (threadId: string) => threadSoulStateSchema.parse(
    await harness.behavior.callRpc("souls_thread_get", { threadId }),
  );
  const dispatch = async (id: string, child = false) => {
    const hook = harness.inspection.registrations.hooks["message.dispatch"];
    assert.ok(hook);
    assert.deepEqual(await hook(makeMessageDispatchHookContext({
      initiator: child ? "agent" : "user", origin: child ? "cli" : "app", attempt: "start-turn",
      senderThreadId: child ? "parent" : null,
      parentThreadId: child ? "parent" : null,
      thread: { id, sourceThreadId: null, parentThreadId: child ? "parent" : null, createdAt: Date.now() },
    })), { action: "proceed" });
  };
  const card = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [open] = harness.inspection.pendingInteractions;
      if (open !== undefined) return open;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("no review card was shown");
  };
  return { harness, create, state, dispatch, card };
}

test("saved defaults apply to new bindings and their session instructions", async () => {
  const x = await setup();
  try {
    const soul = await x.create("Marshal", true);
    await x.harness.behavior.callAgentTool("souls_select", { soulId: soul.id }, { threadId: "fresh" });
    assert.equal((await x.state("fresh")).allowDelegation, true);
    const config = await x.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "fresh" } }),
    );
    assert.match(config.instructions ?? "", /user.*explicitly authorized/i);
    assert.match(String(await x.harness.behavior.callAgentTool("souls_get", { idOrName: soul.id }, { threadId: "fresh" })), /user.*explicitly authorized/i);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("per-thread false overrides the soul default and survives reselection and reload", async () => {
  const x = await setup();
  let live = x.harness;
  try {
    const soul = await x.create("Marshal", true);
    await live.behavior.callRpc("souls_thread_set", { threadId: "off", soulId: soul.id, allowDelegation: false });
    await live.behavior.callAgentTool("souls_select", { soulId: soul.id }, { threadId: "off" });
    assert.equal((await x.state("off")).allowDelegation, false);
    live = (await live.lifecycle.reload(plugin)).harness;
    live.inspection.sdk.stub("threads.get", () => makeThreadResponse({ status: "idle" }));
    live.inspection.sdk.stub("threads.events.list", () => []);
    const read = savedSoul.parse(await live.behavior.callRpc("souls_get", { idOrName: soul.id }));
    assert.equal(read.soul.defaultAllowDelegation, true);
    const state = threadSoulStateSchema.parse(await live.behavior.callRpc("souls_thread_get", { threadId: "off" }));
    assert.equal(state.allowDelegation, false);
    await live.behavior.callRpc("souls_thread_set", { threadId: "fresh", soulId: soul.id });
    assert.equal(threadSoulStateSchema.parse(await live.behavior.callRpc("souls_thread_get", { threadId: "fresh" })).allowDelegation, true);
  } finally { await live.lifecycle.dispose(); }
});

test("editing a default affects new bindings and preserves existing thread choices", async () => {
  const x = await setup();
  try {
    const soul = await x.create("Marshal");
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "existing-off", soulId: soul.id });
    await x.harness.behavior.callRpc("souls_update", { id: soul.id, patch: {}, defaultAllowDelegation: true });
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "new-on", soulId: soul.id });
    assert.equal((await x.state("existing-off")).allowDelegation, false);
    assert.equal((await x.state("new-on")).allowDelegation, true);
    await x.harness.behavior.callRpc("souls_update", { id: soul.id, patch: {}, defaultAllowDelegation: false });
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "new-off", soulId: soul.id });
    assert.equal((await x.state("new-on")).allowDelegation, true);
    assert.equal((await x.state("new-off")).allowDelegation, false);
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "new-off", soulId: soul.id, allowDelegation: true });
    assert.equal((await x.state("new-off")).allowDelegation, true, "an explicit on override also works");
    const other = await x.create("Pip");
    await x.harness.behavior.callAgentTool("souls_select", { soulId: other.id }, { threadId: "new-on" });
    assert.equal((await x.state("new-on")).allowDelegation, false, "switching souls uses that soul's default");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("the new-thread composer carries the default or its explicit off override into the first session", async () => {
  const x = await setup();
  try {
    const soul = await x.create("Marshal", true);
    for (const [threadId, override] of [["default", undefined], ["override", false]] as const) {
      const pending = z.object({ allowDelegation: z.boolean() }).parse(await x.harness.behavior.callRpc(
        "souls_pending_set", { soulId: soul.id, ...(override === undefined ? {} : { allowDelegation: override }) },
      ));
      assert.equal(pending.allowDelegation, override ?? true);
      await x.dispatch(threadId);
      assert.equal((await x.state(threadId)).allowDelegation, override ?? true);
    }
  } finally { await x.harness.lifecycle.dispose(); }
});

test("an armed child uses its own soul's saved default rather than the parent's override", async () => {
  const x = await setup();
  try {
    const soul = await x.create("Marshal");
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "parent", soulId: soul.id, allowDelegation: true });
    await x.harness.behavior.callAgentTool("souls_arm_child", { soulId: soul.id }, { threadId: "parent" });
    await x.dispatch("off-child", true);
    assert.equal((await x.state("off-child")).allowDelegation, false);
    const enabled = await x.create("Captain", true);
    await x.harness.behavior.callAgentTool("souls_arm_child", { soulId: enabled.id }, { threadId: "parent" });
    await x.dispatch("on-child", true);
    assert.equal((await x.state("on-child")).allowDelegation, true);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("agent drafts cannot enable the default; an explicit review decision can save it", async () => {
  const x = await setup();
  try {
    const call = x.harness.behavior.callAgentTool("souls_propose", {
      draft: { name: "Marshal", defaultAllowDelegation: true },
    }, { threadId: "author" });
    const open = await x.card();
    x.harness.behavior.submitInteraction(open.id, { action: "approve", selectHere: false });
    await call;
    const soul = savedSoul.parse(await x.harness.behavior.callRpc("souls_get", { idOrName: "Marshal" })).soul;
    assert.equal(soul.defaultAllowDelegation, false);
    const update = x.harness.behavior.callAgentTool("souls_update", {
      idOrName: soul.id, patch: { role: "Coordinate implementation." },
    }, { threadId: "author" });
    const review = await x.card();
    x.harness.behavior.submitInteraction(review.id, {
      action: "approve", selectHere: true, defaultAllowDelegation: true,
    });
    await update;
    assert.equal((await x.state("author")).allowDelegation, true, "a new review binding uses the approved default without an override");
    await x.harness.behavior.callAgentTool("souls_select", { soulId: soul.id }, { threadId: "fresh" });
    assert.equal((await x.state("fresh")).allowDelegation, true);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("ordinary approved edits preserve the default and a current thread's explicit off choice", async () => {
  const x = await setup();
  try {
    const soul = await x.create("Marshal", true);
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "author", soulId: soul.id, allowDelegation: false });
    const call = x.harness.behavior.callAgentTool("souls_update", {
      idOrName: soul.id, patch: { role: "Coordinate implementation." },
    }, { threadId: "author" });
    const open = await x.card();
    const payload = z.object({ existing: soulSchema.pick({ defaultAllowDelegation: true }), allowDelegation: z.boolean() }).parse(open.payload);
    assert.equal(payload.existing.defaultAllowDelegation, true);
    assert.equal(payload.allowDelegation, false);
    x.harness.behavior.submitInteraction(open.id, { action: "approve", selectHere: true, allowDelegation: false });
    await call;
    assert.equal(savedSoul.parse(await x.harness.behavior.callRpc("souls_get", { idOrName: soul.id })).soul.defaultAllowDelegation, true);
    assert.equal((await x.state("author")).allowDelegation, false);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("legacy souls and imported or raw persona drafts never acquire permission implicitly", async () => {
  const x = await setup();
  try {
    assert.equal(soulSchema.parse({ id: "legacy", name: "Legacy", origin: "manual", createdAt: "", updatedAt: "" }).defaultAllowDelegation, false);
    const soul = savedSoul.parse(await x.harness.behavior.callRpc("souls_create", {
      draft: { name: "Imported", defaultAllowDelegation: true }, origin: "manual",
    })).soul;
    assert.equal(soul.defaultAllowDelegation, false);
    await assert.rejects(x.harness.behavior.callAgentTool("souls_update", {
      idOrName: soul.id, patch: { defaultAllowDelegation: true },
    }, { threadId: "author" }));
  } finally { await x.harness.lifecycle.dispose(); }
});
