// bb-plugin-souls — backend.
//
// A soul is a reusable agent persona. This entry owns four things:
//
//   1. the store (SQLite, synchronous — see store.ts),
//   2. `bb souls` for shells and scripts,
//   3. agent tools, including `souls_propose`, which runs the AI-led interview
//      ending in a review card the user approves, revises, or dismisses,
//   4. `bb.agents.configure`, which injects the selected soul's persona into
//      the thread's instructions.
//
// The library page, the composer picker, and the review card live in app.tsx
// and talk to (1) over the RPC contract below.
import { createHash, randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  comparisonPrompt,
  delegationProbePrompt,
  evalRunSchema,
  evalSoul,
  formatEvalPlan,
  formatEvalRun,
  formatSoulEvalLine,
  type EvalArm,
  type EvalRun,
} from "./eval.ts";
import { z } from "zod";
import {
  MAX_AGENT_IMPORT_LENGTH,
  MAX_AGENTS_PER_IMPORT,
  AGENT_IMPORT_FORMATS,
  changedFields,
  describeModelPin,
  renderAttachedPersona,
  renderCompactionReminder,
  renderSoulInstructions,
  renderSoulPersona,
  soulDirective,
  soulDraftSchema,
  soulPatchSchema,
  soulSchema,
  soulSummarySchema,
  toSummary,
  threadSoulStateSchema,
  describeSoulStatus,
  type ThreadSoulState,
  type Soul,
  type SoulDraftValue,
} from "./shared.ts";
import { ChildSoulQueueFull, createSoulStore, SoulNameTaken } from "./store.ts";
import { ACTIVITIES, activityForItem, type Activity } from "./motion.ts";
import { importAgentFile } from "./soul-import-formats.ts";
import { importGithubAgentFile } from "./soul-import-github.ts";

const agentImportOutputSchema = z.object({
  agents: z.array(z.object({
    draft: soulDraftSchema,
    warnings: z.array(z.string()),
    sourceName: z.string().optional(),
  })).min(1).max(MAX_AGENTS_PER_IMPORT),
});

const nullableSummary = soulSummarySchema.nullable();

/** The compose-screen soul, and when (epoch ms) the choice lapses unused. */
const pendingOutputSchema = z.object({
  soul: nullableSummary,
  allowDelegation: z.boolean(),
  expiresAt: z.number().nullable(),
});

/** Value submitted by the delete confirmation in app.tsx. */
const deleteSubmitSchema = z.object({ action: z.literal("delete") }).strict();

/** Value submitted by the review card in app.tsx. */
const reviewSubmitSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("approve"),
      /** Also bind this soul to the thread the card was shown in. */
      selectHere: z.boolean(),
      allowDelegation: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      action: z.literal("revise"),
      notes: z.string().max(4000),
    })
    .strict(),
]);

export const rpcContract = defineRpcContract({
  souls_list: {
    input: z.null(),
    output: z.object({ souls: z.array(soulSummarySchema) }),
  },
  souls_get: {
    input: z.object({ idOrName: z.string().min(1) }),
    output: z.object({ soul: soulSchema.nullable() }),
  },
  souls_import_preview: {
    input: z.object({
      source: z.string().min(1).max(MAX_AGENT_IMPORT_LENGTH),
      filename: z.string().max(255).default(""),
      format: z.enum(AGENT_IMPORT_FORMATS).default("auto"),
    }),
    output: agentImportOutputSchema,
  },
  souls_import_github: {
    input: z.object({ url: z.string().min(1).max(2048), format: z.enum(AGENT_IMPORT_FORMATS).default("auto") }),
    output: agentImportOutputSchema,
  },
  souls_create: {
    input: z.object({
      draft: soulDraftSchema,
      origin: z.enum(["interview", "manual"]),
    }),
    output: z.object({ soul: soulSchema }),
  },
  souls_update: {
    input: z.object({ id: z.string().min(1), patch: soulPatchSchema }),
    output: z.object({ soul: soulSchema }),
  },
  souls_delete: {
    input: z.object({ id: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  souls_thread_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: threadSoulStateSchema,
  },
  souls_thread_set: {
    input: z.object({
      threadId: z.string().min(1),
      soulId: z.string().min(1).nullable(),
      /**
       * Release an idle thread's agent runtime so its next turn constructs a
       * session with the new persona. A running thread is never stopped.
       */
      applyNow: z.boolean().default(false),
      /** Explicit picker consent, never a persona field or agent-tool option. */
      allowDelegation: z.boolean().default(false),
    }),
    output: z.object({
      soul: nullableSummary,
      /** True when the runtime was released and the change applies next turn. */
      restarted: z.boolean(),
      /** Why a restart was skipped: "running", "no-soul", or "". */
      skipped: z.string(),
    }),
  },
  souls_pending_get: {
    input: z.null(),
    output: pendingOutputSchema,
  },
  souls_pending_set: {
    input: z.object({ soulId: z.string().min(1).nullable(), allowDelegation: z.boolean().default(false) }),
    output: pendingOutputSchema,
  },
  souls_selections: {
    input: z.null(),
    output: z.object({
      selections: z.array(
        z.object({ threadId: z.string(), soul: soulSummarySchema }).strict(),
      ),
    }),
  },
  souls_eval_run: {
    input: z.object({
      soulId: z.string().min(1),
      prompt: z.string().min(1).max(8000),
      against: z.array(z.string().min(1)).max(3).default([]),
      baseline: z.boolean().default(true),
      projectId: z.string().min(1),
      mode: z.enum(["persona", "delegation"]).default("persona"),
    }),
    output: z.object({ run: evalRunSchema }),
  },
  souls_eval_show: {
    input: z.object({ runId: z.string().min(1) }),
    output: z.object({ arms: z.array(z.object({
      threadId: z.string().nullable(),
      injection: threadSoulStateSchema.nullable(),
      childCount: z.number().nullable(),
    })) }),
  },
  souls_eval_latest: {
    input: z.object({ soulId: z.string().min(1) }),
    output: z.object({ run: evalRunSchema.nullable() }),
  },
  /** What a soul thread is doing now, for its animated portrait; null when idle. */
  souls_activity_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ activity: z.enum(ACTIVITIES).nullable() }),
  },
  /** Whether a compaction's persona reminder is waiting for the next message. */
  souls_compaction_get: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({ pending: z.boolean(), seq: z.number().nullable() }),
  },
});

/** Published after every write so open pages and pickers refetch. */
const SOULS_CHANGED = "souls-changed";

/** How long a compose-screen soul choice stays good for. */
const PENDING_TTL_MS = 5 * 60_000;
const PENDING_KEY = "pending-soul";
const WATCHING_KEY = "watching-since";
/**
 * How long a composer pill that carried a compaction's reminder waits for its
 * message to reach the thread. A send that never lands owes the reminder again.
 */
const ATTACH_WAIT_MS = 10 * 60_000;

/**
 * Threads that can have armed this dispatch's child: its parent, then the
 * thread that sent the first message. "mixed" is a hook summary, not an id.
 */
function spawningThreadIds(context: {
  thread: { id: string; parentThreadId: string | null };
  parentThreadId: string | null;
  senderThreadId: string | "mixed" | null;
}): string[] {
  const ids: string[] = [];
  const push = (id: string | null) => {
    if (id === null || id === "mixed" || id === context.thread.id || ids.includes(id))
      return;
    ids.push(id);
  };
  push(context.parentThreadId);
  push(context.thread.parentThreadId);
  push(context.senderThreadId);
  return ids;
}

/** Tool names, re-declared on every `configure` resolution. */
const SOUL_TOOLS = [
  "souls_list",
  "souls_get",
  "souls_eval",
  "souls_propose",
  "souls_update",
  "souls_delete",
  "souls_select",
  "souls_arm_child",
] as const;

