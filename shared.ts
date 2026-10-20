// bb-plugin-souls — the soul data model, shared by server.ts and app.tsx.
//
// A soul is a reusable agent persona: a name, a job, a voice, what it is good
// at, what it always does, and what it never does. The structured fields are
// the single source of truth — the text injected into a thread is rendered
// from them by `renderSoulInstructions`, so editing a soul in the UI, over RPC,
// from the CLI, or through an agent tool all change the same thing.
import { z } from "zod";
import { ACCESSORY, HAIR, HEADWEAR, PALETTE_NAMES, SPECIES, drawPortrait, type Portrait } from "./portrait.ts";

/** A soul is addressed by id, or by name/slug when a human types it. */
export const SOUL_ID_PREFIX = "soul_";

/**
 * `bb.agents.configure` instructions are cut at 4096 characters, so a thread's
 * instructions carry only a pointer to the persona; this bounds the pointer.
 */
export const INSTRUCTION_BUDGET = 3800;

/** Full imported agent prompts live in the voice field, never silently cut. */
export const PERSONALITY_MAX_LENGTH = 32_000;

/** Bounds agent parsing work; uploads and downloads also check bytes. */
export const MAX_AGENT_IMPORT_LENGTH = 128_000;
export const MAX_AGENTS_PER_IMPORT = 50;
export const AGENT_IMPORT_FORMATS = ["auto", "toml", "markdown", "json"] as const;
export type AgentImportFormat = typeof AGENT_IMPORT_FORMATS[number];

/** The chat embed an agent posts once it has loaded its persona: `::soul{id="…"}`. */
export const SOUL_DIRECTIVE = "soul";

export function soulDirective(soulId: string): string {
  return `::${SOUL_DIRECTIVE}{id="${soulId}"}`;
}

export const soulModelPinSchema = z
  .object({
    providerId: z.string().min(1).max(80).nullable(),
    model: z.string().min(1).max(200).nullable(),
    reasoningLevel: z.string().min(1).max(40).nullable(),
  })
  .strict()
  .nullable();
export type SoulModelPin = z.infer<typeof soulModelPinSchema>;

/**
 * Pinned portrait traits. Anything left out is chosen from the seed and the
 * emoji, so a soul with no look still gets a face of its own.
 */
export const soulLookSchema = z
  .object({
    species: z.enum(SPECIES).optional(),
    hair: z.enum(HAIR).optional(),
    headwear: z.enum(HEADWEAR).optional(),
    accessory: z.enum(ACCESSORY).optional(),
    palette: z.enum(PALETTE_NAMES).optional(),
    /** Rerolls every unpinned trait. Set when a soul is created. */
    seed: z.string().min(1).max(60).optional(),
  })
  .strict()
  .nullable();
export type SoulLook = z.infer<typeof soulLookSchema>;

const list = (max: number, itemMax: number) =>
  z.array(z.string().min(1).max(itemMax)).max(max);

/** Everything a person or an AI interview fills in about a soul. */
export const soulDraftSchema = z.object({
  name: z.string().min(1).max(60),
  tagline: z.string().max(160).default(""),
  emoji: z.string().min(1).max(8).default("✨"),
  /** The job: what this soul is for, in one sentence. */
  role: z.string().max(240).default(""),
  /** Voice and temperament, as prose. */
  personality: z.string().max(PERSONALITY_MAX_LENGTH).default(""),
  expertise: list(12, 60).default([]),
  /** What it always does — working style and standards. */
  principles: list(12, 200).default([]),
  /** What it never does — hard limits. */
  boundaries: list(12, 200).default([]),
  /** Optional model preference the composer applies when the soul is picked. */
  model: soulModelPinSchema.default(null),
  /** Optional pinned traits for the soul's pixel-art portrait. */
  look: soulLookSchema.default(null),
});
export type SoulDraft = z.input<typeof soulDraftSchema>;
/** A draft with every default filled in — what a form edits and a handler sees. */
export type SoulDraftValue = z.output<typeof soulDraftSchema>;

/** Starting point for the editor's "new soul" form. */
export const EMPTY_DRAFT: SoulDraftValue = {
  name: "",
  tagline: "",
  emoji: "✨",
  role: "",
  personality: "",
  expertise: [],
  principles: [],
  boundaries: [],
  model: null,
  look: null,
};

