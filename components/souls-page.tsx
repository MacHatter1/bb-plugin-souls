// The Souls library: a list you can scan, and the soul itself beside it.
// Hand-editing and the AI interview both start from here.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ThreadChat,
  useBbContext,
  useBbNavigate,
  useRpc,
  useSdk,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
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
import {
  comparisonPrompt,
  delegationProbePrompt,
  evalSoul,
  type EvalRun,
} from "../eval";
import {
  useSignal,
  useSoulResource,
  useSoulSelectionState,
  useSouls,
} from "../hooks/use-souls";
import {
  librarySelection,
  librarySouls,
  soulUpdatedLabel,
  type LibraryFilter,
  type LibrarySort,
} from "../soul-library";
import {
  LibrarySkeleton,
  PageMessage,
  SoulCreationOptions,
  SoulLibraryCard,
  SoulProfileContent,
} from "./soul-library";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SoulPortrait } from "./soul-bits";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SoulEditorDialog } from "./soul-form";
import { SoulImportDialog } from "./soul-import";

function SoulCompare({ soul, others }: { soul: Soul; others: SoulSummary[] }) {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { projectId: routeProjectId } = useBbContext();
  const [prompt, setPrompt] = useState(() => comparisonPrompt(soul));
  const [baseline, setBaseline] = useState(true);
  const [mode, setMode] = useState<"persona" | "delegation">("persona");
  const [evidence, setEvidence] = useState<
    Array<{
      threadId: string | null;
      injection: ThreadSoulState | null;
      childCount: number | null;
    }>
  >([]);
  const [againstId, setAgainstId] = useState("");
  const [projects, setProjects] = useState<Array<{
    id: string;
    name: string;
  }> | null>(null);
  const [pickedProject, setPickedProject] = useState<string | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectReload, setProjectReload] = useState(0);
  const [run, setRun] = useState<EvalRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ticket = useRef(0);
  const report = evalSoul(soul);
  const pin = describeModelPin(soul.model);
  const projectId = routeProjectId ?? pickedProject;
  const projectUnavailable =
    routeProjectId === null && (projects === null || projectError !== null);
  const arms = 1 + (againstId === "" ? 0 : 1) + (baseline ? 1 : 0);

  useEffect(() => {
    if (routeProjectId !== null) return;
    let cancelled = false;
    setProjects(null);
    setProjectError(null);
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
      (cause) => {
        if (!cancelled) {
          setProjects([]);
          setProjectError(
            cause instanceof Error ? cause.message : String(cause),
          );
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [routeProjectId, sdk, projectReload]);

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
    if (run === null) {
      setEvidence([]);
      return;
    }
    try {
      const result = await rpc.call("souls_eval_show", { runId: run.id });
      if (mine === evidenceTicket.current) setEvidence(result.arms);
    } catch {
      if (mine === evidenceTicket.current) setEvidence([]);
    }
  }, [rpc, run]);
  useEffect(() => {
    void checkEvidence();
    return () => {
      ++evidenceTicket.current;
    };
  }, [checkEvidence]);
  useSignal("souls-session-changed", (payload) => {
    const threadId = (payload as { threadId?: unknown })?.threadId;
    if (run?.arms.some((arm) => arm.threadId === threadId))
      void checkEvidence();
  });

  const start = async () => {
    if (projectId === null || projectUnavailable || starting || arms < 2)
      return;
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
          Persona {report.score} · {report.grade}. The threads are the
          comparison.
        </p>
      )}
      <label className="mt-3 block text-xs text-muted-foreground">
        Evaluation
        <select
          aria-label="Evaluation type"
          className="ml-2 h-8 rounded-md border border-input bg-transparent px-2 text-xs"
          value={mode}
          onChange={(event) => {
            const next =
              event.target.value === "delegation" ? "delegation" : "persona";
            setMode(next);
            setPrompt(
              next === "delegation"
                ? delegationProbePrompt
                : comparisonPrompt(soul),
            );
          }}
        >
          <option value="persona">Persona comparison</option>
          <option value="delegation">Delegation and verification probe</option>
        </select>
      </label>
      {mode === "delegation" ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Running this probe explicitly authorizes each arm to create one child
          thread ({arms} additional children at most). No repository edits or
          deployment. Expected answer: 323. Independent verification must be
          reviewed in the transcript; a static persona score cannot prove it.
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
        {routeProjectId !== null ||
        projects === null ||
        projects.length < 2 ? null : (
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
      {routeProjectId === null && projects === null ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Loading projects…
        </p>
      ) : routeProjectId === null && projectError !== null ? (
        <div
          role="alert"
          className="mt-3 rounded-lg border border-destructive/30 p-3"
        >
          <p className="text-xs">Couldn't load projects. {projectError}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={() => setProjectReload((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      ) : projectId === null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No project to run in. Open a project, or use{" "}
          <code className="text-xs">
            bb souls eval &lt;soul&gt; --run --project &lt;id&gt;
          </code>
          .
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted-foreground">
          They share that project's workspace. Ask a question, not a task that
          edits files.
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
        disabled={
          starting ||
          projectUnavailable ||
          projectId === null ||
          prompt.trim() === "" ||
          arms < 2
        }
        onClick={() => void start()}
      >
        {starting
          ? "Starting…"
          : mode === "delegation"
            ? "Authorize and run delegation probe"
            : arms === 2 && baseline
              ? "Run soul vs no soul"
              : "Run comparison"}
      </Button>
      {run === null ? null : (
        <div className="mt-3 space-y-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void checkEvidence()}
          >
            Check recorded evidence
          </Button>
          <p className="text-xs text-muted-foreground">
            Injection evidence and model behavior are separate.{" "}
            {run.mode === "delegation"
              ? "Pass criteria: one child, correct result (323), and independent verification command/output in the parent transcript. Not automatically graded."
              : "Review the replies to judge behavior; injection alone is not a passing evaluation."}
          </p>
        </div>
      )}
      {run === null ? null : (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {run.arms.map((arm) => {
            const title =
              arm.kind === "none"
                ? "No soul"
                : `${arm.emoji} ${arm.label}`.trim();
            const facts = evidence.find(
              (item) => item.threadId === arm.threadId,
            );
            return (
              <div
                key={`${arm.kind}-${arm.soulId ?? "none"}`}
                className="min-w-0"
              >
                <div className="mb-1 flex items-center gap-2">
                  <p className="min-w-0 flex-1 truncate text-xs font-medium">
                    {title}
                  </p>
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
                  <p
                    className="mb-2 text-xs text-muted-foreground"
                    role="status"
                  >
                    {facts?.injection
                      ? describeSoulStatus(facts.injection)
                      : "Injection evidence not available"}
                    {run.mode === "delegation"
                      ? ` · Recorded children: ${facts?.childCount ?? "unknown"} · Verification: review transcript`
                      : ""}
                  </p>
                )}
                {arm.threadId === null ? (
                  <p className="text-xs text-destructive">
                    {arm.error ?? "Did not start."}
                  </p>
                ) : (
                  <div className="h-80 overflow-hidden rounded-lg border border-border">
                    <ThreadChat
                      threadId={arm.threadId}
                      variant="compact"
                      layout="contained"
                    />
                  </div>
                )}
                {arm.error === null || arm.threadId === null ? null : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {arm.error}
                  </p>
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
  error,
  retry,
  others,
  threadCount,
  usageLoading,
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
  error: string | null;
  retry: () => void;
  others: SoulSummary[];
  threadCount: number | null;
  usageLoading: boolean;
  confirming: boolean;
  deleting: boolean;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
  onBack: () => void;
}) {
  const [compareOpen, setCompareOpen] = useState(false);
  const loaded = soul?.id === summary.id ? soul : null;
  const subject = loaded ?? summary;
  const pin = describeModelPin(subject.model);
  const updated = soulUpdatedLabel(subject.updatedAt);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border bg-background px-5 py-5 @3xl/souls:px-7">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 -ml-2 h-9 @3xl/souls:hidden"
          disabled={deleting}
          onClick={onBack}
        >
          <Icon name="ArrowLeft" />
          All souls
        </Button>
        <div className="mx-auto max-w-3xl">
          <div className="flex items-start gap-4">
            <span
              aria-hidden
              className="shrink-0 overflow-hidden rounded-xl border border-border"
            >
              <SoulPortrait
                soul={subject}
                className="size-12 @3xl/souls:size-[72px]"
              />
            </span>
            <div className="min-w-0 flex-1">
              <p className="hidden text-xs text-muted-foreground @3xl/souls:block">
                Reusable persona
              </p>
              <h2
                id="soul-profile-title"
                tabIndex={-1}
                className="mt-1 break-words text-xl font-semibold leading-tight [overflow-wrap:anywhere]"
              >
                {subject.name}
              </h2>
              {!subject.tagline ? null : (
                <p className="mt-2 break-words text-sm leading-relaxed text-muted-foreground">
                  {subject.tagline}
                </p>
              )}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
              {subject.origin === "interview" ? "Interviewed" : "Manual"}
            </span>
            {threadCount === null ? (
              <span className="text-xs text-muted-foreground">
                {usageLoading
                  ? "Loading thread usage…"
                  : "Thread usage unavailable"}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Icon name="MessageSquare" className="size-3.5" />
                {threadCount === 0
                  ? "Not selected on a thread"
                  : `Selected on ${threadCount} ${threadCount === 1 ? "thread" : "threads"}`}
              </span>
            )}
            <div className="ml-auto flex gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                disabled={loaded === null || deleting}
                onClick={onEdit}
              >
                <Icon name="Edit" />
                Edit soul
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9"
                disabled={loaded === null || deleting}
                onClick={() => setCompareOpen(true)}
              >
                Compare
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Delete ${subject.name}`}
                disabled={deleting}
                onClick={onAskDelete}
              >
                <Icon name="Trash2" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 @3xl/souls:px-7">
        <div className="mx-auto max-w-3xl space-y-7">
          {error !== null ? (
            <div
              role="alert"
              className="rounded-xl border border-destructive/30 bg-destructive/5 p-4"
            >
              <p className="text-sm font-medium">Couldn't load this persona</p>
              <p className="mt-2 break-words text-sm text-muted-foreground">
                {error}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={retry}
              >
                Try again
              </Button>
            </div>
          ) : loaded === null ? (
            <div role="status" className="space-y-5">
              <span className="sr-only">Loading persona…</span>
              <div
                aria-hidden
                className="h-20 rounded-xl bg-muted/40 motion-safe:animate-pulse"
              />
              <div
                aria-hidden
                className="h-48 rounded-xl bg-muted/40 motion-safe:animate-pulse"
              />
            </div>
          ) : (
            <SoulProfileContent soul={loaded} onEdit={onEdit} />
          )}

          {pin === null ? null : (
            <section className="rounded-xl border border-border bg-muted/20 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <Icon name="Code" className="size-4 text-muted-foreground" />
                Preferred model
              </h3>
              <p className="mt-2 break-words font-mono text-xs leading-relaxed [overflow-wrap:anywhere]">
                {pin}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                An advisory preference. Choosing this soul in the composer can
                apply it; comparisons use the project's model.
              </p>
            </section>
          )}
          <div className="flex flex-col gap-2 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
            <p>
              Choose this soul from a thread's + menu. Selection alone never
              grants delegation consent.
            </p>
            {updated === null ? null : (
              <time dateTime={subject.updatedAt}>Updated {updated}</time>
            )}
          </div>
        </div>
      </div>

      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl lg:max-w-5xl">
          <DialogHeader className="shrink-0 border-b border-border px-5 py-5 sm:px-6 sm:pr-12">
            <DialogTitle>Compare {subject.name}</DialogTitle>
            <DialogDescription>
              Review the prompt and scope before starting a comparison.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-5 pb-5 sm:px-6">
            {compareOpen && loaded !== null ? (
              <SoulCompare key={loaded.id} soul={loaded} others={others} />
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !deleting) onCancelDelete();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {subject.name}?</DialogTitle>
            <DialogDescription>
              This removes the persona from your library. It cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed">
            {threadCount === null
              ? "Thread usage is unavailable. Any threads selecting this soul will continue without it."
              : threadCount === 0
                ? "No threads currently select this soul."
                : `${threadCount} ${threadCount === 1 ? "thread currently selects" : "threads currently select"} this soul and will continue without it.`}
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={deleting}
              onClick={onCancelDelete}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={onDelete}
            >
              {deleting ? "Deleting…" : "Delete soul"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** `subPath` is a soul id. Deep links open the actual profile, including on mobile. */
export function SoulsPage({ subPath = "" }: Partial<PluginNavPanelProps>) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { souls, error, refetch } = useSouls();
  const usage = useSoulSelectionState();
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [sort, setSort] = useState<LibrarySort>("name");
  const [pickedId, setPickedId] = useState<string | null>(subPath || null);
  const [reading, setReading] = useState(subPath !== "");
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const libraryPane = useRef<HTMLElement>(null);
  const libraryList = useRef<HTMLUListElement>(null);
  const profilePane = useRef<HTMLElement>(null);
  const focusRequest = useRef<"library" | "profile" | null>(null);
  const libraryScroll = useRef<number | null>(null);

  useEffect(() => {
    if (subPath === "") {
      setReading(false);
      return;
    }
    setPickedId(subPath);
    setQuery("");
    setFilter("all");
    setReading(true);
  }, [subPath]);

  const effectiveFilter =
    filter === "in-use" && usage.counts === null ? "all" : filter;
  const visible = useMemo(
    () => librarySouls(souls ?? [], query, effectiveFilter, sort, usage.counts),
    [souls, query, effectiveFilter, sort, usage.counts],
  );
  const missingLink =
    subPath !== "" &&
    souls !== null &&
    !souls.some((soul) => soul.id === subPath);
  const active = missingLink ? null : librarySelection(visible, pickedId);
  const resource = useSoulResource(active?.id ?? null);
  useEffect(() => {
    if (
      focusRequest.current === "profile" &&
      reading &&
      libraryPane.current !== null &&
      getComputedStyle(libraryPane.current).display === "none"
    ) {
      profilePane.current
        ?.querySelector<HTMLElement>("#soul-profile-title")
        ?.focus({ preventScroll: true });
    } else if (focusRequest.current === "library" && !reading) {
      if (libraryList.current !== null && libraryScroll.current !== null)
        libraryList.current.scrollTop = libraryScroll.current;
      libraryList.current
        ?.querySelector<HTMLButtonElement>("button[aria-current='true']")
        ?.focus({ preventScroll: libraryScroll.current !== null });
    }
    focusRequest.current = null;
  }, [reading, active?.id]);
  const inUse =
    souls === null || usage.counts === null
      ? null
      : souls.filter((soul) => (usage.counts!.get(soul.id) ?? 0) > 0).length;
  const reset = () => {
    setQuery("");
    setFilter("all");
    searchInput.current?.focus();
  };
  const interview = () =>
    navigate.toCompose({ initialPrompt: INTERVIEW_KICKOFF, focusPrompt: true });
  const saved = (soul: Soul) => {
    setPickedId(soul.id);
    setQuery("");
    setFilter("all");
    setReading(true);
    refetch();
  };
  const remove = async (soul: SoulSummary) => {
    if (deleting) return;
    setDeleting(true);
    try {
      await rpc.call("souls_delete", { id: soul.id });
      toast.success(`${soul.emoji} ${soul.name} deleted`);
      setConfirmFor(null);
      setReading(false);
      if (pickedId === soul.id) setPickedId(null);
      if (subPath === soul.id)
        navigate.toPluginPanel("souls", { replace: true });
      refetch();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="@container/souls flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background">
      <header
        className={cn(
          "shrink-0 border-b border-border px-5 py-5 @3xl/souls:px-6",
          reading && "hidden @3xl/souls:block",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight">Your souls</h1>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Reusable personas for the way you work.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0"
            onClick={() => setImporting(true)}
          >
            <Icon name="ArrowUp" />
            <span>
              Import
              <span className="hidden @2xl/souls:inline"> agent file</span>
            </span>
          </Button>
        </div>
        {souls === null ? null : (
          <p className="mt-3 text-xs text-muted-foreground">
            {souls.length} {souls.length === 1 ? "soul" : "souls"}
            {inUse === null ? "" : ` · ${inUse} in use`}
          </p>
        )}
      </header>

      {error === null || souls === null ? null : (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-3 border-b border-destructive/30 bg-destructive/5 px-5 py-2 text-xs"
        >
          <Icon
            name="AlertCircle"
            className="size-4 shrink-0 text-destructive"
          />
          <p className="min-w-0 flex-1 break-words">
            Couldn't refresh your library. {error}
          </p>
          <Button size="sm" variant="ghost" onClick={refetch}>
            Retry
          </Button>
        </div>
      )}

      {souls === null ? (
        error === null ? (
          <LibrarySkeleton />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PageMessage
              icon="AlertCircle"
              title="Couldn't load your souls"
              action={
                <Button size="sm" variant="outline" onClick={refetch}>
                  Try again
                </Button>
              }
            >
              <p className="break-words">{error}</p>
            </PageMessage>
          </div>
        )
      ) : missingLink ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <PageMessage
            icon="AlertCircle"
            title="Soul not found"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigate.toPluginPanel("souls", { replace: true })
                }
              >
                Back to library
              </Button>
            }
          >
            This link doesn't point to a soul in your library. It may have been
            deleted.
          </PageMessage>
        </div>
      ) : souls.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-5 py-12 @3xl/souls:py-16">
            <div className="mx-auto mb-7 max-w-md text-center">
              <span
                aria-hidden
                className="mb-5 inline-flex rounded-xl border border-border bg-muted/30 p-4"
              >
                <Icon name="Bot" className="size-8 text-muted-foreground" />
              </span>
              <h2 className="text-xl font-semibold">Start with a soul</h2>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                Give an agent a job, a voice and a few firm boundaries. Reuse
                the persona across your threads.
              </p>
            </div>
            <SoulCreationOptions
              onInterview={interview}
              onImport={() => setImporting(true)}
              onManual={() => setCreating(true)}
            />
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] @3xl/souls:grid-cols-[19rem_minmax(0,1fr)]">
          <aside
            ref={libraryPane}
            aria-label="Soul library"
            className={cn(
              "min-h-0 min-w-0 flex-col border-border bg-muted/10 @3xl/souls:border-r",
              reading ? "hidden @3xl/souls:flex" : "flex",
            )}
          >
            <div className="shrink-0 space-y-3 border-b border-border px-4 py-4">
              <div className="relative">
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"
                >
                  <Icon name="Search" className="size-4" />
                </span>
                <Input
                  ref={searchInput}
                  aria-label="Search souls"
                  placeholder="Search name, job or expertise…"
                  className={cn("h-9 pl-9", query && "pr-9")}
                  value={query}
                  disabled={deleting}
                  onChange={(event) => setQuery(event.target.value)}
                />
                {!query ? null : (
                  <button
                    type="button"
                    aria-label="Clear search"
                    className="absolute right-1 top-1 flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => {
                      setQuery("");
                      searchInput.current?.focus();
                    }}
                  >
                    <Icon name="X" className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between gap-2">
                <div
                  aria-label="Library filters"
                  className="inline-flex gap-0.5 rounded-lg bg-muted/50 p-0.5"
                >
                  {(["all", "in-use"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={effectiveFilter === value}
                      disabled={
                        deleting ||
                        (value === "in-use" && usage.counts === null)
                      }
                      onClick={() => setFilter(value)}
                      className={cn(
                        "rounded-md px-2.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                        effectiveFilter === value
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {value === "all" ? "All souls" : "In use"}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="Sort souls"
                  className="h-8 min-w-0 max-w-32 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  value={sort}
                  disabled={deleting}
                  onChange={(event) =>
                    setSort(event.target.value as LibrarySort)
                  }
                >
                  <option value="name">Name A–Z</option>
                  <option value="recent">Recently edited</option>
                </select>
              </div>
              {usage.counts !== null ? null : (
                <p role="status" className="text-xs text-muted-foreground">
                  {usage.error === null
                    ? "Loading thread usage…"
                    : "Thread usage unavailable. Showing all souls."}
                </p>
              )}
            </div>

            {visible.length === 0 ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <PageMessage
                  title="No matching souls"
                  action={
                    <Button size="sm" variant="outline" onClick={reset}>
                      Clear filters
                    </Button>
                  }
                >
                  Try another name or expertise, or clear your filters.
                </PageMessage>
              </div>
            ) : (
              <ul
                ref={libraryList}
                aria-label="Souls"
                className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2"
              >
                {visible.map((soul) => (
                  <SoulLibraryCard
                    key={soul.id}
                    soul={soul}
                    selected={soul.id === active?.id}
                    count={
                      usage.counts === null
                        ? null
                        : (usage.counts.get(soul.id) ?? 0)
                    }
                    onSelect={() => {
                      if (deleting) return;
                      libraryScroll.current =
                        libraryList.current?.scrollTop ?? null;
                      focusRequest.current = "profile";
                      setPickedId(soul.id);
                      setReading(true);
                      setConfirmFor(null);
                    }}
                  />
                ))}
              </ul>
            )}
            <div
              role="status"
              aria-live="polite"
              className="shrink-0 border-t border-border px-4 py-3 text-xs tabular-nums text-muted-foreground"
            >
              {visible.length} of {souls.length}{" "}
              {souls.length === 1 ? "soul" : "souls"}
            </div>
          </aside>

          <section
            ref={profilePane}
            aria-label="Soul profile"
            className={cn(
              "min-h-0 min-w-0",
              reading ? "block" : "hidden @3xl/souls:block",
            )}
          >
            {active === null ? (
              <PageMessage
                icon="Bot"
                title="Your next persona is a search away"
              >
                Choose a soul from the library to read its job, voice and
                guidelines.
              </PageMessage>
            ) : (
              <SoulDetail
                key={active.id}
                summary={active}
                soul={resource.soul}
                error={resource.error}
                retry={resource.refetch}
                others={souls.filter((soul) => soul.id !== active.id)}
                threadCount={
                  usage.counts === null
                    ? null
                    : (usage.counts.get(active.id) ?? 0)
                }
                usageLoading={usage.counts === null && usage.error === null}
                confirming={confirmFor === active.id}
                deleting={deleting}
                onEdit={() => setEditing(active.id)}
                onAskDelete={() => setConfirmFor(active.id)}
                onCancelDelete={() => setConfirmFor(null)}
                onDelete={() => void remove(active)}
                onBack={() => {
                  focusRequest.current = "library";
                  setReading(false);
                }}
              />
            )}
          </section>
        </div>
      )}

      <SoulImportDialog
        open={importing}
        onOpenChange={setImporting}
        onSaved={saved}
      />
      <SoulEditorDialog
        open={creating}
        onOpenChange={setCreating}
        existing={null}
        onSaved={saved}
      />
      {editing === null || resource.soul?.id !== editing ? null : (
        <SoulEditorDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          existing={resource.soul}
          onSaved={() => refetch()}
        />
      )}
    </div>
  );
}

/** One creation entry in the host title bar; every path remains explicit. */
export function SoulsPageHeader() {
  const navigate = useBbNavigate();
  const [mode, setMode] = useState<"choose" | "manual" | "import" | null>(null);
  return (
    <>
      <Button size="sm" className="h-8" onClick={() => setMode("choose")}>
        <Icon name="Plus" />
        New soul
      </Button>
      <Dialog
        open={mode === "choose"}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create a soul</DialogTitle>
            <DialogDescription>
              Give your agent a persona it can carry across threads.
            </DialogDescription>
          </DialogHeader>
          <SoulCreationOptions
            compact
            onInterview={() => {
              setMode(null);
              navigate.toCompose({
                initialPrompt: INTERVIEW_KICKOFF,
                focusPrompt: true,
              });
            }}
            onImport={() => setMode("import")}
            onManual={() => setMode("manual")}
          />
        </DialogContent>
      </Dialog>
      <SoulEditorDialog
        open={mode === "manual"}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
        existing={null}
      />
      <SoulImportDialog
        open={mode === "import"}
        onOpenChange={(open) => {
          if (!open) setMode(null);
        }}
        onSaved={() => setMode(null)}
      />
    </>
  );
}