export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  const store = createSoulStore(bb, db);

  function changed() {
    bb.realtime.publish(SOULS_CHANGED, { count: store.list().length });
  }

  // A soul picked on the compose screen has no thread to bind yet, so it waits
  // here — in memory, mirrored to kv so a reload keeps it — and the dispatch
  // hook below binds it to the thread the user is about to start.
  let pending =
    (await bb.storage.kv.get<{ soulId: string; at: number; allowDelegation?: boolean }>(PENDING_KEY)) ??
    null;

  // Compactions from before Souls first watched a thread are history. Kept in
  // kv, so one that lands while the plugin reloads still counts as new.
  const watchingSince = (await bb.storage.kv.get<number>(WATCHING_KEY)) ?? Date.now();
  await bb.storage.kv.set(WATCHING_KEY, watchingSince);

  function pendingSoul(): Soul | null {
    if (pending === null) return null;
    if (Date.now() - pending.at > PENDING_TTL_MS) {
      pending = null;
      void bb.storage.kv.delete(PENDING_KEY).catch(() => undefined);
      return null;
    }
    return store.find(pending.soulId);
  }

  async function setPending(soulId: string | null, allowDelegation = false): Promise<Soul | null> {
    if (soulId === null) {
      pending = null;
      await bb.storage.kv.delete(PENDING_KEY);
      changed();
      return null;
    }
    const soul = store.find(soulId);
    if (soul === null) return null;
    pending = { soulId: soul.id, at: Date.now(), allowDelegation };
    await bb.storage.kv.set(PENDING_KEY, pending);
    changed();
    return soul;
  }

  type ThreadRecord = { status: string | null; sourceThreadId: string | null; parentThreadId: string | null };

  /** What Souls needs of a thread, or null when it cannot be read. */
  async function threadRecord(threadId: string): Promise<ThreadRecord | null> {
    try {
      const result = (await bb.sdk.threads.get({ threadId })) as unknown;
      const thread = ((result as { thread?: unknown })?.thread ?? result) as Record<string, unknown> | null;
      const text = (value: unknown) => (typeof value === "string" ? value : null);
      return {
        status: text(thread?.status),
        sourceThreadId: text(thread?.sourceThreadId),
        parentThreadId: text(thread?.parentThreadId),
      };
    } catch {
      return null;
    }
  }

  /** "idle" | "active" | … or null when the thread cannot be read. */
  async function threadStatus(threadId: string): Promise<string | null> {
    return (await threadRecord(threadId))?.status ?? null;
  }

  const instructionHash = (text: string) => createHash("sha256").update(text).digest("hex");

  /** A side chat's source thread, whose soul it inherits. */
  async function sourceThreadOf(threadId: string): Promise<string | null> {
    // Null when the host is offline: selection remains readable.
    return (await threadRecord(threadId))?.sourceThreadId ?? null;
  }

  /**
   * Which threads an agent (or the CLI run inside a thread) may bind: its own,
   * or a child it spawned. Any other thread's soul is chosen in that thread.
   */
  async function mayBind(callerThreadId: string, targetThreadId: string): Promise<boolean> {
    if (targetThreadId === callerThreadId) return true;
    return (await threadRecord(targetThreadId))?.parentThreadId === callerThreadId;
  }

  async function threadSoulState(threadId: string): Promise<ThreadSoulState> {
    const soul = store.soulForThread(threadId, await sourceThreadOf(threadId));
    const allowDelegation = soul !== null && store.delegationForThread(threadId);
    const base = { soul: soul === null ? null : toSummary(soul), allowDelegation, session: null };
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId, types: ["thread/identity"], order: "desc", limit: "1",
      });
      const identity = rows[0];
      if (!identity || identity.createdAt <= store.releasedAt(threadId))
        return { ...base, status: soul !== null || store.resolutionAt(threadId, Number.MAX_SAFE_INTEGER) !== null ? "pending" : "none" };
      // Equal timestamps cannot prove ordering: prefer unknown to a false applied claim.
      const snapshot = store.resolutionAt(threadId, identity.createdAt);
      if (!snapshot || identity.type !== "thread/identity") return { ...base, status: "unknown" };
      const session = { ...snapshot, providerThreadId: identity.data.providerThreadId };
      const expected = soul === null ? "" : renderSoulInstructions(soul, allowDelegation);
      const matches = snapshot.instructionHash === instructionHash(expected) &&
        snapshot.soulId === (soul?.id ?? null) && snapshot.soulUpdatedAt === (soul?.updatedAt ?? null);
      return { ...base, session, status: matches ? (soul === null ? "none" : "injected") : "outdated" };
    } catch {
      return { ...base, status: "unknown" };
    }
  }

  // The public event-history signal refreshes evidence, not a guessed "applied"
  // flag. A configure call also happens on live turns and proves only preparation.
  bb.events.on("experimental_thread.events", async ({ thread }) => {
    if (store.soulForThread(thread.id) || store.resolutionAt(thread.id, Number.MAX_SAFE_INTEGER))
      bb.realtime.publish("souls-session-changed", { threadId: thread.id });
    await publishActivity(thread);
    await restoreAfterCompaction(thread);
  });
  bb.events.on("thread.archived", ({ thread }) => {
    store.releaseSession(thread.id);
    forgetActivity(thread.id);
    changed();
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    store.forgetThread(thread.id);
    forgetActivity(thread.id);
    void bb.storage.kv.delete(compactionKey(thread.id)).catch(() => undefined);
    changed();
  });

  // --- activity: what a soul thread is doing, for its animated portrait -----
  //
  // While a thread that runs as a soul is active, its latest work item says
  // what it is doing (see motion.ts). Changes go out on "souls-activity"; the
  // banner adds waiting, error and start-up from the host's own thread view.

  const activities = new Map<string, Activity | null>();
  /** Per thread, the newest read; an older read that finishes later is stale. */
  const activityReads = new Map<string, number>();

  function forgetActivity(threadId: string): void {
    activities.delete(threadId);
    activityReads.delete(threadId);
  }

  async function publishActivity(thread: {
    id: string;
    status: string;
    sourceThreadId?: string | null;
  }): Promise<void> {
    const hasSoul = store.soulForThread(thread.id, thread.sourceThreadId ?? null) !== null;
    if (!hasSoul && !activities.has(thread.id)) return;
    const read = (activityReads.get(thread.id) ?? 0) + 1;
    activityReads.set(thread.id, read);
    let activity: Activity | null = null;
    try {
      if (thread.status === "active") {
        const [latest] = await bb.sdk.threads.events.list({
          threadId: thread.id, types: ["item/started", "item/completed"], order: "desc", limit: "1",
        });
        // Between items the model is working out its next step.
        activity =
          latest === undefined || latest.type !== "item/started"
            ? "thinking"
            : activityForItem((latest.data as { item?: { type?: string } }).item?.type);
      }
    } catch {
      activity = thread.status === "active" ? "working" : null;
    }
    if (activityReads.get(thread.id) !== read) return;
    if (activities.get(thread.id) !== activity) {
      activities.set(thread.id, activity);
      bb.realtime.publish("souls-activity", { threadId: thread.id, activity });
    }
    // A thread that lost its soul is followed until it settles, then dropped.
    if (!hasSoul && activity === null) forgetActivity(thread.id);
  }

  // --- compaction: put the persona back ------------------------------------
  //
  // The injected pointer survives a compaction; the persona `souls_get`
  // returned is summarised away with the rest of the conversation. So after a
  // thread running as a soul is compacted, the persona goes back in, agent-only:
  //
  //   • while a turn is using tools (the one that compacted, or a later one),
  //     it is steered into that turn, which reads it at the next tool step;
  //   • otherwise (a manual compaction, or one at the end of a reply) it waits,
  //     and the composer banner attaches it to the user's next message as a
  //     mention. A steer then would be read after the answer, as an extra
  //     turn, and a send to an idle thread would start a turn of its own.
  //
  // If a whole turn runs after the compaction without it (the pill removed,
  // or a message sent from elsewhere with no tools used), it is no longer
  // owed: the pointer still tells the agent to reload after a compaction.

  /**
   * Per thread: the newest compaction seen, whether its reminder is owed, and
   * when a composer pill carrying it was resolved. A pill only counts once its
   * message reaches the thread.
   */
  const compactionStateSchema = z.object({
    seenAt: z.number(),
    seenSeq: z.number(),
    pending: z.boolean(),
    attachedAt: z.number().nullable().optional(),
  });
  type CompactionState = z.infer<typeof compactionStateSchema>;
  const compactionKey = (threadId: string) => `compaction:${threadId}`;
  /** Items that are the agent talking or thinking, not working with tools. */
  const NOT_TOOL_WORK = new Set(["agentMessage", "reasoning", "plan", "contextCompaction", "userMessage"]);
  /** Threads being settled now, and the newest event that arrived meanwhile. */
  const restoring = new Map<string, { id: string; status: string; sourceThreadId?: string | null } | null>();

  /** The saved state, or null; a shape an older build wrote starts over. */
  async function compactionState(threadId: string): Promise<CompactionState | null> {
    const parsed = compactionStateSchema.safeParse(await bb.storage.kv.get(compactionKey(threadId)));
    return parsed.success ? parsed.data : null;
  }

  async function saveCompactionState(threadId: string, next: CompactionState, previous: CompactionState | null) {
    const same = previous !== null &&
      previous.seenAt === next.seenAt &&
      previous.seenSeq === next.seenSeq &&
      previous.pending === next.pending &&
      (previous.attachedAt ?? null) === (next.attachedAt ?? null);
    if (same) return;
    await bb.storage.kv.set(compactionKey(threadId), next);
    if (previous?.pending !== next.pending)
      bb.realtime.publish("souls-session-changed", { threadId });
  }

  const itemTypeOf = (row: { data: unknown } | undefined) =>
    (row?.data as { item?: { type?: string } } | undefined)?.item?.type;

  async function restoreAfterCompaction(thread: {
    id: string;
    status: string;
    sourceThreadId?: string | null;
  }): Promise<void> {
    // One settle per thread at a time. An event that arrives meanwhile is
    // settled straight after, so the last word on a thread is never skipped.
    if (restoring.has(thread.id)) {
      restoring.set(thread.id, thread);
      return;
    }
    restoring.set(thread.id, null);
    try {
      let next: typeof thread | null = thread;
      while (next !== null) {
        await settleCompaction(next);
        next = restoring.get(thread.id) ?? null;
        restoring.set(thread.id, null);
      }
    } finally {
      restoring.delete(thread.id);
    }
  }

  async function settleCompaction(thread: { id: string; status: string; sourceThreadId?: string | null }) {
    const soul = store.soulForThread(thread.id, thread.sourceThreadId ?? null);
    if (soul === null) return;
    try {
      const [compacted] = await bb.sdk.threads.events.list({
        threadId: thread.id, types: ["thread/compacted"], order: "desc", limit: "1",
      });
      const saved = await compactionState(thread.id);
      // A compaction before Souls watched this thread, or before it took this
      // soul, is history.
      const since = Math.max(watchingSince, store.boundAt(thread.id) ?? 0);
      let state: CompactionState = saved ?? (
        compacted !== undefined && compacted.createdAt < since
          ? { seenAt: compacted.createdAt, seenSeq: compacted.seq, pending: false }
          : { seenAt: 0, seenSeq: 0, pending: false }
      );
      if (compacted !== undefined && compacted.createdAt > state.seenAt)
        state = { seenAt: compacted.createdAt, seenSeq: compacted.seq, pending: true, attachedAt: null };

      if (state.pending && typeof state.attachedAt === "number") {
        const attachedAt = state.attachedAt;
        const starts = await bb.sdk.threads.events.list({
          threadId: thread.id, types: ["turn/started", "turn/input/accepted"], order: "desc", limit: "5",
        });
        if (starts.some((row) => row.seq > state.seenSeq && row.createdAt >= attachedAt)) {
          state = { ...state, pending: false, attachedAt: null };
          bb.log.info(`restored ${soul.name} with the next message after a compaction of ${thread.id}`);
        } else if (Date.now() - attachedAt > ATTACH_WAIT_MS) {
          state = { ...state, attachedAt: null }; // That send never landed: still owed.
        }
      }

      if (state.pending && typeof state.attachedAt !== "number") {
        const [ends, items] = await Promise.all([
          bb.sdk.threads.events.list({ threadId: thread.id, types: ["turn/completed"], order: "desc", limit: "2" }),
          bb.sdk.threads.events.list({ threadId: thread.id, types: ["item/started"], order: "desc", limit: "1" }),
        ]);
        const endsSince = ends.filter((row) => row.seq > state.seenSeq);
        // The running turn's latest item: after the compaction and after the last turn ended.
        const latest = items[0];
        const current = latest !== undefined && latest.seq > Math.max(state.seenSeq, endsSince[0]?.seq ?? 0);
        const itemType = current ? itemTypeOf(latest) : undefined;
        const usingTools = itemType !== undefined && !NOT_TOOL_WORK.has(itemType);
        if (thread.status === "active" && usingTools && (await threadStatus(thread.id)) === "active") {
          await bb.sdk.threads.send({
            threadId: thread.id,
            mode: "steer",
            input: [{
              type: "text",
              text: renderCompactionReminder(soul, store.delegationForThread(thread.id)),
              mentions: [],
              visibility: "agent-only",
            }],
          });
          state = { ...state, pending: false };
          bb.log.info(`restored ${soul.name} mid-task after a compaction of ${thread.id}`);
        } else if (endsSince.length >= 2) {
          // The turn that compacted ended, then a whole turn ran without it.
          state = { ...state, pending: false };
          bb.log.info(`a turn ran without ${soul.name}'s reminder after compacting ${thread.id}; left to the pointer`);
        }
      }
      await saveCompactionState(thread.id, state, saved);
    } catch (cause) {
      bb.log.warn(`could not restore the persona after compacting ${thread.id}: ${String(cause)}`);
    }
  }

  // `@` a soul in the composer to attach its persona to that message. The
  // banner inserts one after a compaction; its item id names the thread, so
  // resolving it at send time carries that compaction's reminder. The reminder
  // is settled once the message reaches the thread, not here: a send can fail.
  bb.ui.registerMentionProvider({
    id: "soul",
    label: "Souls",
    search({ query }) {
      const needle = query.trim().toLowerCase();
      return store
        .list()
        .filter((soul) => needle === "" || `${soul.name} ${soul.tagline} ${soul.role}`.toLowerCase().includes(needle))
        .slice(0, 8)
        .map((soul) => ({
          id: soul.id,
          title: `${soul.emoji} ${soul.name}`.trim(),
          subtitle: soul.tagline === "" ? "Attach this persona to your message" : soul.tagline,
        }));
    },
    async resolve(itemId) {
      const [soulId = "", threadId] = itemId.split("~");
      const soul = store.find(soulId);
      if (soul === null) throw new Error("That soul no longer exists.");
      if (threadId === undefined)
        return { context: renderAttachedPersona(soul) };
      const consent = store.soulForThread(threadId)?.id === soul.id && store.delegationForThread(threadId);
      const saved = await compactionState(threadId);
      if (saved?.pending === true) {
        await saveCompactionState(threadId, { ...saved, attachedAt: Date.now() }, saved);
        return { context: renderCompactionReminder(soul, consent) };
      }
      return { context: renderAttachedPersona(soul, consent) };
    },
  });

  // ponytail: 2 minute hold so the bind lands before the first turn. A
  // create-without-a-message API would remove it.
  const EVAL_HOLD_MS = 120_000;
  const OUTPUT_CAP = 4000;

  function threadIdOf(result: unknown): string {
    const record = result as { id?: unknown; thread?: { id?: unknown } };
    const id = typeof record.id === "string" ? record.id : record.thread?.id;
    if (typeof id !== "string" || id === "") throw new Error("Spawn did not return a thread id.");
    return id;
  }

  /** Project for a comparison: an explicit id, the caller's, or the caller's thread. */
  async function resolveProjectId(
    explicit: string | undefined,
    fromContext: string | undefined,
    fromThread: string | undefined,
  ): Promise<string | null> {
    if (explicit !== undefined && explicit !== "" && explicit !== "true") return explicit;
    if (fromContext !== undefined && fromContext !== "") return fromContext;
    if (fromThread === undefined) return null;
    try {
      const result = (await bb.sdk.threads.get({ threadId: fromThread })) as {
        projectId?: unknown;
        thread?: { projectId?: unknown };
      };
      const id = result.projectId ?? result.thread?.projectId;
      return typeof id === "string" && id !== "" ? id : null;
    } catch {
      return null;
    }
  }

  function resolveAgainst(primary: Soul, ids: readonly string[]): Soul[] | string {
    if (ids.length > 3) return "Compare with at most three other souls.";
    const seen = new Set<string>([primary.id]);
    const souls: Soul[] = [];
    for (const id of ids) {
      const soul = store.find(id);
      if (soul === null) return `No soul matches "${id}".`;
      if (seen.has(soul.id)) return `${soul.name} is already in this comparison.`;
      seen.add(soul.id);
      souls.push(soul);
    }
    return souls;
  }

  /**
   * Same prompt on every arm. Soul arms are selected before their first
   * message is released, so the session is constructed with the persona.
   * Eval threads are marked so the dispatch hook does not spend a parent's
   * armed child on them. Model pins are not applied: both arms use the project.
   */
  async function startEvalRun(input: {
    primary: Soul;
    against: readonly Soul[];
    baseline: boolean;
    prompt: string;
    projectId: string;
    mode?: "persona" | "delegation";
  }): Promise<EvalRun | string> {
    const mode = input.mode ?? "persona";
    const prompt = mode === "delegation" ? delegationProbePrompt : input.prompt.trim();
    if (prompt === "") return "A comparison needs a prompt.";
    if (prompt.length > 8000) return "The prompt is longer than 8000 characters.";
    const arms: EvalArm[] = [
      {
        kind: "soul",
        soulId: input.primary.id,
        label: input.primary.name,
        emoji: input.primary.emoji,
        threadId: null,
        error: null,
      },
      ...input.against.map(
        (soul): EvalArm => ({
          kind: "soul",
          soulId: soul.id,
          label: soul.name,
          emoji: soul.emoji,
          threadId: null,
          error: null,
        }),
      ),
    ];
    if (input.baseline) {
      arms.push({
        kind: "none",
        soulId: null,
        label: "No soul",
        emoji: "",
        threadId: null,
        error: null,
      });
    }
    if (arms.length < 2) return "A comparison needs two arms. Keep no soul, or name another soul.";

    const holdUntil = Date.now() + EVAL_HOLD_MS;
    for (const arm of arms) {
      try {
        const spawned = await bb.sdk.threads.spawn({
          projectId: input.projectId,
          prompt,
          title: `Eval · ${arm.label}`,
          // Held so we can bind before the session is constructed.
          sendAt: holdUntil,
          environment: { type: "project-default" },
          visibility: "visible",
        });
        const threadId = threadIdOf(spawned);
        arm.threadId = threadId;
        store.markEvalThread(threadId);
      } catch (cause) {
        arm.error = cause instanceof Error ? cause.message : String(cause);
      }
    }
    for (const arm of arms) {
      if (arm.threadId === null) continue;
      if (arm.soulId === null) {
        store.select(arm.threadId, null);
        continue;
      }
      const bound = store.select(arm.threadId, arm.soulId, mode === "delegation");
      if (bound !== null) continue;
      arm.error = `Could not bind ${arm.label}.`;
      try {
        await bb.sdk.threads.delete({
          threadId: arm.threadId,
          childThreadsConfirmed: true,
        });
        arm.threadId = null;
      } catch (cause) {
        arm.error = `Could not bind ${arm.label}, and the thread is still there: ${
          cause instanceof Error ? cause.message : String(cause)
        }`;
      }
    }
    for (const arm of arms) {
      if (arm.threadId === null || arm.error !== null) continue;
      try {
        const rows = await bb.sdk.threads.queuedMessages.list({ threadId: arm.threadId });
        const queued = rows[0];
        if (queued === undefined) {
          arm.error = "Held message was not listed. It starts when the hold expires, already bound.";
          continue;
        }
        await bb.sdk.threads.queuedMessages.send({
          threadId: arm.threadId,
          queuedMessageId: queued.id,
          mode: "auto",
        });
      } catch (cause) {
        arm.error = `Bound, but not released: ${
          cause instanceof Error ? cause.message : String(cause)
        }. It starts when the hold expires.`;
      }
    }

    const run: EvalRun = {
      id: `eval_${randomUUID()}`,
      createdAt: new Date().toISOString(),
      prompt,
      projectId: input.projectId,
      soulId: input.primary.id,
      mode,
      arms,
    };
    store.saveEvalRun(run);
    return run;
  }

  function personaFootnote(soul: Soul): string | null {
    const report = evalSoul(soul);
    if (report.grade === "holds") return null;
    return `Persona ${report.score} ${report.grade}. The comparison still runs.`;
  }

  async function readEvalShow(run: EvalRun) {
    const snaps = await Promise.all(
      run.arms.map(async (arm) => {
        if (arm.threadId === null) return { ...arm, status: null, output: null };
        const status = await threadStatus(arm.threadId);
        let output: string | null = null;
        try {
          const result = await bb.sdk.threads.output({ threadId: arm.threadId });
          output = result.output;
        } catch {
          output = null;
        }
        if (output !== null && output.length > OUTPUT_CAP) {
          output = `${output.slice(0, OUTPUT_CAP)}\n…`;
        }
        return { ...arm, status, output };
      }),
    );
    return snaps;
  }

  function formatEvalShow(
    run: EvalRun,
    snaps: Array<EvalArm & { status: string | null; output: string | null }>,
  ): string {
    const blocks = snaps.map((arm) => {
      const who = arm.kind === "none" ? "No soul" : `${arm.emoji} ${arm.label}`.trim();
      const head =
        arm.threadId === null
          ? `${who}  did not start${arm.error === null ? "" : `: ${arm.error}`}`
          : `${who}  ${arm.threadId}  ${arm.status ?? "unknown"}`;
      const body = arm.output === null || arm.output === "" ? "(no reply yet)" : arm.output;
      return `${head}\n${body}`;
    });
    const outputs = snaps
      .map((arm) => arm.output?.trim() ?? "")
      .filter((text) => text !== "");
    const compare =
      outputs.length < 2
        ? "Waiting on replies."
        : outputs.every((text) => text === outputs[0])
          ? "Replies in so far are the same text."
          : "Replies in so far differ.";
    return [run.prompt, "", ...blocks, compare].join("\n\n");
  }

  // --- rpc: what app.tsx calls ---------------------------------------------

  bb.rpc.register(rpcContract, {
    souls_list: () => ({ souls: store.list().map((soul) => toSummary(soul)) }),
    souls_get: ({ idOrName }) => ({ soul: store.find(idOrName) }),
    souls_import_preview: ({ source, filename, format }) => importAgentFile(source, filename, format),
    souls_import_github: ({ url, format }) => importGithubAgentFile(url, globalThis.fetch, format),
    souls_create: ({ draft, origin }) => {
      const soul = store.insert(draft, origin);
      changed();
      return { soul };
    },
    souls_update: ({ id, patch }) => {
      const soul = store.update(id, patch);
      if (soul === null) throw new Error(`No soul with id ${id}`);
      changed();
      return { soul };
    },
    souls_delete: ({ id }) => {
      const removed = store.remove(id);
      changed();
      return { removed };
    },
    souls_thread_get: ({ threadId }) => threadSoulState(threadId),
    souls_thread_set: async ({ threadId, soulId, applyNow, allowDelegation }) => {
      if (soulId !== null && store.find(soulId) === null)
        throw new Error(`No soul with id ${soulId}`);
      const soul = store.select(threadId, soulId, allowDelegation);
      changed();
      if (!applyNow)
        return {
          soul: soul === null ? null : toSummary(soul),
          restarted: false,
          skipped: "",
        };
      // A live session keeps the instructions it was constructed with, so
      // "apply now" means releasing an idle runtime: the next turn builds a
      // session that carries the persona. A running thread is never stopped —
      // interrupting work to change a voice would be a bad trade.
      const status = await threadStatus(threadId);
      if (status !== "idle")
        return {
          soul: soul === null ? null : toSummary(soul),
          restarted: false,
          skipped: status === null ? "unknown" : "running",
        };
      try {
        await bb.sdk.threads.stop({ threadId });
        store.releaseSession(threadId);
        changed();
        return { soul: soul === null ? null : toSummary(soul), restarted: true, skipped: "" };
      } catch (cause) {
        bb.log.warn(`could not release ${threadId}: ${String(cause)}`);
        return { soul: soul === null ? null : toSummary(soul), restarted: false, skipped: "stop-failed" };
      }
    },
    souls_pending_get: () => {
      const soul = pendingSoul();
      return {
        soul: soul === null ? null : toSummary(soul),
        allowDelegation: soul !== null && pending?.allowDelegation === true,
        expiresAt: soul === null || pending === null ? null : pending.at + PENDING_TTL_MS,
      };
    },
    souls_pending_set: async ({ soulId, allowDelegation }) => {
      const soul = await setPending(soulId, allowDelegation);
      if (soulId !== null && soul === null)
        throw new Error(`No soul with id ${soulId}`);
      return {
        soul: soul === null ? null : toSummary(soul),
        allowDelegation: soul !== null && allowDelegation,
        expiresAt: soul === null || pending === null ? null : pending.at + PENDING_TTL_MS,
      };
    },
    souls_selections: () => ({
      selections: store
        .selections()
        .map(({ threadId, soul }) => ({ threadId, soul: toSummary(soul) })),
    }),
    souls_eval_show: async ({ runId }) => {
      const run = store.getEvalRun(runId);
      if (run === null) throw new Error(`No comparison ${runId}.`);
      const arms = await Promise.all(run.arms.map(async (arm) => {
        if (arm.threadId === null) return { threadId: null, injection: null, childCount: null };
        let childCount: number | null = null;
        try {
          childCount = (await bb.sdk.threads.childSummary({ threadId: arm.threadId })).nonDeletedChildCount;
        } catch { /* No evidence is unknown, never a false passing result. */ }
        return { threadId: arm.threadId, injection: await threadSoulState(arm.threadId), childCount };
      }));
      return { arms };
    },
    souls_eval_latest: ({ soulId }) => ({ run: store.latestEvalRun(soulId) }),
    souls_activity_get: ({ threadId }) => ({ activity: activities.get(threadId) ?? null }),
    souls_compaction_get: async ({ threadId }) => {
      const state = await compactionState(threadId);
      return { pending: state?.pending === true, seq: state === null ? null : state.seenSeq };
    },
    souls_eval_run: async ({ soulId, prompt, against, baseline, projectId, mode }) => {
      const primary = store.find(soulId);
      if (primary === null) throw new Error(`No soul matches "${soulId}".`);
      const others = resolveAgainst(primary, against);
      if (typeof others === "string") throw new Error(others);
      const run = await startEvalRun({
        primary,
        against: others,
        baseline,
        prompt,
        projectId,
        mode,
      });
      if (typeof run === "string") throw new Error(run);
      return { run };
    },
  });

  // --- agent configuration: the persona a selected soul contributes --------

  bb.agents.configure((context) => {
    try {
      const soul = store.soulForThread(
        context.thread.id,
        context.thread.sourceThreadId,
      );
      bb.log.debug(
        `configure thread=${context.thread.id} provider=${context.provider.id} soul=${soul?.id ?? "none"}`,
      );
      const allowDelegation = soul !== null && store.delegationForThread(context.thread.id);
      const instructions = soul === null ? "" : renderSoulInstructions(soul, allowDelegation);
      store.recordResolution(context.thread.id, {
        soulId: soul?.id ?? null, soulName: soul?.name ?? null,
        soulUpdatedAt: soul?.updatedAt ?? null, allowDelegation,
        instructionHash: instructionHash(instructions), providerId: context.provider.id,
        resolvedAt: Date.now(),
      });
      return {
        tools: [...SOUL_TOOLS], skills: ["souls"],
        ...(soul === null ? {} : { instructions }),
      };
    } catch (cause) {
      // `configure` fails closed for the whole plugin if it throws: never let
      // one unreadable soul take the tools away from every thread.
      bb.log.warn(`soul configuration failed: ${String(cause)}`);
      return { tools: [...SOUL_TOOLS], skills: ["souls"] };
    }
  });

  // --- agent tools ---------------------------------------------------------

  const toolNotes = [
    "Souls are reusable agent personas the user picks per thread. Selection alone is not delegation permission; only explicit user consent in the picker or review card grants thread-scoped delegation.",
    "To create one, run the interview in the `souls` skill and finish with souls_propose. Every change to a soul, edits and deletes included, goes through a card the user approves.",
    "When a child you are about to spawn should run as a soul, call souls_arm_child first, then `bb thread spawn --parent-self`. Skip it when no soul fits. One arm binds one child.",
  ].join(" ");

  bb.agents.registerTool({
    name: "souls_list",
    description:
      "List the souls (reusable agent personas) the user has created, with the one this thread runs as.",
    instructions: toolNotes,
    presentation: {
      label: { pending: "Listing souls", completed: "Listed souls" },
    },
    parameters: z.object({}),
    execute(_params, ctx) {
      const souls = store.list();
      if (souls.length === 0)
        return "No souls yet. Offer to interview the user about one (see the souls skill).";
      const active = store.soulForThread(ctx.threadId);
      const lines = souls.map((soul) => {
        const pin = describeModelPin(soul.model);
        return [
          `${soul.id === active?.id ? "* " : "  "}${soul.emoji} ${soul.name} (${soul.id})`,
          soul.tagline === "" ? null : `      ${soul.tagline}`,
          soul.role === "" ? null : `      job: ${soul.role}`,
          pin === null ? null : `      model: ${pin}`,
        ]
          .filter((line): line is string => line !== null)
          .join("\n");
      });
      return [
        `${souls.length} soul(s). "*" marks the soul selected for this thread; bb souls status shows session injection evidence.`,
        ...lines,
        ``,
        `Bind one to this thread with souls_select. Before spawning a child that should run as a soul, call souls_arm_child, then bb thread spawn --parent-self.`,
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "souls_get",
    description:
      "Read one soul in full: the whole persona an agent adopts (job, hard limits, principles, voice, expertise, model preference). A thread running as a soul calls this to load its persona, which its instructions only point to.",
    presentation: {
      label: { pending: "Loading soul", completed: "Loaded soul" },
    },
    parameters: z.object({
      idOrName: z.string().min(1).describe("Soul id, name, or slug."),
    }),
    async execute({ idOrName }, ctx) {
      const soul = store.find(idOrName);
      if (soul === null) return `No soul matches "${idOrName}".`;
      // The thread's own soul: this call is the agent loading its persona.
      const own = store.soulForThread(ctx.threadId, await sourceThreadOf(ctx.threadId))?.id === soul.id;
      return [
        `${soul.emoji} ${soul.name} — ${soul.id}`,
        `model: ${describeModelPin(soul.model) ?? "(no preference)"}`,
        `origin: ${soul.origin}, updated ${soul.updatedAt}`,
        ...(own
          ? [
              `This thread runs as ${soul.name}: adopt the persona below now. If this is your first reply as ${soul.name}, start it with this line on its own so the user sees the persona load:`,
              soulDirective(soul.id),
            ]
          : []),
        ``,
        `--- persona ---`,
        renderSoulPersona(soul, own && store.delegationForThread(ctx.threadId)),
        ...(own ? [] : [`--- injected instructions (they point at the persona) ---`, renderSoulInstructions(soul)]),
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "souls_eval",
    description:
      "Compare a soul with a thread that has no soul, on the same prompt and the same project model. Omit run to print the prompt and a persona grade, and do not start anything. Set run only when the user asked to spend the runs. against adds other souls. baseline includes the no-soul arm (default true). Returns thread ids and does not wait.",
    presentation: {
      label: { pending: "Comparing soul", completed: "Compared soul" },
    },
    parameters: z.object({
      idOrName: z
        .string()
        .min(1)
        .optional()
        .describe("Soul id, name, or slug. Omit, and do not set run, to grade every soul in one line."),
      run: z
        .boolean()
        .default(false)
        .describe("Start the threads. Only when the user asked for the comparison to run."),
      prompt: z
        .string()
        .max(8000)
        .optional()
        .describe("The task every arm gets. Omit to use a prompt taken from the soul's job and first never."),
      against: z
        .array(z.string().min(1))
        .max(3)
        .default([])
        .describe("Other souls to run on the same prompt."),
      baseline: z
        .boolean()
        .default(true)
        .describe("Also run a thread with no soul."),
      projectId: z
        .string()
        .min(1)
        .optional()
        .describe("Project the threads run in. Defaults to this thread's project."),
    }),
    async execute({ idOrName, run, prompt, against, baseline, projectId }, ctx) {
      if (idOrName === undefined) {
        if (run) return "Name the soul to compare.";
        const souls = store.list();
        if (souls.length === 0) return "No souls yet.";
        return [
          souls.map((soul) => formatSoulEvalLine(soul, evalSoul(soul))).join("\n"),
          ``,
          `Name a soul and set run true to compare it with no soul. Do that only when the user asked.`,
        ].join("\n");
      }
      const soul = store.find(idOrName);
      if (soul === null) return `No soul matches "${idOrName}".`;
      if (!run) return formatEvalPlan(soul, evalSoul(soul));
      const others = resolveAgainst(soul, against);
      if (typeof others === "string") return others;
      const project = await resolveProjectId(projectId, ctx.projectId, ctx.threadId);
      if (project === null) return "Pass projectId, or run this inside a project.";
      const started = await startEvalRun({
        primary: soul,
        against: others,
        baseline,
        prompt: prompt ?? comparisonPrompt(soul),
        projectId: project,
      });
      if (typeof started === "string") return started;
      const note = personaFootnote(soul);
      const pin =
        soul.model === null
          ? null
          : "The model pin is not applied. Every arm uses the project's model.";
      return [formatEvalRun(started), note, pin].filter((line) => line !== null).join("\n");
    },
  });

  /**
   * The card every agent-made change to a soul ends on: the user approves it,
   * asks for changes, or dismisses it, and nothing is written before. Edits
   * reach every thread running the soul, so an agent never saves one directly.
   */
  async function reviewSoul(input: {
    threadId: string;
    signal?: AbortSignal;
    /** The soul as it would be saved. */
    draft: SoulDraftValue;
    /** The soul this changes, or null for a new one. */
    existing: Soul | null;
    summary: string;
    openQuestions: readonly string[];
    /** Writes the approved soul. */
    save: () => Soul;
  }): Promise<string> {
    const { draft, existing } = input;
    // Ticked as they are, so approving an edit never quietly drops consent.
    const runsHere = existing !== null && store.soulForThread(input.threadId)?.id === existing.id;
    const result = await bb.ui.requestInput(
      {
        threadId: input.threadId,
        rendererId: "soul-review",
        title: existing === null ? `New soul: ${draft.name}` : `Update soul: ${existing.name}`,
        payload: {
          draft,
          summary: input.summary,
          openQuestions: [...input.openQuestions],
          existing: existing === null ? null : toSummary(existing),
          changes: existing === null ? [] : changedFields(soulDraftSchema.parse(existing), draft),
          runsHere,
          allowDelegation: runsHere && store.delegationForThread(input.threadId),
        },
        timeoutMs: 45 * 60_000,
        describeSubmission(value) {
          const decision = reviewSubmitSchema.safeParse(value);
          if (!decision.success) return { title: "Soul review closed" };
          if (decision.data.action === "revise")
            return {
              title: `Soul review: changes requested for ${draft.name}`,
              detail: decision.data.notes.slice(0, 600),
            };
          return {
            title: existing === null ? `Soul approved: ${draft.name}` : `Changes approved: ${draft.name}`,
            detail: decision.data.selectHere
              ? `Saved and bound to this thread. Delegation consent: ${decision.data.allowDelegation ? "granted for this thread only" : "not granted"}.`
              : "Saved.",
          };
        },
      },
      { signal: input.signal },
    );

    if (result.outcome === "cancelled")
      return existing === null
        ? `The user dismissed the soul review (${result.reason}). Nothing was saved. Ask what they would rather do instead of proposing again straight away.`
        : `The user dismissed the changes to ${existing.name} (${result.reason}). Nothing was changed. Ask what they would rather do instead of proposing again straight away.`;

    const decision = reviewSubmitSchema.safeParse(result.value);
    if (!decision.success)
      return `The review card returned an unexpected answer; nothing was saved. Ask the user what they want to do.`;

    if (decision.data.action === "revise")
      return [
        `The user asked for changes to the "${draft.name}" soul. Nothing was saved yet.`,
        ``,
        `Their notes:`,
        decision.data.notes,
        ``,
        `Rework the draft with these notes and put it in front of them again (souls_propose, or souls_update for a small change). Ask a follow-up question first if a note is ambiguous.`,
      ].join("\n");

    let saved: Soul;
    try {
      saved = input.save();
    } catch (cause) {
      return cause instanceof SoulNameTaken
        ? `Approved, but not saved: ${cause.message}`
        : `Approved, but not saved: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    changed();
    const bound = decision.data.selectHere
      ? store.select(input.threadId, saved.id, decision.data.allowDelegation)
      : null;
    changed();
    return [
      existing === null
        ? `Saved the new soul ${saved.emoji} ${saved.name} (${saved.id}).`
        : `Saved the changes to ${saved.emoji} ${saved.name} (${saved.id}). Threads running as this soul load them the next time they call souls_get: at the start of their next session, or after their context is compacted.`,
      bound === null
        ? `It is not bound to this thread; the user can pick it from the composer's + menu (Choose a soul…), or you can call souls_select.`
        : `This thread now runs as ${saved.name}. Adopt the persona below immediately — a live agent session keeps the instructions it started with — and start your next reply with this line on its own so the user sees the persona load:\n${soulDirective(saved.id)}`,
      ``,
      renderSoulPersona(saved, bound !== null && store.delegationForThread(input.threadId)),
    ].join("\n");
  }

  bb.agents.registerTool({
    name: "souls_propose",
    description:
      "Put a drafted soul in front of the user as a review card and wait for their decision. Approve saves it (and can bind it to this thread); revise returns their notes so you can improve the draft and propose again. This is the only supported way to create a soul.",
    presentation: {
      label: {
        pending: "Waiting for the soul review",
        completed: "Soul review answered",
      },
    },
    parameters: z.object({
      draft: soulDraftSchema.describe(
        "The complete soul: name, tagline, emoji, role, personality, expertise, principles, boundaries, model, and optionally look (pinned pixel-art portrait traits; null lets the emoji and seed decide).",
      ),
      summary: z
        .string()
        .max(800)
        .default("")
        .describe(
          "Two or three sentences on the card explaining why you chose this shape, and what you inferred rather than heard.",
        ),
      openQuestions: z
        .array(z.string().max(200))
        .max(4)
        .default([])
        .describe(
          "Anything still unresolved the user should settle later. Shown on the card.",
        ),
      existingId: z
        .string()
        .nullable()
        .default(null)
        .describe(
          "Set to a soul id to propose changes to that soul instead of creating a new one.",
        ),
    }),
    async execute({ draft, summary, openQuestions, existingId }, ctx) {
      const parsed = soulDraftSchema.safeParse(draft);
      if (!parsed.success)
        return {
          content: [
            {
              type: "text",
              text: `The draft is not a valid soul: ${parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")}`,
            },
          ],
          isError: true,
        };
      const filling =
        existingId === null ? null : store.find(existingId);
      if (existingId !== null && filling === null)
        return `No soul with id ${existingId}; propose it as a new soul instead (existingId: null).`;
      // A proposed change without a look keeps the soul's face.
      const next: SoulDraftValue =
        filling === null ? parsed.data : { ...parsed.data, look: parsed.data.look ?? filling.look };
      return reviewSoul({
        threadId: ctx.threadId,
        signal: ctx.signal,
        draft: next,
        existing: filling,
        summary,
        openQuestions,
        save: () =>
          filling === null
            ? store.insert(next, "interview")
            : (store.update(filling.id, next) ?? store.insert(next, "interview")),
      });
    },
  });

  bb.agents.registerTool({
    name: "souls_update",
    description:
      "Change specific fields of an existing soul the user asked you to tweak (a name, the voice, one principle, a model preference). The user sees the change on a review card and approves, revises or dismisses it; nothing changes before they approve. An approved change reaches every thread running the soul.",
    presentation: {
      label: { pending: "Waiting for the soul review", completed: "Soul review answered" },
    },
    parameters: z.object({
      idOrName: z.string().min(1),
      patch: soulPatchSchema.describe(
        "Only the fields to change; lists replace the whole list.",
      ),
      summary: z
        .string()
        .max(800)
        .default("")
        .describe("One or two sentences on the card saying why, in the user's words where you can."),
    }),
    async execute({ idOrName, patch, summary }, ctx) {
      const soul = store.find(idOrName);
      if (soul === null) return `No soul matches "${idOrName}".`;
      const parsed = soulDraftSchema.safeParse({ ...soulDraftSchema.parse(soul), ...patch });
      if (!parsed.success)
        return {
          content: [{ type: "text", text: `That change does not make a valid soul: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` }],
          isError: true,
        };
      const name = parsed.data.name.trim().toLowerCase();
      if (store.list().some((other) => other.id !== soul.id && other.name.toLowerCase() === name))
        return { content: [{ type: "text", text: new SoulNameTaken(parsed.data.name.trim()).message }], isError: true };
      if (changedFields(soulDraftSchema.parse(soul), parsed.data).length === 0)
        return `Nothing to change: ${soul.name} already reads that way.`;
      return reviewSoul({
        threadId: ctx.threadId,
        signal: ctx.signal,
        draft: parsed.data,
        existing: soul,
        summary,
        openQuestions: [],
        save: () => {
          const next = store.update(soul.id, patch);
          if (next === null) throw new Error(`${soul.name} was deleted before the change was approved.`);
          return next;
        },
      });
    },
  });

  bb.agents.registerTool({
    name: "souls_delete",
    description:
      "Delete a soul. The user confirms on a card first; deleting it also unbinds it from every thread.",
    presentation: {
      label: { pending: "Waiting to confirm the delete", completed: "Delete answered" },
    },
    parameters: z.object({ idOrName: z.string().min(1) }),
    async execute({ idOrName }, ctx) {
      const soul = store.find(idOrName);
      if (soul === null) return `No soul matches "${idOrName}".`;
      const threads = store.selections().filter((row) => row.soul.id === soul.id).length;
      const result = await bb.ui.requestInput(
        {
          threadId: ctx.threadId,
          rendererId: "soul-delete",
          title: `Delete soul: ${soul.name}`,
          payload: { soul: toSummary(soul), threads },
          timeoutMs: 15 * 60_000,
          describeSubmission: () => ({ title: `Soul deleted: ${soul.name}` }),
        },
        { signal: ctx.signal },
      );
      if (result.outcome === "cancelled")
        return `The user kept ${soul.emoji} ${soul.name} (${result.reason}). Nothing was deleted.`;
      if (!deleteSubmitSchema.safeParse(result.value).success)
        return `The confirmation returned an unexpected answer; nothing was deleted.`;
      if (!store.remove(soul.id)) return `${soul.name} was already deleted.`;
      changed();
      return `Deleted ${soul.emoji} ${soul.name} (${soul.id}) and unbound it from every thread.`;
    },
  });

  bb.agents.registerTool({
    name: "souls_select",
    description:
      "Bind a soul to this thread so its persona is injected into the thread's instructions. Pass threadId only for a child this thread spawned that has not started its first turn; any other thread's soul is its user's choice. To bind a child you are about to spawn, call souls_arm_child instead.",
    presentation: {
      label: { pending: "Choosing a thread's soul", completed: "Chose a thread's soul" },
    },
    parameters: z.object({
      soulId: z
        .string()
        .min(1)
        .nullable()
        .describe("Soul id or name, or null to clear the thread's soul."),
      threadId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A child this thread spawned. Defaults to this thread.",
        ),
    }),
    async execute({ soulId, threadId }, ctx) {
      const targetId = threadId ?? ctx.threadId;
      const here = targetId === ctx.threadId;
      if (!(await mayBind(ctx.threadId, targetId)))
        return {
          content: [{
            type: "text",
            text: `${targetId} is not this thread or a child it spawned, so its soul is not yours to change. The user can pick one from that thread's + menu (Choose a soul…).`,
          }],
          isError: true,
        };
      if (soulId === null) {
        store.select(targetId, null);
        changed();
        return here
          ? `This thread no longer runs as a soul. Drop the persona and continue as yourself.`
          : `${targetId} no longer runs as a soul. Its next session is constructed without one.`;
      }
      const soul = store.select(targetId, soulId);
      if (soul === null) return `No soul matches "${soulId}".`;
      changed();
      if (!here) {
        return [
          `${targetId} will run as ${soul.emoji} ${soul.name} when its agent session is next constructed.`,
          `A session that has already started keeps its current instructions until then.`,
        ].join("\n");
      }
      return [
        `This thread now runs as ${soul.emoji} ${soul.name}.`,
        `Adopt the persona below immediately: a live agent session keeps the instructions it was constructed with. Start your next reply with this line on its own so the user sees the persona load:`,
        soulDirective(soul.id),
        ``,
        renderSoulPersona(soul, store.delegationForThread(targetId)),
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "souls_arm_child",
    description:
      "Arm the next child this thread spawns to run as a soul. Call it immediately before `bb thread spawn --parent-self` when a soul fits that child's job, then spawn. Skip it when no soul fits. One arm binds one child, before that child's first session. Arm again for the next child.",
    presentation: {
      label: { pending: "Arming the next child", completed: "Armed the next child" },
    },
    parameters: z.object({
      soulId: z
        .string()
        .min(1)
        .describe("Soul id or name the next child should run as."),
    }),
    execute({ soulId }, ctx) {
      try {
        const soul = store.armChild(ctx.threadId, soulId);
        if (soul === null) return `No soul matches "${soulId}".`;
        changed();
        return [
          `The next child this thread spawns will run as ${soul.emoji} ${soul.name}.`,
          `Spawn it now with bb thread spawn --parent-self, before you spawn anything else.`,
          `The persona is bound before that child's first session. One arm covers one child and expires after five minutes.`,
        ].join("\n");
      } catch (cause) {
        if (cause instanceof ChildSoulQueueFull) return cause.message;
        throw cause;
      }
    },
  });

  // --- new threads: bind the soul chosen on the compose screen -------------

  // Dispatch admission runs before anything is provisioned, so a binding made
  // here is in place when the thread's first session is constructed.
  bb.experimental_hooks.on("message.dispatch", async (context) => {
    try {
      pendingSoul(); // drops an expired intent
      // A comparison thread is bound by the runner before its message is
      // released. Claiming a parent's arm, or a compose-screen soul, onto it
      // would mix the comparison.
      if (store.isEvalThread(context.thread.id)) return { action: "proceed" as const };
      const intent = pending;
      // Only a thread a person starts in the app takes the compose-screen
      // choice. Plugin workers (a recap, say), CLI and SDK starts, and threads
      // another thread asked for also dispatch as "user", and must not take it.
      if (
        intent !== null &&
        context.attempt === "start-turn" &&
        context.initiator === "user" &&
        context.origin === "app" &&
        context.senderThreadId === null &&
        context.thread.sourceThreadId === null &&
        Date.now() - context.thread.createdAt < PENDING_TTL_MS &&
        store.soulForThread(context.thread.id) === null
      ) {
        const soul = store.select(context.thread.id, intent.soulId, intent.allowDelegation === true);
        pending = null;
        await bb.storage.kv.delete(PENDING_KEY);
        if (soul !== null) {
          changed();
          bb.log.info(
            `new thread ${context.thread.id} starts as ${soul.name}`,
          );
        }
      }
      // A parent arms a soul, then spawns. This runs before the child is
      // provisioned, so the binding is in place for its first session.
      // Retries see the binding and do not take a second arm.
      if (context.attempt === "start-turn") {
        for (const parentId of spawningThreadIds(context)) {
          const soul = store.claimChild(
            parentId,
            context.thread.id,
            context.thread.createdAt,
            Date.now(),
          );
          if (soul === null) continue;
          changed();
          bb.log.info(
            `child thread ${context.thread.id} starts as ${soul.name} (armed by ${parentId})`,
          );
          break;
        }
      }
    } catch (cause) {
      // A hook that throws FAILS THE ATTEMPT. A persona preference is never
      // worth a user's message, so this swallows everything.
      bb.log.warn(`dispatch hook failed: ${String(cause)}`);
    }
    return { action: "proceed" as const };
  });

  // --- cli -----------------------------------------------------------------

  const usage = [
    "Usage:",
    "  bb souls list [--json]",
    "  bb souls show <soul> [--json]",
    "  bb souls create <name> [--data <soul-json>] [--tagline <text>] [--role <text>]",
    "                         [--emoji <char>] [--personality <text>]",
    "                         [--expertise <a,b>] [--principles <a,b>] [--boundaries <a,b>]",
    "  bb souls update <soul> --data <patch-json>",
    "  bb souls delete <soul>",
    "  bb souls current [--thread <id>] [--json]",
    "  bb souls status [--thread <id>] [--json]",
    "  bb souls select <soul> [--thread <id>] [--now | --next-child]",
    "  bb souls unbind [--thread <id>]",
    "  bb souls eval [soul] [--json]",
    "  bb souls eval <soul> --run [--prompt <text>] [--against <soul>] [--no-baseline] [--project <id>] [--json]",
    "  bb souls eval show [id] [--json]",
    "  bb souls threads [--json]",
    "",
    "Prefer the AI-led interview: ask an agent to create a soul and it will",
    "interview you, then show a review card. <soul> is an id, name, or slug.",
  ].join("\n");

  /** Boolean flags take no value; everything else consumes the next argv. */
  const BOOLEAN_FLAGS = new Set(["json", "now", "next-child", "run", "no-baseline"]);

  /** Split `--flag value` pairs out of argv; the rest is positional. */
  function parseFlags(argv: string[]) {
    const flags = new Map<string, string>();
    const repeated = new Map<string, string[]>();
    const rest: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const arg = argv[index];
      if (arg !== undefined && arg.startsWith("--")) {
        const key = arg.slice(2);
        const next = argv[index + 1];
        if (key === "against") {
          if (next === undefined || next.startsWith("--")) {
            flags.set("against-missing", "true");
            continue;
          }
          const list = repeated.get(key) ?? [];
          list.push(next);
          repeated.set(key, list);
          index += 1;
          continue;
        }
        if (BOOLEAN_FLAGS.has(key)) {
          flags.set(key, "true");
          continue;
        }
        if (next === undefined) {
          flags.set(key, "true");
          continue;
        }
        flags.set(key, next);
        index += 1;
        continue;
      }
      rest.push(arg as string);
    }
    return { flags, rest, repeated };
  }

  function splitList(value: string | undefined): string[] {
    if (value === undefined) return [];
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }

  function formatSoul(soul: Soul): string {
    const pin = describeModelPin(soul.model);
    return [
      `${soul.emoji} ${soul.name}  ${soul.id}`,
      soul.tagline === "" ? null : `   ${soul.tagline}`,
      soul.role === "" ? null : `   job: ${soul.role}`,
      pin === null ? null : `   model: ${pin}`,
      `   updated: ${soul.updatedAt}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n");
  }

  bb.cli.register({
    name: "souls",
    summary: "Create, inspect, and apply souls — reusable agent personas",
    commands: [
      { name: "list", summary: "List souls", usage: "bb souls list [--json]" },
      { name: "status", summary: "Show selection, consent and session injection evidence", usage: "bb souls status [--thread <id>] [--json]" },
      {
        name: "show",
        summary: "Show one soul and the persona it injects",
        usage: "bb souls show <soul> [--json]",
      },
      {
        name: "create",
        summary: "Create a soul from flags or a JSON draft",
        usage: "bb souls create <name> [--data <soul-json>] [--tagline <text>]",
      },
      {
        name: "update",
        summary: "Patch a soul's fields from JSON",
        usage: "bb souls update <soul> --data <patch-json>",
      },
      {
        name: "delete",
        summary: "Delete a soul and unbind it everywhere",
        usage: "bb souls delete <soul>",
      },
      {
        name: "current",
        summary: "Show the soul a thread runs as",
        usage: "bb souls current [--thread <id>] [--json]",
      },
      {
        name: "select",
        summary:
          "Bind a soul to a thread, or arm the next child this thread spawns (--next-child)",
        usage: "bb souls select <soul> [--thread <id>] [--now | --next-child]",
      },
      {
        name: "unbind",
        summary: "Clear a thread's soul",
        usage: "bb souls unbind [--thread <id>]",
      },
      {
        name: "threads",
        summary: "List threads and the souls they run as",
        usage: "bb souls threads [--json]",
      },
      {
        name: "eval",
        summary:
          "Compare a soul with no soul on one prompt. --run starts the threads. show reads them.",
        usage:
          "bb souls eval <soul> --run [--prompt <text>] [--against <soul>] [--project <id>]",
      },
    ],
    async run(argv, ctx) {
      const { flags, rest, repeated } = parseFlags(argv);
      const json = flags.has("json");
      const [command, ...args] = rest;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const nameTaken = (cause: unknown) =>
        cause instanceof SoulNameTaken ? fail(cause.message) : null;

      // `--thread` defaults to the thread that invoked the CLI, so an agent
      // (or a shell inside a thread workspace) binds the thread it is in.
      const threadId = flags.get("thread") ?? ctx.threadId;
      if (flags.has("allow-delegation"))
        return fail("Delegation consent must be granted by the user in the soul picker or review card, not by an agent or CLI flag.");
      // Run inside a thread, this is usually that thread's agent. A soul is
      // shared by every thread that runs it, so an agent changes one only
      // through a card the user approves, and binds only its own threads.
      if (ctx.threadId !== undefined && (command === "create" || command === "update" || command === "delete"))
        return fail(
          `Inside a thread, souls change only through a card the user approves: use the souls_propose, souls_update or souls_delete tools. To change a soul yourself, use the Souls page, or run bb souls ${command} outside a thread.`,
        );
      if (
        ctx.threadId !== undefined && threadId !== undefined &&
        (command === "select" || command === "unbind") &&
        !(await mayBind(ctx.threadId, threadId))
      )
        return fail(
          `From inside a thread, bb souls ${command} changes only that thread or a child it spawned. Choose ${threadId}'s soul from its own + menu (Choose a soul…).`,
        );

      switch (command) {
        case undefined:
        case "help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const souls = store.list();
          if (json) return reply(souls.map((soul) => toSummary(soul)), "");
          return reply(
            souls.map((soul) => toSummary(soul)),
            souls.length === 0
              ? "No souls. Ask an agent to interview you about one, or run: bb souls create <name>"
              : souls.map(formatSoul).join("\n\n"),
          );
        }
        case "show": {
          const target = args[0];
          if (target === undefined) break;
          const soul = store.find(target);
          if (soul === null) return fail(`No soul matches "${target}".`);
          if (json) return reply(soul, "");
          return reply(
            soul,
            `${formatSoul(soul)}\n\n--- persona (loaded with souls_get) ---\n${renderSoulPersona(soul)}\n--- injected instructions ---\n${renderSoulInstructions(soul)}`,
          );
        }
        case "create": {
          const name = args.join(" ").trim();
          const raw = flags.get("data");
          let draft: unknown;
          if (raw !== undefined) {
            try {
              draft = JSON.parse(raw);
            } catch {
              return fail("--data needs a JSON object, e.g. --data '{\"name\":\"Ada\"}'");
            }
          } else {
            if (name === "") break;
            draft = {
              name,
              tagline: flags.get("tagline") ?? "",
              emoji: flags.get("emoji") ?? "✨",
              role: flags.get("role") ?? "",
              personality: flags.get("personality") ?? "",
              expertise: splitList(flags.get("expertise")),
              principles: splitList(flags.get("principles")),
              boundaries: splitList(flags.get("boundaries")),
              model: null,
            };
          }
          const parsed = soulDraftSchema.safeParse(draft);
          if (!parsed.success)
            return fail(
              `Invalid soul: ${parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")}`,
            );
          try {
            const soul = store.insert(parsed.data, "manual");
            changed();
            return reply(toSummary(soul), `Created ${formatSoul(soul)}`);
          } catch (cause) {
            return nameTaken(cause) ?? fail(String(cause));
          }
        }
        case "update": {
          const target = args[0];
          const raw = flags.get("data");
          if (target === undefined || raw === undefined) break;
          let patch: unknown;
          try {
            patch = JSON.parse(raw);
          } catch {
            return fail("--data needs a JSON object.");
          }
          const parsed = soulPatchSchema.safeParse(patch);
          if (!parsed.success)
            return fail(
              `Invalid patch: ${parsed.error.issues
                .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                .join("; ")}`,
            );
          try {
            const soul = store.update(target, parsed.data);
            if (soul === null) return fail(`No soul matches "${target}".`);
            changed();
            return reply(toSummary(soul), `Updated ${formatSoul(soul)}`);
          } catch (cause) {
            return nameTaken(cause) ?? fail(String(cause));
          }
        }
        case "delete": {
          const target = args[0];
          if (target === undefined) break;
          if (!store.remove(target)) return fail(`No soul matches "${target}".`);
          changed();
          return reply({ removed: target }, `Deleted ${target}.`);
        }
        case "status": {
          if (threadId === undefined) return fail("Pass --thread <id>, or run this inside a thread.");
          const state = await threadSoulState(threadId);
          return reply(state, `${threadId}: ${state.soul?.name ?? "No soul"}\n${describeSoulStatus(state)}\nDelegation consent: ${state.allowDelegation ? "granted for this thread" : "not granted"}`);
        }
        case "current": {
          if (threadId === undefined)
            return fail("Pass --thread <id>, or run this inside a thread.");
          const soul = store.soulForThread(threadId);
          if (json) return reply(soul === null ? null : soul, "");
          return reply(
            soul === null ? null : toSummary(soul),
            soul === null
              ? `${threadId} runs with no soul.`
              : `${threadId} runs as ${soul.emoji} ${soul.name} (${soul.id}).`,
          );
        }
        case "select": {
          const target = args[0];
          if (target === undefined) break;
          if (flags.has("next-child") && flags.has("now"))
            return fail("--next-child applies when the child is spawned, so --now does not apply.");
          if (threadId === undefined)
            return fail("Pass --thread <id>, or run this inside a thread.");
          if (flags.has("next-child")) {
            try {
              const soul = store.armChild(threadId, target);
              if (soul === null) return fail(`No soul matches "${target}".`);
              changed();
              return reply(
                toSummary(soul),
                `The next child ${threadId} spawns will run as ${soul.emoji} ${soul.name}. Spawn it with --parent-self before arming another. The arm expires after five minutes.`,
              );
            } catch (cause) {
              if (cause instanceof ChildSoulQueueFull) return fail(cause.message);
              throw cause;
            }
          }
          const soul = store.select(threadId, target);
          if (soul === null) return fail(`No soul matches "${target}".`);
          changed();
          let applied = "";
          if (flags.has("now")) {
            const status = await threadStatus(threadId);
            if (status !== "idle") {
              applied = ` Not released: the thread is ${status ?? "unreachable"}, so the persona applies when its session is next constructed.`;
            } else {
              try {
                await bb.sdk.threads.stop({ threadId });
                store.releaseSession(threadId);
                changed();
                applied = " Runtime released — the next turn runs as this soul.";
              } catch (cause) {
                applied = ` Could not release the runtime: ${String(cause)}`;
              }
            }
          } else {
            applied =
              " The persona is injected when the thread's agent session is next constructed; pass --now to release an idle runtime and apply it on the next turn.";
          }
          return reply(
            toSummary(soul),
            `${threadId} now runs as ${soul.emoji} ${soul.name}.${applied}`,
          );
        }
        case "unbind": {
          if (threadId === undefined)
            return fail("Pass --thread <id>, or run this inside a thread.");
          store.select(threadId, null);
          changed();
          return reply({ threadId, soul: null }, `${threadId} runs with no soul.`);
        }
        case "eval": {
          if (args[0] === "show") {
            const run =
              args[1] === undefined ? store.latestEvalRun() : store.getEvalRun(args[1]);
            if (run === null)
              return fail(args[1] === undefined ? "No comparisons yet." : `No comparison ${args[1]}.`);
            const snaps = await readEvalShow(run);
            if (json) return reply({ ...run, arms: snaps }, "");
            return reply(snaps, formatEvalShow(run, snaps));
          }
          const target = args[0];
          if (flags.has("against-missing")) return fail("--against needs a soul.");
          if (target === undefined) {
            if (flags.has("run")) return fail("Name the soul to compare.");
            const scored = store.list().map((soul) => ({
              soul,
              report: evalSoul(soul),
            }));
            if (json)
              return reply(
                scored.map(({ soul, report }) => ({
                  id: soul.id,
                  name: soul.name,
                  comparisonPrompt: comparisonPrompt(soul),
                  ...report,
                })),
                "",
              );
            return reply(
              scored,
              scored.length === 0
                ? "No souls."
                : `${scored.map(({ soul, report }) => formatSoulEvalLine(soul, report)).join("\n")}\n\nbb souls eval <soul> --run compares that soul with no soul.`,
            );
          }
          const soul = store.find(target);
          if (soul === null) return fail(`No soul matches "${target}".`);
          const report = evalSoul(soul);
          if (!flags.has("run")) {
            if (json)
              return reply(
                { id: soul.id, name: soul.name, comparisonPrompt: comparisonPrompt(soul), ...report },
                "",
              );
            return reply(report, formatEvalPlan(soul, report));
          }
          const others = resolveAgainst(soul, repeated.get("against") ?? []);
          if (typeof others === "string") return fail(others);
          const project = await resolveProjectId(
            flags.get("project"),
            ctx.projectId,
            threadId,
          );
          if (project === null)
            return fail("Pass --project <id>, or run this inside a project.");
          const started = await startEvalRun({
            primary: soul,
            against: others,
            baseline: !flags.has("no-baseline"),
            prompt: flags.get("prompt") ?? comparisonPrompt(soul),
            projectId: project,
          });
          if (typeof started === "string") return fail(started);
          const note = personaFootnote(soul);
          const pin =
            soul.model === null
              ? null
              : "The model pin is not applied. Every arm uses the project's model.";
          const text = [formatEvalRun(started), note, pin]
            .filter((line): line is string => line !== null)
            .join("\n");
          if (started.arms.every((arm) => arm.threadId === null)) {
            return { exitCode: 1, stderr: text };
          }
          if (json) return reply(started, "");
          return reply(started, text);
        }
        case "threads": {
          const selections = store.selections();
          if (json)
            return reply(
              selections.map(({ threadId: id, soul }) => ({
                threadId: id,
                soul: toSummary(soul),
              })),
              "",
            );
          return reply(
            selections.map(({ threadId: id, soul }) => ({
              threadId: id,
              soul: toSummary(soul),
            })),
            selections.length === 0
              ? "No thread runs as a soul."
              : selections
                  .map(
                    ({ threadId: id, soul }) =>
                      `${id}  ${soul.emoji} ${soul.name}`,
                  )
                  .join("\n"),
          );
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
