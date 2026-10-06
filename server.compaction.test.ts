import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createSoulStore } from "./store.ts";

type Status = "active" | "idle";
type Sent = { threadId: string; mode: string; input: Array<{ type: string; text: string; visibility?: string }> };
type Row = { seq: number; type: string; createdAt: number; item?: string };

/** A thread's event log, served the way `threads.events.list` serves it. */
function eventLog(initial: Row[] = []) {
  let rows = [...initial];
  let seq = initial.reduce((max, row) => Math.max(max, row.seq), 0);
  return {
    add(type: string, item?: string) {
      seq += 1;
      rows = [...rows, { seq, type, createdAt: Date.now() + seq, item }];
    },
    list(args: { types?: string[]; limit?: string }) {
      return rows
        .filter((row) => args.types === undefined || args.types.includes(row.type))
        .sort((a, b) => b.seq - a.seq)
        .slice(0, Number(args.limit ?? "100"))
        .map((row) => ({
          id: `event-${row.seq}`, threadId: "thread-1", seq: row.seq, createdAt: row.createdAt,
          type: row.type, scope: { kind: "thread" },
          data: { providerThreadId: "session-1", ...(row.item === undefined ? {} : { item: { type: row.item, id: `item-${row.seq}` } }) },
        }));
    },
  };
}

async function setup(initial: Row[] = []) {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  const log = eventLog(initial);
  let status: Status = "idle";
  harness.inspection.sdk.stub("threads.events.list", ((args: { types?: string[]; limit?: string }) =>
    log.list(args)) as (...args: never[]) => unknown);
  harness.inspection.sdk.stub("threads.get", (() => ({ status })) as (...args: never[]) => unknown);
  harness.inspection.sdk.stub("threads.send", (() => ({ kind: "sent" })) as (...args: never[]) => unknown);
  await plugin(bb);
  const { soul } = (await harness.behavior.callRpc("souls_create", {
    draft: { name: "Hazel", role: "Reviews diffs before merge.", boundaries: ["Never approve a change she has not run."] },
    origin: "manual",
  })) as { soul: { id: string } };
  await harness.behavior.callRpc("souls_thread_set", { threadId: "thread-1", soulId: soul.id });

  const tick = (id = "thread-1") =>
    harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id, status }),
      sequence: 1,
    });
  const sent = () => harness.inspection.sdk.callsTo("threads.send").map((call) => call[0] as Sent);
  const reminder = async (threadId = "thread-1") =>
    (await harness.behavior.callRpc("souls_compaction_get", { threadId })) as { pending: boolean };
  const mentions = () => {
    const provider = harness.inspection.registrations.mentionProviders.find((entry) => entry.id === "soul");
    assert.ok(provider, "a soul mention provider is registered");
    return provider;
  };
  return {
    harness, soul, log, tick, sent, reminder, mentions,
    setStatus: (next: Status) => { status = next; },
  };
}

