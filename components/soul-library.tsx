// Library-only presentation. Shared review/composer surfaces keep their own chrome.
import type { ReactNode } from "react";
import type { Soul, SoulSummary } from "../shared";
import { soulBlurb } from "../soul-library";
import { SoulPortrait } from "./soul-bits";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function SoulCreationOptions({
  onInterview,
  onImport,
  onManual,
  compact = false,
}: {
  onInterview: () => void;
  onImport: () => void;
  onManual: () => void;
  compact?: boolean;
}) {
  const options = [
    {
      title: "Start an interview",
      description: "Shape a persona with an agent's help.",
      icon: "MessageCirclePlus",
      action: onInterview,
      recommended: true,
    },
    {
      title: "Import an agent file",
      description: "Bring an existing agent into your library.",
      icon: "ArrowUp",
      action: onImport,
      recommended: false,
    },
    {
      title: "Write by hand",
      description: "Set the job, voice and boundaries yourself.",
      icon: "Edit",
      action: onManual,
      recommended: false,
    },
  ];
  return (
    <div
      className={cn(
        "grid gap-3 text-left",
        !compact && "@3xl/souls:grid-cols-3",
      )}
    >
      {options.map((item) => (
        <button
          key={item.title}
          type="button"
          onClick={item.action}
          className={cn(
            "group flex min-w-0 items-start gap-3 rounded-xl border border-border p-4 text-left outline-none transition-colors hover:border-foreground/25 hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring",
            compact ? "items-center" : "flex-col",
          )}
        >
          <span
            aria-hidden
            className="rounded-lg border border-border bg-muted/40 p-2"
          >
            <Icon name={item.icon} className="size-5" />
          </span>
          <span className="min-w-0 flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{item.title}</span>
              {item.recommended ? (
                <span className="text-xs text-muted-foreground">
                  Recommended
                </span>
              ) : null}
            </span>
            <span className="block text-xs leading-relaxed text-muted-foreground">
              {item.description}
            </span>
          </span>
          {compact ? (
            <span aria-hidden className="text-muted-foreground">
              <Icon name="ArrowRight" className="size-4" />
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function SoulLibraryCard({
  soul,
  selected,
  count,
  onSelect,
}: {
  soul: SoulSummary;
  selected: boolean;
  count: number | null;
  onSelect: () => void;
}) {
  const line = soulBlurb(soul);
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "group flex w-full items-start gap-3 rounded-xl border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          selected
            ? "border-foreground/25 bg-state-active"
            : "border-transparent hover:border-border hover:bg-state-hover",
        )}
      >
        <span
          aria-hidden
          className="shrink-0 overflow-hidden rounded-lg border border-border/70"
        >
          <SoulPortrait soul={soul} className="size-12" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">
              {soul.name}
            </span>
            {count === null || count === 0 ? null : (
              <span
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-background/60 px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground"
                title={`Selected on ${count} ${count === 1 ? "thread" : "threads"}`}
              >
                <Icon name="MessageSquare" className="size-3" />
                <span>{count}</span>
                <span className="sr-only">
                  {count === 1 ? "thread" : "threads"}
                </span>
              </span>
            )}
          </span>
          <span className="mt-1 line-clamp-2 break-words text-xs leading-relaxed text-muted-foreground">
            {line || "No description yet."}
          </span>
        </span>
      </button>
    </li>
  );
}

export function LibrarySkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading souls"
      className="grid min-h-0 flex-1 @3xl/souls:grid-cols-[19rem_minmax(0,1fr)]"
    >
      <span className="sr-only">Loading your soul library…</span>
      <div
        aria-hidden
        className="space-y-3 border-border p-4 @3xl/souls:border-r"
      >
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex gap-3 rounded-xl p-3">
            <div className="size-12 shrink-0 rounded-lg bg-muted motion-safe:animate-pulse" />
            <div className="min-w-0 flex-1 space-y-2 pt-1">
              <div className="h-3 w-24 rounded bg-muted" />
              <div className="h-3 w-full rounded bg-muted" />
              <div className="h-3 w-2/3 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
      <div aria-hidden className="hidden space-y-6 p-8 @3xl/souls:block">
        <div className="h-20 rounded-xl bg-muted/50" />
        <div className="h-40 rounded-xl bg-muted/50" />
        <div className="h-24 rounded-xl bg-muted/30" />
      </div>
    </div>
  );
}

export function PageMessage({
  icon = "Search",
  title,
  children,
  action,
}: {
  icon?: string;
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-5 py-12 text-center">
      <span
        aria-hidden
        className="mb-4 rounded-xl border border-border bg-muted/30 p-3"
      >
        <Icon name={icon} className="size-6 text-muted-foreground" />
      </span>
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
      {action === undefined ? null : <div className="mt-5">{action}</div>}
    </div>
  );
}

function ProfileSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint === undefined ? null : (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}

function ProfileRules({
  title,
  items,
  icon,
}: {
  title: string;
  items: readonly string[];
  icon: string;
}) {
  return items.length === 0 ? null : (
    <ProfileSection title={title}>
      <ul className="space-y-3">
        {items.map((item, index) => (
          <li
            key={index}
            className="flex items-start gap-2.5 text-sm leading-relaxed"
          >
            <span aria-hidden className="mt-1 shrink-0 text-muted-foreground">
              <Icon name={icon} className="size-4" />
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {item}
            </span>
          </li>
        ))}
      </ul>
    </ProfileSection>
  );
}

export function SoulProfileContent({
  soul,
  onEdit,
}: {
  soul: Soul;
  onEdit: () => void;
}) {
  const empty =
    !soul.role &&
    !soul.personality &&
    !soul.expertise.length &&
    !soul.principles.length &&
    !soul.boundaries.length;
  return (
    <div className="space-y-7">
      {!soul.role ? null : (
        <ProfileSection title="Job">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
            {soul.role}
          </p>
        </ProfileSection>
      )}
      {!soul.personality ? null : (
        <ProfileSection title="Voice and temperament">
          <div className="rounded-xl border border-border bg-muted/20 p-4">
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
              {soul.personality}
            </p>
          </div>
        </ProfileSection>
      )}
      {!soul.expertise.length ? null : (
        <ProfileSection title="Expertise">
          <ul aria-label="Expertise" className="flex flex-wrap gap-2">
            {soul.expertise.map((item, i) => (
              <li
                key={i}
                className="max-w-full break-words rounded-md border border-border bg-muted/30 px-2.5 py-1 text-xs text-muted-foreground [overflow-wrap:anywhere]"
              >
                {item}
              </li>
            ))}
          </ul>
        </ProfileSection>
      )}
      {!soul.principles.length && !soul.boundaries.length ? null : (
        <div className="grid gap-6 border-t border-border pt-6 @5xl/souls:grid-cols-2">
          <ProfileRules title="Always" items={soul.principles} icon="Check" />
          <ProfileRules title="Never" items={soul.boundaries} icon="X" />
        </div>
      )}
      {empty ? (
        <PageMessage
          icon="Edit"
          title="Give this soul a little direction"
          action={
            <Button size="sm" variant="outline" onClick={onEdit}>
              Edit soul
            </Button>
          }
        >
          Add a job, a voice or a few principles to make the persona useful.
        </PageMessage>
      ) : null}
    </div>
  );
}