export const soulTeamSchema = z.object({
  roster: z.array(z.object({ role: z.string().trim().min(1).max(80), soulId: z.string().min(1) }).strict()).max(20).default([]),
  maxHiresPerTask: z.number().int().min(0).max(100).nullable().default(null),
  maxConcurrentChildren: z.number().int().min(0).max(50).nullable().default(null),
  handoff: z.object({
    brief: z.string().max(4000).default(""),
    deliverable: z.string().max(2000).default("Complete the assigned work and explain the result."),
    evidence: z.string().max(2000).default("Report the checks you ran and their results."),
    unresolvedQuestions: z.string().max(2000).default("List blockers, uncertainties and decisions still needed."),
  }).default(() => ({ brief: "", deliverable: "Complete the assigned work and explain the result.", evidence: "Report the checks you ran and their results.", unresolvedQuestions: "List blockers, uncertainties and decisions still needed." })),
}).strict();
export type SoulTeam = z.infer<typeof soulTeamSchema>;

export const soulHireSchema = z.object({
  employerSoulId: z.string(), employerName: z.string(), parentThreadId: z.string(),
  taskId: z.string(), reason: z.string().max(2000), lifetime: z.enum(["task", "permanent"]),
  createdAt: z.string(),
});
export type SoulHire = z.infer<typeof soulHireSchema>;

export const soulSchema = soulDraftSchema.extend({
  id: z.string().min(1),
  /** User-controlled consent for new bindings; never taken from persona drafts. */
  defaultAllowDelegation: z.boolean().default(false),
  /** User-controlled permission to create souls without a review card. */
  allowHiring: z.boolean().default(false),
  team: soulTeamSchema.default(() => soulTeamSchema.parse({})),
  hire: soulHireSchema.nullable().default(null),
  archivedAt: z.string().nullable().default(null),
  revision: z.number().int().positive().default(1),
  origin: z.enum(["interview", "manual", "hired"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Soul = z.infer<typeof soulSchema>;
export type SoulConsent = Pick<Soul, "defaultAllowDelegation" | "allowHiring">;
export type SoulUserSettings = SoulConsent & Pick<Soul, "team">;

/** A patch: only the editable fields, all optional. */
export const soulPatchSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    tagline: z.string().max(160).optional(),
    emoji: z.string().min(1).max(8).optional(),
    role: z.string().max(240).optional(),
    personality: z.string().max(PERSONALITY_MAX_LENGTH).optional(),
    expertise: list(12, 60).optional(),
    principles: list(12, 200).optional(),
    boundaries: list(12, 200).optional(),
    model: soulModelPinSchema.optional(),
    look: soulLookSchema.optional(),
  })
  .strict();
export type SoulPatch = z.infer<typeof soulPatchSchema>;

/** A draft's fields as a person reads them, in the order a soul shows them. */
export const SOUL_FIELD_LABELS: Record<keyof SoulDraftValue, string> = {
  name: "Name",
  tagline: "Tagline",
  emoji: "Emoji",
  role: "Job",
  boundaries: "Hard limits",
  principles: "Principles",
  personality: "Voice",
  expertise: "Expertise",
  model: "Model",
  look: "Look",
};

/** The labels of the fields `after` changes in `before`, for a review card. */
export function changedFields(before: SoulDraftValue, after: SoulDraftValue): string[] {
  return (Object.keys(SOUL_FIELD_LABELS) as Array<keyof SoulDraftValue>)
    .filter((field) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null))
    .map((field) => SOUL_FIELD_LABELS[field]);
}

/** What a soul looks like in a picker: everything except the long prose. */
export const soulSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  emoji: z.string(),
  role: z.string(),
  expertise: z.array(z.string()).max(12),
  origin: soulSchema.shape.origin,
  model: soulModelPinSchema,
  look: soulLookSchema.default(null),
  defaultAllowDelegation: z.boolean().default(false),
  allowHiring: z.boolean().default(false),
  archivedAt: z.string().nullable().default(null),
  revision: z.number().int().positive().default(1),
  updatedAt: z.string(),
});
export type SoulSummary = z.infer<typeof soulSummarySchema>;

export function toSummary(soul: Soul): SoulSummary {
  return {
    id: soul.id,
    name: soul.name,
    tagline: soul.tagline,
    emoji: soul.emoji,
    role: soul.role,
    expertise: [...soul.expertise],
    origin: soul.origin,
    model: soul.model,
    look: soul.look,
    defaultAllowDelegation: soul.defaultAllowDelegation,
    allowHiring: soul.allowHiring,
    archivedAt: soul.archivedAt,
    revision: soul.revision,
    updatedAt: soul.updatedAt,
  };
}

/** Anything with a portrait: a saved soul, a summary, or a draft without an id yet. */
export type PortraitSubject = { id?: string; name: string; emoji: string; look?: SoulLook };

/**
 * A soul's pixel-art portrait. A draft has no id, so it is seeded by name;
 * creating a soul pins that seed, so the face on the review card is the face
 * it keeps.
 */
export function soulPortrait(subject: PortraitSubject): Portrait {
  return drawPortrait(subject.id ?? (subject.name.trim() || "new soul"), subject.emoji, subject.look ?? null);
}

