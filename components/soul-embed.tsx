// The `::soul{id="…"}` chat embed. A thread's instructions only point at its
// persona; the agent loads it with `souls_get` and posts this line, so the user
// sees which soul it took on and can open the persona it is working from.
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  useBbNavigate,
  useRpc,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import { SOUL_ID_PREFIX, describeModelPin, type Soul } from "../shared";
import { useSignal, useThreadSoul } from "../hooks/use-souls";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { FOCUS_RING, Overline, Pill, RuleList, SoulAura, SoulPortrait } from "./soul-bits";

type Load =
  | { status: "loading" }
  | { status: "ready"; soul: Soul }
  | { status: "missing" }
  | { status: "error"; message: string };

export function SoulEmbed({ attributes, message }: PluginMessageDirectiveProps) {
  const id = attributes.id?.trim() ?? "";
  if (!id.startsWith(SOUL_ID_PREFIX)) {
    return (
      <div className="my-3 flex items-center gap-2 rounded-xl border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
        <Icon name="AlertCircle" className="size-4 shrink-0" />
        This soul card has no valid soul id.
      </div>
    );
  }
  return <SoulCard id={id} threadId={message.threadId} />;
}

function SoulCard({ id, threadId }: { id: string; threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  // A slower response for an older fetch must not replace a newer one.
  const ticket = useRef(0);
  const refetch = useCallback(() => {
    const mine = ++ticket.current;
    rpc.call("souls_get", { idOrName: id }).then(
      (result) => {
        if (mine !== ticket.current) return;
        setLoad(result.soul === null ? { status: "missing" } : { status: "ready", soul: result.soul });
      },
      (cause) => {
        if (mine !== ticket.current) return;
        setLoad({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      },
    );
  }, [rpc, id]);
  useEffect(() => {
    refetch();
    return () => { ++ticket.current; };
  }, [refetch]);
  useSignal("souls-changed", refetch);
  const thread = useThreadSoul(threadId);

  if (load.status === "loading") {
    return (
      <div
        role="status"
        aria-label="Loading soul"
        className="my-3 flex items-start gap-3 rounded-xl border border-border bg-card p-3.5"
      >
        <span className="size-11 shrink-0 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" />
        <span className="flex-1 space-y-2 pt-1">
          <span className="block h-3.5 w-32 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <span className="block h-3 w-64 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
          <span className="block h-3 w-48 max-w-full animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </span>
      </div>
    );
  }
  if (load.status !== "ready") {
    return (
      <div
        role="status"
        className="my-3 flex items-start gap-3 rounded-xl border border-dashed border-border bg-card p-3.5"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <Icon name={load.status === "missing" ? "UserRound" : "AlertCircle"} className="size-5" />
        </span>
        <span className="min-w-0 flex-1 pt-0.5">
          <span className="block text-sm font-medium">
            {load.status === "missing" ? "Soul not found" : "Could not load this soul"}
          </span>
          <span className="block text-xs leading-5 text-muted-foreground">
            {load.status === "missing"
              ? "It may have been deleted since this message was posted."
              : load.message}
          </span>
          <span className="mt-1 block font-mono text-[11px] text-muted-foreground">{id}</span>
        </span>
      </div>
    );
  }

  return <LoadedSoul soul={load.soul} thread={thread} />;
}

type Section = "never" | "always" | "expertise" | "voice";

function LoadedSoul({
  soul,
  thread,
}: {
  soul: Soul;
  thread: ReturnType<typeof useThreadSoul>;
}) {
  const [section, setSection] = useState<Section | null>(null);
  const headingId = useId();
  const panelId = useId();
  const navigate = useBbNavigate();
  const session = thread.state?.session ?? null;
  // Only say what the evidence shows: the thread moved to another soul, or the
  // recorded session was built from an older version of this one.
  const left = thread.loaded && thread.soul?.id !== soul.id;
  const edited =
    !left &&
    session !== null &&
    session.soulId === soul.id &&
    session.soulUpdatedAt !== null &&
    session.soulUpdatedAt !== soul.updatedAt;
  const toggle = (next: Section) => setSection((open) => (open === next ? null : next));

  return (
    <section
      aria-labelledby={headingId}
      className="@container relative my-3 overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-sm"
    >
      {/* The cover: the soul's own colours, from its portrait. */}
      <div aria-hidden className="relative h-20 overflow-hidden bg-muted/30">
        <SoulAura soul={soul} className="-left-12 -top-28 size-[288px] opacity-70" />
        <SoulAura soul={soul} className="-right-16 -top-24 size-[264px] opacity-55" />
        <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-b from-transparent to-card" />
      </div>
      <div className="absolute right-3 top-3">
        <span className="inline-flex rounded-full bg-card/85 shadow-sm backdrop-blur-sm">
          <Pill tone="success" icon="CircleCheck">
            Soul loaded
          </Pill>
        </span>
      </div>

      <div className="px-4 pb-3.5">
        <div className="-mt-11 flex items-end gap-3">
          <span className="relative shrink-0 overflow-hidden rounded-2xl border-2 border-card shadow-md">
            <SoulPortrait soul={soul} className="size-[72px]" />
          </span>
          <h3 id={headingId} className="min-w-0 truncate pb-1 text-lg font-semibold leading-7 tracking-tight">
            {soul.name}
          </h3>
        </div>
        {soul.tagline === "" ? null : (
          <p className="mt-1.5 text-sm leading-snug text-muted-foreground">{soul.tagline}</p>
        )}
        {soul.role === "" ? null : (
          <p
            title={soul.role}
            className="mt-3 line-clamp-3 border-l-2 border-border pl-3 text-sm leading-relaxed"
          >
            {soul.role}
          </p>
        )}

        {left ? (
          <Notice icon="Info">This thread no longer runs as {soul.name}.</Notice>
        ) : edited ? (
          <Notice icon="Clock" tone="attention">
            {soul.name} was edited after this session started. The next session loads the
            change.
          </Notice>
        ) : null}

        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          <SectionTab
            section="never" open={section} onToggle={toggle} panelId={panelId}
            icon="X" iconClassName="text-destructive" count={soul.boundaries.length} label="Never"
          />
          <SectionTab
            section="always" open={section} onToggle={toggle} panelId={panelId}
            icon="Check" iconClassName="text-success" count={soul.principles.length} label="Always"
          />
          <SectionTab
            section="expertise" open={section} onToggle={toggle} panelId={panelId}
            icon="Target" count={soul.expertise.length} label="Expertise"
          />
          {soul.personality === "" ? null : (
            <SectionTab
              section="voice" open={section} onToggle={toggle} panelId={panelId}
              icon="MessageSquare" label="Voice"
            />
          )}
          <button
            type="button"
            onClick={() => navigate.toPluginPanel("souls", { subPath: soul.id })}
            className={cn(
              "ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground",
              FOCUS_RING,
            )}
          >
            Open in Souls
            <Icon name="ArrowUpRight" className="size-3.5" />
          </button>
        </div>
      </div>

      {section === null ? null : (
        <div
          id={panelId}
          className="animate-in fade-in-0 slide-in-from-top-1 border-t border-border bg-muted/25 px-4 py-3.5 duration-200 motion-reduce:animate-none"
        >
          <SectionBody soul={soul} section={section} />
        </div>
      )}
    </section>
  );
}

function SectionTab({
  section,
  open,
  onToggle,
  panelId,
  icon,
  iconClassName,
  count,
  label,
}: {
  section: Section;
  open: Section | null;
  onToggle: (section: Section) => void;
  panelId: string;
  icon: string;
  iconClassName?: string;
  count?: number;
  label: string;
}) {
  const pressed = open === section;
  const empty = count === 0;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-controls={pressed ? panelId : undefined}
      disabled={empty}
      onClick={() => onToggle(section)}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition-colors disabled:cursor-default disabled:opacity-50",
        pressed
          ? "border-ring bg-state-active text-foreground"
          : "border-border bg-card text-muted-foreground hover:bg-state-hover hover:text-foreground",
        FOCUS_RING,
      )}
    >
      <Icon name={icon} className={cn("size-3.5 shrink-0", iconClassName)} />
      {count === undefined ? null : (
        <span className="font-semibold tabular-nums text-foreground">{count}</span>
      )}
      {label}
    </button>
  );
}

