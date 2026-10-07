// The hand-editing path: a dialog form over the same fields an AI interview
// fills in. Saving goes through RPC, so the server stays the only writer and
// every open surface refetches from its "souls-changed" signal.
import { useEffect, useId, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  EMPTY_DRAFT,
  PERSONALITY_MAX_LENGTH,
  renderSoulPersona,
  soulSchema,
  type PortraitSubject,
  type Soul,
  type SoulDraftValue,
  type SoulLook,
} from "../shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Field,
  LinesInput,
  ModelPinFields,
  SoulPortrait,
} from "./soul-bits";
import { Icon } from "@/components/ui/icon";
import {
  ACCESSORY,
  HAIR,
  HEADWEAR,
  PALETTE_NAMES,
  SPECIES,
  accessoriesFor,
  hasHair,
  resolveLook,
  type Look,
} from "../portrait";

type Trait = Exclude<keyof Look, "seed">;
const TRAITS: ReadonlyArray<{ key: Trait; label: string; options: readonly string[] }> = [
  { key: "species", label: "Species", options: SPECIES },
  { key: "hair", label: "Hair", options: HAIR },
  { key: "headwear", label: "Headwear", options: HEADWEAR },
  { key: "accessory", label: "Accessory", options: ACCESSORY },
  { key: "palette", label: "Palette", options: PALETTE_NAMES },
];

/**
 * The soul's pixel-art portrait and the traits behind it. "Auto" leaves a
 * trait to the soul's emoji and seed, and shows what that picks; Shuffle
 * rerolls every trait left on Auto.
 */