export const soulSessionSchema = z.object({
  soulId: z.string().nullable(),
  soulName: z.string().nullable(),
  soulUpdatedAt: z.string().nullable(),
  allowDelegation: z.boolean(),
  instructionHash: z.string(),
  providerId: z.string(),
  resolvedAt: z.number(),
  providerThreadId: z.string(),
});
export type SoulSession = z.infer<typeof soulSessionSchema>;
export type SoulResolution = Omit<SoulSession, "providerThreadId">;

export const threadSoulStateSchema = z.object({
  soul: soulSummarySchema.nullable(),
  allowDelegation: z.boolean(),
  allowHiring: z.boolean().default(false),
  hiringOverride: z.boolean().nullable().default(null),
  pinnedRevision: z.number().int().positive().nullable().default(null),
  status: z.enum(["none", "pending", "injected", "outdated", "unknown"]),
  session: soulSessionSchema.nullable(),
});
export type ThreadSoulState = z.infer<typeof threadSoulStateSchema>;

export const soulVersionSchema = z.object({
  revision: z.number().int().positive(), recordedAt: z.string(), changes: z.array(z.string()),
});
export const soulUsageSchema = z.object({ threadId: z.string(), parentThreadId: z.string().nullable(), at: z.string() });
export const soulHireRecordSchema = soulHireSchema.extend({ soulId: z.string(), soulName: z.string() });
export const soulHistorySchema = z.object({
  versions: z.array(soulVersionSchema), hires: z.array(soulHireRecordSchema), usage: z.array(soulUsageSchema),
  nextOffset: z.number().int().nullable(),
});
export type SoulHistory = z.infer<typeof soulHistorySchema>;
export const soulTaskSchema = z.object({ id: z.string(), parentThreadId: z.string(), status: z.enum(["active", "finished"]), createdAt: z.string(), finishedAt: z.string().nullable() });

export function renderHandoff(manager: Soul, specialist: Soul, task: string): string {
  const handoff = manager.team.handoff;
  return [
    `You are working as ${specialist.name} for ${manager.name}.`,
    `## Task\n${task}`,
    handoff.brief ? `## Working instructions\n${handoff.brief}` : "",
    `## Deliverable\n${handoff.deliverable}`,
    `## Evidence\n${handoff.evidence}`,
    `## Unresolved questions\n${handoff.unresolvedQuestions}`,
    "Preserve the user's standing instructions. Your soul does not widen tool permissions. Report your result to your parent thread.",
  ].filter(Boolean).join("\n\n");
}

export function describeSoulStatus(state: ThreadSoulState): string {
  switch (state.status) {
    case "none": return state.session === null ? "No soul selected" : "No soul in the recorded session";
    case "pending": return state.soul === null
      ? "Removal — waiting for session restart"
      : "Selected — waiting for session restart";
    case "injected": return "Injected into the recorded session";
    case "outdated": return "Changed — the recorded session has older instructions";
    case "unknown": return "Session injection unknown — restart to apply";
  }
}

/** Lowercase, dash-separated, stable-ish handle used by the CLI. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function describeModelPin(pin: SoulModelPin): string | null {
  if (pin === null) return null;
  const parts = [pin.providerId, pin.model].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  if (parts.length === 0) return null;
  return pin.reasoningLevel
    ? `${parts.join(" / ")} · ${pin.reasoningLevel}`
    : parts.join(" / ");
}

/** "You are **Name** — tagline." without doubling the tagline's own full stop. */
function introduce(soul: Soul): string {
  const tagline = soul.tagline.replace(/[\s.!?…]+$/, "");
  return `You are **${soul.name}**${tagline ? ` — ${tagline}` : ""}.`;
}

function delegationNote(allowDelegation: boolean): string {
  return allowDelegation
    ? "**User authorization** — The user has explicitly authorized this soul to spawn and coordinate BB child threads for work in this thread. This consent is not inherited by children or side chats. It does not authorize push, merge, deploy, deletion, external communications, or wider tool permissions; all other approval rules still apply."
    : "**Delegation** — Selecting a soul alone does not authorize spawning or messaging other threads. Follow explicit user authorization; otherwise ask before delegating.";
}

function hiringNote(allowHiring: boolean): string {
  return allowHiring
    ? "**Hiring authorization** — The user allows you to create and save specialist souls with `souls_hire` without a review card. Check your saved roster and `souls_list` first. New hires start with hiring and child-thread defaults off. Use `souls_spawn_child` for model selection and handoff templates when delegation is authorized. Finish tasks with `souls_finish_task` to archive temporary hires. Hiring does not authorize spawning, editing or deleting souls."
    : "**Hiring** — Automatic creation of souls is not authorized here. Use `souls_propose` for a user-approved creation. You can use existing souls for authorized child threads with `souls_arm_child`.";
}

