import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost, makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext, makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];
type State = {
  soul: { id: string; name: string } | null;
  allowDelegation: boolean;
  status: "none" | "pending" | "injected" | "outdated" | "unknown";
  session: { soulId: string | null; soulName: string | null; allowDelegation: boolean; providerThreadId: string } | null;
};

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  await plugin(bb);
  const { soul } = await harness.behavior.callRpc("souls_create", {
    draft: { name: "Marshal", role: "Delegate and verify the work." }, origin: "manual",
  }) as { soul: { id: string } };
  let identities: unknown[] = [];
  let status = "idle";
  harness.inspection.sdk.stub("threads.events.list", (() => identities) as (...args: never[]) => unknown);
  // "child" is a child of thread-1, so thread-1's agent may bind it.
  harness.inspection.sdk.stub("threads.get", ((args: { threadId: string }) =>
    ({ status, parentThreadId: args.threadId === "child" ? "thread-1" : null })) as (...args: never[]) => unknown);
  harness.inspection.sdk.stub("threads.stop", (() => ({ ok: true })) as (...args: never[]) => unknown);
  const configure = (id = "thread-1", sourceThreadId: string | null = null) =>
    harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ thread: { id, sourceThreadId } }));
  const state = (id = "thread-1") => harness.behavior.callRpc("souls_thread_get", { threadId: id }) as Promise<State>;
  const select = (allowDelegation = false, applyNow = false) => harness.behavior.callRpc("souls_thread_set", {
    threadId: "thread-1", soulId: soul.id, allowDelegation, applyNow,
  });
  const identity = (createdAt: number, seq = 1) => {
    identities = [{ id: `event-${seq}`, threadId: "thread-1", seq, createdAt, type: "thread/identity", scope: { kind: "thread" }, data: { providerThreadId: `session-${seq}` } }];
  };
  return { harness, soul, configure, state, select, identity, active: () => { status = "active"; } };
}

