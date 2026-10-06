// The Souls library: a list you can scan, and the soul itself beside it.
// Hand-editing and the AI interview both start from here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ThreadChat, useBbContext, useBbNavigate, useRpc, useSdk, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  INTERVIEW_KICKOFF,
  describeModelPin,
  describeSoulStatus,
  type ThreadSoulState,
  type Soul,
  type SoulSummary,
} from "../shared";
import { comparisonPrompt, delegationProbePrompt, evalSoul, type EvalRun } from "../eval";
import { useSignal, useSoul, useSoulSelections, useSouls } from "../hooks/use-souls";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Chip, SoulBody, SoulPortrait } from "./soul-bits";
import { SoulEditorDialog } from "./soul-form";

function blurb(soul: SoulSummary): string {
  if (soul.tagline !== "") return soul.tagline;
  if (soul.role !== "") return soul.role;
  return "";
}

function matches(soul: SoulSummary, needle: string): boolean {
  return `${soul.name} ${soul.tagline} ${soul.role} ${soul.expertise.join(" ")}`
    .toLowerCase()
    .includes(needle);
}

function SoulCompare({
  soul,
  others,
}: {
  soul: Soul;
  others: SoulSummary[];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { projectId: routeProjectId } = useBbContext();
  const [prompt, setPrompt] = useState(() => comparisonPrompt(soul));
  const [baseline, setBaseline] = useState(true);
  const [mode, setMode] = useState<"persona" | "delegation">("persona");
  const [evidence, setEvidence] = useState<Array<{ threadId: string | null; injection: ThreadSoulState | null; childCount: number | null }>>([]);
  const [againstId, setAgainstId] = useState("");
  const [projects, setProjects] = useState<Array<{ id: string; name: string }> | null>(null);
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const report = evalSoul(soul);
  const pin = describeModelPin(soul.model);
  const projectId = routeProjectId ?? pickedProject;
  const arms = 1 + (againstId === "" ? 0 : 1) + (baseline ? 1 : 0);

  useEffect(() => {
    if (routeProjectId !== null) return;
    let cancelled = false;
    sdk.projects.list().then(
      (rows) => {
        if (cancelled) return;
        const standard = rows.filter((row) => row.kind === "standard");
        const list = (standard.length > 0 ? standard : rows).map((row) => ({
          id: row.id,
          name: row.name,
        }));
        setProjects(list);
        setPickedProject(list[0]?.id ?? null);
      },
      () => {
        if (!cancelled) setProjects([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [routeProjectId, sdk]);

  useEffect(() => {
    const mine = ++ticket.current;
    rpc.call("souls_eval_latest", { soulId: soul.id }).then(
      (result) => {
        if (ticket.current === mine) setRun(result.run);
      },
      () => {
        if (ticket.current === mine) setRun(null);
      },
    );
  }, [rpc, soul.id]);

  const evidenceTicket = useRef(0);
  const checkEvidence = useCallback(async () => {
    const mine = ++evidenceTicket.current;
    if (run === null) { setEvidence([]); return; }
    try {
      const result = await rpc.call("souls_eval_show", { runId: run.id });
      if (mine === evidenceTicket.current) setEvidence(result.arms);
    } catch {
      if (mine === evidenceTicket.current) setEvidence([]);
    }
  }, [rpc, run]);
  useEffect(() => { void checkEvidence(); return () => { ++evidenceTicket.current; }; }, [checkEvidence]);
  useSignal("souls-session-changed", (payload) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    if (run?.arms.some((arm) => arm.threadId === threadId)) void checkEvidence();
  });

  const start = async () => {
    if (projectId === null || starting || arms < 2) return;
    const mine = ++ticket.current;
    setStarting(true);
    setError(null);
    try {
      const result = await rpc.call("souls_eval_run", {
        soulId: soul.id,
        prompt: prompt.trim(),
        against: againstId === "" ? [] : [againstId],
        baseline,
        projectId,
        mode,
      });
      if (ticket.current === mine) setRun(result.run);
    } catch (cause) {
      if (ticket.current === mine) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (ticket.current === mine) setStarting(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-border p-3">
      <p className="text-sm">
        Same prompt, with this soul and without it. The soul is bound before its
        first turn. Every arm uses the project's model.
      </p>
      {pin === null ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          The model pin is not applied, so the difference is the persona.
        </p>
      )}
      {report.grade === "holds" ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          Persona {report.score} · {report.grade}. The threads are the comparison.
        </p>
      )}
      <label className="mt-3 block text-xs text-muted-foreground">
        Evaluation
        <select
          aria-label="Evaluation type"
          className="ml-2 h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          value={mode}
          onChange={(event) => {
            const next = event.target.value === "delegation" ? "delegation" : "persona";
            setMode(next);
            setPrompt(next === "delegation" ? delegationProbePrompt : comparisonPrompt(soul));
          }}
        >
          <option value="persona">Persona comparison</option>
          <option value="delegation">Delegation and verification probe</option>
        </select>
      </label>
      {mode === "delegation" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Running this probe explicitly authorizes each arm to create one child thread ({arms} additional children at most). No repository edits or deployment. Expected answer: 323. Independent verification must be reviewed in the transcript; a static persona score cannot prove it.
        </p>
      ) : null}
      <Textarea
        aria-label="Comparison prompt"
        readOnly={mode === "delegation"}
        className="mt-3 min-h-24"
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={baseline}
            onCheckedChange={(value) => setBaseline(value === true)}
          />
          No soul
        </label>
        {others.length === 0 ? null : (
          <select
            aria-label="Also compare with"
            className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
            value={againstId}
            onChange={(event) => setAgainstId(event.target.value)}
          >
            <option value="">Also compare with…</option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.emoji} {other.name}
              </option>
            ))}
          </select>
        )}
        {routeProjectId !== null || projects === null || projects.length < 2 ? null : (
          <select
            aria-label="Project"
            className="h-8 max-w-48 rounded-md border border-input bg-transparent px-2 text-xs"
            value={pickedProject ?? ""}
            onChange={(event) => setPickedProject(event.target.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {projectId === null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No project to run in. Open a project, or use{" "}
          <code className="text-xs">bb souls eval {soul.name} --run --project &lt;id&gt;</code>.
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          They share that project's workspace. Ask a question, not a task that edits files.
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {arms < 2 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Keep no soul, or pick another soul. A comparison needs two arms.
        </p>
      ) : null}
      <Button
        className="mt-3"
        size="sm"
        disabled={starting || projectId === null || prompt.trim() === "" || arms < 2}
        onClick={() => void start()}
      >
        {starting ? "Starting…" : mode === "delegation" ? "Authorize and run delegation probe" : arms === 2 && baseline ? "Run soul vs no soul" : "Run comparison"}
      </Button>
      {run === null ? null : (
        <div className="mt-3 space-y-1">
          <Button variant="outline" size="sm" onClick={() => void checkEvidence()}>Check recorded evidence</Button>
          <p className="text-xs text-muted-foreground">Injection evidence and model behavior are separate. {run.mode === "delegation" ? "Pass criteria: one child, correct result (323), and independent verification command/output in the parent transcript. Not automatically graded." : "Review the replies to judge behavior; injection alone is not a passing evaluation."}</p>
        </div>
      )}
      {run === null ? null : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {run.arms.map((arm) => {
            const title = arm.kind === "none" ? "No soul" : `${arm.emoji} ${arm.label}`.trim();
            const facts = evidence.find((item) => item.threadId === arm.threadId);
            return (
              <div key={`${arm.kind}-${arm.soulId ?? "none"}`} className="min-w-0">
                <div className="mb-1 flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs font-medium">{title}</p>
                  {arm.threadId === null ? null : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => navigate.toThread(arm.threadId as string)}
                    >
                      Open
                    </Button>
                  )}
                </div>
                {arm.threadId === null ? null : (
                  <p className="mb-2 text-xs text-muted-foreground" role="status">
                    {facts?.injection ? describeSoulStatus(facts.injection) : "Injection evidence not available"}
                    {run.mode === "delegation" ? ` · Recorded children: ${facts?.childCount ?? "unknown"} · Verification: review transcript` : ""}
                  </p>
                )}
                {arm.threadId === null ? (
                  <p className="text-xs text-destructive">{arm.error ?? "Did not start."}</p>
                ) : (
                  <div className="h-80 overflow-hidden rounded-lg border border-border">
                    <ThreadChat threadId={arm.threadId} variant="compact" layout="contained" />
                  </div>
                )}
                {arm.error === null || arm.threadId === null ? null : (
                  <p className="mt-1 text-xs text-muted-foreground">{arm.error}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SoulDetail({
  summary,
  soul,
  others,
  threadCount,
  confirming,
  deleting,
  onEdit,
  onAskDelete,
  onCancelDelete,
  onDelete,
  onBack,
}: {
  summary: SoulSummary;
  soul: Soul | null;
  others: SoulSummary[];
  threadCount: number;
  confirming: boolean;
  deleting: boolean;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const [compareOpen, setCompareOpen] = useState(false);
  const pin = describeModelPin(summary.model);
  const subtitle = blurb(summary);
  const loaded = soul !== null && soul.id === summary.id ? soul : null;
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-4 md:px-6 md:py-5">
      <Button
        variant="ghost"
        size="sm"
        className="mb-3 md:hidden"
        onClick={onBack}
      >
        <Icon name="ArrowLeft" className="size-4" />
        All souls
      </Button>

      <div className="flex items-start gap-3">
        <span className="shrink-0 overflow-hidden rounded-xl border border-border/70 shadow-sm">
          <SoulPortrait soul={summary} className="size-12" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold">{summary.name}</h2>
          {subtitle === "" ? null : (
            <p className="text-sm text-muted-foreground">{subtitle}</p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Chip>
          {summary.origin === "interview" ? "AI-interviewed" : "hand-made"}
        </Chip>
        {pin === null ? null : <Chip>{pin}</Chip>}
        {threadCount === 0 ? null : (
          <Chip>
            {threadCount} thread{threadCount === 1 ? "" : "s"}
          </Chip>
        )}
      </div>

      {confirming ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
          <p className="min-w-0 flex-1 text-sm">
            Delete {summary.name}?
            {threadCount === 0
              ? ""
              : ` ${threadCount} thread${threadCount === 1 ? "" : "s"} will run with no soul.`}
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={onCancelDelete}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={onDelete}
          >
            {deleting ? "Deleting…" : "Delete"}
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Icon name="Edit" className="size-3.5" />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onAskDelete}
          >
            <Icon name="Trash2" className="size-3.5" />
            Delete
          </Button>
          {loaded === null ? null : (
            <Button
              variant="outline"
              size="sm"
              aria-pressed={compareOpen}
              onClick={() => setCompareOpen((open) => !open)}
            >
              Compare
            </Button>
          )}
        </div>
      )}

      {compareOpen && loaded !== null ? (
        <SoulCompare key={loaded.id} soul={loaded} others={others} />
      ) : null}

      <div className="mt-5 space-y-3 border-t border-border pt-5">
        {loaded === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <SoulBody
            soul={{
              ...loaded,
              tagline: "",
              role: loaded.tagline === "" ? "" : loaded.role,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** `subPath` is a soul id: `/plugins/souls/souls/<id>` opens that soul. */
export function SoulsPage({ subPath = "" }: Partial<PluginNavPanelProps>) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { souls, error, refetch } = useSouls();
  const threadCounts = useSoulSelections();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(subPath === "" ? null : subPath);
  const [reading, setReading] = useState(false);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // A deep link from a chat card or the composer banner selects its soul.
  useEffect(() => {
    if (subPath === "") return;
    setPickedId(subPath);
    setQuery("");
  }, [subPath]);

  const visible = useMemo(() => {
    const all = souls ?? [];
    const needle = query.trim().toLowerCase();
    if (needle === "") return all;
    return all.filter((soul) => matches(soul, needle));
  }, [souls, query]);

  const activeId =
    visible.find((soul) => soul.id === pickedId)?.id ?? visible[0]?.id ?? null;
  const active = visible.find((soul) => soul.id === activeId) ?? null;
  const activeSoul = useSoul(activeId);

  const interview = () =>
    navigate.toCompose({ initialPrompt: INTERVIEW_KICKOFF, focusPrompt: true });

  const remove = async (soul: SoulSummary) => {
    if (deleting) return;
    setDeleting(true);
    try {
      await rpc.call("souls_delete", { id: soul.id });
      toast.success(`${soul.emoji} ${soul.name} deleted`);
      setConfirmFor(null);
      setReading(false);
      if (pickedId === soul.id) setPickedId(null);
      refetch();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  };

  const editors = (
    <>
      <SoulEditorDialog
        open={creating}
        onOpenChange={setCreating}
        existing={null}
        onSaved={() => refetch()}
      />
      {editing === null || activeSoul?.id !== editing ? null : (
        <SoulEditorDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          existing={activeSoul}
          onSaved={() => refetch()}
        />
      )}
    </>
  );

  if (souls === null || souls.length === 0) {
    return (
      <div className="h-full min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto box-border w-full max-w-xl px-4 py-8 md:px-5">
          {error === null ? null : (
            <p role="alert" className="mb-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
            <p className="text-sm font-medium">
              {souls === null ? "Loading souls…" : "No souls yet"}
            </p>
            {souls === null ? null : (
              <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
                A soul is a persona you can put any thread into. Start with an
                interview, or write one by hand. You can also run{" "}
                <code className="text-xs">bb souls create &lt;name&gt;</code>.
              </p>
            )}
            {souls === null ? null : (
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Button onClick={interview}>
                  <Icon name="MessageCirclePlus" className="size-4" />
                  Interview me
                </Button>
                <Button variant="outline" onClick={() => setCreating(true)}>
                  <Icon name="Plus" className="size-4" />
                  Write one by hand
                </Button>
              </div>
            )}
          </div>
        </div>
        {editors}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-border px-4 py-3 md:flex-row md:items-center">
        <Input
          aria-label="Search souls"
          placeholder="Search souls"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="md:max-w-xs"
        />
        <div className="flex flex-wrap gap-2 md:ml-auto">
          <Button size="sm" onClick={interview}>
            <Icon name="MessageCirclePlus" className="size-4" />
            Interview me
          </Button>
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Icon name="Plus" className="size-4" />
            Write by hand
          </Button>
        </div>
      </div>

      {error === null ? null : (
        <p role="alert" className="shrink-0 px-4 pt-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="px-4 py-8 text-sm text-muted-foreground">
          No soul matches that search.
        </p>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <ul
            aria-label="Souls"
            className={cn(
              "min-h-0 flex-1 overflow-y-auto md:w-72 md:flex-none md:border-r md:border-border",
              reading && "hidden md:block",
            )}
          >
            {visible.map((soul) => {
              const selected = soul.id === activeId;
              const count = threadCounts.get(soul.id) ?? 0;
              const line = blurb(soul);
              return (
                <li key={soul.id}>
                  <button
                    type="button"
                    aria-current={selected ? "true" : undefined}
                    onClick={() => {
                      setPickedId(soul.id);
                      setReading(true);
                      setConfirmFor(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 border-l-2 px-3 py-2.5 text-left",
                      selected
                        ? "border-foreground bg-state-active"
                        : "border-transparent hover:bg-state-hover",
                    )}
                  >
                    <span className="shrink-0 overflow-hidden rounded-md border border-border/70">
                      <SoulPortrait soul={soul} className="size-9" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium">
                          {soul.name}
                        </span>
                        {count === 0 ? null : (
                          <span
                            className="shrink-0 text-[11px] text-muted-foreground"
                            title={`${count} thread${count === 1 ? "" : "s"}`}
                          >
                            {count}
                          </span>
                        )}
                      </span>
                      {line === "" ? null : (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                          {line}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          <section
            className={cn(
              "min-h-0 flex-1 overflow-y-auto",
              !reading && "hidden md:block",
            )}
          >
            {active === null ? null : (
              <SoulDetail
                summary={active}
                soul={activeSoul}
                others={(souls ?? []).filter((soul) => soul.id !== active.id)}
                threadCount={threadCounts.get(active.id) ?? 0}
                confirming={confirmFor === active.id}
                deleting={deleting}
                onEdit={() => setEditing(active.id)}
                onAskDelete={() => setConfirmFor(active.id)}
                onCancelDelete={() => setConfirmFor(null)}
                onDelete={() => void remove(active)}
                onBack={() => setReading(false)}
              />
            )}
          </section>
        </div>
      )}

      {editors}
    </div>
  );
}

/** The title-bar button on the Souls page. */
export function SoulsPageHeader() {
  const navigate = useBbNavigate();
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={() =>
        navigate.toCompose({ initialPrompt: INTERVIEW_KICKOFF, focusPrompt: true })
      }
    >
      <Icon name="MessageCirclePlus" className="size-4" />
      New soul
    </Button>
  );
}
