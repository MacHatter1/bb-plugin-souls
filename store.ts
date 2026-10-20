// bb-plugin-souls — the soul store.
//
// One SQLite table in the plugin's own database, plus a per-thread selection.
// Every read is synchronous because `bb.agents.configure` runs on the
// thread-start path and cannot await: better-sqlite3 (what
// `bb.storage.database()` returns) is sync by nature, so the whole store is.
import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { evalRunSchema, type EvalRun } from "./eval.ts";
import {
  SOUL_ID_PREFIX,
  slugify,
  soulDraftSchema,
  soulPatchSchema,
  soulSchema,
  changedFields, soulHireRecordSchema, soulTaskSchema, soulUsageSchema, soulVersionSchema,
  type Soul,
  type SoulUserSettings, type SoulHire,
  type SoulDraft,
  type SoulPatch,
  type SoulResolution,
} from "./shared.ts";

export type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type Row = { id: string; body: string };
type ThreadRow = { thread_id: string; soul_id: string; allow_delegation: number };

export class SoulNameTaken extends Error {
  constructor(name: string) {
    super(`A soul named "${name}" already exists. Pick another name, or update that soul.`);
    this.name = "SoulNameTaken";
  }
}

/** How long an armed child soul stays waiting for the spawn it was meant for. */
const CHILD_INTENT_TTL_MS = 5 * 60_000;
/**
 * A child row can be stamped a moment before the arm is recorded when the
 * clock and the spawn race. An arm still matches that child inside this window.
 */
const CHILD_INTENT_SKEW_MS = 2_000;
/** One parent arming without spawning must not queue forever. */
const CHILD_INTENT_CAP = 8;
/** How long a comparison thread stays marked as one. */
const EVAL_THREAD_TTL_MS = 24 * 60 * 60_000;

export class ChildSoulQueueFull extends Error {
  constructor() {
    super(
      `This thread already has ${CHILD_INTENT_CAP} child souls waiting. Spawn those children before arming another.`,
    );
    this.name = "ChildSoulQueueFull";
  }
}

