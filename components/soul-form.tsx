// The hand-editing path: a dialog form over the same fields an AI interview
// fills in. Saving goes through RPC, so the server stays the only writer and
// every open surface refetches from its "souls-changed" signal.
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  EMPTY_DRAFT,
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
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The soul being edited, or null to create one. */
  existing: Soul | null;
  onSaved?: (soul: Soul) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [draft, setDraft] = useState<SoulDraftValue>(() => fromSoul(existing));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reload when the dialog opens or a different soul is opened. A refetch of
  // the same soul must not wipe edits in progress.
  const existingRef = useRef(existing);
  existingRef.current = existing;
  const existingId = existing?.id ?? null;
  useEffect(() => {
    if (!open) return;
    setDraft(fromSoul(existingRef.current));
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl lg:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {existing === null ? "New soul" : `Edit ${existing.name}`}
          </DialogTitle>
          <DialogDescription>
            A soul is a persona you can put any thread into. The agent loads
            all of it when the thread starts, so nothing is cut for length.
          </DialogDescription>
        </DialogHeader>

        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:items-start lg:gap-6">
        <div className="space-y-4">
          <div className="flex items-end gap-3">
            <div className="space-y-1.5">
              <span className="text-xs font-medium text-foreground">
                Emoji
              </span>
              <Input
                aria-label="Emoji"
                className="w-20 text-center text-lg"
                maxLength={8}
                value={draft.emoji}
                onChange={(event) => patch({ emoji: event.target.value })}
              />
            </div>
            <div className="min-w-0 flex-1 space-y-1.5">
              <span className="text-xs font-medium text-foreground">Name</span>
              <Input
                aria-label="Name"
                placeholder="Ada"
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
              />
            </div>
          </div>

          <LookPicker
            subject={{ id: existing?.id, name: draft.name, emoji: draft.emoji === "" ? "✨" : draft.emoji, look: draft.look }}
            onChange={(look) => patch({ look })}
          />

          <Field label="Tagline" hint="One line the pickers show.">
            <Input
              value={draft.tagline}
              maxLength={160}
              placeholder="Staff engineer who ships small, boring, correct changes"
              onChange={(event) => patch({ tagline: event.target.value })}
            />
          </Field>

          <Field label="Job" hint="What this soul is for.">
            <Input
              value={draft.role}
              maxLength={240}
              placeholder="Reviews and refactors the payments service"
              onChange={(event) => patch({ role: event.target.value })}
            />
          </Field>

          <Field
            label="Voice and temperament"
            hint="How it talks and how it thinks. This is the field that makes a soul feel like someone."
          >
            <Textarea
              rows={4}
              value={draft.personality}
              maxLength={2000}
              placeholder="Dry and direct. States the trade-off before the recommendation. Never cheerleads, never hedges…"
              onChange={(event) => patch({ personality: event.target.value })}
            />
          </Field>

          <Field label="Expertise" hint="One per line.">
            <LinesInput
              ariaLabel="Expertise"
              rows={3}
              value={draft.expertise}
              placeholder={"TypeScript\nPostgres\nDistributed systems"}
              onChange={(next) => patch({ expertise: next })}
            />
          </Field>

          <Field label="Always" hint="Working style and standards, one per line.">
            <LinesInput
              ariaLabel="Principles"
              rows={3}
              value={draft.principles}
              placeholder={"Read the code before suggesting a change\nRun the tests it touched"}
              onChange={(next) => patch({ principles: next })}
            />
          </Field>

          <Field label="Never" hint="Hard limits, one per line.">
            <LinesInput
              ariaLabel="Boundaries"
              rows={3}
              value={draft.boundaries}
              placeholder={"Never widen a public type to make a call site compile\nNever touch migrations without asking"}
              onChange={(next) => patch({ boundaries: next })}
            />
          </Field>

          <ModelPinFields
            value={draft.model}
            onChange={(next) => patch({ model: next })}
          />

          <details className="rounded-lg border border-border bg-muted/40 px-3 py-2 lg:hidden">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              What the agent sees
            </summary>
            <AgentPreview text={previewText} />
          </details>

          {error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <aside className="sticky top-0 hidden lg:block">
          <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              What the agent sees
            </p>
            <AgentPreview text={previewText} className="max-h-[50dvh]" />
          </div>
        </aside>
        </div>

        <DialogFooter className="sticky bottom-0 z-10 border-t border-border bg-background pt-4">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={save} disabled={saving || draft.name.trim() === ""}>
            {saving ? "Saving…" : existing === null ? "Create soul" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
