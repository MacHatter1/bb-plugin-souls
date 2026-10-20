import { z } from "zod";
import type { BbPluginApi, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { SoulStore } from "./store.ts";
import { renderHandoff, type Soul } from "./shared.ts";

export const TEAM_TOOLS = ["souls_spawn_child", "souls_finish_task", "souls_team"] as const;
type Execution = NonNullable<Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["defaultExecutionOptions"]>>>;

export async function childExecution(bb: BbPluginApi, soul: Soul, environmentId: string, parentProviderId: string, inherited: Execution) {
  const fallback = { providerId: parentProviderId, model: inherited.model, permissionMode: inherited.permissionMode, reasoningLevel: inherited.reasoningLevel, serviceTier: inherited.serviceTier };
  if (soul.model === null) return { execution: fallback, warning: "" };
  try {
    const providerId = soul.model.providerId ?? parentProviderId;
    const catalog = await bb.sdk.providers.models({ providerId, environmentId });
    if (catalog.modelLoadError !== null) throw new Error(catalog.modelLoadError.detail ?? catalog.modelLoadError.code);
    const provider = catalog.providers.find((entry) => entry.id === providerId && entry.available);
    if (!provider) throw new Error(`Provider ${providerId} is unavailable`);
    if (!provider.capabilities.permissionModes.includes(inherited.permissionMode)) throw new Error("The preferred provider cannot inherit the parent's permission mode");
    const wanted = soul.model.model ?? (providerId === parentProviderId ? inherited.model : null);
    const model = wanted === null ? catalog.models.find((entry) => entry.isDefault) ?? catalog.models[0] : catalog.models.find((entry) => entry.model === wanted || entry.id === wanted);
    if (!model) throw new Error(`Preferred model ${wanted ?? "default"} is unavailable`);
    const wantedReasoning = soul.model.reasoningLevel ?? (providerId === parentProviderId && model.model === inherited.model ? inherited.reasoningLevel : model.defaultReasoningEffort);
    const reasoning = model.supportedReasoningEfforts.find((entry) => entry.reasoningEffort === wantedReasoning)?.reasoningEffort
      ?? (wantedReasoning === "none" && model.supportedReasoningEfforts.length === 0 ? "none" : undefined);
    if (reasoning === undefined) throw new Error(`Preferred reasoning ${wantedReasoning} is unavailable`);
    return { execution: { providerId, model: model.model, permissionMode: inherited.permissionMode, reasoningLevel: reasoning, serviceTier: provider.capabilities.supportsServiceTier ? inherited.serviceTier : "default" as const }, warning: "" };
  } catch (cause) {
    return { execution: fallback, warning: `Soul model preference unavailable: ${cause instanceof Error ? cause.message : String(cause)}. Using parent's ${parentProviderId}/${inherited.model} (${inherited.reasoningLevel}) with unchanged permissions.` };
  }
}

export function createSoulTeamTools(bb: BbPluginApi, store: SoulStore, changed: () => void) {
  bb.agents.registerTool({
    name: "souls_team",
    description: "Read this soul's preferred roster, hiring/delegation permissions, limits, current task and hiring history. Reads only; starts no work.",
    parameters: z.object({}),
    execute(_input, ctx) {
      const manager = store.soulForThread(ctx.threadId);
      if (manager === null) return "This thread has no selected soul.";
      const hires = store.history(manager.id).hires;
      return JSON.stringify({
        manager: { id: manager.id, name: manager.name },
        hiring: store.hiringForThread(ctx.threadId), delegation: store.delegationForThread(ctx.threadId),
        team: manager.team,
        roster: manager.team.roster.map((entry) => {
          const member = store.find(entry.soulId);
          return { ...entry, soul: member?.name ?? "missing", archived: member?.archivedAt != null };
        }),
        task: store.activeTask(ctx.threadId), hires: hires.slice(0, 10), moreHiresInProfile: hires.length > 10,
      }, null, 2);
    },
  });

  bb.agents.registerTool({
    name: "souls_spawn_child",
    description: "Spawn a child as an existing or hired soul. Requires the current thread's delegation permission. Applies the soul's model preference with a visible fallback, inherits parent permissions, uses the manager's handoff template, and binds before work starts. Use a stable key for one assignment: retries return its existing receipt. Read-only children reuse the workspace; write children use an isolated worktree. Saved concurrent-child limits queue excess work. Never retry an uncertain spawn under a different key.",
    presentation: { label: { pending: "Starting a soul child", completed: "Soul child recorded" } },
    parameters: z.object({
      soulId: z.string().min(1), key: z.string().trim().min(1).max(120),
      task: z.string().trim().min(1).max(16000), title: z.string().max(160).optional(),
      access: z.enum(["read-only", "write"]).default("read-only"),
    }).strict(),
    async execute(input, ctx) {
      const manager = store.soulForThread(ctx.threadId);
      if (manager === null || !store.delegationForThread(ctx.threadId)) return { isError: true, content: [{ type: "text", text: "This thread needs the user's delegation permission before it can spawn a child." }] };
      const soul = store.find(input.soulId);
      if (soul === null || soul.archivedAt !== null) return { isError: true, content: [{ type: "text", text: "Choose an existing, unarchived soul." }] };
      const reserved = store.reserveSpawn(ctx.threadId, input.key, soul.id);
      if (!reserved.fresh) return JSON.stringify({ ...reserved.receipt, message: "Existing assignment; no second child started. If uncertain, inspect this parent's children before deciding what to do." });
      const receipt = reserved.receipt;
      let childId: string | null = null;
      let spawnAttempted = false;
      try {
        const parent = await bb.sdk.threads.get({ threadId: ctx.threadId });
        if (parent.environmentId === null) throw new Error("The parent needs a workspace before starting a child.");
        const inherited = await bb.sdk.threads.defaultExecutionOptions({ threadId: ctx.threadId });
        if (inherited === null) throw new Error("The parent's execution permissions could not be resolved.");
        const selection = await childExecution(bb, soul, parent.environmentId, parent.providerId, inherited);
        const environment = await bb.sdk.environments.get({ environmentId: parent.environmentId });
        if (store.activeTask(ctx.threadId)?.id !== receipt.taskId || !store.delegationForThread(ctx.threadId)) throw new Error("The task or delegation permission changed before the child started.");
        if (input.access === "write" && (!environment.isGitRepo || environment.branchName === null)) throw new Error("Write children need a Git workspace with a known parent branch.");
        spawnAttempted = true;
        const child = await bb.sdk.threads.spawn({
          // Source-thread attribution requires originKind, which replaces the
          // hierarchy link. Keep both unset for a direct child.
          projectId: ctx.projectId, parentThreadId: ctx.threadId,
          title: input.title ?? `${soul.name} · ${input.key}`,
          prompt: `${renderHandoff(manager, soul, input.task)}\n\nAccess: ${input.access}.${input.access === "read-only" ? " Inspect and report; do not edit files." : " Work only in this child's isolated worktree."}`,
          ...selection.execution,
          environment: input.access === "read-only" ? { type: "reuse", environmentId: parent.environmentId } : { type: "host", hostId: environment.hostId, workspace: { type: "managed-worktree", baseBranch: environment.branchName === null ? { kind: "default" } : { kind: "named", name: environment.branchName } } },
          // The reserved receipt holds initial dispatch until binding completes.
          pluginMetadata: { soulSpawnId: receipt.id },
        });
        childId = child.id;
        store.updateSpawn(receipt.id, child.id, "reserved", selection.warning);
        store.select(child.id, soul.id);
        store.recordChildUsage(soul.id, child.id, ctx.threadId);
        store.updateSpawn(receipt.id, child.id, "bound", selection.warning);
        changed();
        if (store.activeTask(ctx.threadId)?.id !== receipt.taskId) throw new Error("This task finished while the child was being created; its message remains held.");
        // Send-now bypasses all admission hooks. Recheck the held queue instead.
        await bb.experimental_hooks.recheck("message.dispatch");
        store.updateSpawn(receipt.id, child.id, "released", selection.warning);
        return JSON.stringify({ ...store.spawnReceipt(receipt.id), execution: selection.execution, message: "Soul bound before first session. Normal queue admission has been requested; excess children stay queued under the saved concurrency limit." }, null, 2);
      } catch (cause) {
        const warning = spawnAttempted
          ? `Child start needs inspection: ${cause instanceof Error ? cause.message : String(cause)}. No automatic retry will start another child.`
          : `Child preflight failed before any spawn request: ${cause instanceof Error ? cause.message : String(cause)}. Correct the issue and retry the same assignment key.`;
        store.updateSpawn(receipt.id, childId, spawnAttempted ? "uncertain" : "failed", warning);
        changed();
        return { isError: true, content: [{ type: "text", text: JSON.stringify({ ...store.spawnReceipt(receipt.id), warning }) }] };
      }
    },
  });

  bb.agents.registerTool({
    name: "souls_finish_task",
    description: "Explicitly finish this manager thread's current task after its children settle. Archives its task-only hires, preserves permanent/promoted souls, and lets the next task start a fresh hiring allowance. Does not stop or delete threads. Refuses while children have queued or running work.",
    parameters: z.object({}),
    async execute(_input, ctx) {
      for (let offset = 0; ; offset += 100) {
        const children = await bb.sdk.threads.list({ parentThreadId: ctx.threadId, includeHidden: true, limit: 100, offset });
        if (children.some((child) => child.status !== "idle" && child.status !== "error")) return { isError: true, content: [{ type: "text", text: "Children still have queued or running work. Finish them before closing this task." }] };
        for (const child of children) {
          if ((await bb.sdk.threads.queuedMessages.list({ threadId: child.id })).length !== 0) return { isError: true, content: [{ type: "text", text: "A child still has queued work. Finish or cancel that work before closing this task." }] };
        }
        if (children.length < 100) break;
      }
      const archived = store.finishTask(ctx.threadId);
      changed();
      return `Task finished. Archived ${archived.length} temporary hire(s): ${archived.map((soul) => soul.name).join(", ") || "none"}. Permanent and promoted souls remain available.`;
    },
  });

  async function admit(context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> {
    if (context.originPluginId === "souls" && context.thread.parentThreadId !== null) {
      try {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: context.thread.id });
        const id = z.object({ soulSpawnId: z.string() }).safeParse(metadata);
        if (id.success) {
          const receipt = store.spawnReceipt(id.data.soulSpawnId);
          if (receipt !== null && store.activeTask(receipt.parentThreadId)?.id !== receipt.taskId) return { action: "wait", reason: "This child's original task has finished. Its message remains held for inspection." };
          if (receipt === null || receipt.threadId !== context.thread.id || store.soulForThread(context.thread.id)?.id !== receipt.soulId || receipt.status === "reserved") return { action: "wait", reason: "Waiting for the soul assignment to be confirmed before starting this child." };
        }
      } catch {
        return { action: "wait", reason: "Could not verify this managed child's soul assignment." };
      }
    }
    const parentId = context.thread.parentThreadId;
    if (parentId === null || context.attempt === "join-turn" || context.thread.status === "active" || context.thread.status === "starting") return { action: "proceed" };
    const manager = store.soulForThread(parentId);
    const limit = manager?.team.maxConcurrentChildren;
    if (limit == null) return { action: "proceed" };
    try {
      // Read in lifecycle order: starting -> active can temporarily count
      // twice, but cannot disappear from both reads during admission.
      const starting = await bb.sdk.threads.count({ parentThreadId: parentId, status: "starting" });
      const active = await bb.sdk.threads.count({ parentThreadId: parentId, status: "active" });
      return active.total + starting.total >= limit
        ? { action: "wait", reason: `Soul child limit: ${limit} concurrent children for ${manager?.name ?? parentId}.`, sendAt: Date.now() + 5000 }
        : { action: "proceed" };
    } catch {
      return { action: "wait", reason: "Could not check this soul's child limit; retrying shortly.", sendAt: Date.now() + 5000 };
    }
  }
  return { admit };
}
