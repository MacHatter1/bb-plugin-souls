import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import {
  createFakePluginHost, makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext, makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { soulSchema, threadSoulStateSchema, type SoulConsent } from "./shared.ts";

const saved = z.object({ soul: soulSchema.nullable() });
const toolError = z.object({ isError: z.literal(true), content: z.array(z.object({ text: z.string() })) });

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  harness.inspection.sdk.stub("threads.get", ({ threadId }) => makeThreadResponse({
    id: threadId, status: "idle", parentThreadId: "manager", sourceThreadId: threadId === "side" ? "manager" : null,
  }));
  harness.inspection.sdk.stub("threads.events.list", () => []);
  await plugin(bb);
  const read = async (idOrName: string) => saved.parse(await harness.behavior.callRpc("souls_get", { idOrName })).soul;
  const create = async (name: string, consent: Partial<SoulConsent> = {}) => {
    const soul = saved.parse(await harness.behavior.callRpc("souls_create", { draft: { name }, origin: "manual", ...consent })).soul;
    assert.ok(soul);
    return soul;
  };
  const select = async (soulId: string, threadId = "manager") => harness.behavior.callRpc("souls_thread_set", { threadId, soulId });
  const hire = (name: string, threadId = "manager", extra = {}) => harness.behavior.callAgentTool("souls_hire", {
    draft: { name, role: "Review database migrations.", ...extra },
  }, { threadId });
  const card = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [open] = harness.inspection.pendingInteractions;
      if (open !== undefined) return open;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail("no review card was shown");
  };
  const dispatch = async (id: string) => {
    const hook = harness.inspection.registrations.hooks["message.dispatch"];
    assert.ok(hook);
    assert.deepEqual(await hook(makeMessageDispatchHookContext({
      initiator: "agent", origin: "cli", attempt: "start-turn", senderThreadId: "manager", parentThreadId: "manager",
      thread: { id, parentThreadId: "manager", sourceThreadId: null, createdAt: Date.now() },
    })), { action: "proceed" });
  };
  return { harness, read, create, select, hire, card, dispatch };
}