test("only explicit user selection grants delegation; agent and child bindings do not", async () => {
  const x = await setup();
  try {
    await x.harness.behavior.callAgentTool("souls_select", { soulId: x.soul.id, allowDelegation: true }, { threadId: "thread-1" });
    assert.equal((await x.state()).allowDelegation, false);
    await x.select(true);
    assert.match((await x.configure()).instructions ?? "", /user.*explicitly authorized/i);
    await x.harness.behavior.callAgentTool("souls_select", { soulId: x.soul.id }, { threadId: "thread-1" });
    assert.equal((await x.state()).allowDelegation, true);
    assert.doesNotMatch((await x.configure("side-chat", "thread-1")).instructions ?? "", /explicitly authorized/);
    await x.harness.behavior.callAgentTool("souls_select", { soulId: x.soul.id, threadId: "child" }, { threadId: "thread-1" });
    assert.equal((await x.state("child")).soul?.id, x.soul.id);
    assert.equal((await x.state("child")).allowDelegation, false);
    await x.harness.behavior.callRpc("souls_thread_set", { threadId: "side-chat", soulId: null });
    assert.equal((await x.configure("side-chat", "thread-1")).instructions ?? null, null);
    const cli = await x.harness.behavior.runCli(["select", x.soul.id, "--thread", "child", "--allow-delegation"]);
    assert.equal(cli.exitCode, 1);
    assert.equal((await x.state("child")).allowDelegation, false);
    await x.select(false);
    assert.doesNotMatch((await x.configure()).instructions ?? "", /explicitly authorized/);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("prepare is not injection; session identity confirms the exact prepared version", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const x = await setup();
  try {
    await x.select();
    await x.configure();
    assert.equal((await x.state()).status, "pending");
    now = 1100; x.identity(now);
    assert.equal((await x.state()).status, "injected");
    now = 1200;
    await x.harness.behavior.callRpc("souls_update", { id: x.soul.id, patch: { role: "Delegate a different task, then verify it." } });
    await x.configure(); // BB resolves on turns too; this is NOT a new session.
    assert.equal((await x.state()).status, "outdated");
    assert.equal((await x.state()).session?.providerThreadId, "session-1");
    now = 1300; x.identity(now, 2);
    assert.equal((await x.state()).status, "injected");
    await x.select(true); // consent changes also need a fresh session
    assert.equal((await x.state()).status, "outdated");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("clearing an idle thread releases its runtime, and the next session contains no soul", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const x = await setup();
  try {
    await x.select(true); await x.configure();
    now = 1100; x.identity(now);
    now = 1200;
    const cleared = await x.harness.behavior.callRpc("souls_thread_set", { threadId: "thread-1", soulId: null, applyNow: true });
    assert.equal((cleared as { restarted: boolean }).restarted, true);
    assert.equal(x.harness.inspection.sdk.callsTo("threads.stop").length, 1);
    assert.equal((await x.state()).status, "pending");
    assert.equal((await x.state()).allowDelegation, false);
    const config = await x.configure();
    assert.equal(config.instructions ?? null, null);
    now = 1300; x.identity(now, 2);
    assert.equal((await x.state()).status, "none");
    assert.equal((await x.state()).session?.soulId, null);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("a working thread is never stopped, even when consent is changed", async () => {
  const x = await setup();
  try {
    x.active();
    const result = await x.select(true, true) as { restarted: boolean; skipped: string };
    assert.equal(result.restarted, false);
    assert.equal(result.skipped, "running");
    assert.equal(x.harness.inspection.sdk.callsTo("threads.stop").length, 0);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("an older session or unavailable evidence is unknown, not falsely injected", async () => {
  const x = await setup();
  try {
    await x.select(); x.identity(0);
    assert.equal((await x.state()).status, "unknown");
    x.harness.inspection.sdk.stub("threads.events.list", (() => { throw new Error("offline"); }) as (...args: never[]) => unknown);
    await x.configure();
    assert.equal((await x.state()).status, "unknown");
  } finally { await x.harness.lifecycle.dispose(); }
});

test("compose-screen consent binds before the first turn and expires with the intent", async () => {
  const x = await setup();
  try {
    await x.harness.behavior.callRpc("souls_pending_set", { soulId: x.soul.id, allowDelegation: true });
    const hook = x.harness.inspection.registrations.hooks["message.dispatch"]!;
    await hook(makeMessageDispatchHookContext({ initiator: "user", origin: "app", attempt: "start-turn", thread: { id: "fresh", sourceThreadId: null, createdAt: Date.now() } }));
    assert.equal((await x.state("fresh")).allowDelegation, true);
    assert.match((await x.configure("fresh")).instructions ?? "", /explicitly authorized/);
    assert.equal((await x.harness.behavior.callRpc("souls_pending_get", null) as { allowDelegation: boolean }).allowDelegation, false);
    const signalsBefore = x.harness.inspection.realtimeSignals.length;
    await x.harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: "fresh" }), sequence: 1 });
    assert.ok(x.harness.inspection.realtimeSignals.length > signalsBefore);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("changing souls resets consent and reselecting the old soul cannot restore it", async () => {
  const x = await setup();
  try {
    await x.select(true);
    const { soul } = await x.harness.behavior.callRpc("souls_create", { draft: { name: "Ada" }, origin: "manual" }) as { soul: { id: string } };
    await x.harness.behavior.callAgentTool("souls_select", { soulId: soul.id }, { threadId: "thread-1" });
    assert.equal((await x.state()).allowDelegation, false);
    await x.harness.behavior.callAgentTool("souls_select", { soulId: x.soul.id }, { threadId: "thread-1" });
    assert.equal((await x.state()).allowDelegation, false);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("expired compose consent does not leak into a later user thread", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const x = await setup();
  try {
    await x.harness.behavior.callRpc("souls_pending_set", { soulId: x.soul.id, allowDelegation: true });
    now += 5 * 60_000 + 1;
    await x.harness.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
      initiator: "user", origin: "app", attempt: "start-turn", thread: { id: "late", sourceThreadId: null, createdAt: now },
    }));
    const state = await x.state("late");
    assert.equal(state.soul, null);
    assert.equal(state.allowDelegation, false);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("reload preserves consent and session evidence without reapplying a live session", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const x = await setup();
  let live = x.harness;
  try {
    await x.select(true); await x.configure();
    now = 1100;
    // Reload returns a replacement host; the old harness is deliberately stale.
    live = (await x.harness.lifecycle.reload(plugin)).harness;
    live.inspection.sdk.stub("threads.events.list", (() => [{
      id: "event-1", threadId: "thread-1", seq: 1, createdAt: now,
      type: "thread/identity", data: { providerThreadId: "session-1" }, scope: { kind: "thread" },
    }]) as (...args: never[]) => unknown);
    const result = await live.behavior.runCli(["status", "--thread", "thread-1", "--json"]);
    assert.equal(result.exitCode, 0, result.stderr);
    const state = JSON.parse(result.stdout) as State;
    assert.equal(state.status, "injected");
    assert.equal(state.allowDelegation, true);
    assert.equal(state.session?.providerThreadId, "session-1");
    assert.equal(live.inspection.sdk.callsTo("threads.stop").length, 0);
  } finally { await live.lifecycle.dispose(); }
});

test("a failed runtime release never claims consent revocation reached the old session", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const x = await setup();
  try {
    await x.select(true); await x.configure();
    now = 1100; x.identity(now);
    now = 1200;
    x.harness.inspection.sdk.stub("threads.stop", (() => { throw new Error("unreachable"); }) as (...args: never[]) => unknown);
    const result = await x.select(false, true) as { restarted: boolean; skipped: string };
    assert.equal(result.restarted, false);
    assert.equal(result.skipped, "stop-failed");
    const state = await x.state();
    assert.equal(state.status, "outdated");
    assert.equal(state.allowDelegation, false);
    assert.equal(state.session?.allowDelegation, true);
  } finally { await x.harness.lifecycle.dispose(); }
});

test("equal preparation and identity timestamps are unknown, not a false applied claim", async (t) => {
  t.mock.method(Date, "now", () => 1000);
  const x = await setup();
  try {
    await x.select(); await x.configure(); x.identity(1000);
    assert.equal((await x.state()).status, "unknown");
  } finally { await x.harness.lifecycle.dispose(); }
});