/**
 * The whole persona an agent adopts, never cut. It is not injected: a thread's
 * instructions point at `souls_get`, which returns this.
 */
export function renderSoulPersona(soul: Soul, allowDelegation = false, allowHiring = false): string {
  const sections = [
    `## Soul: ${soul.name} ${soul.emoji}`.trimEnd(),
    `${introduce(soul)} Stay in character throughout this thread. This persona never overrides BB's rules, the user's instructions, or safety.`,
  ];
  if (soul.role) sections.push(`**Job** — ${soul.role}`);
  sections.push(delegationNote(allowDelegation));
  sections.push(hiringNote(allowHiring));
  if (soul.team.roster.length) sections.push(`**Preferred team roster**\n${soul.team.roster.map((entry) => `- ${entry.role}: ${entry.soulId}`).join("\n")}\nReuse a suitable member before hiring.`);
  sections.push(`**Team limits** — New hires per task: ${soul.team.maxHiresPerTask ?? "unlimited"}. Concurrent children: ${soul.team.maxConcurrentChildren ?? "unlimited"}.`);
  const list = (heading: string, items: readonly string[]) =>
    [heading, ...items.map((item) => `- ${item}`)].join("\n");
  if (soul.boundaries.length) sections.push(list("**Never** (hard limits)", soul.boundaries));
  if (soul.principles.length) sections.push(list("**Always**", soul.principles));
  if (soul.personality) sections.push(`**Voice and temperament**\n${soul.personality}`);
  if (soul.expertise.length) sections.push(`**Expertise**\n${soul.expertise.join(", ")}`);
  const pin = describeModelPin(soul.model);
  if (pin) sections.push(`**Preferred model** (applied by the composer or souls_spawn_child)\n${pin}`);
  return sections.join("\n\n") + "\n";
}

/**
 * What a thread's instructions carry: a pointer to the persona, not the
 * persona. BB cuts plugin instructions at 4096 characters; the pointer stays
 * small whatever the soul's size. Consent stays inline because it is a
 * permission, and must hold even if the agent never loads the persona.
 */
export function renderSoulInstructions(soul: Soul, allowDelegation = false, allowHiring = false): string {
  return [
    `## Soul active: ${soul.name} ${soul.emoji}`.trimEnd(),
    `${introduce(soul)} This persona never overrides BB's rules, the user's instructions, or safety.`,
    `**Load your persona first** — Your job, hard limits, working principles, voice and expertise are not in these instructions. Before your first reply in this thread, call the Souls plugin's \`souls_get\` tool with idOrName \`${soul.id}\` (load its schema first if your tools are deferred) and adopt everything under "--- persona ---" in its result, every hard limit included. Then start that first reply with this line on its own, so the user sees the persona load (once; not on later reloads):\n${soulDirective(soul.id)}\nStay in character from then on. Call \`souls_get\` again whenever your context has been compacted or you are unsure of the persona. If you cannot call it, tell the user the persona did not load.`,
    delegationNote(allowDelegation),
    hiringNote(allowHiring),
  ].join("\n\n") + "\n";
}

/**
 * What Souls steers back into a thread after its context is compacted: a
 * compaction summarises away the persona `souls_get` returned, while the
 * injected pointer survives. Sent agent-only, so it never shows in the chat.
 */
export function renderCompactionReminder(soul: Soul, allowDelegation = false, allowHiring = false): string {
  return [
    `[Souls] Your context was just compacted, and your persona may have been summarised away with it. This thread still runs as ${soul.name} (${soul.id}).`,
    `Re-adopt everything under "--- persona ---" below, every hard limit included, then carry on with the work in progress. This is a reminder from the Souls plugin, not a request from the user: do not answer it, and do not post the ::soul line again.`,
    ``,
    `--- persona ---`,
    renderSoulPersona(soul, allowDelegation, allowHiring),
  ].join("\n");
}

/** What an @-mentioned soul attaches to the user's message, agent-only. */
export function renderAttachedPersona(soul: Soul, allowDelegation = false, allowHiring = false): string {
  return [
    `[Souls] The user attached the persona of ${soul.name} (${soul.id}) to this message.`,
    ``,
    `--- persona ---`,
    renderSoulPersona(soul, allowDelegation, allowHiring),
  ].join("\n");
}

/** The prompt that starts an AI-led soul interview from the library page. */
export const INTERVIEW_KICKOFF = [
  "I want to create a new soul (a reusable agent persona) with the Souls plugin.",
  "",
  "Interview me about it using the `souls` skill: ask what job it is for first, then its voice, expertise, principles and hard boundaries — a few questions at a time, in your own words, and offer concrete suggestions I can just accept. When we have enough, call `souls_propose` with the full draft so I get a review card to approve, revise, or dismiss.",
  "",
  "Do not write the soul straight into storage without the review card.",
].join("\n");