test("only the current soul's user-saved hiring permission allows an automatic hire", async () => {
  const x = await setup();
  try {
    toolError.parse(await x.hire("No soul"));
    const ordinary = await x.create("Reviewer", { defaultAllowDelegation: true });
    await x.select(ordinary.id);
    toolError.parse(await x.hire("No permission"));
    const manager = await x.create("Manager", { allowHiring: true });
    await x.harness.behavior.callAgentTool("souls_get", { idOrName: manager.id }, { threadId: "manager" });
    toolError.parse(await x.hire("Reading does not grant permission"));
    await x.select(manager.id);
    const config = await x.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "manager" } }));
    assert.ok(config.tools.some((tool) => tool.name === "souls_hire"));
    assert.match(config.instructions ?? "", /user allows you to create and save specialist souls/i);
    assert.match(String(await x.harness.behavior.callAgentTool("souls_get", { idOrName: manager.id }, { threadId: "manager" })), /user allows you to create and save specialist souls/i);
    assert.match(String(await x.hire("Migration specialist")), /saved automatically/);
    const hired = await x.read("Migration specialist");
    assert.ok(hired);
    assert.equal(hired.origin, "hired");
    assert.equal(hired.role, "Review database migrations.");
    assert.equal(hired.allowHiring, false);
    assert.equal(hired.defaultAllowDelegation, false);
    assert.equal(threadSoulStateSchema.parse(await x.harness.behavior.callRpc("souls_thread_get", { threadId: "manager" })).soul?.id, manager.id);
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
    assert.equal(x.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(await x.read("No permission"), null);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("hiring permission persists through reload, is independent of delegation, and revocation is checked on each call", async () => {
  const x = await setup();
  let live = x.harness;
  try {
    const manager = await x.create("Manager", { allowHiring: true, defaultAllowDelegation: true });
    await live.behavior.callRpc("souls_thread_set", { threadId: "manager", soulId: manager.id, allowDelegation: false });
    live = (await live.lifecycle.reload(plugin)).harness;
    assert.match(String(await live.behavior.callAgentTool("souls_hire", { draft: { name: "After restart" } }, { threadId: "manager" })), /saved automatically/);
    await live.behavior.callRpc("souls_update", { id: manager.id, patch: {}, allowHiring: false });
    toolError.parse(await live.behavior.callAgentTool("souls_hire", { draft: { name: "Revoked" } }, { threadId: "manager" }));
    assert.equal(saved.parse(await live.behavior.callRpc("souls_get", { idOrName: "Revoked" })).soul, null);
    assert.equal(saved.parse(await live.behavior.callRpc("souls_get", { idOrName: manager.id })).soul?.defaultAllowDelegation, true);
  } finally { await live.lifecycle.dispose(); }
});

test("side chats receive the source persona without hiring authority", async () => {
  const x = await setup();
  try {
    const manager = await x.create("Manager", { allowHiring: true });
    await x.select(manager.id);
    const config = await x.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "side", sourceThreadId: "manager" } }));
    assert.match(config.instructions ?? "", /Soul active: Manager/);
    assert.match(config.instructions ?? "", /Automatic creation of souls is not authorized/);
    assert.match(String(await x.harness.behavior.callAgentTool("souls_get", { idOrName: manager.id }, { threadId: "side" })), /Automatic creation of souls is not authorized/);
    toolError.parse(await x.hire("Side chat hire", "side"));
    assert.equal(await x.read("Side chat hire"), null);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("new hires cannot grant themselves permissions and can be assigned before a child's first session", async () => {
  const x = await setup();
  try {
    const manager = await x.create("Manager", { allowHiring: true, defaultAllowDelegation: true });
    await x.select(manager.id);
    await x.hire("Specialist", "manager", { allowHiring: true, defaultAllowDelegation: true });
    const hired = await x.read("Specialist");
    assert.ok(hired);
    assert.equal(hired.allowHiring, false);
    assert.equal(hired.defaultAllowDelegation, false);
    await x.harness.behavior.callAgentTool("souls_arm_child", { soulId: hired.id }, { threadId: "manager" });
    await x.dispatch("new-child");
    const state = threadSoulStateSchema.parse(await x.harness.behavior.callRpc("souls_thread_get", { threadId: "new-child" }));
    assert.equal(state.soul?.id, hired.id);
    assert.equal(state.allowDelegation, false);
    toolError.parse(await x.hire("Recursive hire", "new-child"));
    await assert.rejects(x.harness.behavior.callAgentTool("souls_update", { idOrName: hired.id, patch: { allowHiring: true } }, { threadId: "new-child" }), /unrecognized|unknown|allowHiring/i);
    const existing = await x.create("Existing delegator", { defaultAllowDelegation: true });
    await x.harness.behavior.callAgentTool("souls_arm_child", { soulId: existing.id }, { threadId: "manager" });
    await x.dispatch("existing-child");
    assert.equal(threadSoulStateSchema.parse(await x.harness.behavior.callRpc("souls_thread_get", { threadId: "existing-child" })).allowDelegation, true);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("retrying a hire with an existing name does not overwrite a soul", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { allowHiring: true })).id);
    await x.hire("Specialist");
    const before = await x.read("Specialist");
    const error = toolError.parse(await x.hire(" specialist ", "manager", { role: "Changed" }));
    assert.match(error.content[0]?.text ?? "", /Existing soul: soul_/);
    assert.deepEqual(await x.read("Specialist"), before);
    assert.equal(x.harness.inspection.pendingInteractions.length, 0);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("review cards can grant hiring, ordinary approved edits preserve it, and edits/deletes still require approval", async () => {
  const x = await setup();
  try {
    const proposal = x.harness.behavior.callAgentTool("souls_propose", { draft: { name: "Manager", allowHiring: true } }, { threadId: "manager" });
    const first = await x.card();
    assert.equal(await x.read("Manager"), null);
    x.harness.behavior.submitInteraction(first.id, { action: "approve", selectHere: true, allowHiring: true });
    await proposal;
    const manager = await x.read("Manager");
    assert.ok(manager?.allowHiring);
    const edit = x.harness.behavior.callAgentTool("souls_update", { idOrName: manager.id, patch: { role: "Coordinate specialists" } }, { threadId: "manager" });
    const second = await x.card();
    assert.equal(z.object({ existing: soulSchema.pick({ allowHiring: true }) }).parse(second.payload).existing.allowHiring, true);
    assert.equal((await x.read(manager.id))?.role, "");
    x.harness.behavior.submitInteraction(second.id, { action: "approve", selectHere: true });
    await edit;
    assert.equal((await x.read(manager.id))?.allowHiring, true);
    const deletion = x.harness.behavior.callAgentTool("souls_delete", { idOrName: manager.id }, { threadId: "manager" });
    x.harness.behavior.cancelInteraction((await x.card()).id);
    await deletion;
    assert.ok(await x.read(manager.id));
  } finally { await x.harness.lifecycle.dispose(); }
});

test("legacy souls and agent/import drafts never grant hiring consent", async () => {
  const x = await setup();
  try {
    assert.equal(soulSchema.parse({ name: "Legacy", id: "legacy", origin: "manual", createdAt: "", updatedAt: "" }).allowHiring, false);
    const imported = saved.parse(await x.harness.behavior.callRpc("souls_create", { draft: { name: "Imported", allowHiring: true }, origin: "manual" })).soul;
    assert.equal(imported?.allowHiring, false);
    const proposal = x.harness.behavior.callAgentTool("souls_propose", { draft: { name: "Agent draft", allowHiring: true } }, { threadId: "author" });
    x.harness.behavior.submitInteraction((await x.card()).id, { action: "approve", selectHere: false });
    await proposal;
    assert.equal((await x.read("Agent draft"))?.allowHiring, false);
  } finally { await x.harness.lifecycle.dispose(); }
});
