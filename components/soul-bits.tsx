// Small presentational pieces the library page, the composer picker, and the
// review card all share. Colors come from host theme tokens only — never
// hardcoded literals — so custom palettes keep working.
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { MOTION, type Mood } from "../motion";
import { PORTRAIT_SIZE, portraitRuns } from "../portrait";
import {
  describeModelPin,
  soulPortrait,
  type PortraitSubject,
  type Soul,
  type SoulDraftValue,
  type SoulModelPin,
} from "../shared";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
      {children}
    </span>
  );
}

const PILL_TONES = {
  neutral: "border-border bg-muted text-muted-foreground",
  success: "border-success/30 bg-success/10 text-success",
  attention: "border-warning/30 bg-warning/10 text-warning-text",
} as const;

/**
 * A one-line status: an icon and a few words, in a host status tone. Pass
 * `labelClassName` (say `@max-lg:sr-only`) to fold it to its icon when the
 * surrounding container is narrow; the words stay for screen readers.
 */
export function Pill({
  icon,
  tone = "neutral",
  title,
  labelClassName,
  children,
}: {
  icon?: string;
  tone?: keyof typeof PILL_TONES;
  title?: string;
  labelClassName?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
        PILL_TONES[tone],
      )}
    >
      {icon === undefined ? null : <Icon name={icon} className="size-3 shrink-0" />}
      <span className={labelClassName}>{children}</span>
    </span>
  );
}

/** True when the user asked the system for less motion. */
export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (media === undefined) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

const ms = (value: number) => `${value}ms`;

type SoulPortraitProps = {
  soul: PortraitSubject;
  mood?: Mood;
  className?: string;
};

/**
 * A soul's pixel-art portrait (see portrait.ts), drawn as crisp SVG runs.
 * Keep its rendered size a multiple of 24px so every art pixel stays square.
 *
 * Pass `mood` to animate it for what the thread is doing (see motion.ts):
 * stepped SVG animations, so pixels never blur between frames. With reduced
 * motion it holds a still frame that still shows the mood.
 */
