import { useEffect, useRef, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  changedFields,
  SOUL_FIELD_LABELS,
  soulDraftSchema,
  type Soul,
  type SoulTeam,
  type SoulHistory,
  type SoulDraftValue,
} from "../shared";
import { useSignal, useSouls } from "../hooks/use-souls";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { Field, SoulPortrait } from "./soul-bits";

const HANDOFF_FIELDS = [
  { key: "brief", label: "Briefing", rows: 3, max: 4000 },
  { key: "deliverable", label: "Expected deliverable", rows: 2, max: 2000 },
  { key: "evidence", label: "Required evidence", rows: 2, max: 2000 },
  {
    key: "unresolvedQuestions",
    label: "Questions to report",
    rows: 2,
    max: 2000,
  },
] as const;

function versionFieldText(value: SoulDraftValue[keyof SoulDraftValue]): string {
  if (value === null) return "Not specified";
  if (typeof value === "string") return value || "Not specified";
  if (Array.isArray(value)) return value.join("\n") || "None";
  return JSON.stringify(value, null, 2);
}

export function SoulTeamControls({
  value,
  onChange,
  disabled = false,
  soulId,
}: {
  value: SoulTeam;
  onChange: (next: SoulTeam) => void;
  disabled?: boolean;
  soulId?: string;
}) {
  const { souls, error } = useSouls();
  const patch = (next: Partial<SoulTeam>) => onChange({ ...value, ...next });
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-sm font-semibold">Preferred specialists</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Reuse souls from your library before hiring someone new.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            Could not load the roster library: {error}
          </p>
        ) : null}
        {value.roster.map((entry, index) => (
          <div
            key={index}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 rounded-lg border border-border p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
          >
            <Field label={`Roster role ${index + 1}`}>
              <Input
                value={entry.role}
                maxLength={80}
                disabled={disabled}
                placeholder="Reviewer"
                onChange={(event) =>
                  patch({
                    roster: value.roster.map((item, i) =>
                      i === index
                        ? { ...item, role: event.target.value }
                        : item,
                    ),
                  })
                }
              />
            </Field>
            <div className="col-start-1 row-start-2 min-w-0 sm:col-start-auto sm:row-start-auto">
              <Field label={`Roster soul ${index + 1}`}>
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={entry.soulId}
                  disabled={disabled}
                  onChange={(event) =>
                    patch({
                      roster: value.roster.map((item, i) =>
                        i === index
                          ? { ...item, soulId: event.target.value }
                          : item,
                      ),
                    })
                  }
                >
                  <option value="">Choose a soul…</option>
                  {entry.soulId &&
                  !souls?.some((soul) => soul.id === entry.soulId) ? (
                    <option value={entry.soulId}>
                      Unavailable: {entry.soulId}
                    </option>
                  ) : null}
                  {souls
                    ?.filter((soul) => soul.id !== soulId)
                    .map((soul) => (
                      <option key={soul.id} value={soul.id}>
                        {soul.name}
                      </option>
                    ))}
                </select>
              </Field>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="col-start-2 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto"
              disabled={disabled}
              aria-label={`Remove roster role ${index + 1}`}
              onClick={() =>
                patch({ roster: value.roster.filter((_, i) => i !== index) })
              }
            >
              <Icon name="Trash2" />
            </Button>
          </div>
        ))}
        {value.roster.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
            No specialists yet. Add a soul and the role it should fill.
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || value.roster.length >= 20}
          onClick={() =>
            patch({ roster: [...value.roster, { role: "", soulId: "" }] })
          }
        >
          <Icon name="Plus" />
          Add preferred specialist
        </Button>
      </section>
      <section className="space-y-3 border-t border-border pt-5">
        <h3 className="text-sm font-semibold">Task limits</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="New hires per task"
            hint="Blank means unlimited. Zero disables new hires."
          >
            <Input
              type="number"
              min={0}
              max={100}
              value={value.maxHiresPerTask ?? ""}
              disabled={disabled}
              onChange={(event) =>
                patch({
                  maxHiresPerTask:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                })
              }
            />
          </Field>
          <Field
            label="Concurrent children"
            hint="Extra children wait for a slot. Blank means unlimited."
          >
            <Input
              type="number"
              min={0}
              max={50}
              value={value.maxConcurrentChildren ?? ""}
              disabled={disabled}
              onChange={(event) =>
                patch({
                  maxConcurrentChildren:
                    event.target.value === ""
                      ? null
                      : Number(event.target.value),
                })
              }
            />
          </Field>
        </div>
      </section>
      <details className="group border-t border-border pt-5">
        <summary className="flex cursor-pointer list-none items-start gap-3 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span className="flex-1">
            <span className="block text-sm font-semibold">
              Child briefing template
            </span>
            <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
              Instructions and expected results for every managed child.
            </span>
          </span>
          <Icon
            name="ChevronDown"
            className="mt-0.5 size-4 text-muted-foreground group-open:rotate-180"
          />
        </summary>
        <div className="mt-4 space-y-4">
          {HANDOFF_FIELDS.map((field) => (
            <Field key={field.key} label={field.label}>
              <Textarea
                rows={field.rows}
                maxLength={field.max}
                value={value.handoff[field.key]}
                disabled={disabled}
                onChange={(event) =>
                  patch({
                    handoff: {
                      ...value.handoff,
                      [field.key]: event.target.value,
                    },
                  })
                }
              />
            </Field>
          ))}
        </div>
      </details>
    </div>
  );
}

