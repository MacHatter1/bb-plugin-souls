// Choosing a soul.
//
// One dialog, opened from the composer's `+` menu row ("Choose a soul…") or
// from the banner's Change button:
//   • the composer banner shows the soul a thread runs as, above the composer.
//     It owns the dialog while mounted, so the `+` row gets composer access and
//     can apply the soul's model preference to the composer's pickers;
//   • an app-wide overlay catches a `+` row request no banner claimed.
//
// The `+` menu row asks the banner of its own composer to open the picker
// (with the same thread in two panes, only that pane's). With no banner
// mounted, it fires a window event the app overlay answers.
//
// Two scopes, two meanings:
//   • a thread      — binds the soul to that thread, and can release an idle
//                     runtime so the next turn already carries the persona.
//   • new-thread    — there is no thread yet, so the choice waits server-side
//                     and the dispatch hook binds it to the thread the user is
//                     about to start.
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useBbNavigate,
  useComposer,
  useComposerView,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  INTERVIEW_KICKOFF,
  describeModelPin,
  describeSoulStatus,
  renderSoulInstructions,
  toSummary,
  type Soul,
  type ThreadSoulState,
  type SoulSummary,
} from "../shared";
import {
  useCompactionReminder,
  usePendingSoul,
  useSoul,
  useSoulResource,
  useSouls,
  useThreadMood,
  useThreadSoul,
} from "../hooks/use-souls";
import { MOOD_LABEL } from "../motion";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  FOCUS_RING,
  Overline,
  Pill,
  RuleList,
  SoulPortrait,
} from "./soul-bits";

export const OPEN_PICKER = "souls:open-picker";

/** A mounted composer banner, which owns the picker for its composer. */
type MountedBanner = {
  threadId: string | null;
  composer: unknown;
  /** The banner's own element, to tell panes apart by focus. */
  anchor: { current: HTMLElement | null };
  open: () => void;
};
const banners = new Set<MountedBanner>();

/** The nearest ancestor that holds a composer's editable text: its composer. */
function composerRootOf(element: HTMLElement | null): HTMLElement | null {
  let node = element?.parentElement ?? null;
  for (
    let depth = 0;
    node !== null && depth < 12;
    depth += 1, node = node.parentElement
  )
    if (node.querySelector('[contenteditable="true"], textarea') !== null)
      return node;
  return null;
}

/**
 * Open the picker for `threadId` (null: the compose screen's next thread) in
 * the composer whose `+` row asked. With the same thread open in two panes,
 * only one picker opens: the asking composer's when it can be told apart,
 * else the one holding focus, else the newest. With no banner mounted, the
 * app overlay opens it.
 */
export function requestSoulPicker(
  threadId: string | null,
  composer?: unknown,
): void {
  const candidates = [...banners].filter(
    (banner) => banner.threadId === threadId,
  );
  // Trusted only when it singles one out: a host may share one API object.
  const same = candidates.filter(
    (banner) => composer !== undefined && banner.composer === composer,
  );
  const focused = document.activeElement;
  const target =
    (same.length === 1 ? same[0] : undefined) ??
    candidates.find(
      (banner) =>
        focused !== null &&
        composerRootOf(banner.anchor.current)?.contains(focused) === true,
    ) ??
    candidates.at(-1);
  if (target !== undefined) {
    target.open();
    return;
  }
  window.dispatchEvent(new CustomEvent(OPEN_PICKER, { detail: { threadId } }));
}

type ComposerSelection = Parameters<
  ReturnType<typeof useComposer>["experimental_setSelection"]
>[0];

function SoulRow({
  soul,
  active,
  onPick,
}: {
  soul: SoulSummary;
  active: boolean;
  onPick: () => void;
}) {
  const pin = describeModelPin(soul.model);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
        active
          ? "border-ring bg-state-active"
          : "border-transparent hover:bg-state-hover",
      )}
    >
      <span className="mt-0.5 shrink-0 overflow-hidden rounded-md border border-border/70">
        <SoulPortrait soul={soul} className="size-9" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{soul.name}</span>
        {soul.archivedAt === null ? null : (
          <span className="block text-xs text-muted-foreground">
            Archived · current thread
          </span>
        )}
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {soul.tagline === "" ? soul.role || "No tagline" : soul.tagline}
        </span>
        {soul.expertise.length === 0 ? null : (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {soul.expertise.slice(0, 4).join(" · ")}
          </span>
        )}
        {pin === null ? null : (
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            {pin}
          </span>
        )}
      </span>
      {active ? (
        <Icon name="Check" className="mt-1 size-4 shrink-0 text-foreground" />
      ) : null}
    </button>
  );
}