export function createSoulStore(bb: BbPluginApi, db: Database) {
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS souls (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       name_lower TEXT NOT NULL,
       body TEXT NOT NULL,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    `CREATE UNIQUE INDEX IF NOT EXISTS souls_name_lower ON souls(name_lower)`,
    `CREATE TABLE IF NOT EXISTS thread_souls (
       thread_id TEXT PRIMARY KEY,
       soul_id TEXT NOT NULL,
       updated_at TEXT NOT NULL
     )`,
    // A parent arms a soul, then spawns. The dispatch hook claims the oldest
    // match onto that child before its first session is constructed.
    `CREATE TABLE IF NOT EXISTS child_intents (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       parent_thread_id TEXT NOT NULL,
       soul_id TEXT NOT NULL,
       created_at_ms INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS child_intents_parent ON child_intents(parent_thread_id, id)`,
    // Append-only. A comparison run, and the threads it started so the
    // dispatch hook does not bind a parent's armed child onto them.
    `CREATE TABLE IF NOT EXISTS eval_runs (
       id TEXT PRIMARY KEY,
       soul_id TEXT NOT NULL,
       created_at TEXT NOT NULL,
       body TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS eval_runs_soul ON eval_runs(soul_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS eval_threads (
       thread_id TEXT PRIMARY KEY
     )`,
    `ALTER TABLE thread_souls ADD COLUMN allow_delegation INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS soul_resolutions (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       thread_id TEXT NOT NULL,
       resolved_at INTEGER NOT NULL,
       body TEXT NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS soul_resolutions_thread ON soul_resolutions(thread_id, resolved_at, id)`,
    `CREATE TABLE IF NOT EXISTS soul_runtime_releases (
       thread_id TEXT PRIMARY KEY,
       released_at INTEGER NOT NULL
     )`,
    // Rows from before this column are 0, so the first prune clears them.
    `ALTER TABLE eval_threads ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE thread_souls ADD COLUMN allow_hiring INTEGER`,
    `ALTER TABLE thread_souls ADD COLUMN pinned_revision INTEGER`,
    `CREATE TABLE soul_versions (soul_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, changes TEXT NOT NULL, recorded_at TEXT NOT NULL, PRIMARY KEY(soul_id, revision))`,
    `CREATE TABLE soul_tasks (id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT)`,
    `CREATE UNIQUE INDEX soul_tasks_active ON soul_tasks(parent_thread_id) WHERE status = 'active'`,
    `CREATE TABLE soul_hires (soul_id TEXT PRIMARY KEY, employer_soul_id TEXT NOT NULL, task_id TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE INDEX soul_hires_task ON soul_hires(task_id)`,
    `CREATE TABLE soul_usage (soul_id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_thread_id TEXT, at TEXT NOT NULL, PRIMARY KEY(soul_id, thread_id))`,
    `CREATE TABLE soul_spawns (id TEXT PRIMARY KEY, parent_thread_id TEXT NOT NULL, task_id TEXT NOT NULL, key TEXT NOT NULL, soul_id TEXT NOT NULL, thread_id TEXT, status TEXT NOT NULL, warning TEXT NOT NULL, UNIQUE(parent_thread_id, task_id, key))`,
    `DELETE FROM soul_versions WHERE soul_id NOT IN (SELECT id FROM souls)`,
  ]);

  function parse(row: Row): Soul | null {
    try {
      const parsed = soulSchema.safeParse(JSON.parse(row.body));
      if (!parsed.success) {
        bb.log.warn(`soul ${row.id} failed validation and was skipped`);
        return null;
      }
      return parsed.data;
    } catch (cause) {
      bb.log.warn(`soul ${row.id} is unreadable: ${String(cause)}`);
      return null;
    }
  }

  function list(includeArchived = false): Soul[] {
    const rows = db
      .prepare(`SELECT id, body FROM souls ORDER BY name COLLATE NOCASE ASC`)
      .all() as Row[];
    return rows.flatMap((row) => {
      const soul = parse(row);
      return soul === null || (!includeArchived && soul.archivedAt !== null) ? [] : [soul];
    });
  }

  /**
   * Look up by id, then by exact name, then by slug — what a human types. Two
   * souls can share a slug ("Ada!" and "Ada?"); then the slug names neither.
   */
  function find(idOrName: string): Soul | null {
    const key = idOrName.trim();
    if (key === "") return null;
    const byId = db
      .prepare(`SELECT id, body FROM souls WHERE id = ?`)
      .get(key) as Row | undefined;
    if (byId !== undefined) return parse(byId);
    const lower = key.toLowerCase();
    const byName = db
      .prepare(`SELECT id, body FROM souls WHERE name_lower = ?`)
      .get(lower) as Row | undefined;
    if (byName !== undefined) return parse(byName);
    const slug = slugify(key);
    if (slug === "") return null;
    const matches = list(true).filter((soul) => slugify(soul.name) === slug);
    return matches.length === 1 ? (matches[0] as Soul) : null;
  }

  function insert(
    draft: SoulDraft,
    origin: Soul["origin"],
    consent: Partial<SoulUserSettings> = {},
    hire: SoulHire | null = null,
  ): Soul {
    const filled = soulDraftSchema.parse(draft);
    const lower = filled.name.trim().toLowerCase();
    if (lower === "") throw new Error("A soul needs a name.");
    const taken = db
      .prepare(`SELECT id FROM souls WHERE name_lower = ?`)
      .get(lower) as { id: string } | undefined;
    if (taken !== undefined) throw new SoulNameTaken(filled.name.trim());
    const now = new Date().toISOString();
    const soul = soulSchema.parse({
      ...filled,
      defaultAllowDelegation: consent.defaultAllowDelegation ?? false,
      allowHiring: consent.allowHiring ?? false,
      team: consent.team,
      hire,
      name: filled.name.trim(),
      // Pin the portrait seed the draft was previewed with (its name), so the
      // saved soul keeps the face it was approved with, even after a rename.
      look: { ...(filled.look ?? {}), seed: filled.look?.seed ?? filled.name.trim() },
      id: `${SOUL_ID_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 10)}`,
      origin,
      createdAt: now,
      updatedAt: now,
    });
    db.prepare(
      `INSERT INTO souls (id, name, name_lower, body, created_at, updated_at)
       VALUES (@id, @name, @name_lower, @body, @created_at, @updated_at)`,
    ).run({
      id: soul.id,
      name: soul.name,
      name_lower: lower,
      body: JSON.stringify(soul),
      created_at: now,
      updated_at: now,
    });
    recordVersion(soul, ["Created"]);
    return soul;
  }

  function recordVersion(soul: Soul, changes: string[]): void {
    db.prepare(`INSERT OR IGNORE INTO soul_versions (soul_id, revision, body, changes, recorded_at) VALUES (?, ?, ?, ?, ?)`)
      .run(soul.id, soul.revision, JSON.stringify(soul), JSON.stringify(changes), soul.updatedAt);
  }

  function saveSoul(current: Soul, next: Soul, changes: string[]): Soul {
    return db.transaction(() => {
      recordVersion(current, ["Initial snapshot"]);
      const saved = soulSchema.parse({ ...next, revision: current.revision + 1, updatedAt: new Date().toISOString() });
      db.prepare(`UPDATE souls SET name = ?, name_lower = ?, body = ?, updated_at = ? WHERE id = ?`)
        .run(saved.name, saved.name.toLowerCase(), JSON.stringify(saved), saved.updatedAt, saved.id);
      recordVersion(saved, changes);
      return saved;
    })();
  }

  function update(id: string, patch: SoulPatch, consent: Partial<SoulUserSettings> = {}): Soul | null {
    const current = find(id);
    if (current === null) return null;
    const clean = soulPatchSchema.parse(patch);
    const nextName = (clean.name ?? current.name).trim();
    if (nextName === "") throw new Error("A soul needs a name.");
    const lower = nextName.toLowerCase();
    if (lower !== current.name.toLowerCase()) {
      const taken = db
        .prepare(`SELECT id FROM souls WHERE name_lower = ? AND id != ?`)
        .get(lower, current.id) as { id: string } | undefined;
      if (taken !== undefined) throw new SoulNameTaken(nextName);
    }
    const next: Soul = {
      ...current,
      ...clean,
      defaultAllowDelegation: consent.defaultAllowDelegation ?? current.defaultAllowDelegation,
      allowHiring: consent.allowHiring ?? current.allowHiring,
      team: consent.team ?? current.team,
      name: nextName,
      updatedAt: new Date().toISOString(),
    };
    const changes = changedFields(soulDraftSchema.parse(current), soulDraftSchema.parse(next));
    if (current.allowHiring !== next.allowHiring || current.defaultAllowDelegation !== next.defaultAllowDelegation) changes.push("Permissions");
    if (JSON.stringify(current.team) !== JSON.stringify(next.team)) changes.push("Team settings");
    return saveSoul(current, next, changes);
  }

  function remove(id: string): boolean {
    const soul = find(id);
    if (soul === null) return false;
    db.prepare(`UPDATE thread_souls SET soul_id = '', allow_delegation = 0 WHERE soul_id = ?`).run(soul.id);
    db.prepare(`DELETE FROM child_intents WHERE soul_id = ?`).run(soul.id);
    db.prepare(`DELETE FROM soul_versions WHERE soul_id = ?`).run(soul.id);
    db.prepare(`DELETE FROM souls WHERE id = ?`).run(soul.id);
    return true;
  }

  /**
   * Remember that the next child `parentThreadId` spawns should run as `soulId`.
   * One arm binds one child. Returns null when no soul matches.
   */
  function armChild(parentThreadId: string, soulId: string): Soul | null {
    const soul = find(soulId);
    if (soul === null) return null;
    if (soul.archivedAt !== null) throw new Error(`${soul.name} is archived. Restore it before assigning a child.`);
    const now = Date.now();
    db.prepare(`DELETE FROM child_intents WHERE created_at_ms < ?`).run(
      now - CHILD_INTENT_TTL_MS,
    );
    const insert = db.transaction(() => {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM child_intents WHERE parent_thread_id = ?`,
        )
        .get(parentThreadId) as { n: number };
      if (row.n >= CHILD_INTENT_CAP) throw new ChildSoulQueueFull();
      db.prepare(
        `INSERT INTO child_intents (parent_thread_id, soul_id, created_at_ms)
         VALUES (?, ?, ?)`,
      ).run(parentThreadId, soul.id, now);
    });
    insert();
    return soul;
  }

  /**
   * Bind the oldest armed soul from `parentThreadId` onto `childThreadId`,
   * when the arm happened before that child existed and the child has no soul
   * of its own yet. A second call for the same child does not take another arm.
   */
  function claimChild(
    parentThreadId: string,
    childThreadId: string,
    childCreatedAtMs: number,
    nowMs: number,
  ): Soul | null {
    if (parentThreadId === childThreadId) return null;
    const claim = db.transaction((): Soul | null => {
      db.prepare(`DELETE FROM child_intents WHERE created_at_ms < ?`).run(
        nowMs - CHILD_INTENT_TTL_MS,
      );
      const bound = db
        .prepare(`SELECT soul_id FROM thread_souls WHERE thread_id = ?`)
        .get(childThreadId) as { soul_id: string } | undefined;
      if (bound !== undefined) return null;
      const intent = db
        .prepare(
          `SELECT id, soul_id, created_at_ms FROM child_intents
           WHERE parent_thread_id = ? AND created_at_ms <= ?
           ORDER BY id ASC
           LIMIT 1`,
        )
        .get(parentThreadId, childCreatedAtMs + CHILD_INTENT_SKEW_MS) as
        | { id: number; soul_id: string; created_at_ms: number }
        | undefined;
      if (intent === undefined) return null;
      const soul = select(childThreadId, intent.soul_id);
      if (soul !== null) recordChildUsage(soul.id, childThreadId, parentThreadId);
      db.prepare(`DELETE FROM child_intents WHERE id = ?`).run(intent.id);
      if (soul === null) {
        bb.log.warn(
          `child intent ${intent.id} names missing soul ${intent.soul_id}; dropped`,
        );
      }
      return soul;
    });
    return claim();
  }

  /** Which soul a thread runs as, or null. Also checks a side chat's source. */
  function soulForThread(threadId: string, sourceThreadId?: string | null): Soul | null {
    const row = db
      .prepare(`SELECT thread_id, soul_id FROM thread_souls WHERE thread_id = ?`)
      .get(threadId) as ThreadRow | undefined;
    const id = row?.soul_id ?? (sourceThreadId ? directThreadId(sourceThreadId) : null);
    if (id === null || id === undefined) return null;
    const current = find(id);
    if (current === null) return null;
    const pin = bindingOptions(row === undefined && sourceThreadId ? sourceThreadId : threadId).pinnedRevision;
    const snapshot = pin === null ? null : version(current.id, pin);
    return snapshot === null ? current : { ...current, ...soulDraftSchema.parse(snapshot), revision: snapshot.revision, updatedAt: snapshot.updatedAt };
  }

  function directThreadId(threadId: string): string | null {
    const row = db
      .prepare(`SELECT thread_id, soul_id FROM thread_souls WHERE thread_id = ?`)
      .get(threadId) as ThreadRow | undefined;
    return row?.soul_id ?? null;
  }

  /** When a thread was last bound to its own soul (epoch ms), or null. */
  function boundAt(threadId: string): number | null {
    const row = db
      .prepare(`SELECT updated_at FROM thread_souls WHERE thread_id = ? AND soul_id != ''`)
      .get(threadId) as { updated_at: string } | undefined;
    const at = row === undefined ? Number.NaN : Date.parse(row.updated_at);
    return Number.isNaN(at) ? null : at;
  }

  /** Consent is deliberately direct-only: a fork or child never inherits it. */
  function delegationForThread(threadId: string): boolean {
    const row = db.prepare(`SELECT allow_delegation FROM thread_souls WHERE thread_id = ?`)
      .get(threadId) as { allow_delegation: number } | undefined;
    return row?.allow_delegation === 1;
  }

  function bindingOptions(threadId: string) {
    const row = db.prepare(`SELECT allow_hiring, pinned_revision FROM thread_souls WHERE thread_id = ?`).get(threadId);
    if (row === undefined) return { hiringOverride: null, pinnedRevision: null };
    const parsed = z.object({ allow_hiring: z.number().nullable(), pinned_revision: z.number().nullable() }).parse(row);
    return { hiringOverride: parsed.allow_hiring === null ? null : parsed.allow_hiring === 1, pinnedRevision: parsed.pinned_revision };
  }

  function hiringForThread(threadId: string): boolean {
    const soul = soulForThread(threadId);
    return soul !== null && soul.archivedAt === null && (bindingOptions(threadId).hiringOverride ?? soul.allowHiring);
  }

  function select(threadId: string, soulId: string | null, allowDelegation?: boolean, options: { hiringOverride?: boolean | null; pinnedRevision?: number | null } = {}): Soul | null {
    if (soulId === null) {
      // An explicit no-soul row suppresses side-chat inheritance too.
      db.prepare(`INSERT INTO thread_souls (thread_id, soul_id, updated_at, allow_delegation)
        VALUES (?, '', ?, 0) ON CONFLICT(thread_id) DO UPDATE SET soul_id = '',
          updated_at = excluded.updated_at, allow_delegation = 0, allow_hiring = NULL, pinned_revision = NULL`)
        .run(threadId, new Date().toISOString());
      return null;
    }
    const soul = find(soulId);
    if (soul === null) return null;
    const same = directThreadId(threadId) === soul.id;
    if (soul.archivedAt !== null && !same) throw new Error(`${soul.name} is archived. Restore it before assigning it to a new thread.`);
    const previous = same ? bindingOptions(threadId) : { hiringOverride: null, pinnedRevision: null };
    const pin = options.pinnedRevision === undefined ? previous.pinnedRevision : options.pinnedRevision;
    if (pin !== null && version(soul.id, pin) === null) throw new Error(`No revision ${pin} for ${soul.name}.`);
    const hiring = options.hiringOverride === undefined ? previous.hiringOverride : options.hiringOverride;
    const consent = allowDelegation ?? (same
      ? delegationForThread(threadId)
      : soul.defaultAllowDelegation);
    db.prepare(
      `INSERT INTO thread_souls (thread_id, soul_id, updated_at, allow_delegation, allow_hiring, pinned_revision) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET soul_id = excluded.soul_id,
         updated_at = excluded.updated_at, allow_delegation = excluded.allow_delegation, allow_hiring = excluded.allow_hiring, pinned_revision = excluded.pinned_revision`,
    ).run(threadId, soul.id, new Date().toISOString(), consent ? 1 : 0, hiring === null ? null : hiring ? 1 : 0, pin);
    db.prepare(`INSERT INTO soul_usage (soul_id, thread_id, parent_thread_id, at) VALUES (?, ?, NULL, ?) ON CONFLICT(soul_id, thread_id) DO UPDATE SET at = excluded.at`)
      .run(soul.id, threadId, new Date().toISOString());
    return soulForThread(threadId);
  }

  function version(soulId: string, revision: number): Soul | null {
    const current = find(soulId);
    if (current === null) return null;
    recordVersion(current, ["Initial snapshot"]);
    const row = db.prepare(`SELECT body FROM soul_versions WHERE soul_id = ? AND revision = ?`).get(soulId, revision);
    return row === undefined ? null : soulSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body));
  }

  function restoreVersion(soulId: string, revision: number): Soul {
    const snapshot = version(soulId, revision);
    if (snapshot === null) throw new Error(`No revision ${revision} for this soul.`);
    const saved = update(soulId, soulDraftSchema.parse(snapshot));
    if (saved === null) throw new Error("This soul no longer exists.");
    return saved;
  }

  function history(soulId: string, offset = 0) {
    const current = find(soulId);
    if (current !== null) recordVersion(current, ["Initial snapshot"]);
    const versions = db.prepare(`SELECT revision, recorded_at AS recordedAt, changes FROM soul_versions WHERE soul_id = ? ORDER BY revision DESC LIMIT 51 OFFSET ?`).all(soulId, offset)
      .map((row) => { const raw = z.object({ revision: z.number(), recordedAt: z.string(), changes: z.string() }).parse(row); return soulVersionSchema.parse({ ...raw, changes: JSON.parse(raw.changes) }); });
    const hires = db.prepare(`SELECT body FROM soul_hires WHERE soul_id = ? OR employer_soul_id = ? ORDER BY rowid DESC LIMIT 51 OFFSET ?`).all(soulId, soulId, offset)
      .map((row) => soulHireRecordSchema.parse(JSON.parse(z.object({ body: z.string() }).parse(row).body)));
    const usage = db.prepare(`SELECT thread_id AS threadId, parent_thread_id AS parentThreadId, at FROM soul_usage WHERE soul_id = ? ORDER BY at DESC LIMIT 51 OFFSET ?`).all(soulId, offset).map((row) => soulUsageSchema.parse(row));
    return { versions: versions.slice(0, 50), hires: hires.slice(0, 50), usage: usage.slice(0, 50), nextOffset: Math.max(versions.length, hires.length, usage.length) > 50 ? offset + 50 : null };
  }

  function setArchived(soulId: string, archived: boolean): Soul {
    const current = find(soulId);
    if (current === null) throw new Error("This soul no longer exists.");
    if ((current.archivedAt !== null) === archived) return current;
    return saveSoul(current, { ...current, archivedAt: archived ? new Date().toISOString() : null }, [archived ? "Archived" : "Restored to library"]);
  }

  function promote(soulId: string): Soul {
    const current = find(soulId);
    if (current === null || current.hire === null) throw new Error("Only a hired soul can be promoted.");
    return saveSoul(current, { ...current, archivedAt: null, hire: { ...current.hire, lifetime: "permanent" } }, ["Promoted to permanent"]);
  }

  function activeTask(parentThreadId: string) {
    const row = db.prepare(`SELECT id, parent_thread_id AS parentThreadId, status, created_at AS createdAt, finished_at AS finishedAt FROM soul_tasks WHERE parent_thread_id = ? AND status = 'active'`).get(parentThreadId);
    return row === undefined ? null : soulTaskSchema.parse(row);
  }

  function taskForThread(parentThreadId: string) {
    const existing = activeTask(parentThreadId);
    if (existing !== null) return existing;
    const task = soulTaskSchema.parse({ id: `task_${randomUUID()}`, parentThreadId, status: "active", createdAt: new Date().toISOString(), finishedAt: null });
    db.prepare(`INSERT INTO soul_tasks VALUES (?, ?, ?, ?, NULL)`).run(task.id, parentThreadId, task.status, task.createdAt);
    return task;
  }

  function hire(draft: SoulDraft, parentThreadId: string, reason: string, lifetime: SoulHire["lifetime"]): Soul {
    return db.transaction(() => {
      const employer = soulForThread(parentThreadId);
      if (employer === null || !hiringForThread(parentThreadId)) throw new Error("Automatic hiring is not authorized for this thread.");
      const task = taskForThread(parentThreadId);
      const count = z.object({ n: z.number() }).parse(db.prepare(`SELECT count(*) AS n FROM soul_hires WHERE task_id = ?`).get(task.id)).n;
      if (employer.team.maxHiresPerTask !== null && count >= employer.team.maxHiresPerTask) throw new Error(`Hiring limit reached: ${employer.team.maxHiresPerTask} new souls for this task. Reuse a saved roster member or finish the task before starting another.`);
      const metadata: SoulHire = { employerSoulId: employer.id, employerName: employer.name, parentThreadId, taskId: task.id, reason, lifetime, createdAt: new Date().toISOString() };
      const soul = insert(draft, "hired", {}, metadata);
      db.prepare(`INSERT INTO soul_hires (soul_id, employer_soul_id, task_id, body) VALUES (?, ?, ?, ?)`)
        .run(soul.id, employer.id, task.id, JSON.stringify({ ...metadata, soulId: soul.id, soulName: soul.name }));
      return soul;
    })();
  }

  function finishTask(parentThreadId: string): Soul[] {
    return db.transaction(() => {
      const task = activeTask(parentThreadId);
      if (task === null) return [];
      const archived = list(true).filter((soul) => soul.hire?.taskId === task.id && soul.hire.lifetime === "task" && soul.archivedAt === null).map((soul) => setArchived(soul.id, true));
      db.prepare(`UPDATE soul_tasks SET status = 'finished', finished_at = ? WHERE id = ?`).run(new Date().toISOString(), task.id);
      return archived;
    })();
  }

  const spawnSchema = z.object({ id: z.string(), parentThreadId: z.string(), taskId: z.string(), key: z.string(), soulId: z.string(), threadId: z.string().nullable(), status: z.enum(["reserved", "bound", "released", "failed", "uncertain"]), warning: z.string() });
  function spawnReceipt(id: string) {
    const row = db.prepare(`SELECT id, parent_thread_id AS parentThreadId, task_id AS taskId, key, soul_id AS soulId, thread_id AS threadId, status, warning FROM soul_spawns WHERE id = ?`).get(id);
    return row === undefined ? null : spawnSchema.parse(row);
  }
  function reserveSpawn(parentThreadId: string, key: string, soulId: string) {
    return db.transaction(() => {
      const task = taskForThread(parentThreadId);
      const old = db.prepare(`SELECT id FROM soul_spawns WHERE parent_thread_id = ? AND task_id = ? AND key = ?`).get(parentThreadId, task.id, key);
      if (old !== undefined) {
        const receipt = spawnReceipt(z.object({ id: z.string() }).parse(old).id);
        if (receipt === null) throw new Error("The saved child-spawn receipt is missing.");
        if (receipt.status === "failed" && receipt.threadId === null && receipt.soulId === soulId) {
          updateSpawn(receipt.id, null, "reserved");
          return { fresh: true, receipt: { ...receipt, status: "reserved" as const, warning: "" } };
        }
        return { fresh: false, receipt };
      }
      const id = `spawn_${randomUUID()}`;
      db.prepare(`INSERT INTO soul_spawns VALUES (?, ?, ?, ?, ?, NULL, 'reserved', '')`).run(id, parentThreadId, task.id, key, soulId);
      return { fresh: true, receipt: spawnSchema.parse({ id, parentThreadId, taskId: task.id, key, soulId, threadId: null, status: "reserved", warning: "" }) };
    })();
  }
  function updateSpawn(id: string, threadId: string | null, status: z.infer<typeof spawnSchema>["status"], warning = "") {
    db.prepare(`UPDATE soul_spawns SET thread_id = ?, status = ?, warning = ? WHERE id = ?`).run(threadId, status, warning, id);
  }
  function recordChildUsage(soulId: string, threadId: string, parentThreadId: string) {
    db.prepare(`INSERT INTO soul_usage VALUES (?, ?, ?, ?) ON CONFLICT(soul_id, thread_id) DO UPDATE SET parent_thread_id = excluded.parent_thread_id`)
      .run(soulId, threadId, parentThreadId, new Date().toISOString());
  }

  /** Keep changes, not every turn: resolution is NOT proof of session injection. */
  function recordResolution(threadId: string, snapshot: SoulResolution): void {
    const previous = resolutionAt(threadId, Number.MAX_SAFE_INTEGER);
    if (previous && previous.instructionHash === snapshot.instructionHash &&
        previous.soulId === snapshot.soulId && previous.soulUpdatedAt === snapshot.soulUpdatedAt &&
        previous.providerId === snapshot.providerId) return;
    db.prepare(`INSERT INTO soul_resolutions (thread_id, resolved_at, body) VALUES (?, ?, ?)`)
      .run(threadId, snapshot.resolvedAt, JSON.stringify(snapshot));
  }

  function resolutionAt(threadId: string, at: number): SoulResolution | null {
    const row = db.prepare(`SELECT body FROM soul_resolutions
      WHERE thread_id = ? AND resolved_at < ? ORDER BY resolved_at DESC, id DESC LIMIT 1`)
      .get(threadId, at) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as SoulResolution : null;
  }

  function releaseSession(threadId: string): void {
    db.prepare(`INSERT INTO soul_runtime_releases (thread_id, released_at) VALUES (?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET released_at = excluded.released_at`)
      .run(threadId, Date.now());
  }

  function releasedAt(threadId: string): number {
    const row = db.prepare(`SELECT released_at FROM soul_runtime_releases WHERE thread_id = ?`)
      .get(threadId) as { released_at: number } | undefined;
    return row?.released_at ?? -1;
  }

  function forgetThread(threadId: string): void {
    db.prepare(`DELETE FROM thread_souls WHERE thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM soul_resolutions WHERE thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM soul_runtime_releases WHERE thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM child_intents WHERE parent_thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM eval_threads WHERE thread_id = ?`).run(threadId);
  }

  function selections(): Array<{ threadId: string; soul: Soul }> {
    const rows = db
      .prepare(`SELECT thread_id, soul_id FROM thread_souls ORDER BY updated_at DESC`)
      .all() as ThreadRow[];
    return rows.flatMap((row) => {
      const soul = find(row.soul_id);
      return soul === null ? [] : [{ threadId: row.thread_id, soul }];
    });
  }

  function readRun(row: { body: string } | undefined): EvalRun | null {
    if (row === undefined) return null;
    try {
      const parsed = evalRunSchema.safeParse(JSON.parse(row.body));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  // ponytail: keep 30 runs. Raise the limit if people compare a lot.
  function saveEvalRun(run: EvalRun): void {
    const parsed = evalRunSchema.parse(run);
    const write = db.transaction(() => {
      db.prepare(
        `INSERT INTO eval_runs (id, soul_id, created_at, body) VALUES (?, ?, ?, ?)`,
      ).run(parsed.id, parsed.soulId, parsed.createdAt, JSON.stringify(parsed));
      db.prepare(
        `DELETE FROM eval_runs WHERE id NOT IN (
           SELECT id FROM eval_runs ORDER BY created_at DESC LIMIT 30
         )`,
      ).run();
    });
    write();
  }

  function getEvalRun(id: string): EvalRun | null {
    const row = db.prepare(`SELECT body FROM eval_runs WHERE id = ?`).get(id) as
      | { body: string }
      | undefined;
    return readRun(row);
  }

  function latestEvalRun(soulId?: string): EvalRun | null {
    const row = (
      soulId === undefined
        ? db.prepare(`SELECT body FROM eval_runs ORDER BY created_at DESC LIMIT 1`).get()
        : db
            .prepare(
              `SELECT body FROM eval_runs WHERE soul_id = ? ORDER BY created_at DESC LIMIT 1`,
            )
            .get(soulId)
    ) as { body: string } | undefined;
    return readRun(row);
  }

  /**
   * A thread this plugin started for a comparison. The dispatch hook leaves it
   * alone. That matters only around its first turn, so a mark is kept a day.
   */
  function markEvalThread(threadId: string, nowMs = Date.now()): void {
    db.prepare(`DELETE FROM eval_threads WHERE created_at_ms < ?`).run(nowMs - EVAL_THREAD_TTL_MS);
    db.prepare(`INSERT OR IGNORE INTO eval_threads (thread_id, created_at_ms) VALUES (?, ?)`).run(threadId, nowMs);
  }

  function isEvalThread(threadId: string): boolean {
    const row = db
      .prepare(`SELECT thread_id FROM eval_threads WHERE thread_id = ?`)
      .get(threadId) as { thread_id: string } | undefined;
    return row !== undefined;
  }

  return {
    list,
    find,
    insert,
    update,
    remove,
    select,
    soulForThread,
    boundAt,
    delegationForThread,
    recordResolution,
    resolutionAt,
    releaseSession,
    releasedAt,
    forgetThread,
    selections,
    armChild,
    claimChild,
    saveEvalRun,
    getEvalRun,
    latestEvalRun,
    markEvalThread,
    isEvalThread,
    hiringForThread, bindingOptions, version, restoreVersion, history, setArchived, promote,
    activeTask, taskForThread, hire, finishTask, reserveSpawn, spawnReceipt, updateSpawn, recordChildUsage,
  };
}

export type SoulStore = ReturnType<typeof createSoulStore>;