function LookPicker({
  subject,
  onChange,
}: {
  subject: PortraitSubject;
  onChange: (look: SoulLook) => void;
}) {
  const pinned = subject.look ?? {};
  const seedId = subject.id ?? (subject.name.trim() || "new soul");
  const resolved = resolveLook(seedId, subject.emoji, subject.look ?? null);
  const set = (key: Trait, value: string) => {
    const next: Record<string, string> = { ...pinned };
    if (value === "") delete next[key];
    else next[key] = value;
    // A pinned accessory the new species cannot wear would never be drawn.
    const species = resolveLook(seedId, subject.emoji, next as Partial<Look>).species;
    if (next.accessory !== undefined && !accessoriesFor(species).includes(next.accessory as Look["accessory"]))
      delete next.accessory;
    onChange(Object.keys(next).length === 0 ? null : (next as SoulLook));
  };
  /** Only what this species can show: no hair on a robot, no glasses on an owl. */
  const optionsFor = (key: Trait, options: readonly string[]) =>
    key === "accessory" ? accessoriesFor(resolved.species) : options;
  const shuffle = () => onChange({ ...pinned, seed: Math.random().toString(36).slice(2, 10) });
  return (
    <div className="flex gap-4 rounded-xl border border-border bg-muted/30 p-3">
      <span className="shrink-0 self-start overflow-hidden rounded-xl border border-border shadow-sm">
        <SoulPortrait soul={subject} className="size-24" />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-foreground">Look</span>
          <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={shuffle}>
            <Icon name="RotateCcw" />
            Shuffle
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {TRAITS.filter(({ key }) => key !== "hair" || hasHair(resolved.species)).map(({ key, label, options }) => (
            <label key={key} className="min-w-0 space-y-1">
              <span className="block text-[11px] text-muted-foreground">{label}</span>
              <select
                aria-label={label}
                value={optionsFor(key, options).includes(pinned[key] ?? "") ? pinned[key] : ""}
                onChange={(event) => set(key, event.target.value)}
                className="h-8 w-full rounded-md border border-input bg-card px-2 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">Auto · {resolved[key]}</option>
                {optionsFor(key, options).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="text-[11px] leading-4 text-muted-foreground">
          Auto picks from the soul's emoji and its own seed. Shuffle rerolls those.
        </p>
      </div>
    </div>
  );
}

function AgentPreview({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <pre
      className={cn(
        "mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground",
        className,
      )}
    >
      {text}
    </pre>
  );
}

function fromSoul(soul: Soul | null): SoulDraftValue {
  if (soul === null) return { ...EMPTY_DRAFT, expertise: [], principles: [], boundaries: [] };
  return {
    name: soul.name,
    tagline: soul.tagline,
    emoji: soul.emoji,
    role: soul.role,
    personality: soul.personality,
    expertise: [...soul.expertise],
    principles: [...soul.principles],
    boundaries: [...soul.boundaries],
    model: soul.model === null ? null : { ...soul.model },
    look: soul.look === null ? null : { ...soul.look },
  };
}

export function SoulEditorDialog({
  open,
  onOpenChange,
  existing,
  initialDraft,
  importWarnings,
  onBack,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The soul being edited, or null to create one. */
  existing: Soul | null;
  /** An imported draft is reviewed here and saved only by Create soul. */
  initialDraft?: SoulDraftValue;
  importWarnings?: string[];
  /** Return to the import source/selector, keeping every unsaved edit. */
  onBack?: (draft: SoulDraftValue) => void;
  onSaved?: (soul: Soul) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<SoulDraftValue>(() => initialDraft ?? fromSoul(existing));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const emojiId = useId();

  // Reload when the dialog opens or a different soul is opened. A refetch of
  // the same soul must not wipe edits in progress.
  const existingRef = useRef(existing);
  existingRef.current = existing;
  const initialDraftRef = useRef(initialDraft);
  initialDraftRef.current = initialDraft;
  const existingId = existing?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraftRef.current ?? fromSoul(existingRef.current));
    setError(null);
  }, [open, existingId]);

  const patch = (next: Partial<SoulDraftValue>) =>
    setDraft((current) => ({ ...current, ...next }));

  const save = async () => {
    if (saving) return;
    const name = draft.name.trim();
    if (name === "") {
      setError("A soul needs a name.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result =
        existing === null
          ? await rpc.call("souls_create", {
              draft: { ...draft, name },
              origin: "manual",
            })
          : await rpc.call("souls_update", {
              id: existing.id,
              patch: { ...draft, name },
            });
      toast.success(
        existing === null
          ? `${result.soul.emoji} ${result.soul.name} created`
          : `${result.soul.emoji} ${result.soul.name} saved`,
      );
      onSaved?.(result.soul);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  // The preview renders the persona `souls_get` hands the agent, so what you
  // see is what the agent gets — a lie here would be the worst kind.
  const preview = soulSchema.safeParse(
    existing === null
      ? {
          ...draft,
          id: "preview",
          origin: "manual",
          createdAt: "",
          updatedAt: "",
        }
      : { ...existing, ...draft },
  );
  const previewText = preview.success
    ? renderSoulPersona(preview.data)
    : `Not a valid soul yet: ${preview.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`;

  const imported = initialDraft !== undefined;
  const importedModel = imported && initialDraft.model !== null;
  const appearance = (
    <LookPicker
      subject={{ id: existing?.id, name: draft.name, emoji: draft.emoji === "" ? "✨" : draft.emoji, look: draft.look }}
      onChange={(look) => patch({ look })}
    />
  );
  const tagline = (
    <Field label="Tagline" hint="One line the pickers show.">
      <Input value={draft.tagline} maxLength={160} placeholder="Staff engineer who ships small, boring, correct changes" onChange={(event) => patch({ tagline: event.target.value })} />
    </Field>
  );
  const modelFields = <ModelPinFields value={draft.model} onChange={(next) => patch({ model: next })} />;
  const importNotes = (
    <details className="rounded-lg border border-border bg-muted/30 text-xs">
      <summary className="cursor-pointer px-3 py-3 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Import details
        {(importWarnings?.length ?? 0) === 0 ? null : <span className="ml-2 font-normal text-muted-foreground">{importWarnings!.length} {importWarnings!.length === 1 ? "note" : "notes"}</span>}
      </summary>
      <div className="space-y-2 border-t border-border p-3 leading-relaxed text-muted-foreground">
        <p>Instructions are preserved. Tool access, permissions and delegation consent are not imported.</p>
        {(importWarnings?.length ?? 0) === 0 ? null : <ul className="list-disc space-y-1.5 pl-4 [overflow-wrap:anywhere]">{importWarnings?.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}
      </div>
    </details>
  );
  const personaDetails = (
    <>
      <Field label="Expertise" hint="One per line.">
        <LinesInput ariaLabel="Expertise" rows={3} value={draft.expertise} placeholder={"TypeScript\nPostgres\nDistributed systems"} onChange={(next) => patch({ expertise: next })} />
      </Field>
      <Field label="Always" hint="Working style and standards, one per line.">
        <LinesInput ariaLabel="Principles" rows={3} value={draft.principles} placeholder={"Read the code before suggesting a change\nRun the tests it touched"} onChange={(next) => patch({ principles: next })} />
      </Field>
      <Field label="Never" hint="Hard limits, one per line.">
        <LinesInput ariaLabel="Boundaries" rows={3} value={draft.boundaries} placeholder={"Never widen a public type to make a call site compile\nNever touch migrations without asking"} onChange={(next) => patch({ boundaries: next })} />
      </Field>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onOpenAutoFocus={(event) => { if (imported) { event.preventDefault(); document.getElementById(nameId)?.focus(); } }} className={cn(
        "max-h-[90dvh] sm:max-w-2xl lg:max-w-4xl",
        imported ? "flex w-full flex-col gap-0 overflow-hidden p-0" : "overflow-y-auto",
      )}>
        <DialogHeader className={imported ? "shrink-0 border-b border-border px-5 py-5 sm:px-6 sm:pr-12" : undefined}>
          {imported ? <p className="mb-1 text-xs font-medium text-muted-foreground">2 of 2 · Review</p> : null}
          <DialogTitle className={imported ? "text-lg leading-tight" : undefined}>
            {existing !== null ? `Edit ${existing.name}` : imported ? "Make this agent your own" : "New soul"}
          </DialogTitle>
          <DialogDescription>
            {imported ? "Review the instructions and details, then create your soul." : "A soul is a persona you can put any thread into. The agent loads all of it when the thread starts, so nothing is cut for length."}
          </DialogDescription>
        </DialogHeader>

        <div className={cn("space-y-5", imported && "min-h-0 overflow-y-auto p-5 sm:p-6")}>

          <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start lg:gap-6">
            <div className="flex min-w-0 flex-col gap-4">
              <div className="flex items-end gap-3">
                <div className="space-y-1.5">
                  <label htmlFor={emojiId} className="text-xs font-medium text-foreground">Emoji</label>
                  <Input id={emojiId} aria-label="Emoji" className="w-16 text-center text-lg" maxLength={8} value={draft.emoji} onChange={(event) => patch({ emoji: event.target.value })} />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <label htmlFor={nameId} className="text-xs font-medium text-foreground">Name</label>
                  <Input id={nameId} aria-label="Name" placeholder="Ada" value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </div>
              </div>
              {imported ? null : appearance}
              {imported ? null : tagline}

              <Field label={imported ? "Description" : "Job"} hint={imported ? undefined : "What this soul is for."}>
                <Input value={draft.role} maxLength={240} placeholder="Reviews and refactors the payments service" onChange={(event) => patch({ role: event.target.value })} />
              </Field>
              <Field
                label={imported ? "Agent instructions" : "Voice and temperament"}
                hint={imported ? "Stored in Voice and temperament. The full prompt stays intact." : "How it talks and how it thinks. This is the field that makes a soul feel like someone."}
              >
                <Textarea
                  rows={imported ? 9 : 4} value={draft.personality} maxLength={PERSONALITY_MAX_LENGTH}
                  className={imported ? "min-h-52 font-mono text-xs leading-relaxed" : undefined}
                  placeholder="Dry and direct. States the trade-off before the recommendation. Never cheerleads, never hedges…"
                  onChange={(event) => patch({ personality: event.target.value })}
                />
              </Field>
              {imported ? <p className="-mt-2 text-right text-xs tabular-nums text-muted-foreground">{draft.personality.length.toLocaleString()} / {PERSONALITY_MAX_LENGTH.toLocaleString()} characters</p> : null}
              {importedModel ? modelFields : null}
              {imported ? <div className="lg:hidden">{importNotes}</div> : null}

              {imported ? (
                <details className="rounded-lg border border-border">
                  <summary className="cursor-pointer px-3 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Customize this soul
                    <span className="mt-1 block pl-4 text-xs font-normal text-muted-foreground">Appearance, tagline, expertise and guidelines</span>
                  </summary>
                  <div className="space-y-4 border-t border-border p-3">
                    {appearance}{tagline}{personaDetails}
                    {importedModel ? null : modelFields}
                  </div>
                </details>
              ) : <>{personaDetails}{modelFields}</>}

              <details className="rounded-lg border border-border bg-muted/30 px-3 py-3 lg:hidden">
                <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">What the agent sees</summary>
                <AgentPreview text={previewText} />
              </details>
              {error === null || imported ? null : <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
            </div>
            <aside className="sticky top-0 hidden min-w-0 lg:block">
              <div className="rounded-lg border border-border bg-muted/30 p-4">
                <p className="text-sm font-medium">What the agent sees</p>
                {imported ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">The complete persona, including your edits.</p> : null}
                <AgentPreview text={previewText} className={cn(imported ? "max-h-[35dvh]" : "max-h-[50dvh]", "break-words leading-relaxed [overflow-wrap:anywhere]")} />
              </div>
              {imported ? <div className="mt-3">{importNotes}</div> : null}
            </aside>
          </div>
        </div>

        <div className={imported ? "shrink-0 border-t border-border px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6" : "sticky bottom-0 z-10 border-t border-border bg-background pt-4"}>
          {imported && error !== null ? <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3"><span aria-hidden className="shrink-0 text-destructive"><Icon name="AlertCircle" className="size-4" /></span><p className="min-w-0 max-h-24 overflow-y-auto break-words text-xs leading-relaxed text-foreground">{error}</p></div> : null}
          <DialogFooter className={imported ? "flex-row items-center justify-between gap-2 sm:justify-between sm:space-x-0" : undefined}>
            {imported && onBack !== undefined ? <Button variant="ghost" className="h-10 px-2 sm:h-9 sm:px-4" disabled={saving} onClick={() => onBack(draft)}><Icon name="ArrowLeft" />Back</Button> : null}
            <div className={cn("flex items-center gap-2", imported ? "ml-auto" : "w-full justify-end")}>
              <Button variant="ghost" className={imported ? "h-10 px-2 sm:h-9 sm:px-4" : undefined} onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
              <Button className={imported ? "h-10 sm:h-9" : undefined} onClick={save} disabled={saving || draft.name.trim() === ""}>
                {saving ? "Saving…" : existing === null ? "Create soul" : "Save"}
              </Button>
            </div>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
