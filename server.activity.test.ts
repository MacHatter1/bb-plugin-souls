import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { activityForItem, moodFor } from "./motion.ts";
import plugin from "./server.ts";

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  let latest: { type: string; item?: string } | null = null;
  harness.inspection.sdk.stub("threads.events.list", ((args: { types?: string[] }) =>
    latest !== null && (args.types ?? []).includes(latest.type)
      ? [{ id: "e1", threadId: "thread-1", seq: 1, createdAt: Date.now(), type: latest.type, scope: { kind: "thread" },
          data: { providerThreadId: "s", ...(latest.item === undefined ? {} : { item: { type: latest.item, id: "i1" } }) } }]
      : []) as (...args: never[]) => unknown);
  await plugin(bb);
  const { soul } = (await harness.behavior.callRpc("souls_create", { draft: { name: "Hazel" }, origin: "manual" })) as {
    soul: { id: string };
  };
  await harness.behavior.callRpc("souls_thread_set", { threadId: "thread-1", soulId: soul.id });
  const tick = (status: "active" | "idle", id = "thread-1") =>
    harness.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id, status }), sequence: 1 });
  const published = () =>
    harness.inspection.realtimeSignals
      .filter((signal) => signal.channel === "souls-activity")
      .map((signal) => signal.payload as { threadId: string; activity: string | null });
  return { harness, tick, published, setLatest: (next: typeof latest) => { latest = next; } };
}

test("a soul thread's work item becomes its activity, published only when it changes", async () => {
  const x = await setup();
  try {
    x.setLatest({ type: "item/started", item: "reasoning" });
    await x.tick("active");
    x.setLatest({ type: "item/started", item: "commandExecution" });
    await x.tick("active");
    await x.tick("active");
    x.setLatest({ type: "item/completed", item: "commandExecution" });
    await x.tick("active");
    await x.tick("idle");
    assert.deepEqual(x.published().map((entry) => entry.activity), ["thinking", "running", "thinking", null]);
    assert.deepEqual(await x.harness.behavior.callRpc("souls_activity_get", { threadId: "thread-1" }), { activity: null });
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a thread with no soul publishes no activity", async () => {
  const x = await setup();
  try {
    x.setLatest({ type: "item/started", item: "fileChange" });
    await x.tick("active", "thread-without-soul");
    assert.equal(x.published().length, 0);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("work items map to the activity they stand for", () => {
  assert.equal(activityForItem("reasoning"), "thinking");
  assert.equal(activityForItem("agentMessage"), "writing");
  assert.equal(activityForItem("commandExecution"), "running");
  assert.equal(activityForItem("backgroundTask"), "running", "a long command moved to the background");
  assert.equal(activityForItem("fileChange"), "editing");
  assert.equal(activityForItem("webSearch"), "browsing");
  assert.equal(activityForItem("delegation"), "delegating");
  assert.equal(activityForItem("somethingNew"), "working");
});

test("the mood puts the user first, then errors, start-up and the work", () => {
  const active = { status: "active", hasPendingInteraction: false };
  assert.equal(moodFor(null, null), "idle");
  assert.equal(moodFor({ ...active, hasPendingInteraction: true }, "running"), "waiting");
  assert.equal(moodFor({ status: "error", hasPendingInteraction: false }, null), "error");
  assert.equal(moodFor({ ...active, runtimeStatus: "provisioning" }, null), "starting");
  assert.equal(moodFor(active, "editing"), "editing");
  assert.equal(moodFor(active, null), "thinking");
  assert.equal(moodFor({ status: "idle", hasPendingInteraction: false }, "running"), "idle");
});

test("a slow read never overwrites a newer one, and a deleted thread is forgotten", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  const reads: Array<(rows: unknown[]) => void> = [];
  const row = (item: string) => ({
    id: `e-${item}`, threadId: "thread-1", seq: 1, createdAt: Date.now(), type: "item/started",
    scope: { kind: "thread" }, data: { providerThreadId: "s", item: { type: item, id: item } },
  });
  harness.inspection.sdk.stub("threads.events.list", ((args: { types?: string[] }) =>
    args.types?.includes("item/completed")
      ? new Promise((resolve) => reads.push(resolve))
      : []) as (...args: never[]) => unknown);
  await plugin(bb);
  const { soul } = (await harness.behavior.callRpc("souls_create", { draft: { name: "Hazel" }, origin: "manual" })) as {
    soul: { id: string };
  };
  await harness.behavior.callRpc("souls_thread_set", { threadId: "thread-1", soulId: soul.id });
  const tick = () =>
    harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thread-1", status: "active" }),
      sequence: 1,
    });
  const settle = async (count: number) => {
    for (let attempt = 0; attempt < 100 && reads.length < count; attempt += 1)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reads.length, count);
  };
  try {
    const older = tick();
    await settle(1);
    const newer = tick();
    await settle(2);
    reads[1]?.([row("commandExecution")]);
    await newer;
    reads[0]?.([row("reasoning")]);
    await older;
    const published = harness.inspection.realtimeSignals
      .filter((signal) => signal.channel === "souls-activity")
      .map((signal) => (signal.payload as { activity: string | null }).activity);
    assert.deepEqual(published, ["running"]);
    assert.deepEqual(await harness.behavior.callRpc("souls_activity_get", { threadId: "thread-1" }), { activity: "running" });

    await harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thread-1" }) });
    assert.deepEqual(await harness.behavior.callRpc("souls_activity_get", { threadId: "thread-1" }), { activity: null });
  } finally {
    await harness.lifecycle.dispose();
  }
});
