import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";

type Harness = ReturnType<typeof createFakePluginHost>["harness"];

async function load(): Promise<Harness> {
  const { bb, harness } = createFakePluginHost({
    pluginId: "souls",
    agentSkillIds: ["souls"],
  });
  await plugin(bb);
  return harness;
}

async function createSoul(harness: Harness, name: string): Promise<void> {
  const result = await harness.behavior.runCli([
    "create",
    name,
    "--emoji",
    "✨",
    "--json",
  ]);
  assert.equal(result.exitCode, 0, result.stderr);
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

function toolText(result: unknown): string {
  if (typeof result !== "string") {
    assert.fail(`expected a string tool result, got ${typeof result}`);
  }
  return result;
}

async function dispatch(
  harness: Harness,
  overrides: Parameters<typeof makeMessageDispatchHookContext>[0],
): Promise<void> {
  const hook = harness.inspection.registrations.hooks["message.dispatch"];
  assert.ok(hook);
  const decision = await hook(makeMessageDispatchHookContext(overrides));
  assert.deepEqual(decision, { action: "proceed" });
}

function childDispatch(
  id: string,
  extra: Parameters<typeof makeMessageDispatchHookContext>[0] = {},
): Parameters<typeof makeMessageDispatchHookContext>[0] {
  const { thread: threadOverride, ...rest } = extra;
  return {
    attempt: "start-turn",
    initiator: "agent",
    parentThreadId: "parent-1",
    senderThreadId: "parent-1",
    ...rest,
    thread: {
      id,
      parentThreadId: "parent-1",
      createdAt: Date.now(),
      status: "pending",
      ...threadOverride,
    },
  };
}

test("an armed soul binds the next spawned child before its first session", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    await createSoul(harness, "Bea");
    const armed = await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Ada" },
      { threadId: "parent-1" },
    );
    const armedText = toolText(armed);
    assert.match(armedText, /Ada/);
    assert.match(armedText, /--parent-self/);
    assert.match(armedText, /five minutes/);

    await dispatch(harness, childDispatch("child-1"));
    await dispatch(harness, childDispatch("child-1"));
    assert.equal(await soulName(harness, "child-1"), "Ada");
    assert.equal(await soulName(harness, "parent-1"), null);

    const resolved = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "child-1" } }),
    );
    assert.match(resolved.instructions ?? "", /Ada/);

    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Bea" },
      { threadId: "parent-1" },
    );
    await dispatch(harness, childDispatch("child-2"));
    assert.equal(await soulName(harness, "child-2"), "Bea");
    assert.equal(await soulName(harness, "child-1"), "Ada");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a spawn with no arm leaves the child without a soul", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    await dispatch(harness, childDispatch("child-1"));
    assert.equal(await soulName(harness, "child-1"), null);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("an arm does not bind the parent, an older thread, a join, or a user thread", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Ada" },
      { threadId: "parent-1" },
    );

    await dispatch(
      harness,
      childDispatch("parent-1", {
        parentThreadId: null,
        senderThreadId: "parent-1",
        thread: { id: "parent-1", parentThreadId: null },
      }),
    );
    await dispatch(
      harness,
      childDispatch("old-child", {
        thread: { id: "old-child", createdAt: 1 },
      }),
    );
    await dispatch(
      harness,
      childDispatch("joining", { attempt: "join-turn", thread: { id: "joining" } }),
    );
    await dispatch(
      harness,
      childDispatch("user-thread", {
        initiator: "user",
        parentThreadId: null,
        senderThreadId: null,
        thread: { id: "user-thread", parentThreadId: null },
      }),
    );

    assert.equal(await soulName(harness, "parent-1"), null);
    assert.equal(await soulName(harness, "old-child"), null);
    assert.equal(await soulName(harness, "joining"), null);
    assert.equal(await soulName(harness, "user-thread"), null);

    await dispatch(harness, childDispatch("child-1"));
    assert.equal(await soulName(harness, "child-1"), "Ada");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("the sending thread matches when the child has no parent link", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Ada" },
      { threadId: "parent-1" },
    );
    await dispatch(
      harness,
      childDispatch("child-1", {
        parentThreadId: null,
        senderThreadId: "parent-1",
        thread: { id: "child-1", parentThreadId: null },
      }),
    );
    assert.equal(await soulName(harness, "child-1"), "Ada");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("the parent's arm wins when the sender armed a different soul", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    await createSoul(harness, "Bea");
    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Ada" },
      { threadId: "parent-1" },
    );
    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Bea" },
      { threadId: "sender-1" },
    );
    await dispatch(
      harness,
      childDispatch("child-1", { senderThreadId: "sender-1" }),
    );
    assert.equal(await soulName(harness, "child-1"), "Ada");
    await dispatch(
      harness,
      childDispatch("child-2", {
        parentThreadId: "sender-1",
        senderThreadId: "sender-1",
        thread: { id: "child-2", parentThreadId: "sender-1" },
      }),
    );
    assert.equal(await soulName(harness, "child-2"), "Bea");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("an armed soul overrides fork inheritance for that child only", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    await createSoul(harness, "Bea");
    await harness.behavior.callAgentTool(
      "souls_select",
      { soulId: "Bea" },
      { threadId: "parent-1" },
    );
    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Ada" },
      { threadId: "parent-1" },
    );
    await dispatch(
      harness,
      childDispatch("child-1", {
        thread: { id: "child-1", sourceThreadId: "parent-1" },
      }),
    );
    assert.equal(await soulName(harness, "child-1"), "Ada");
    const inherited = await harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        thread: { id: "side-chat", sourceThreadId: "parent-1" },
      }),
    );
    assert.match(inherited.instructions ?? "", /Bea/);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("souls_select can bind an existing child without adopting it here", async () => {
  const harness = await load();
  try {
    harness.inspection.sdk.stub("threads.get", ((args: { threadId: string }) =>
      makeThreadResponse({ id: args.threadId, parentThreadId: args.threadId === "child-1" ? "parent-1" : null })) as (...args: never[]) => unknown);
    await createSoul(harness, "Ada");
    const bound = await harness.behavior.callAgentTool(
      "souls_select",
      { soulId: "Ada", threadId: "child-1" },
      { threadId: "parent-1" },
    );
    const boundText = toolText(bound);
    assert.match(boundText, /child-1/);
    assert.doesNotMatch(boundText, /Adopt the persona/);
    assert.equal(await soulName(harness, "child-1"), "Ada");
    assert.equal(await soulName(harness, "parent-1"), null);

    const here = await harness.behavior.callAgentTool(
      "souls_select",
      { soulId: "Ada" },
      { threadId: "parent-1" },
    );
    assert.match(toolText(here), /Adopt the persona/);
    assert.equal(await soulName(harness, "parent-1"), "Ada");

    // Another thread's soul is its user's choice, not this agent's.
    const elsewhere = await harness.behavior.callAgentTool(
      "souls_select",
      { soulId: "Ada", threadId: "someone-else" },
      { threadId: "parent-1" },
    );
    assert.equal((elsewhere as { isError?: boolean }).isError, true);
    assert.equal(await soulName(harness, "someone-else"), null);
    const cleared = await harness.behavior.callAgentTool(
      "souls_select",
      { soulId: null, threadId: "someone-else" },
      { threadId: "parent-1" },
    );
    assert.equal((cleared as { isError?: boolean }).isError, true);

    // The CLI run inside a thread is held to the same rule.
    const cli = await harness.behavior.runCli(["select", "Ada", "--thread", "someone-else"], { threadId: "parent-1" });
    assert.equal(cli.exitCode, 1);
    assert.equal(await soulName(harness, "someone-else"), null);
    const unbind = await harness.behavior.runCli(["unbind", "--thread", "child-1"], { threadId: "parent-1" });
    assert.equal(unbind.exitCode, 0, unbind.stderr);
    assert.equal(await soulName(harness, "child-1"), null);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("bb souls select --next-child arms from the invoking thread", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    const armed = await harness.behavior.runCli(["select", "Ada", "--next-child"], {
      threadId: "parent-1",
    });
    assert.equal(armed.exitCode, 0, armed.stderr);
    assert.match(armed.stdout, /parent-1/);
    const both = await harness.behavior.runCli(
      ["select", "Ada", "--next-child", "--now"],
      { threadId: "parent-1" },
    );
    assert.equal(both.exitCode, 1);
    await dispatch(harness, childDispatch("child-1"));
    assert.equal(await soulName(harness, "child-1"), "Ada");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("eight waiting arms is the cap, and deleting a soul drops its arms", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    for (let index = 0; index < 8; index += 1) {
      const armed = await harness.behavior.callAgentTool(
        "souls_arm_child",
        { soulId: "Ada" },
        { threadId: "parent-1" },
      );
      assert.match(toolText(armed), /next child/);
    }
    const full = await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Ada" },
      { threadId: "parent-1" },
    );
    assert.match(toolText(full), /already has 8/);

    const removed = await harness.behavior.runCli(["delete", "Ada"]);
    assert.equal(removed.exitCode, 0, removed.stderr);
    await dispatch(harness, childDispatch("child-1"));
    assert.equal(await soulName(harness, "child-1"), null);
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a compose-screen soul still binds a user-started thread", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    await createSoul(harness, "Bea");
    const pending = (await harness.behavior.callRpc("souls_pending_set", {
      soulId: "Ada",
    })) as { soul: { name: string } | null };
    assert.equal(pending.soul?.name, "Ada");
    await harness.behavior.callAgentTool(
      "souls_arm_child",
      { soulId: "Bea" },
      { threadId: "parent-1" },
    );
    await dispatch(
      harness,
      childDispatch("fresh", {
        initiator: "user",
        origin: "app",
        parentThreadId: null,
        senderThreadId: null,
        thread: { id: "fresh", parentThreadId: null, sourceThreadId: null },
      }),
    );
    assert.equal(await soulName(harness, "fresh"), "Ada");
    await dispatch(harness, childDispatch("child-1"));
    assert.equal(await soulName(harness, "child-1"), "Bea");
  } finally {
    await harness.lifecycle.dispose();
  }
});

test("a compose-screen soul binds the thread you start in the app, not a plugin's worker", async () => {
  const harness = await load();
  try {
    await createSoul(harness, "Ada");
    const { soul } = (await harness.behavior.callRpc("souls_get", { idOrName: "Ada" })) as {
      soul: { id: string };
    };
    await harness.behavior.callRpc("souls_pending_set", { soulId: soul.id, allowDelegation: false });
    const userStart = (id: string, extra: Parameters<typeof makeMessageDispatchHookContext>[0] = {}) => ({
      attempt: "start-turn" as const,
      initiator: "user" as const,
      senderThreadId: null,
      parentThreadId: null,
      origin: "app" as const,
      originPluginId: null,
      ...extra,
      thread: { id, parentThreadId: null, sourceThreadId: null, createdAt: Date.now(), status: "pending" as const },
    });

    // Another plugin's background worker starts first: it must not take the choice.
    await dispatch(harness, userStart("worker-1", { origin: "plugin", originPluginId: "recap" }));
    assert.equal(await soulName(harness, "worker-1"), null);
    // Nor a thread started from a terminal or an SDK script.
    await dispatch(harness, userStart("cli-1", { origin: "cli" }));
    assert.equal(await soulName(harness, "cli-1"), null);

    // The thread the user starts from the compose screen gets it, once.
    await dispatch(harness, userStart("user-1"));
    assert.equal(await soulName(harness, "user-1"), "Ada");
    const after = (await harness.behavior.callRpc("souls_pending_get", null)) as { soul: unknown; expiresAt: unknown };
    assert.equal(after.soul, null);
    assert.equal(after.expiresAt, null);
  } finally {
    await harness.lifecycle.dispose();
  }
});
