// The `::soul{id="…"}` chat embed. A thread's instructions only point at its
// persona; the agent loads it with `souls_get` and posts this line, so the user
// sees which soul it took on and can open the persona it is working from.
import { useId, useState, type ReactNode } from "react";
import {
  useBbNavigate,
  type PluginMessageDirectiveProps,
} from "@get-bb/plugin-sdk/app";
import { SOUL_ID_PREFIX, describeModelPin, type Soul } from "../shared";
import { useSoulResource, useThreadSoul } from "../hooks/use-souls";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
  FOCUS_RING,
  Overline,
  Pill,
  RuleList,
  SoulPortrait,
} from "./soul-bits";

export function SoulEmbed({
  attributes,
  message,
}: PluginMessageDirectiveProps) {
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
  const thread = useThreadSoul(threadId);
  const { soul, error, loaded, refetch } = useSoulResource(
    thread.loaded ? id : null,
    thread.soul?.id === id ? thread.soul.revision : null,
  );

  if (!loaded) {
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
  if (soul === null) {
    return (
      <div
        role="status"
        className="my-3 flex items-start gap-3 rounded-xl border border-dashed border-border bg-card p-3.5"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
          <Icon
            name={error === null ? "UserRound" : "AlertCircle"}
            className="size-5"
          />
        </span>
        <span className="min-w-0 flex-1 pt-0.5">
          <span className="block text-sm font-medium">
            {error === null ? "Soul not found" : "Could not load this soul"}
          </span>
          <span className="block text-xs leading-5 text-muted-foreground">
            {error === null
              ? "It may have been deleted since this message was posted."
              : error}
          </span>
          <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
            {id}
          </span>
          {error !== null ? (
            <button
              type="button"
              className={cn(
                "mt-2 rounded-sm text-xs font-medium underline underline-offset-4",
                FOCUS_RING,
              )}
              onClick={refetch}
            >
              Try again
            </button>
          ) : null}
        </span>
      </div>
    );
  }

  return <LoadedSoul soul={soul} thread={thread} />;
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
  const pinnedRevision = left ? null : (thread.state?.pinnedRevision ?? null);
  const edited =
    !left &&
    session !== null &&
    session.soulId === soul.id &&
    session.soulUpdatedAt !== null &&
    session.soulUpdatedAt !== soul.updatedAt;
  const toggle = (next: Section) =>
    setSection((open) => (open === next ? null : next));

  return (
    <section
      aria-labelledby={headingId}
      className="@container my-3 overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
    >
      <div className="p-4">
        <div className="flex items-start gap-3">
          <span className="shrink-0 overflow-hidden rounded-lg border border-border">
            <SoulPortrait soul={soul} className="size-12" />
          </span>
          <div className="min-w-0 flex-1">
            <h3
              id={headingId}
              className="break-words text-base font-semibold leading-tight tracking-tight [overflow-wrap:anywhere]"
            >
              {soul.name}
            </h3>
            {soul.tagline === "" ? null : (
              <p className="mt-1 break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
                {soul.tagline}
              </p>
            )}
            <div className="mt-2">
              <Pill
                tone={edited ? "attention" : "neutral"}
                icon={left ? "ClockArrowDown" : "UserRound"}
              >
                {left
                  ? "Previous soul"
                  : pinnedRevision !== null
                    ? `Pinned to revision ${pinnedRevision}`
                    : edited
                      ? "Newer version available"
                      : thread.loaded && thread.soul?.id === soul.id
                        ? "Selected in this thread"
                        : "Saved persona"}
              </Pill>
            </div>
          </div>
        </div>
        {soul.role === "" ? null : (
          <p
            title={soul.role}
            className="mt-4 line-clamp-3 break-words text-sm leading-relaxed [overflow-wrap:anywhere]"
          >
            {soul.role}
          </p>
        )}

        {left ? (
          <Notice icon="Info">
            This thread no longer runs as {soul.name}.
          </Notice>
        ) : pinnedRevision !== null ? (
          <Notice icon="Clock" tone={edited ? "attention" : "neutral"}>
            {edited
              ? `This thread is pinned to revision ${pinnedRevision}. The next session loads that revision.`
              : `This thread uses revision ${pinnedRevision}. Newer persona edits will not apply while it is pinned.`}
          </Notice>
        ) : edited ? (
          <Notice icon="Clock" tone="attention">
            {soul.name} was edited after this session started. The next session
            loads the change.
          </Notice>
        ) : null}

        <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
          {soul.personality === "" ? null : (
            <SectionTab
              section="voice"
              open={section}
              onToggle={toggle}
              panelId={panelId}
              icon="MessageSquare"
              label="Voice"
            />
          )}
          <SectionTab
            section="always"
            open={section}
            onToggle={toggle}
            panelId={panelId}
            icon="Check"
            count={soul.principles.length}
            label="Always"
          />
          <SectionTab
            section="never"
            open={section}
            onToggle={toggle}
            panelId={panelId}
            icon="X"
            count={soul.boundaries.length}
            label="Never"
          />
          <SectionTab
            section="expertise"
            open={section}
            onToggle={toggle}
            panelId={panelId}
            icon="Target"
            count={soul.expertise.length}
            label="Expertise"
          />
          <button
            type="button"
            onClick={() =>
              navigate.toPluginPanel("souls", { subPath: soul.id })
            }
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
          role="region"
          aria-label={
            section === "voice"
              ? "Voice and temperament"
              : section === "always"
                ? "Working principles"
                : section === "never"
                  ? "Hard limits"
                  : "Expertise"
          }
          className="border-t border-border bg-muted/15 px-4 py-4"
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
  count,
  label,
}: {
  section: Section;
  open: Section | null;
  onToggle: (section: Section) => void;
  panelId: string;
  icon: string;
  count?: number;
  label: string;
}) {
  const pressed = open === section;
  const empty = count === 0;
  if (empty) return null;
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-expanded={pressed}
      aria-controls={pressed ? panelId : undefined}
      onClick={() => onToggle(section)}
      className={cn(
        "inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs transition-colors",
        pressed
          ? "border-border bg-state-active text-foreground"
          : "border-transparent bg-muted/30 text-muted-foreground hover:bg-state-hover hover:text-foreground",
        FOCUS_RING,
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0" />
      {label}
      {count === undefined ? null : (
        <span className="font-semibold tabular-nums text-foreground">
          {count}
        </span>
      )}
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
          <Overline>Hard limits</Overline>
          <RuleList kind="never" items={soul.boundaries} />
        </div>
      );
    case "always":
      return (
        <div className="space-y-2">
          <Overline>Working principles</Overline>
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
                className="max-w-full break-words rounded-md border border-border bg-card px-2 py-0.5 text-xs text-foreground [overflow-wrap:anywhere]"
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
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
            {soul.personality}
          </p>
          {pin === null ? null : (
            <p className="text-xs text-muted-foreground">
              Preferred model: {pin}. Applied from the composer and for managed
              soul children.
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
