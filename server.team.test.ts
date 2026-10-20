import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { soulSchema, soulHistorySchema, soulTeamSchema, threadSoulStateSchema } from "./shared.ts";

const saved = z.object({ soul: soulSchema });
const toolError = z.object({ isError: z.literal(true), content: z.array(z.object({ text: z.string() })) });
const spawnInput = z.object({
  projectId: z.string(), parentThreadId: z.string(),
  // Source-thread attribution requires originKind and loses the hierarchy link.
  originKind: z.null().optional(), startedOnBehalfOf: z.null().optional(), sourceThreadId: z.never().optional(), sendAt: z.number().optional(),
  prompt: z.string(), providerId: z.string(), model: z.string(), permissionMode: z.string(), reasoningLevel: z.string(), environment: z.unknown(), pluginMetadata: z.object({ soulSpawnId: z.string() }),
});

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  const children: ReturnType<typeof makeThreadResponse>[] = [];
  const metadata = new Map<string, { soulSpawnId: string }>();
  harness.inspection.sdk.stub("threads.get", ({ threadId }) => children.find((child) => child.id === threadId) ?? makeThreadResponse({ id: threadId, providerId: "parent-provider", environmentId: "parent-env", parentThreadId: null }));
  harness.inspection.sdk.stub("threads.events.list", () => []);
  harness.inspection.sdk.stub("threads.list", () => children);
  harness.inspection.sdk.stub("threads.count", () => ({ total: 0 }));
  harness.inspection.sdk.stub("threads.defaultExecutionOptions", () => ({ model: "parent-model", permissionMode: "accept-edits", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/start" }));
  harness.inspection.sdk.stub("environments.get", () => ({ hostId: "parent-host", branchName: "feature/team", isGitRepo: true }));
  harness.inspection.sdk.stub("providers.models", () => ({
    modelLoadError: null,
    providers: [{ id: "specialist-provider", available: true, capabilities: { permissionModes: ["accept-edits"], supportsServiceTier: false } }],
    models: [{ id: "specialist-model", model: "specialist-model", isDefault: true, defaultReasoningEffort: "high", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }],
  }));
  harness.inspection.sdk.stub("threads.spawn", async (raw) => {
    const input = spawnInput.parse(raw);
    const child = makeThreadResponse({ id: `child-${children.length + 1}`, parentThreadId: input.parentThreadId, environmentId: "parent-env", status: "pending" });
    children.push(child); metadata.set(child.id, input.pluginMetadata);
    const hook = harness.inspection.registrations.hooks["message.dispatch"];
    assert.ok(hook);
    const held = await hook(makeMessageDispatchHookContext({
      initiator: "user", origin: "plugin", originPluginId: "souls", senderThreadId: null,
      parentThreadId: input.parentThreadId,
      thread: { id: child.id, parentThreadId: input.parentThreadId, createdAt: Date.now(), status: "pending" },
    }));
    assert.equal(held.action, "wait", "the real host evaluates initial admission before spawn returns");
    return child;
  });
  harness.inspection.sdk.stub("threads.getPluginMetadata", ({ threadId }) => metadata.get(threadId) ?? {});
  harness.inspection.sdk.stub("threads.queuedMessages.list", () => [{ id: "queued-work" }]);
  harness.inspection.sdk.stub("threads.queuedMessages.send", async ({ threadId }) => {
    const state = threadSoulStateSchema.parse(await harness.behavior.callRpc("souls_thread_get", { threadId }));
    assert.ok(state.soul, "the child must be bound before releasing its first message");
    return { ok: true, delivery: "sent" };
  });
  await plugin(bb);
  const create = async (name: string, settings = {}) => saved.parse(await harness.behavior.callRpc("souls_create", { draft: { name }, origin: "manual", ...settings })).soul;
  const read = async (name: string) => saved.parse(await harness.behavior.callRpc("souls_get", { idOrName: name })).soul;
  const state = async (threadId = "manager") => threadSoulStateSchema.parse(await harness.behavior.callRpc("souls_thread_get", { threadId }));
  const select = (soulId: string, options = {}, threadId = "manager") => harness.behavior.callRpc("souls_thread_set", { threadId, soulId, ...options });
  const hire = (name: string, extra = {}) => harness.behavior.callAgentTool("souls_hire", { draft: { name }, reason: "The roster has no database specialist.", ...extra }, { threadId: "manager" });
  const spawn = (soulId: string, key = "review", extra = {}) => harness.behavior.callAgentTool("souls_spawn_child", { soulId, key, task: "Review the migration safely.", ...extra }, { threadId: "manager", projectId: "project" });
  const dispatch = async (id: string, extra: Parameters<typeof makeMessageDispatchHookContext>[0] = {}) => {
    const hook = harness.inspection.registrations.hooks["message.dispatch"];
    assert.ok(hook);
    return hook(makeMessageDispatchHookContext({ initiator: "agent", origin: "cli", parentThreadId: "manager", senderThreadId: "manager", thread: { id, parentThreadId: "manager", createdAt: Date.now(), status: "pending" }, ...extra }));
  };
  return { harness, children, metadata, create, read, state, select, hire, spawn, dispatch };
}

test("saved rosters and handoff templates persist and are visible to the manager", async () => {
  const x = await setup();
  try {
    const reviewer = await x.create("Reviewer");
    const team = soulTeamSchema.parse({ roster: [{ role: "Reviewer", soulId: reviewer.id }], maxHiresPerTask: 2, maxConcurrentChildren: 1, handoff: { brief: "Never modify a migration.", deliverable: "A ranked list of findings.", evidence: "Cite files and line numbers.", unresolvedQuestions: "List unverified assumptions." } });
    const manager = await x.create("Manager", { team, allowHiring: true, defaultAllowDelegation: true });
    await x.select(manager.id);
    const roster = JSON.parse(String(await x.harness.behavior.callAgentTool("souls_team", {}, { threadId: "manager" })));
    assert.equal(roster.roster[0].soul, "Reviewer");
    assert.deepEqual((await x.read(manager.id)).team, team);
    assert.match(String(await x.harness.behavior.callAgentTool("souls_get", { idOrName: manager.id }, { threadId: "manager" })), /Preferred team roster/);
    await x.spawn(reviewer.id);
    const input = spawnInput.parse(x.harness.inspection.sdk.calls.filter((call) => call.path === "threads.spawn")[0]?.args[0]);
    for (const text of Object.values(team.handoff)) assert.ok(input.prompt.includes(text));
    assert.ok(input.prompt.includes("Review the migration safely."));
    assert.match(input.prompt, /Access: read-only/);
    const history = soulHistorySchema.parse(await x.harness.behavior.callRpc("souls_history", { soulId: reviewer.id }));
    assert.equal(history.usage[0]?.parentThreadId, "manager");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("the hiring allowance is atomic per task and deleting a hire does not reset it", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { allowHiring: true, team: { maxHiresPerTask: 1 } })).id);
    const results = await Promise.all([x.hire("First"), x.hire("Second")]);
    assert.equal(results.filter((result) => typeof result === "string").length, 1);
    const hired = z.object({ souls: z.array(soulSchema.pick({ id: true, name: true })) }).parse(await x.harness.behavior.callRpc("souls_list", null)).souls.find((soul) => soul.name !== "Manager");
    assert.ok(hired);
    await x.harness.behavior.callRpc("souls_delete", { id: hired.id });
    const denied = toolError.parse(await x.hire("Third"));
    assert.match(denied.content[0]?.text ?? "", /Hiring limit reached/);
    x.harness.inspection.sdk.stub("threads.queuedMessages.list", () => []);
    await x.harness.behavior.callAgentTool("souls_finish_task", {}, { threadId: "manager" });
    assert.match(String(await x.hire("Next task")), /saved automatically/);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("finishing a task archives only temporary hires and preserves promoted/permanent souls", async () => {
  const x = await setup();
  try {
    const manager = await x.create("Manager", { allowHiring: true });
    await x.select(manager.id);
    await x.hire("Temporary"); await x.hire("Promoted"); await x.hire("Permanent", { lifetime: "permanent" });
    await x.harness.behavior.callRpc("souls_promote", { soulId: (await x.read("Promoted")).id });
    const before = (await x.read("Temporary")).hire;
    assert.equal(before?.employerSoulId, manager.id);
    assert.equal(before?.parentThreadId, "manager");
    assert.equal(before?.reason, "The roster has no database specialist.");
    const result = await x.harness.behavior.callAgentTool("souls_finish_task", {}, { threadId: "manager" });
    assert.match(String(result), /Archived 1 temporary/);
    assert.ok((await x.read("Temporary")).archivedAt);
    assert.equal((await x.read("Promoted")).archivedAt, null);
    assert.equal((await x.read("Permanent")).archivedAt, null);
    const listed = z.object({ souls: z.array(soulSchema.pick({ name: true })) }).parse(await x.harness.behavior.callRpc("souls_list", null));
    assert.ok(!listed.souls.some((soul) => soul.name === "Temporary"));
    const all = z.object({ souls: z.array(soulSchema.pick({ name: true })) }).parse(await x.harness.behavior.callRpc("souls_list", { includeArchived: true }));
    assert.ok(all.souls.some((soul) => soul.name === "Temporary"));
    await assert.rejects(x.select((await x.read("Temporary")).id, {}, "new-thread"), /archived/);
    await x.harness.behavior.callRpc("souls_archive", { soulId: (await x.read("Temporary")).id, archived: false });
    await x.select((await x.read("Temporary")).id, {}, "new-thread");
    const history = soulHistorySchema.parse(await x.harness.behavior.callRpc("souls_history", { soulId: manager.id }));
    assert.equal(history.hires.length, 3);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("task cleanup refuses running or queued child work", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { allowHiring: true })).id);
    await x.hire("Temporary");
    x.children.push(makeThreadResponse({ id: "busy", status: "active", parentThreadId: "manager" }));
    toolError.parse(await x.harness.behavior.callAgentTool("souls_finish_task", {}, { threadId: "manager" }));
    assert.equal((await x.read("Temporary")).archivedAt, null);
    x.children[0] = makeThreadResponse({ id: "busy", status: "idle", parentThreadId: "manager" });
    toolError.parse(await x.harness.behavior.callAgentTool("souls_finish_task", {}, { threadId: "manager" }));
    x.harness.inspection.sdk.stub("threads.queuedMessages.list", () => []);
    assert.match(String(await x.harness.behavior.callAgentTool("souls_finish_task", {}, { threadId: "manager" })), /Archived 1/);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("version pins freeze the persona, while current permissions and team settings remain effective", async () => {
  const x = await setup();
  try {
    const manager = await x.create("Manager", { allowHiring: true });
    await x.select(manager.id, { pinnedRevision: 1 });
    await x.harness.behavior.callRpc("souls_update", { id: manager.id, patch: { personality: "A different voice." }, allowHiring: false, team: { maxHiresPerTask: 0 } });
    const state = await x.state();
    assert.equal(state.pinnedRevision, 1);
    assert.equal(state.allowHiring, false);
    toolError.parse(await x.hire("Not permitted"));
    const loaded = String(await x.harness.behavior.callAgentTool("souls_get", { idOrName: manager.id }, { threadId: "manager" }));
    assert.ok(!loaded.includes("A different voice."));
    assert.match(loaded, /New hires per task: 0/);
    const restored = saved.parse(await x.harness.behavior.callRpc("souls_restore_version", { soulId: manager.id, revision: 1 })).soul;
    assert.equal(restored.personality, "");
    assert.equal(restored.allowHiring, false);
    assert.equal(restored.team.maxHiresPerTask, 0);
    assert.equal(restored.revision, 3);
    await x.harness.behavior.callRpc("souls_update", { id: manager.id, patch: { personality: "Latest voice." } });
    await x.select(manager.id, { pinnedRevision: null });
    assert.match(String(await x.harness.behavior.callAgentTool("souls_get", { idOrName: manager.id }, { threadId: "manager" })), /Latest voice/);
    await assert.rejects(x.select(manager.id, { pinnedRevision: 99 }), /No revision/);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("per-thread hiring overrides survive reselection and the new-thread composer carries pins and overrides", async () => {
  const x = await setup();
  try {
    const manager = await x.create("Manager", { allowHiring: true });
    await x.select(manager.id, { hiringOverride: false });
    await x.harness.behavior.callAgentTool("souls_select", { soulId: manager.id }, { threadId: "manager" });
    assert.equal((await x.state()).allowHiring, false);
    toolError.parse(await x.hire("Denied"));
    await x.select(manager.id, { hiringOverride: null });
    assert.equal((await x.state()).allowHiring, true);
    await x.harness.behavior.callRpc("souls_pending_set", { soulId: manager.id, hiringOverride: false, pinnedRevision: 1 });
    await x.dispatch("fresh", { initiator: "user", origin: "app", senderThreadId: null, thread: { id: "fresh", parentThreadId: null, sourceThreadId: null, createdAt: Date.now() } });
    assert.equal((await x.state("fresh")).hiringOverride, false);
    assert.equal((await x.state("fresh")).pinnedRevision, 1);
    await x.harness.behavior.callRpc("souls_update", { id: manager.id, patch: {}, allowHiring: false });
    await x.select(manager.id, { hiringOverride: true });
    assert.equal((await x.state()).allowHiring, true, "a user's explicit thread grant can override the saved off choice");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("an existing archived binding can change permissions and revision without allowing new assignments", async () => {
  const x = await setup();
  try {
    const manager = await x.create("Manager", { defaultAllowDelegation: true, allowHiring: true });
    await x.select(manager.id);
    await x.harness.behavior.callRpc("souls_archive", { soulId: manager.id, archived: true });
    await x.select(manager.id, { allowDelegation: false, hiringOverride: false, pinnedRevision: 1 });
    const state = await x.state();
    assert.equal(state.soul?.id, manager.id);
    assert.ok(state.soul?.archivedAt);
    assert.equal(state.allowDelegation, false);
    assert.equal(state.allowHiring, false);
    assert.equal(state.pinnedRevision, 1);
    await assert.rejects(x.select(manager.id, {}, "new-thread"), /archived/);
    await assert.rejects(x.harness.behavior.callRpc("souls_pending_set", { soulId: manager.id }), /archived/);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("managed children use validated model preferences and inherit the parent's permission mode", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const specialist = saved.parse(await x.harness.behavior.callRpc("souls_create", { draft: { name: "Specialist", model: { providerId: "specialist-provider", model: "specialist-model", reasoningLevel: "high" } }, origin: "manual" })).soul;
    const result = JSON.parse(String(await x.spawn(specialist.id)));
    assert.equal(result.execution.providerId, "specialist-provider");
    assert.equal(result.execution.model, "specialist-model");
    assert.equal(result.execution.reasoningLevel, "high");
    assert.equal(result.execution.permissionMode, "accept-edits");
    const call = spawnInput.parse(x.harness.inspection.sdk.calls.filter((call) => call.path === "threads.spawn")[0]?.args[0]);
    assert.deepEqual(call.environment, { type: "reuse", environmentId: "parent-env" });
    assert.equal((await x.state("child-1")).soul?.id, specialist.id);
    assert.equal((await x.state("child-1")).allowDelegation, false);
    x.harness.inspection.sdk.stub("providers.models", () => { throw new Error("Provider offline"); });
    const fallback = JSON.parse(String(await x.spawn(specialist.id, "fallback")));
    assert.equal(fallback.execution.providerId, "parent-provider");
    assert.equal(fallback.execution.model, "parent-model");
    assert.match(fallback.warning, /Provider offline.*Using parent's/);
    await x.spawn(specialist.id, "writer", { access: "write" });
    const writer = spawnInput.parse(x.harness.inspection.sdk.calls.filter((call) => call.path === "threads.spawn")[2]?.args[0]);
    assert.deepEqual(writer.environment, { type: "host", hostId: "parent-host", workspace: { type: "managed-worktree", baseBranch: { kind: "named", name: "feature/team" } } });
  } finally { await x.harness.lifecycle.dispose(); }
});

test("managed spawns retain their hierarchical parent and reuse the released receipt", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const reviewer = await x.create("Reviewer");
    const result = await x.spawn(reviewer.id);
    assert.equal(typeof result, "string", `Managed spawn was rejected: ${JSON.stringify(result)}`);
    const receipt = z.object({ threadId: z.string(), status: z.literal("released") }).parse(JSON.parse(String(result)));
    const request = spawnInput.parse(x.harness.inspection.sdk.callsTo("threads.spawn")[0]?.[0]);
    assert.equal(request.parentThreadId, "manager");
    assert.equal(request.originKind ?? null, null);
    assert.equal(request.startedOnBehalfOf ?? null, null);
    assert.equal(request.sourceThreadId, undefined);
    assert.equal(request.sendAt, undefined, "the receipt guard holds work without a later clock delay");
    const child = x.children.find((entry) => entry.id === receipt.threadId);
    assert.ok(child);
    assert.equal(child.parentThreadId, "manager");
    assert.equal(child.sourceThreadId, null);
    assert.equal((await x.state(child.id)).soul?.id, reviewer.id);

    const repeated = JSON.parse(String(await x.spawn(reviewer.id)));
    assert.equal(repeated.threadId, child.id);
    assert.equal(repeated.status, "released");
    assert.equal(x.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("concurrent calls with the same assignment key start one child, including after reload", async () => {
  const x = await setup();
  let live = x.harness;
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const soul = await x.create("Reviewer");
    await Promise.all([x.spawn(soul.id), x.spawn(soul.id)]);
    assert.equal(live.inspection.sdk.callsTo("threads.spawn").length, 1);
    live = (await live.lifecycle.reload(plugin)).harness;
    const receipt = JSON.parse(String(await live.behavior.callAgentTool("souls_spawn_child", { soulId: soul.id, key: "review", task: "Same assignment" }, { threadId: "manager", projectId: "project" })));
    assert.equal(receipt.threadId, "child-1");
    assert.equal(live.inspection.sdk.callsTo("threads.spawn").length, 0);
  } finally { await live.lifecycle.dispose(); }
});

test("uncertain spawns retain their receipt and never automatically start a replacement", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const soul = await x.create("Reviewer");
    x.harness.inspection.sdk.stub("threads.spawn", () => { throw new Error("Connection lost after request"); });
    toolError.parse(await x.spawn(soul.id));
    const repeat = JSON.parse(String(await x.spawn(soul.id)));
    assert.equal(repeat.status, "uncertain");
    assert.equal(x.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("saved concurrency limits queue CLI child starts and leave unrelated threads and joining turns alone", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { team: { maxConcurrentChildren: 1 } })).id);
    const reviewer = await x.create("Reviewer");
    await x.harness.behavior.callAgentTool("souls_arm_child", { soulId: reviewer.id }, { threadId: "manager" });
    x.harness.inspection.sdk.stub("threads.count", ({ status }) => ({ total: status === "active" ? 1 : 0 }));
    const wait = await x.dispatch("queued-cli-child");
    assert.equal(wait.action, "wait");
    assert.equal((await x.state("queued-cli-child")).soul?.id, reviewer.id, "binding lands even when work waits for capacity");
    assert.equal((await x.dispatch("root", { thread: { id: "root", parentThreadId: null } })).action, "proceed");
    assert.equal((await x.dispatch("joining", { attempt: "join-turn" })).action, "proceed");
    x.harness.inspection.sdk.stub("threads.count", () => ({ total: 0 }));
    assert.equal((await x.dispatch("queued-cli-child")).action, "proceed");
    x.harness.inspection.sdk.stub("threads.count", () => { throw new Error("Unavailable"); });
    assert.equal((await x.dispatch("not-admitted")).action, "wait");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("managed release requests normal admission and respects occupied or zero child limits", async () => {
  for (const limit of [0, 1]) {
    const x = await setup();
    try {
      const manager = await x.create("Manager", { defaultAllowDelegation: true, team: { maxConcurrentChildren: limit } });
      await x.select(manager.id);
      x.harness.inspection.sdk.stub("threads.count", ({ status }) => ({ total: status === "active" ? limit : 0 }));
      const result = await x.spawn((await x.create("Reviewer")).id);
      assert.equal(typeof result, "string", `Managed spawn failed: ${JSON.stringify(result)}`);
      const receipt = z.object({ threadId: z.string() }).parse(JSON.parse(String(result)));
      assert.equal(x.harness.inspection.sdk.callsTo("threads.queuedMessages.send").length, 0, "Send now bypasses admission");
      assert.equal(x.harness.inspection.recheckCount, 1);
      assert.equal((await x.dispatch(receipt.threadId, { origin: "plugin", originPluginId: "souls" })).action, "wait");
      assert.ok((await x.state(receipt.threadId)).soul, "the queued child already has its persona");

      await x.harness.behavior.callRpc("souls_update", { id: manager.id, patch: {}, team: { maxConcurrentChildren: 1 } });
      x.harness.inspection.sdk.stub("threads.count", () => ({ total: 0 }));
      assert.equal((await x.dispatch(receipt.threadId, { origin: "plugin", originPluginId: "souls" })).action, "proceed");
    } finally { await x.harness.lifecycle.dispose(); }
  }
});

test("managed spawns preserve armed CLI assignments while waiting for admission", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const armed = await x.create("CLI reviewer");
    const managed = await x.create("Managed reviewer");
    await x.harness.behavior.callAgentTool("souls_arm_child", { soulId: armed.id }, { threadId: "manager" });
    await x.spawn(managed.id);
    await x.dispatch("cli-child");
    assert.equal((await x.state("cli-child")).soul?.id, armed.id);
    assert.equal((await x.state("child-1")).soul?.id, managed.id);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("a delayed managed child cannot start after its task finishes", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    await x.spawn((await x.create("Reviewer")).id);
    x.children[0] = makeThreadResponse({ id: "child-1", status: "idle", parentThreadId: "manager" });
    x.harness.inspection.sdk.stub("threads.queuedMessages.list", () => []);
    await x.harness.behavior.callAgentTool("souls_finish_task", {}, { threadId: "manager" });
    const decision = await x.dispatch("child-1", { origin: "plugin", originPluginId: "souls" });
    assert.equal(decision.action, "wait");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("history is paginated and restoring an old persona never overwrites a conflicting name", async () => {
  const x = await setup();
  try {
    const original = await x.create("First name");
    for (let index = 0; index < 51; index += 1) await x.harness.behavior.callRpc("souls_update", { id: original.id, patch: { role: `Job ${index}` } });
    const page = soulHistorySchema.parse(await x.harness.behavior.callRpc("souls_history", { soulId: original.id }));
    assert.equal(page.versions.length, 50); assert.equal(page.nextOffset, 50);
    const older = soulHistorySchema.parse(await x.harness.behavior.callRpc("souls_history", { soulId: original.id, offset: 50 }));
    assert.equal(older.versions.length, 2); assert.equal(older.nextOffset, null);
    await x.harness.behavior.callRpc("souls_update", { id: original.id, patch: { name: "Renamed" } });
    await x.create("First name");
    await assert.rejects(x.harness.behavior.callRpc("souls_restore_version", { soulId: original.id, revision: 1 }), /already exists/);
    assert.equal((await x.read(original.id)).name, "Renamed");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("pinned persona and explicit hiring denial persist through plugin reload", async () => {
  const x = await setup();
  let live = x.harness;
  try {
    const manager = await x.create("Manager", { allowHiring: true });
    await x.select(manager.id, { pinnedRevision: 1, hiringOverride: false });
    await live.behavior.callRpc("souls_update", { id: manager.id, patch: { personality: "New voice." } });
    live = (await live.lifecycle.reload(plugin)).harness;
    const state = threadSoulStateSchema.parse(await live.behavior.callRpc("souls_thread_get", { threadId: "manager" }));
    assert.equal(state.pinnedRevision, 1);
    assert.equal(state.hiringOverride, false);
    assert.equal(state.allowHiring, false);
    const config = await live.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id: "manager" } }));
    assert.match(config.instructions ?? "", /Automatic creation of souls is not authorized/);
    const loaded = String(await live.behavior.callAgentTool("souls_get", { idOrName: manager.id }, { threadId: "manager" }));
    assert.ok(!loaded.includes("New voice."));
  } finally { await live.lifecycle.dispose(); }
});

test("a preferred provider cannot cause a child permission upgrade", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const specialist = saved.parse(await x.harness.behavior.callRpc("souls_create", { draft: { name: "Specialist", model: { providerId: "specialist-provider", model: "specialist-model", reasoningLevel: "high" } }, origin: "manual" })).soul;
    x.harness.inspection.sdk.stub("providers.models", () => ({ modelLoadError: null, providers: [{ id: "specialist-provider", available: true, capabilities: { permissionModes: ["full"] } }], models: [] }));
    const result = JSON.parse(String(await x.spawn(specialist.id)));
    assert.equal(result.execution.providerId, "parent-provider");
    assert.equal(result.execution.permissionMode, "accept-edits");
    assert.match(result.warning, /cannot inherit/);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("models without a reasoning control can use the explicit none level", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const specialist = saved.parse(await x.harness.behavior.callRpc("souls_create", { draft: { name: "Specialist", model: { providerId: "specialist-provider", model: "simple-model", reasoningLevel: null } }, origin: "manual" })).soul;
    x.harness.inspection.sdk.stub("providers.models", () => ({ modelLoadError: null, providers: [{ id: "specialist-provider", available: true, capabilities: { permissionModes: ["accept-edits"], supportsServiceTier: false } }], models: [{ id: "simple-model", model: "simple-model", isDefault: true, defaultReasoningEffort: "none", supportedReasoningEfforts: [] }] }));
    const result = JSON.parse(String(await x.spawn(specialist.id)));
    assert.equal(result.execution.providerId, "specialist-provider");
    assert.equal(result.execution.model, "simple-model");
    assert.equal(result.execution.reasoningLevel, "none");
    assert.equal(result.warning, "");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("a child transitioning from starting to active still occupies its concurrency slot", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { team: { maxConcurrentChildren: 1 } })).id);
    let childStatus = "starting";
    x.harness.inspection.sdk.stub("threads.count", ({ status }) => {
      const total = status === childStatus ? 1 : 0;
      childStatus = "active";
      return { total };
    });
    assert.equal((await x.dispatch("next-child")).action, "wait");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("a failed preflight can retry the same key without duplicating a spawn", async () => {
  const x = await setup();
  try {
    await x.select((await x.create("Manager", { defaultAllowDelegation: true })).id);
    const reviewer = await x.create("Reviewer");
    x.harness.inspection.sdk.stub("threads.defaultExecutionOptions", () => null);
    toolError.parse(await x.spawn(reviewer.id));
    assert.equal(x.harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    x.harness.inspection.sdk.stub("threads.defaultExecutionOptions", () => ({ model: "parent-model", permissionMode: "accept-edits", reasoningLevel: "medium", serviceTier: "default", source: "client/turn/start" }));
    const result = JSON.parse(String(await x.spawn(reviewer.id)));
    assert.equal(result.threadId, "child-1");
    assert.equal(x.harness.inspection.sdk.callsTo("threads.spawn").length, 1);
  } finally { await x.harness.lifecycle.dispose(); }
});