export function SoulTeamPanel({
  soul,
  view,
}: {
  soul: Soul;
  view: "team" | "history";
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { souls: rosterSouls } = useSouls();
  const [refresh, setRefresh] = useState(0);
  useSignal("souls-changed", () => setRefresh((value) => value + 1));
  const [history, setHistory] = useState<SoulHistory | null>(null);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Soul | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    setOffset(0);
    setSelected(null);
    setSnapshot(null);
  }, [soul.id]);
  useEffect(() => {
    if (view !== "history") return;
    let live = true;
    setHistory(null);
    setError(null);
    rpc.call("souls_history", { soulId: soul.id, offset }).then(
      (result) => {
        if (live) setHistory(result);
      },
      (cause) => {
        if (live) setError(String(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [rpc, soul.id, soul.revision, offset, refresh, view]);
  useEffect(() => {
    const ticket = ++generation.current;
    setSnapshot(null);
    if (selected === null) return;
    rpc.call("souls_version", { soulId: soul.id, revision: selected }).then(
      (result) => {
        if (generation.current === ticket) setSnapshot(result.soul);
      },
      (cause) => {
        if (generation.current === ticket) setError(String(cause));
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [rpc, soul.id, selected]);
  const run = async (action: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      toast.success(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const differences =
    snapshot === null
      ? []
      : changedFields(
          soulDraftSchema.parse(snapshot),
          soulDraftSchema.parse(soul),
        );
  const fields =
    snapshot === null
      ? []
      : Object.keys(SOUL_FIELD_LABELS)
          .map((key) => soulDraftSchema.keyof().parse(key))
          .flatMap((key) => {
            const before = snapshot[key];
            const after = soul[key];
            return JSON.stringify(before) === JSON.stringify(after)
              ? []
              : [
                  {
                    key,
                    label: SOUL_FIELD_LABELS[key],
                    before: versionFieldText(before),
                    after: versionFieldText(after),
                  },
                ];
          });
  return (
    <section className="space-y-6">
      {error ? (
        <p role="alert" className="break-words text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {soul.hire ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg bg-muted/30 p-4">
          <p className="min-w-0 flex-1 text-sm text-muted-foreground">
            Hired by{" "}
            <strong className="font-medium text-foreground">
              {soul.hire.employerName}
            </strong>
            {soul.hire.lifetime === "task" ? " for this task." : "."}
            {soul.hire.reason ? ` ${soul.hire.reason}` : ""}
          </p>
          {soul.hire.lifetime === "task" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () => rpc.call("souls_promote", { soulId: soul.id }),
                  "Soul kept permanently",
                )
              }
            >
              Keep permanently
            </Button>
          ) : null}
        </div>
      ) : null}
      {view === "team" ? (
        <>
          <section>
            <h3 className="text-sm font-semibold">
              Permissions for new threads
            </h3>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Saved defaults. Each thread can override these when choosing a
              soul.
            </p>
            <dl className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                {
                  label: "Child threads",
                  allowed: soul.defaultAllowDelegation,
                  icon: "GitBranch",
                },
                {
                  label: "Automatic hiring",
                  allowed: soul.allowHiring,
                  icon: "UserRoundPlus",
                },
              ].map((permission) => (
                <div
                  key={permission.label}
                  className="flex items-center gap-3 rounded-lg border border-border p-3"
                >
                  <Icon
                    name={permission.icon}
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <dt className="flex-1 text-sm">{permission.label}</dt>
                  <dd
                    className={cn(
                      "text-xs font-medium",
                      permission.allowed
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {permission.allowed ? "Allowed" : "Off"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Preferred specialists</h3>
            {soul.team.roster.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                No specialists saved. Edit this soul to build its team.
              </p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {soul.team.roster.map((entry) => {
                  const member = rosterSouls?.find(
                    (item) => item.id === entry.soulId,
                  );
                  return (
                    <button
                      key={`${entry.role}-${entry.soulId}`}
                      type="button"
                      className="flex min-w-0 items-center gap-3 rounded-lg border border-border p-3 text-left outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() =>
                        navigate.toPluginPanel("souls", {
                          subPath: entry.soulId,
                        })
                      }
                    >
                      {member ? (
                        <SoulPortrait
                          soul={member}
                          className="size-10 shrink-0 rounded-md"
                        />
                      ) : (
                        <Icon
                          name="UserRound"
                          className="size-10 shrink-0 text-muted-foreground"
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {member?.name ?? "Unavailable soul"}
                        </span>
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {entry.role}
                        </span>
                      </span>
                      <Icon
                        name="ChevronRight"
                        className="size-4 shrink-0 text-muted-foreground"
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
          <section>
            <h3 className="text-sm font-semibold">Task limits</h3>
            <dl className="mt-3 divide-y divide-border text-sm">
              {[
                {
                  label: "New hires per task",
                  value: soul.team.maxHiresPerTask,
                },
                {
                  label: "Concurrent child threads",
                  value: soul.team.maxConcurrentChildren,
                },
              ].map((limit) => (
                <div
                  key={limit.label}
                  className="flex justify-between gap-4 py-3"
                >
                  <dt className="text-muted-foreground">{limit.label}</dt>
                  <dd className="font-medium tabular-nums">
                    {limit.value ?? "Unlimited"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section>
            <h3 className="text-sm font-semibold">Child briefing template</h3>
            <dl className="mt-3 space-y-4">
              {HANDOFF_FIELDS.map((field) => (
                <div key={field.key}>
                  <dt className="text-xs font-medium text-muted-foreground">
                    {field.label}
                  </dt>
                  <dd className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
                    {soul.team.handoff[field.key] || "Not specified"}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      ) : (
        <>
          <section>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Persona versions</h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                Current revision {soul.revision}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Choose a version to compare. Restoring keeps current permissions
              and team settings.
            </p>
            {history === null ? (
              <p className="mt-4 text-sm text-muted-foreground" role="status">
                {error ? "History unavailable." : "Loading history…"}
              </p>
            ) : (
              <div className="mt-4 divide-y divide-border rounded-lg border border-border">
                {history.versions.map((version) => (
                  <button
                    key={version.revision}
                    type="button"
                    aria-pressed={selected === version.revision}
                    className={cn(
                      "flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors first:rounded-t-lg last:rounded-b-lg focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      selected === version.revision
                        ? "bg-state-active"
                        : "hover:bg-state-hover",
                    )}
                    onClick={() => setSelected(version.revision)}
                  >
                    <Icon
                      name="ClockArrowDown"
                      className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">
                        Revision {version.revision}
                        {version.revision === soul.revision ? (
                          <span className="ml-2 text-xs font-normal text-muted-foreground">
                            Current
                          </span>
                        ) : null}
                      </span>
                      <span className="mt-1 block break-words text-xs leading-relaxed text-muted-foreground">
                        {version.changes.join(", ") || "Saved"}
                      </span>
                    </span>
                    <time
                      dateTime={version.recordedAt}
                      className="shrink-0 text-right text-xs leading-relaxed text-muted-foreground"
                    >
                      {new Date(version.recordedAt).toLocaleDateString(
                        undefined,
                        { month: "short", day: "numeric" },
                      )}
                      <span className="block">
                        {new Date(version.recordedAt).toLocaleTimeString(
                          undefined,
                          { hour: "2-digit", minute: "2-digit" },
                        )}
                      </span>
                    </time>
                  </button>
                ))}
              </div>
            )}
            {snapshot === null ? null : (
              <div className="mt-4 space-y-3">
                <p className="text-sm font-medium">
                  {differences.length
                    ? `Changes since revision ${snapshot.revision}`
                    : "Persona text is unchanged."}
                </p>
                <div className="max-h-80 space-y-3 overflow-y-auto">
                  {fields.map((field) => (
                    <div
                      key={field.key}
                      className="rounded border border-border p-2 text-xs"
                    >
                      <strong>{field.label}</strong>
                      <div className="mt-1 grid gap-2 sm:grid-cols-2">
                        <pre className="whitespace-pre-wrap break-words">
                          Earlier: {field.before}
                        </pre>
                        <pre className="whitespace-pre-wrap break-words">
                          Current: {field.after}
                        </pre>
                      </div>
                    </div>
                  ))}
                </div>
                <Button
                  size="sm"
                  disabled={busy || differences.length === 0}
                  onClick={() =>
                    void run(
                      () =>
                        rpc.call("souls_restore_version", {
                          soulId: soul.id,
                          revision: snapshot.revision,
                        }),
                      "Persona restored as a new revision",
                    )
                  }
                >
                  Restore persona from revision {snapshot.revision}
                </Button>
              </div>
            )}
          </section>
          <details className="group border-t border-border pt-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              Hiring and thread history
              <Icon
                name="ChevronDown"
                className="size-4 text-muted-foreground group-open:rotate-180"
              />
            </summary>
            <div className="mt-3 space-y-2 text-sm text-muted-foreground">
              {history === null ? (
                <p>{error ? "History unavailable." : "Loading history…"}</p>
              ) : (
                <>
                  {history.hires.length === 0 ? (
                    <p>No hiring records.</p>
                  ) : (
                    history.hires.map((hire) => (
                      <p key={hire.soulId}>
                        <strong>{hire.employerName}</strong> hired{" "}
                        <button
                          className="underline"
                          onClick={() =>
                            navigate.toPluginPanel("souls", {
                              subPath: hire.soulId,
                            })
                          }
                        >
                          {hire.soulName}
                        </button>
                        {hire.reason ? `: ${hire.reason}` : "."}{" "}
                        <button
                          className="underline"
                          onClick={() => navigate.toThread(hire.parentThreadId)}
                        >
                          View task thread
                        </button>
                      </p>
                    ))
                  )}
                  {history.usage.length === 0 ? (
                    <p>No thread usage recorded.</p>
                  ) : (
                    history.usage.map((usage) => (
                      <div
                        key={usage.threadId}
                        className="flex flex-wrap justify-between gap-2 border-b border-border py-2"
                      >
                        <button
                          className="break-all text-left underline underline-offset-4"
                          onClick={() => navigate.toThread(usage.threadId)}
                        >
                          Open thread {usage.threadId}
                        </button>
                        <time dateTime={usage.at} className="text-xs">
                          {new Date(usage.at).toLocaleDateString()}
                        </time>
                      </div>
                    ))
                  )}
                </>
              )}
            </div>
          </details>
          {history?.nextOffset != null ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setOffset(history.nextOffset ?? 0)}
            >
              Older history
            </Button>
          ) : offset > 0 ? (
            <Button size="sm" variant="outline" onClick={() => setOffset(0)}>
              Newest history
            </Button>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
            <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">
              {soul.archivedAt === null
                ? "Archive this soul to hide it from your library and pickers."
                : "This soul is archived. Restore it to make it available again."}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    rpc.call("souls_archive", {
                      soulId: soul.id,
                      archived: soul.archivedAt === null,
                    }),
                  soul.archivedAt === null
                    ? "Soul archived"
                    : "Soul restored to library",
                )
              }
            >
              <Icon
                name={soul.archivedAt === null ? "Archive" : "ArchiveRestore"}
              />
              {soul.archivedAt === null ? "Archive soul" : "Restore to library"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