export function SoulPickerDialog({
  open,
  onOpenChange,
  threadId,
  currentId,
  currentDelegation = false,
  currentHiringOverride = null,
  currentPinnedRevision = null,
  sessionState = null,
  running = false,
  onPicked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** null in the new-thread composer. */
  threadId: string | null;
  currentId: string | null;
  currentDelegation?: boolean;
  currentHiringOverride?: boolean | null;
  currentPinnedRevision?: number | null;
  sessionState?: ThreadSoulState | null;
  /** True while this thread's agent is working; "apply now" is skipped then. */
  running?: boolean;
  /** Extra work after a successful pick — the composer applies model pins here. */
  onPicked?: (
    soul: SoulSummary | null,
    info: { restarted: boolean; skipped: string },
  ) => void | Promise<void>;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { souls, error } = useSouls();
  const missingCurrent =
    open &&
    threadId !== null &&
    currentId !== null &&
    souls !== null &&
    !souls.some((soul) => soul.id === currentId);
  const { soul: currentSoul, error: currentError } = useSoulResource(
    missingCurrent ? currentId : null,
  );
  const availableSouls = useMemo(() => {
    const listed = souls ?? [];
    return threadId !== null &&
      currentSoul?.id === currentId &&
      !listed.some((soul) => soul.id === currentId)
      ? [toSummary(currentSoul), ...listed]
      : listed;
  }, [souls, currentSoul, currentId, threadId]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [applyNow, setApplyNow] = useState(true);
  const [chosenId, setChosenId] = useState(currentId);
  const [allowDelegation, setAllowDelegation] = useState(false);
  const [hiringOverride, setHiringOverride] = useState<boolean | null>(null);
  const [pinnedRevision, setPinnedRevision] = useState<number | null>(null);
  const [revisions, setRevisions] = useState<number[]>([]);
  const [olderRevisionOffset, setOlderRevisionOffset] = useState<number | null>(
    null,
  );
  const revisionTarget = useRef(chosenId);
  revisionTarget.current = chosenId;
  const [pinnedSoul, setPinnedSoul] = useState<import("../shared").Soul | null>(
    null,
  );
  const fullSoul = useSoul(open ? chosenId : null);
  const previewSoul = pinnedRevision === null ? fullSoul : pinnedSoul;
  const instructions =
    previewSoul === null || fullSoul === null
      ? null
      : renderSoulInstructions(
          previewSoul,
          allowDelegation,
          hiringOverride ?? fullSoul.allowHiring,
        );
  const chosenSoul =
    availableSouls.find((soul) => soul.id === chosenId) ?? null;

  useEffect(() => {
    if (open) {
      setQuery("");
      setApplyNow(true);
      setChosenId(currentId);
      setAllowDelegation(currentDelegation);
      setHiringOverride(currentHiringOverride);
      setPinnedRevision(currentPinnedRevision);
    }
  }, [
    open,
    currentId,
    currentDelegation,
    currentHiringOverride,
    currentPinnedRevision,
  ]);

  useEffect(() => {
    let live = true;
    setRevisions([]);
    setOlderRevisionOffset(null);
    if (open && fullSoul !== null)
      rpc.call("souls_history", { soulId: fullSoul.id }).then(
        (result) => {
          if (live) {
            setRevisions(result.versions.map((version) => version.revision));
            setOlderRevisionOffset(result.nextOffset);
          }
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [rpc, open, fullSoul?.id, fullSoul?.revision]);
  useEffect(() => {
    let live = true;
    setPinnedSoul(null);
    if (open && chosenId !== null && pinnedRevision !== null)
      rpc
        .call("souls_version", { soulId: chosenId, revision: pinnedRevision })
        .then(
          (result) => {
            if (live) setPinnedSoul(result.soul);
          },
          () => undefined,
        );
    return () => {
      live = false;
    };
  }, [rpc, open, chosenId, pinnedRevision]);

  const choose = (id: string | null) => {
    setChosenId(id);
    setHiringOverride(id === currentId ? currentHiringOverride : null);
    setPinnedRevision(id === currentId ? currentPinnedRevision : null);
    setAllowDelegation(
      id === null
        ? false
        : id === currentId
          ? currentDelegation
          : (availableSouls.find((soul) => soul.id === id)
              ?.defaultAllowDelegation ?? false),
    );
  };

  const visible = useMemo(() => {
    const all = availableSouls;
    const needle = query.trim().toLowerCase();
    if (needle === "") return all;
    return all.filter((soul) =>
      `${soul.name} ${soul.tagline} ${soul.role} ${soul.expertise.join(" ")}`
        .toLowerCase()
        .includes(needle),
    );
  }, [availableSouls, query]);

  const pick = useCallback(
    async (soulId: string | null, soul: SoulSummary | null) => {
      if (busy) return;
      setBusy(true);
      try {
        const info =
          threadId === null
            ? await rpc
                .call("souls_pending_set", {
                  soulId,
                  allowDelegation: soulId !== null && allowDelegation,
                  hiringOverride,
                  pinnedRevision,
                })
                .then((result) => ({
                  restarted: false,
                  skipped: "",
                  soul: result.soul,
                }))
            : await rpc.call("souls_thread_set", {
                threadId,
                soulId,
                applyNow: applyNow && !running,
                allowDelegation: soulId !== null && allowDelegation,
                hiringOverride,
                pinnedRevision,
              });
        onOpenChange(false);
        if (soul === null) {
          toast.success(
            threadId === null
              ? "New threads start with no soul"
              : "Soul selection cleared",
            {
              description:
                threadId === null
                  ? undefined
                  : info.restarted
                    ? "Runtime released. The next turn starts without a soul."
                    : "The current session keeps its previous persona until it is restarted.",
            },
          );
        } else if (threadId === null) {
          toast.success(
            `${soul.emoji} New threads you start now begin as ${soul.name}`,
          );
        } else if (info.restarted) {
          toast.success(
            `${soul.emoji} ${soul.name} is this thread's soul from the next turn`,
          );
        } else {
          toast.success(`${soul.emoji} ${soul.name} selected`, {
            description:
              info.skipped === "running"
                ? "The agent is working, so its runtime was left alone — the persona applies when the session is next constructed."
                : "Waiting for session restart. The picker shows recorded injection evidence, not a guarantee of model behavior.",
          });
        }
        await onPicked?.(info.soul, info);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
    },
    [
      allowDelegation,
      hiringOverride,
      pinnedRevision,
      applyNow,
      busy,
      onOpenChange,
      onPicked,
      rpc,
      running,
      threadId,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(43rem,90dvh)] max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="shrink-0 border-b border-border px-5 py-5 pr-12">
          <DialogTitle>
            {threadId === null
              ? "Soul for your next thread"
              : "This thread's soul"}
          </DialogTitle>
          <DialogDescription>
            {threadId === null
              ? "Choose a persona and its permissions before the first turn."
              : "Choose the persona this thread uses when its session next starts."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 overflow-y-auto sm:grid-cols-[minmax(0,1fr)_18rem] sm:overflow-hidden">
          <div className="flex min-h-0 min-w-0 flex-col border-border sm:border-r">
            <div className="relative m-4 shrink-0">
              <Icon
                name="Search"
                className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground"
              />
              <Input
                aria-label="Search souls"
                autoFocus
                placeholder="Search souls…"
                className="h-9 pl-9"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="min-h-0 max-h-[35dvh] flex-1 space-y-1 overflow-y-auto px-3 pb-3 sm:max-h-none">
              <button
                type="button"
                disabled={busy}
                onClick={() => choose(null)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                  chosenId === null
                    ? "border-border bg-state-active"
                    : "border-transparent hover:bg-state-hover",
                )}
              >
                <Icon
                  name="UserRound"
                  className="size-4 text-muted-foreground"
                />
                <span className="flex-1">
                  No soul
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Use the agent's usual instructions.
                  </span>
                </span>
                {chosenId === null ? (
                  <Icon name="Check" className="size-4" />
                ) : null}
              </button>

              {souls === null ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  Loading…
                </p>
              ) : visible.length === 0 ? (
                <p className="px-3 py-2 text-sm text-muted-foreground">
                  {availableSouls.length === 0
                    ? "No souls yet — create one with AI below."
                    : "No soul matches that search."}
                </p>
              ) : (
                visible.map((soul) => (
                  <SoulRow
                    key={soul.id}
                    soul={soul}
                    active={soul.id === chosenId}
                    onPick={() => choose(soul.id)}
                  />
                ))
              )}

              {(error ?? currentError) === null ? null : (
                <p role="alert" className="px-3 py-2 text-sm text-destructive">
                  {error ?? currentError}
                </p>
              )}
            </div>
          </div>
          <div className="min-h-0 min-w-0 space-y-5 border-t border-border p-5 sm:overflow-y-auto sm:border-t-0">
            {chosenSoul === null ? (
              <div>
                <h3 className="text-sm font-semibold">Thread settings</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Choose a soul to customize how it works in this thread.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                <SoulPortrait
                  soul={chosenSoul}
                  className="size-11 shrink-0 rounded-lg border border-border"
                />
                <div className="min-w-0">
                  <h3 className="break-words text-sm font-semibold">
                    {chosenSoul.name}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {chosenSoul.tagline || chosenSoul.role}
                  </p>
                </div>
              </div>
            )}
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3">
              <Checkbox
                checked={allowDelegation && chosenId !== null}
                disabled={chosenId === null || busy}
                onCheckedChange={(checked) =>
                  setAllowDelegation(checked === true)
                }
                aria-label="Allow this soul to spawn and coordinate child threads"
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">
                  Allow child threads
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                  Spawn and coordinate specialists in this thread.{" "}
                  {chosenSoul?.defaultAllowDelegation
                    ? "On by default for this soul."
                    : "Off by default for this soul."}
                </span>
              </span>
            </label>
            <label className="block space-y-1.5 text-xs font-medium">
              <span className="block">Hiring in this thread</span>
              <select
                aria-label="Hiring in this thread"
                className="h-9 w-full rounded-md border border-input bg-background px-2"
                disabled={chosenId === null || busy}
                value={
                  hiringOverride === null
                    ? "default"
                    : hiringOverride
                      ? "allow"
                      : "deny"
                }
                onChange={(event) =>
                  setHiringOverride(
                    event.target.value === "default"
                      ? null
                      : event.target.value === "allow",
                  )
                }
              >
                <option value="default">
                  Use soul setting (
                  {chosenSoul?.allowHiring ? "allowed" : "off"})
                </option>
                <option value="deny">Disable hiring here</option>
                <option value="allow">Allow hiring here</option>
              </select>
            </label>
            <label className="block space-y-1.5 text-xs font-medium">
              <span className="block">Persona version</span>
              <select
                aria-label="Persona version"
                className="h-9 w-full rounded-md border border-input bg-background px-2"
                disabled={chosenId === null || busy}
                value={pinnedRevision ?? "latest"}
                onChange={(event) =>
                  setPinnedRevision(
                    event.target.value === "latest"
                      ? null
                      : Number(event.target.value),
                  )
                }
              >
                <option value="latest">Follow latest persona</option>
                {pinnedRevision !== null &&
                !revisions.includes(pinnedRevision) ? (
                  <option value={pinnedRevision}>
                    Revision {pinnedRevision}
                  </option>
                ) : null}
                {revisions.map((revision) => (
                  <option key={revision} value={revision}>
                    Pin revision {revision}
                  </option>
                ))}
              </select>
              <span className="block text-xs font-normal leading-relaxed text-muted-foreground">
                Follow updates or keep this thread on a saved version.
              </span>
            </label>
            {olderRevisionOffset === null || chosenId === null ? null : (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const id = chosenId;
                  void rpc
                    .call("souls_history", {
                      soulId: id,
                      offset: olderRevisionOffset,
                    })
                    .then(
                      (result) => {
                        if (revisionTarget.current !== id) return;
                        setRevisions((current) => [
                          ...new Set([
                            ...current,
                            ...result.versions.map(
                              (version) => version.revision,
                            ),
                          ]),
                        ]);
                        setOlderRevisionOffset(result.nextOffset);
                      },
                      (cause) => toast.error(String(cause)),
                    );
                }}
              >
                Load older persona versions
              </Button>
            )}
            {instructions === null ? null : (
              <details className="rounded-lg border border-border px-3 py-2">
                <summary className="cursor-pointer text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  What the agent receives
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                  {instructions}
                </pre>
              </details>
            )}

            {threadId === null ? null : (
              <label className="flex cursor-pointer items-start gap-3 border-t border-border pt-4">
                <Checkbox
                  checked={applyNow && !running}
                  disabled={running}
                  onCheckedChange={(checked) => setApplyNow(checked === true)}
                  aria-label="Apply from the next turn"
                  className="mt-0.5"
                />
                <span>
                  <span className="block text-sm">
                    Apply from the next turn
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {running
                      ? "The agent is working, so this waits until its session is next constructed."
                      : "Stops the idle agent. The next message starts with this persona."}
                  </span>
                </span>
              </label>
            )}
            {sessionState === null ? null : (
              <details className="border-t border-border pt-4 text-xs text-muted-foreground">
                <summary className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Recorded session
                </summary>
                <div className="mt-2 space-y-2 leading-relaxed" role="status">
                  <p>{describeSoulStatus(sessionState)}</p>
                  {sessionState.session?.soulUpdatedAt ? (
                    <p>
                      Persona saved{" "}
                      {new Date(
                        sessionState.session.soulUpdatedAt,
                      ).toLocaleString()}
                    </p>
                  ) : null}
                  <p>Session records show which instructions were injected.</p>
                </div>
              </details>
            )}
          </div>
        </div>
        <DialogFooter className="shrink-0 flex-row flex-wrap items-center justify-between gap-2 border-t border-border bg-background px-4 py-3 sm:justify-between sm:space-x-0">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                navigate.toCompose({
                  initialPrompt: INTERVIEW_KICKOFF,
                  focusPrompt: true,
                });
              }}
            >
              <Icon name="MessageCirclePlus" className="size-4" />
              Create with AI
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                navigate.toPluginPanel("souls");
              }}
            >
              <Icon name="Settings" className="size-4" />
              Library
            </Button>
          </div>
          <Button
            disabled={busy || (chosenId !== null && chosenSoul === null)}
            onClick={() => void pick(chosenId, chosenSoul)}
          >
            {busy ? "Applying…" : "Apply soul"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Applies a soul's model preference through the composer's own pickers. */
function useApplyModelPin() {
  const composer = useComposer();
  return useCallback(
    async (soul: SoulSummary | null) => {
      const pin = soul?.model ?? null;
      if (pin === null) return;
      const selection: ComposerSelection = {};
      if (pin.providerId !== null) selection.providerId = pin.providerId;
      if (pin.model !== null) selection.model = pin.model;
      if (pin.reasoningLevel !== null)
        selection.reasoningLevel = pin.reasoningLevel as NonNullable<
          ComposerSelection["reasoningLevel"]
        >;
      if (Object.keys(selection).length === 0) return;
      try {
        // BB ignores anything this composer has no picker for and reconciles
        // the rest, so the resolved selection is the truth to report.
        const settled = await composer.experimental_setSelection(selection);
        const label = describeModelPin({
          providerId: settled.providerId ?? null,
          model: settled.model ?? null,
          reasoningLevel: settled.reasoningLevel ?? null,
        });
        if (label !== null) toast.info(`Model set to ${label}`);
      } catch {
        // A provider this composer does not list is ignored, not an error worth
        // interrupting the user for.
      }
    },
    [composer],
  );
}

/** Short banner wording for a session state; the full sentence is the tooltip. */
function bannerStatus(state: ThreadSoulState | null): string | null {
  if (state === null) return null;
  switch (state.status) {
    case "pending":
    case "outdated":
      return "From next session";
    case "unknown":
      return "Not confirmed";
    default:
      return null;
  }
}

/** The banner status as a full sentence, for its peek. */
function bannerNote(state: ThreadSoulState): string | null {
  switch (state.status) {
    case "pending":
      return "Chosen after this session started. It applies from the next session.";
    case "outdated":
      return "Changed since this session started. The change applies from the next session.";
    case "unknown":
      return "BB has no record of this session's instructions, so the soul is not confirmed yet.";
    default:
      return null;
  }
}

/** Whole minutes until `expiresAt`, ticking while there is one to count down. */
function useMinutesLeft(expiresAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (expiresAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  if (expiresAt === null) return null;
  return Math.max(1, Math.ceil((expiresAt - now) / 60_000));
}

/**
 * The composer banner: the soul this thread runs as, or the one the next new
 * thread starts as, above the composer. Its name opens a peek at the job and
 * hard limits. It renders nothing without a soul but stays mounted to own the
 * picker, so the `+` menu row opens it with composer access and a soul's
 * model preference can be applied.
 */
export function ComposerSoulBanner() {
  const view = useComposerView();
  const scope = view.scope;
  const threadId = scope.kind === "thread" ? scope.threadId : null;
  const isNewThread = scope.kind === "new-thread";
  const { soul: threadSoul, allowDelegation, state } = useThreadSoul(threadId);
  const pendingSoul = usePendingSoul();
  const applyPin = useApplyModelPin();
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [peek, setPeek] = useState(false);
  const peekId = useId();
  const soul = isNewThread ? pendingSoul.soul : threadSoul;
  const full = useSoul(
    peek && soul !== null ? soul.id : null,
    soul?.revision ?? null,
  );
  const minutesLeft = useMinutesLeft(
    isNewThread ? pendingSoul.expiresAt : null,
  );
  const composer = useComposer();
  const anchor = useRef<HTMLSpanElement>(null);
  const reminder = useCompactionReminder(threadId);
  const reminderDue = !isNewThread && soul !== null && reminder.pending;

  // After a compaction, the persona rides along with the user's next message:
  // a mention pill in the draft, resolved to agent-only context at send time.
  // Once per compaction across every window and pane (local storage, not
  // session storage), so a pill the user removed stays removed.
  const reminderSoulId = reminderDue ? soul.id : null;
  useEffect(() => {
    if (
      reminderSoulId === null ||
      threadId === null ||
      reminder.seq === null ||
      soul === null
    )
      return;
    const key = `souls:reminder:${threadId}`;
    const seq = String(reminder.seq);
    try {
      if (window.localStorage.getItem(key) === seq) return;
      window.localStorage.setItem(key, seq);
    } catch {
      // No storage: attach anyway; the removal below keeps it to one pill.
    }
    const mention = { provider: "soul", id: `${reminderSoulId}~${threadId}` };
    // A draft shared with another window may already carry one.
    if (typeof composer.experimental_removeMention === "function")
      composer.experimental_removeMention(mention);
    composer.insertMention({ ...mention, label: `${soul.name}'s persona` });
    // `soul` is read for its name only; the id is the dependency that matters.
  }, [reminderSoulId, threadId, reminder.seq, composer]);

  // Let the `+` menu row of this composer drive this dialog while it is mounted.
  useEffect(() => {
    const banner: MountedBanner = {
      threadId,
      composer,
      anchor,
      open: () => setOpen(true),
    };
    banners.add(banner);
    return () => {
      banners.delete(banner);
    };
  }, [threadId, composer]);

  // A peek belongs to the soul it opened on.
  const soulId = soul?.id ?? null;
  useEffect(() => setPeek(false), [soulId]);

  if (!isNewThread && threadId === null) return null;
  const delegation = isNewThread
    ? pendingSoul.allowDelegation
    : allowDelegation;
  const status = isNewThread ? null : bannerStatus(state);

  return (
    <>
      <span ref={anchor} hidden />
      {soul === null ? null : (
        <div className="@container">
          <div
            role="group"
            aria-label={
              isNewThread ? "Soul for your next thread" : "This thread's soul"
            }
            className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground"
          >
            <div className="flex min-w-0 items-center gap-1.5 p-1.5">
              <button
                type="button"
                aria-expanded={peek}
                aria-controls={peekId}
                onClick={() => setPeek((value) => !value)}
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md py-0.5 pl-0.5 pr-2 text-left transition-colors hover:bg-state-hover",
                  FOCUS_RING,
                )}
              >
                <BannerIdentity
                  soul={soul}
                  threadId={isNewThread ? null : threadId}
                />
                <Icon
                  name="ChevronDown"
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none",
                    peek && "rotate-180",
                  )}
                />
              </button>
              {status === null ? null : (
                <Pill
                  tone="attention"
                  icon="Clock"
                  title={state === null ? undefined : describeSoulStatus(state)}
                  labelClassName="@max-lg:sr-only"
                >
                  {status}
                </Pill>
              )}
              {reminderDue ? (
                <Pill
                  tone="attention"
                  icon="RotateCcw"
                  title={`The context was compacted. ${soul.name}'s persona is attached to your next message.`}
                  labelClassName="@max-lg:sr-only"
                >
                  Compacted
                </Pill>
              ) : null}
              {minutesLeft === null ? null : (
                <Pill
                  icon="Clock"
                  title="An unused choice lapses after five minutes. It binds to the next thread you start before then."
                  labelClassName="@max-lg:sr-only"
                >
                  {minutesLeft} min left
                </Pill>
              )}
              {delegation ? (
                <Pill
                  icon="Workflow"
                  title="You allowed this soul to spawn and coordinate child threads here."
                  labelClassName="@max-xl:sr-only"
                >
                  Can delegate
                </Pill>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 px-2.5 text-xs"
                aria-label={`Change the soul (${soul.name} is selected)`}
                onClick={() => setOpen(true)}
              >
                Change
              </Button>
              {isNewThread ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0 text-muted-foreground"
                  aria-label={`Start the next thread without ${soul.name}`}
                  onClick={() => {
                    void rpc
                      .call("souls_pending_set", {
                        soulId: null,
                        allowDelegation: false,
                      })
                      .catch((cause: unknown) =>
                        toast.error(
                          cause instanceof Error
                            ? cause.message
                            : String(cause),
                        ),
                      );
                  }}
                >
                  <Icon name="X" />
                </Button>
              ) : null}
            </div>
            {peek ? (
              <SoulPeek
                id={peekId}
                summary={soul}
                soul={full}
                notes={[
                  ...((isNewThread
                    ? pendingSoul.pinnedRevision
                    : state?.pinnedRevision) != null
                    ? [
                        {
                          icon: "Clock",
                          text: `Pinned to revision ${soul.revision}. Newer persona edits will not apply while it is pinned.`,
                        },
                      ]
                    : []),
                  ...(reminderDue
                    ? [
                        {
                          icon: "RotateCcw",
                          text: `The context was compacted, so ${soul.name}'s persona is attached to your next message. Remove the pill to send without it.`,
                        },
                      ]
                    : []),
                  ...(status !== null &&
                  state !== null &&
                  bannerNote(state) !== null
                    ? [{ icon: "Clock", text: bannerNote(state) as string }]
                    : []),
                  ...(minutesLeft !== null
                    ? [
                        {
                          icon: "Clock",
                          text: `Binds to the next thread you start in the next ${minutesLeft} min, before its first turn.`,
                        },
                      ]
                    : []),
                  ...(delegation
                    ? [
                        {
                          icon: "Workflow",
                          text: `You allowed ${soul.name} to spawn and coordinate child threads${isNewThread ? " in that thread" : " here"}.`,
                        },
                      ]
                    : []),
                ]}
              />
            ) : null}
          </div>
        </div>
      )}
      <SoulPickerDialog
        open={open}
        onOpenChange={setOpen}
        threadId={threadId}
        currentId={soul?.id ?? null}
        currentDelegation={delegation}
        currentHiringOverride={
          threadId === null ? pendingSoul.hiringOverride : state?.hiringOverride
        }
        currentPinnedRevision={
          threadId === null ? pendingSoul.pinnedRevision : state?.pinnedRevision
        }
        sessionState={state}
        running={view.run.isRunning || view.run.isSubmitting}
        onPicked={async (picked) => applyPin(picked)}
      />
    </>
  );
}