test("a compaction mid-task steers the persona back in while the agent is still using tools", async () => {
  const x = await setup();
  try {
    x.setStatus("active");
    x.log.add("turn/started");
    x.log.add("item/started", "commandExecution");
    await x.tick();
    assert.equal(x.sent().length, 0, "nothing to restore before a compaction");

    x.log.add("item/started", "contextCompaction");
    x.log.add("thread/compacted");
    await x.tick();
    assert.equal(x.sent().length, 0, "not while the compaction is still settling");

    x.log.add("item/started", "fileRead"); // the agent carries on with its tools
    await x.tick();
    const [steer] = x.sent();
    assert.ok(steer, "the persona was sent");
    assert.equal(steer.threadId, "thread-1");
    assert.equal(steer.mode, "steer");
    assert.equal(steer.input.length, 1);
    assert.equal(steer.input[0]?.visibility, "agent-only");
    assert.match(steer.input[0]?.text ?? "", /compacted/);
    assert.match(steer.input[0]?.text ?? "", /Hazel/);
    assert.match(steer.input[0]?.text ?? "", /Never approve a change she has not run\./);
    assert.equal((await x.reminder()).pending, false);

    x.log.add("item/started", "commandExecution");
    await x.tick();
    await x.tick();
    assert.equal(x.sent().length, 1, "one compaction, one reminder");
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a compaction that ends the turn goes out with the user's next message, never as a turn of its own", async () => {
  const x = await setup();
  try {
    await x.tick();
    // A manual compaction runs as its own short turn.
    x.setStatus("active");
    x.log.add("turn/input/accepted");
    x.log.add("item/started", "contextCompaction");
    x.log.add("thread/compacted");
    await x.tick();
    x.log.add("turn/completed");
    x.setStatus("idle");
    await x.tick();
    assert.equal(x.sent().length, 0, "an idle thread is never woken up");
    assert.equal((await x.reminder()).pending, true, "the banner attaches it to the next message");

    // The next turn answers straight away: a steer now would be read after the
    // answer, as an extra turn. It is never steered; the mention carries it.
    x.setStatus("active");
    x.log.add("turn/input/accepted");
    x.log.add("item/started", "agentMessage");
    await x.tick();
    assert.equal(x.sent().length, 0);

    const resolved = await x.mentions().resolve(`${x.soul.id}~thread-1`);
    assert.match(resolved.context, /compacted/);
    assert.match(resolved.context, /Never approve a change she has not run\./);
    assert.equal((await x.reminder()).pending, true, "owed until that message reaches the thread");
    x.log.add("turn/input/accepted");
    await x.tick();
    assert.equal((await x.reminder()).pending, false, "sent with that message");
    assert.equal(x.sent().length, 0);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a compaction followed only by the final answer waits for the next message", async () => {
  const x = await setup();
  try {
    x.setStatus("active");
    x.log.add("turn/started");
    x.log.add("thread/compacted");
    await x.tick();
    x.log.add("item/started", "agentMessage");
    await x.tick();
    assert.equal(x.sent().length, 0, "steering into a closing answer would start an extra turn");
    assert.equal((await x.reminder()).pending, true);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("@-mentioning a soul attaches its persona to that message", async () => {
  const x = await setup();
  try {
    const items = await x.mentions().search({ trigger: "@", query: "haz", projectId: null, threadId: "thread-1" });
    assert.equal(items.length, 1);
    assert.match(items[0]?.title ?? "", /Hazel/);
    const resolved = await x.mentions().resolve(items[0]!.id);
    assert.match(resolved.context, /attached/);
    assert.match(resolved.context, /Never approve a change she has not run\./);
    assert.equal((await x.mentions().search({ trigger: "@", query: "nobody", projectId: null, threadId: null })).length, 0);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a thread with no soul is left alone after a compaction", async () => {
  const x = await setup();
  try {
    x.setStatus("active");
    x.log.add("thread/compacted");
    x.log.add("item/started", "commandExecution");
    await x.tick("thread-without-soul");
    assert.equal(x.sent().length, 0);
    assert.equal((await x.reminder("thread-without-soul")).pending, false);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a compaction from before the plugin was watching is history, not a new one", async () => {
  const before = Date.now() - 60_000;
  const x = await setup([
    { seq: 1, type: "thread/compacted", createdAt: before },
    { seq: 2, type: "item/started", createdAt: before + 1, item: "commandExecution" },
  ]);
  try {
    x.setStatus("active");
    x.log.add("item/started", "commandExecution");
    await x.tick();
    assert.equal(x.sent().length, 0);
    assert.equal((await x.reminder()).pending, false);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

/** A manual compaction that has run and ended, leaving the reminder owed. */
async function compactedAndIdle(x: Awaited<ReturnType<typeof setup>>) {
  await x.tick();
  x.setStatus("active");
  x.log.add("turn/input/accepted");
  x.log.add("item/started", "contextCompaction");
  x.log.add("thread/compacted");
  await x.tick();
  x.log.add("turn/completed");
  x.setStatus("idle");
  await x.tick();
  assert.equal((await x.reminder()).pending, true);
}

test("a later turn that works with tools gets the reminder, even without the pill", async () => {
  const x = await setup();
  try {
    await compactedAndIdle(x);
    // Sent from the CLI or another client: no pill. The turn reaches for a tool.
    x.setStatus("active");
    x.log.add("turn/input/accepted");
    x.log.add("item/started", "agentMessage");
    await x.tick();
    assert.equal(x.sent().length, 0, "not into a reply");
    x.log.add("item/started", "commandExecution");
    await x.tick();
    assert.equal(x.sent().length, 1);
    assert.equal(x.sent()[0]?.mode, "steer");
    assert.equal((await x.reminder()).pending, false);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a whole turn without the reminder lets it go, so the banner stops promising it", async () => {
  const x = await setup();
  try {
    await compactedAndIdle(x);
    // The user removed the pill and asked a quick question.
    x.setStatus("active");
    x.log.add("turn/input/accepted");
    x.log.add("item/started", "agentMessage");
    await x.tick();
    x.log.add("turn/completed");
    x.setStatus("idle");
    await x.tick();
    assert.equal((await x.reminder()).pending, false);
    assert.equal(x.sent().length, 0, "nothing is sent to an idle thread");
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a pill whose message never arrives leaves the reminder owed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const x = await setup();
  try {
    await compactedAndIdle(x);
    t.mock.timers.setTime(Date.now() + 1_000);
    await x.mentions().resolve(`${x.soul.id}~thread-1`);
    await x.tick();
    assert.equal((await x.reminder()).pending, true, "waiting for the message");
    // The send failed; ten minutes on, nothing has reached the thread.
    t.mock.timers.setTime(Date.now() + 11 * 60_000);
    await x.tick();
    assert.equal((await x.reminder()).pending, true, "still owed");
    // So the next turn that uses tools is steered.
    x.setStatus("active");
    x.log.add("turn/input/accepted");
    x.log.add("item/started", "fileRead");
    await x.tick();
    assert.equal(x.sent().length, 1);
    assert.equal((await x.reminder()).pending, false);
  } finally {
    await x.harness.lifecycle.dispose();
  }
});

test("a compaction while the plugin was down still counts once it is back", async (t) => {
  const bound = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now: bound });
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  // The soul was bound, and Souls was watching, before it went down.
  const earlier = createSoulStore(bb, bb.storage.database());
  const soul = earlier.insert({ name: "Hazel", boundaries: ["Never approve a change she has not run."] }, "manual");
  earlier.select("thread-1", soul.id);
  await bb.storage.kv.set("watching-since", bound);
  const log = eventLog([
    { seq: 1, type: "thread/compacted", createdAt: bound + 60_000 },
    { seq: 2, type: "item/started", createdAt: bound + 61_000, item: "commandExecution" },
  ]);
  harness.inspection.sdk.stub("threads.events.list", ((args: { types?: string[]; limit?: string }) =>
    log.list(args)) as (...args: never[]) => unknown);
  harness.inspection.sdk.stub("threads.get", (() => ({ status: "active" })) as (...args: never[]) => unknown);
  harness.inspection.sdk.stub("threads.send", (() => ({ kind: "sent" })) as (...args: never[]) => unknown);
  try {
    // It comes back after the compaction.
    t.mock.timers.setTime(bound + 120_000);
    await plugin(bb);
    await harness.behavior.emitThreadEvent("experimental_thread.events", {
      thread: makeThreadResponse({ id: "thread-1", status: "active" }),
      sequence: 1,
    });
    assert.equal(harness.inspection.sdk.callsTo("threads.send").length, 1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a compaction state an older build saved never breaks the banner's read", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  // An early build saved no event sequence.
  await bb.storage.kv.set("compaction:thread-1", { seenAt: 5, pending: true });
  harness.inspection.sdk.stub("threads.events.list", (() => []) as (...args: never[]) => unknown);
  try {
    await plugin(bb);
    assert.deepEqual(await harness.behavior.callRpc("souls_compaction_get", { threadId: "thread-1" }), { pending: false, seq: null });
  } finally {
    await harness.lifecycle.dispose();
  }
});