/** One part of the persona the agent adopted, opened from its tab. */
function SectionBody({ soul, section }: { soul: Soul; section: Section }) {
  const pin = describeModelPin(soul.model);
  switch (section) {
    case "never":
      return (
        <div className="space-y-2">
          <Overline>Hard limits · never</Overline>
          <RuleList kind="never" items={soul.boundaries} />
        </div>
      );
    case "always":
      return (
        <div className="space-y-2">
          <Overline>Principles · always</Overline>
          <RuleList kind="always" items={soul.principles} />
        </div>
      );
    case "expertise":
      return (
        <div className="space-y-2">
          <Overline>Expertise</Overline>
          <div className="flex flex-wrap gap-1.5">
            {soul.expertise.map((item) => (
              <span
                key={item}
                className="rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground"
              >
                {item}
              </span>
            ))}
          </div>
        </div>
      );
    case "voice":
      return (
        <div className="space-y-2">
          <Overline>Voice and temperament</Overline>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{soul.personality}</p>
          {pin === null ? null : (
            <p className="text-xs text-muted-foreground">
              Preferred model: {pin} · advisory, applied from the composer
            </p>
          )}
        </div>
      );
  }
}

function Notice({
  icon,
  tone = "neutral",
  children,
}: {
  icon: string;
  tone?: "neutral" | "attention";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5",
        tone === "attention"
          ? "border-warning/30 bg-warning/10 text-warning-text"
          : "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon name={icon} className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