function SoulPortraitView({ soul, mood, className }: SoulPortraitProps) {
  const look = JSON.stringify(soul.look ?? null);
  const portrait = useMemo(
    () => soulPortrait(soul),
    // The subject is often a fresh object; these are what change the face.
    [soul.id, soul.name, soul.emoji, look],
  );
  const runs = useMemo(() => portraitRuns(portrait), [portrait]);
  const reduced = usePrefersReducedMotion();
  const motion = mood === undefined ? null : MOTION[mood];
  const live = motion !== null && !reduced;
  const frames = motion?.frames ?? [];
  const cycle = frames.length * (motion?.frameMs ?? 0);
  const still = mood === "thinking" ? 2 : 0;
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${PORTRAIT_SIZE} ${PORTRAIT_SIZE}`}
      shapeRendering="crispEdges"
      className={cn("block shrink-0", className)}
    >
      <rect width={PORTRAIT_SIZE} height={PORTRAIT_SIZE} fill={portrait.background} />
      {/* Keyed by mood: a new mood mounts fresh SMIL timelines, never stale frames. */}
      <g key={`figure-${mood ?? "still"}`}>
        {runs.map((run) => (
          <rect key={`${run.x},${run.y}`} x={run.x} y={run.y} width={run.width} height={1} fill={run.colour} />
        ))}
        {motion === null || (motion.eyes === "blink" && !live) ? null : (
          <g opacity={motion.eyes === "closed" ? 1 : 0}>
            {portrait.blink.map((pixel) => (
              <rect key={`${pixel.x},${pixel.y}`} x={pixel.x} y={pixel.y} width={1} height={1} fill={pixel.colour} />
            ))}
            {motion.eyes === "blink" ? (
              <animate attributeName="opacity" values="0;1;0" keyTimes="0;0.95;0.98" dur="4.4s" calcMode="discrete" repeatCount="indefinite" />
            ) : null}
          </g>
        )}
        {live && motion.figure.length > 1 ? (
          <animateTransform
            attributeName="transform"
            type="translate"
            values={motion.figure.map(([x, y]) => `${x} ${y}`).join(";")}
            dur={ms(motion.figure.length * motion.figureMs)}
            calcMode="discrete"
            repeatCount="indefinite"
          />
        ) : null}
      </g>
      <g key={`overlay-${mood ?? "still"}-${live ? "live" : "still"}`}>
      {frames.map((frame, index) =>
        !live && index !== Math.min(still, frames.length - 1) ? null : (
          <g key={index} opacity={live ? (index === 0 ? 1 : 0) : 1}>
            {frame.map((pixel) => (
              <rect key={`${pixel.x},${pixel.y}`} x={pixel.x} y={pixel.y} width={1} height={1} fill={pixel.colour} />
            ))}
            {live && frames.length > 1 ? (
              <animate
                attributeName="opacity"
                values={frames.map((_, other) => (other === index ? "1" : "0")).join(";")}
                dur={ms(cycle)}
                calcMode="discrete"
                repeatCount="indefinite"
              />
            ) : null}
          </g>
        ),
      )}
      </g>
    </svg>
  );
}

/**
 * The portrait only redraws when its face, mood or size changes: callers pass
 * fresh subject objects, and a busy banner re-renders often.
 */
export const SoulPortrait = memo(
  SoulPortraitView,
  (before: SoulPortraitProps, after: SoulPortraitProps) =>
    before.mood === after.mood &&
    before.className === after.className &&
    before.soul.id === after.soul.id &&
    before.soul.name === after.soul.name &&
    before.soul.emoji === after.soul.emoji &&
    JSON.stringify(before.soul.look ?? null) === JSON.stringify(after.soul.look ?? null),
);

/**
 * A soul's own colours as an ambient wash: its portrait, enlarged and blurred
 * behind the content. Size and place it with `className` inside a
 * `relative overflow-hidden` parent.
 */
export function SoulAura({ soul, className }: { soul: PortraitSubject; className?: string }) {
  return (
    <span aria-hidden className={cn("pointer-events-none absolute select-none blur-2xl saturate-150", className)}>
      <SoulPortrait soul={soul} className="size-full" />
    </span>
  );
}

/** A small uppercase label above a group of persona details. */
export function Overline({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

/**
 * Hard limits and working principles as scannable lists: a cross for what the
 * soul never does, a tick for what it always does.
 */
export function RuleList({
  kind,
  items,
}: {
  kind: "never" | "always";
  items: readonly string[];
}) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={item} className="flex gap-2 text-sm leading-snug">
          <Icon
            name={kind === "never" ? "X" : "Check"}
            className={cn(
              "mt-0.5 size-3.5 shrink-0",
              kind === "never" ? "text-destructive" : "text-success",
            )}
          />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** The standard keyboard focus ring for plugin-drawn controls. */
export const FOCUS_RING =
  "outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      {children}
      {hint === undefined ? null : (
        <span className="block text-xs text-muted-foreground">{hint}</span>
      )}
    </label>
  );
}

function linesOf(value: readonly string[]): string {
  return value.join("\n");
}

function parseLines(raw: string): string[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * One item per line. The textarea keeps its own text so a trailing newline
 * survives — filtering blank lines on each keystroke made Enter a no-op.
 */
export function LinesInput({
  value,
  onChange,
  placeholder,
  rows = 3,
  ariaLabel,
}: {
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  rows?: number;
  ariaLabel: string;
}) {
  const [text, setText] = useState(() => linesOf(value));
  const emitted = useRef(linesOf(value));

  useEffect(() => {
    const next = linesOf(value);
    if (next !== emitted.current) {
      emitted.current = next;
      setText(next);
    }
  }, [value]);

  return (
    <Textarea
      aria-label={ariaLabel}
      rows={rows}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        const raw = event.target.value;
        const lines = parseLines(raw);
        emitted.current = linesOf(lines);
        setText(raw);
        onChange(lines);
      }}
    />
  );
}

export function ModelPinFields({
  value,
  onChange,
}: {
  value: SoulModelPin;
  onChange: (next: SoulModelPin) => void;
}) {
  const set = (part: keyof NonNullable<SoulModelPin>, next: string) => {
    const merged = {
      providerId: value?.providerId ?? null,
      model: value?.model ?? null,
      reasoningLevel: value?.reasoningLevel ?? null,
      [part]: next === "" ? null : next,
    };
    onChange(
      merged.providerId === null &&
        merged.model === null &&
        merged.reasoningLevel === null
        ? null
        : merged,
    );
  };
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-foreground">
        Preferred model (optional)
      </span>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input
          aria-label="Provider id"
          placeholder="provider id"
          value={value?.providerId ?? ""}
          onChange={(event) => set("providerId", event.target.value)}
        />
        <Input
          aria-label="Model"
          placeholder="model"
          value={value?.model ?? ""}
          onChange={(event) => set("model", event.target.value)}
        />
        <Input
          aria-label="Reasoning level"
          placeholder="reasoning"
          value={value?.reasoningLevel ?? ""}
          onChange={(event) => set("reasoningLevel", event.target.value)}
        />
      </div>
      <span className="block text-xs text-muted-foreground">
        Applied to the composer's pickers when you choose this soul in a thread.
        Leave blank to keep whatever the thread already uses.
      </span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="space-y-1">
        {items.map((item) => (
          <li key={item} className="flex gap-2 text-sm">
            <span aria-hidden className="text-muted-foreground">
              •
            </span>
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The read-only view of a soul: the library detail and the review card. */
export type SoulBodyView = Pick<
  Soul,
  | "tagline"
  | "role"
  | "personality"
  | "expertise"
  | "principles"
  | "boundaries"
  | "model"
>;

export function SoulBody({ soul }: { soul: SoulBodyView | SoulDraftValue }) {
  const pin = describeModelPin(soul.model);
  return (
    <div className="space-y-4">
      {soul.tagline === "" ? null : (
        <p className="text-sm text-muted-foreground">{soul.tagline}</p>
      )}
      {soul.role === "" ? null : (
        <Section title="Job">
          <p className="text-sm">{soul.role}</p>
        </Section>
      )}
      {soul.personality === "" ? null : (
        <Section title="Voice and temperament">
          <p className="whitespace-pre-wrap text-sm">{soul.personality}</p>
        </Section>
      )}
      {soul.expertise.length === 0 ? null : (
        <Section title="Expertise">
          <div className="flex flex-wrap gap-1.5">
            {soul.expertise.map((item) => (
              <Chip key={item}>{item}</Chip>
            ))}
          </div>
        </Section>
      )}
      <List title="Always" items={soul.principles} />
      <List title="Never" items={soul.boundaries} />
      {pin === null ? null : (
        <p className="text-xs text-muted-foreground">Preferred model: {pin}</p>
      )}
    </div>
  );
}
