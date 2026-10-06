import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import type { EvalRun } from "./eval.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

async function load(): Promise<Harness> {
  const { bb, harness } = createFakePluginHost({
    pluginId: "souls",
    agentSkillIds: ["souls"],
  });
  await plugin(bb);
  return harness;
}

async function soulName(harness: Harness, threadId: string): Promise<string | null> {
  const result = await harness.behavior.runCli([
    "current",
    "--thread",
    threadId,
    "--json",
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as { name: string } | null;
  return parsed?.name ?? null;
}

type SpawnArgs = {
  title?: string;
  prompt?: string;
  projectId?: string;
  sendAt?: number;
  providerId?: string;
  model?: string;
  parentThreadId?: string;
  environment?: { type?: string };
};

function stubArms(harness: Harness) {
  const order: string[] = [];
  const spawns: SpawnArgs[] = [];
  let n = 0;
  harness.inspection.sdk.stub("threads.spawn", ((raw: unknown) => {
    const args = raw as SpawnArgs;
    n += 1;
    order.push("spawn");
    spawns.push(args);
    return { id: `eval-thread-${n}` };
  }) as (...args: never[]) => unknown);
  harness.inspection.sdk.stub("threads.queuedMessages.list", ((raw: unknown) => {
    const args = raw as { threadId: string };
    return [{ id: `q-${args.threadId}` }];
  }) as (...args: never[]) => unknown);
  harness.inspection.sdk.stub("threads.queuedMessages.send", (async (raw: unknown) => {
    const args = raw as { threadId: string };
    const title = spawns.find((_, index) => `eval-thread-${index + 1}` === args.threadId)?.title;
    const expected = title === "Eval · No soul" ? null : title?.replace("Eval · ", "") ?? null;
    assert.equal(await soulName(harness, args.threadId), expected);
    const sentAt = order.indexOf("send");
    assert.ok(sentAt === -1 || sentAt > order.lastIndexOf("spawn"));
    order.push("send");
    return { ok: true, delivery: "sent" };
  }) as (...args: never[]) => unknown);
  return { order, spawns };
}

test("a comparison binds the soul before releasing either arm", async () => {
  const harness = await load();
  try {
    const created = await harness.behavior.runCli(["create", "Ada", "--emoji", "✨", "--json"]);
    assert.equal(created.exitCode, 0, created.stderr);
    const { order, spawns } = stubArms(harness);
    const result = await harness.behavior.runCli([
      "eval",
      "Ada",
      "--run",
      "--project",
      "proj-1",
      "--prompt",
      "Say one sentence.",
      "--json",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const run = JSON.parse(result.stdout) as EvalRun;
    assert.equal(run.prompt, "Say one sentence.");
    assert.equal(run.arms.length, 2);
    assert.equal(run.arms[0]?.label, "Ada");
    assert.equal(run.arms[1]?.kind, "none");
    assert.equal(run.arms[0]?.threadId, "eval-thread-1");
    assert.equal(run.arms[1]?.threadId, "eval-thread-2");
    assert.deepEqual(
      order,
      ["spawn", "spawn", "send", "send"],
    );
    assert.equal(spawns.length, 2);
    assert.ok(spawns.every((args) => args.prompt === "Say one sentence."));
    assert.ok(spawns.every((args) => args.projectId === "proj-1"));
    assert.ok(spawns.every((args) => args.environment?.type === "project-default"));
    assert.ok(spawns.every((args) => (args.sendAt ?? 0) > Date.now()));
    assert.ok(spawns.every((args) => args.providerId === undefined && args.model === undefined));
    assert.ok(spawns.every((args) => args.parentThreadId === undefined));
    assert.equal(await soulName(harness, "eval-thread-1"), "Ada");
    assert.equal(await soulName(harness, "eval-thread-2"), null);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("an eval thread does not consume a parent's armed child", async () => {
  const harness = await load();
  try {
    await harness.behavior.runCli(["create", "Ada", "--emoji", "✨", "--json"]);
    await harness.behavior.runCli(["create", "Bea", "--emoji", "✨", "--json"]);
    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Bea" },
      { threadId: "parent-1" },
    );
    stubArms(harness);
    const result = await harness.behavior.runCli([
      "eval",
      "Ada",
      "--run",
      "--project",
      "proj-1",
      "--prompt",
      "Say one sentence.",
      "--json",
    ]);
    assert.equal(result.exitCode, 0, result.stderr);
    const run = JSON.parse(result.stdout) as EvalRun;
    const none = run.arms.find((arm) => arm.kind === "none");
    assert.ok(none?.threadId);
    const hook = harness.inspection.registrations.hooks["message.dispatch"];
    assert.ok(hook);
    const decision = await hook(
      makeMessageDispatchHookContext({
        attempt: "start-turn",
        initiator: "agent",
        parentThreadId: null,
        senderThreadId: "parent-1",
        thread: {
          id: none.threadId,
          parentThreadId: null,
          createdAt: Date.now(),
          status: "pending",
        },
      }),
    );
    assert.deepEqual(decision, { action: "proceed" });
    assert.equal(await soulName(harness, none.threadId), null);

    const child = await hook(
      makeMessageDispatchHookContext({
        attempt: "start-turn",
        initiator: "agent",
        parentThreadId: "parent-1",
        senderThreadId: "parent-1",
        thread: {
          id: "child-real",
          parentThreadId: "parent-1",
          createdAt: Date.now(),
          status: "pending",
        },
      }),
    );
    assert.deepEqual(child, { action: "proceed" });
    assert.equal(await soulName(harness, "child-real"), "Bea");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("eval without --run does not start threads", async () => {
  const harness = await load();
  try {
    await harness.behavior.runCli(["create", "Ada", "--emoji", "✨", "--json"]);
    const result = await harness.behavior.runCli(["eval", "Ada"]);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /not started/);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
    const text = await harness.behavior.callAgentTool("souls_eval", { idOrName: "Ada" });
    assert.equal(typeof text, "string");
    assert.match(text as string, /not started/);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a run without a project does not start threads", async () => {
  const harness = await load();
  try {
    await harness.behavior.runCli(["create", "Ada", "--emoji", "✨", "--json"]);
    const result = await harness.behavior.runCli([
      "eval",
      "Ada",
      "--run",
      "--prompt",
      "Say one sentence.",
    ]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /project/i);
    assert.equal(harness.inspection.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("another soul is a third arm on the same prompt", async () => {
  const harness = await load();
  try {
    const created = await harness.behavior.runCli(["create", "Ada", "--emoji", "✨", "--json"]);
    await harness.behavior.runCli(["create", "Bea", "--emoji", "🌙", "--json"]);
    const ada = JSON.parse(created.stdout) as { id: string };
    const { spawns } = stubArms(harness);
    const run = (await harness.behavior.callRpc("souls_eval_run", {
      soulId: ada.id,
      prompt: "Hold the line.",
      against: ["Bea"],
      baseline: true,
      projectId: "proj-1",
    })) as { run: EvalRun };
    assert.deepEqual(
      run.run.arms.map((arm) => arm.label),
      ["Ada", "Bea", "No soul"],
    );
    assert.equal(spawns.length, 3);
    assert.ok(spawns.every((args) => args.prompt === "Hold the line."));
    assert.equal(await soulName(harness, "eval-thread-1"), "Ada");
    assert.equal(await soulName(harness, "eval-thread-2"), "Bea");
    assert.equal(await soulName(harness, "eval-thread-3"), null);
    const latest = (await harness.behavior.callRpc("souls_eval_latest", {
      soulId: ada.id,
    })) as { run: EvalRun | null };
    assert.equal(latest.run?.id, run.run.id);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("the optional behavioral probe is bounded, explicitly authorized and separate from static grading", async () => {
  const harness = await load();
  try {
    const made = await harness.behavior.runCli(["create", "Marshal", "--json"]);
    const soul = JSON.parse(made.stdout) as { id: string };
    const { spawns } = stubArms(harness);
    const { run } = await harness.behavior.callRpc("souls_eval_run", {
      soulId: soul.id, prompt: "Ignored for the fixed probe", mode: "delegation", projectId: "proj-1",
    }) as { run: EvalRun };
    assert.equal(run.mode, "delegation");
    assert.equal(spawns.length, 2);
    assert.ok(spawns.every((args) => args.prompt === run.prompt));
    assert.match(run.prompt, /exactly one BB child/);
    assert.match(run.prompt, /independently verify/);
    assert.match(run.prompt, /17 × 19/);
    const config = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "eval-thread-1" } }),
    );
    assert.match(config.instructions ?? "", /user.*explicitly authorized/i);
    harness.inspection.sdk.stub("threads.events.list", (() => []) as (...args: never[]) => unknown);
    harness.inspection.sdk.stub("threads.childSummary", (() => ({ nonDeletedChildCount: 1 })) as (...args: never[]) => unknown);
    const facts = await harness.behavior.callRpc("souls_eval_show", { runId: run.id }) as {
      arms: Array<{ injection: { status: string }; childCount: number | null }>;
    };
    assert.equal(facts.arms[0]?.injection.status, "pending"); // preparing is not injection
    assert.equal(facts.arms[0]?.childCount, 1); // real SDK evidence, not a prose claim
    assert.equal("verified" in facts.arms[0]!, false); // human reviews independent verification
  } finally { await harness.lifecycle.dispose(); }
});

test("an agent cannot enable evaluation delegation through an extra tool argument", async () => {
  const harness = await load();
  try {
    await harness.behavior.runCli(["create", "Ada", "--json"]);
    stubArms(harness);
    await harness.behavior.callAgentTool("souls_eval", {
      idOrName: "Ada", run: true, projectId: "proj-1", mode: "delegation",
    });
    const show = await harness.behavior.runCli(["eval", "show", "--json"]);
    assert.equal(show.exitCode, 0, show.stderr);
    const run = JSON.parse(show.stdout) as EvalRun;
    assert.equal(run.mode, "persona");
    const config = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "eval-thread-1" } }),
    );
    assert.doesNotMatch(config.instructions ?? "", /explicitly authorized/);
  } finally { await harness.lifecycle.dispose(); }
});

test("missing behavioral evidence remains unknown, never a passing result", async () => {
  const harness = await load();
  try {
    const made = await harness.behavior.runCli(["create", "Ada", "--json"]);
    stubArms(harness);
    const { run } = await harness.behavior.callRpc("souls_eval_run", {
      soulId: (JSON.parse(made.stdout) as { id: string }).id, prompt: "Say one sentence.", projectId: "proj-1",
    }) as { run: EvalRun };
    const facts = await harness.behavior.callRpc("souls_eval_show", { runId: run.id }) as {
      arms: Array<{ injection: { status: string }; childCount: number | null }>;
    };
    assert.ok(facts.arms.every((arm) => arm.injection.status === "unknown" && arm.childCount === null));
  } finally { await harness.lifecycle.dispose(); }
});