/**
 * The banner's portrait and line, the only part that follows the thread's
 * live state: the sidebar's thread list changes often, and this re-renders
 * for it, not the whole banner. `threadId` null is the compose screen.
 */
const BannerIdentity = memo(function BannerIdentity({
  soul,
  threadId,
}: {
  soul: SoulSummary;
  threadId: string | null;
}) {
  const mood = useThreadMood(threadId);
  const moodLabel = threadId === null ? null : MOOD_LABEL[mood];
  return (
    <>
      <span className="shrink-0 overflow-hidden rounded-md border border-border/70">
        <SoulPortrait
          soul={soul}
          mood={threadId === null ? undefined : mood}
          className="size-9"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-tight text-foreground">
          {soul.name}
        </span>
        <span className="mt-0.5 block truncate text-xs leading-tight text-muted-foreground">
          {threadId === null
            ? "For your next thread"
            : (moodLabel ?? "This thread's soul")}
        </span>
      </span>
    </>
  );
});

/** The banner's peek: the job, the hard limits, and a way to the full soul. */
function SoulPeek({
  id,
  summary,
  soul,
  notes,
}: {
  id: string;
  summary: SoulSummary;
  soul: Soul | null;
  /** The banner's pills in full sentences, for touch screens without tooltips. */
  notes: readonly { icon: string; text: string }[];
}) {
  const navigate = useBbNavigate();
  return (
    <div
      id={id}
      role="region"
      aria-label={`${summary.name}'s persona`}
      className="max-h-[40dvh] space-y-4 overflow-y-auto border-t border-border bg-muted/10 px-4 py-4"
    >
      {notes.length === 0 ? null : (
        <ul className="space-y-1">
          {notes.map((note) => (
            <li
              key={note.text}
              className="flex gap-2 text-xs leading-5 text-muted-foreground"
            >
              <Icon name={note.icon} className="mt-1 size-3 shrink-0" />
              <span className="min-w-0">{note.text}</span>
            </li>
          ))}
        </ul>
      )}
      {summary.role === "" ? null : (
        <div className="space-y-1">
          <Overline>Job</Overline>
          <p className="text-sm leading-snug">{summary.role}</p>
        </div>
      )}
      {soul === null ? (
        <div className="space-y-1.5" aria-hidden>
          <span className="block h-3 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <span className="block h-3 w-72 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </div>
      ) : soul.boundaries.length === 0 ? null : (
        <div className="space-y-1.5">
          <Overline>Never</Overline>
          <RuleList kind="never" items={soul.boundaries} />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">
          {soul === null
            ? " "
            : `${soul.principles.length} ${soul.principles.length === 1 ? "principle" : "principles"} · ${
                soul.expertise.length === 0
                  ? "no listed expertise"
                  : soul.expertise.join(", ")
              }`}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="-mr-1.5 h-7 shrink-0 px-2 text-xs"
          onClick={() =>
            navigate.toPluginPanel("souls", { subPath: summary.id })
          }
        >
          Open in Souls
          <Icon name="ArrowUpRight" />
        </Button>
      </div>
    </div>
  );
}

/**
 * App-wide fallback: opens the picker for a `+` menu row that no composer
 * banner claimed. It has no composer access, so it binds the persona and says
 * plainly that a model preference was not applied.
 */
export function SoulPickerOverlay() {
  const [target, setTarget] = useState<{ threadId: string | null } | null>(
    null,
  );
  const { soul, allowDelegation, state } = useThreadSoul(
    target?.threadId ?? null,
  );
  const pendingSoul = usePendingSoul();

  // Only fired when no composer banner was mounted to take the request.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId?: unknown }>).detail;
      if (detail === null || typeof detail !== "object") return;
      const requested = (detail as { threadId?: unknown }).threadId ?? null;
      if (typeof requested !== "string" && requested !== null) return;
      setTarget({ threadId: requested });
    };
    window.addEventListener(OPEN_PICKER, handler);
    return () => window.removeEventListener(OPEN_PICKER, handler);
  }, []);

  if (target === null) return null;
  const current = target.threadId === null ? pendingSoul.soul : soul;
  return (
    <SoulPickerDialog
      open
      onOpenChange={(open) => {
        if (!open) setTarget(null);
      }}
      threadId={target.threadId}
      currentId={current?.id ?? null}
      currentDelegation={
        target.threadId === null ? pendingSoul.allowDelegation : allowDelegation
      }
      currentHiringOverride={
        target.threadId === null
          ? pendingSoul.hiringOverride
          : state?.hiringOverride
      }
      currentPinnedRevision={
        target.threadId === null
          ? pendingSoul.pinnedRevision
          : state?.pinnedRevision
      }
      sessionState={state}
      onPicked={(picked) => {
        const label = describeModelPin(picked?.model ?? null);
        if (label !== null)
          toast.info(
            `${picked?.name ?? "This soul"} prefers ${label}. It was not applied here; choose the soul from a composer's + menu to apply it.`,
          );
      }}
    />
  );
}
