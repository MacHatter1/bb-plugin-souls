// The review card an AI-led interview ends with, and every agent edit.
//
// `souls_propose` and `souls_update` open this through `bb.ui.requestInput`
// and wait. Nothing is written to storage until the user approves here, which
// is what keeps the interview honest: the AI drafts, the person decides. An
// edit reaches every thread running the soul, so it gets the same card.
// `souls_delete` waits on the smaller confirmation at the end of this file.
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { soulDraftSchema, soulSummarySchema } from "../shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Textarea } from "@/components/ui/textarea";
import { Chip, SoulBody, SoulPortrait } from "./soul-bits";

const payloadSchema = z.object({
  draft: soulDraftSchema,
  summary: z.string().max(800).default(""),
  openQuestions: z.array(z.string().max(200)).max(4).default([]),
  existing: soulSummarySchema.nullable().default(null),
  /** For an edit: the fields it changes, as labels. */
  changes: z.array(z.string()).default([]),
  /** This thread already runs as the soul being edited. */
  runsHere: z.boolean().default(false),
  /** The delegation consent this thread has now, so approving keeps it. */
  allowDelegation: z.boolean().default(false),
});

export function SoulReview({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = payloadSchema.safeParse(interaction.payload);
  const initial = parsed.success ? parsed.data : null;
  const [notes, setNotes] = useState("");
  const [revising, setRevising] = useState(false);
  // A new soul offers to run here; an edit leaves the thread's soul alone
  // unless it already runs as this one.
  const [selectHere, setSelectHere] = useState(initial === null || initial.existing === null || initial.runsHere);
  const [allowDelegation, setAllowDelegation] = useState(initial?.allowDelegation ?? false);
  const [busy, setBusy] = useState(false);

  if (!parsed.success) {
    // An unparseable payload is a bug, not a dead end: let the user close it.
    return (
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-destructive">
          This soul review card is malformed and cannot be shown.
        </p>
        <Button variant="outline" size="sm" onClick={() => void cancel()}>
          Dismiss
        </Button>
      </div>
    );
  }

  const { draft, summary, openQuestions, existing, changes, runsHere } = parsed.data;
  const answer = async (value: Parameters<typeof submit>[0]) => {
    if (busy) return;
    setBusy(true);
    try {
      await submit(value);
    } catch (cause) {
      setBusy(false);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    // The card replaces the thread composer, whose row the page cannot
    // scroll. Bound the card to the viewport and scroll inside it instead, so
    // the decision buttons stay reachable at any window height.
    <div className="flex max-h-[min(62dvh,560px)] flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex shrink-0 items-start gap-3">
        <span className="shrink-0 overflow-hidden rounded-lg border border-border/70 shadow-sm">
          <SoulPortrait
            soul={{
              id: existing?.id,
              name: draft.name,
              emoji: draft.emoji,
              look: draft.look ?? existing?.look ?? null,
            }}
            className="size-12"
          />
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-semibold">
              {draft.name}
            </span>
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {existing === null ? "new soul" : `updates ${existing.name}`}
            </span>
          </p>
          {draft.tagline === "" ? null : (
            <p className="line-clamp-2 text-sm text-muted-foreground">
              {draft.tagline}
            </p>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        {existing === null || changes.length === 0 ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Changes</span>
            {changes.map((change) => (
              <Chip key={change}>{change}</Chip>
            ))}
            <span className="text-xs text-muted-foreground">
              · reaches every thread running {existing.name}
            </span>
          </div>
        )}

        {summary === "" ? null : (
          <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            {summary}
          </p>
        )}

        <SoulBody soul={{ ...draft, tagline: "" }} />

        {openQuestions.length === 0 ? null : (
          <div className="space-y-1 rounded-lg border border-border px-3 py-2">
            <p className="text-xs font-medium text-muted-foreground">
              Still open
            </p>
            <ul className="space-y-1">
              {openQuestions.map((question) => (
                <li key={question} className="flex gap-2 text-sm">
                  <Icon
                    name="Info"
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0">{question}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {revising ? (
        <div className="shrink-0 space-y-2 border-t border-border pt-3">
          <Textarea
            autoFocus
            rows={3}
            aria-label="What should change?"
            placeholder="What should change? Be specific — the AI reworks the draft and asks you again."
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setRevising(false);
                setNotes("");
              }}
            >
              Back
            </Button>
            <Button
              size="sm"
              disabled={busy || notes.trim() === ""}
              onClick={() =>
                void answer({ action: "revise", notes: notes.trim() })
              }
            >
              {busy ? "Sending…" : "Send notes"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="shrink-0 space-y-3 border-t border-border pt-3">
          {runsHere ? (
            <p className="text-sm text-muted-foreground">
              This thread runs as {existing?.name ?? draft.name}, so the change applies here too.
            </p>
          ) : (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={selectHere}
                onCheckedChange={(checked) => setSelectHere(checked === true)}
                aria-label="Run this thread as this soul"
                className="mt-0.5"
              />
              <span>Run this thread as {draft.name}</span>
            </label>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={selectHere && allowDelegation}
              disabled={!selectHere}
              onCheckedChange={(checked) => setAllowDelegation(checked === true)}
              aria-label="Allow this soul to spawn and coordinate child threads"
              className="mt-0.5"
            />
            <span>Allow this soul to spawn and coordinate child threads in this thread only. Other approvals are unchanged.</span>
          </label>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
              Dismiss
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setRevising(true)}
            >
              Request changes
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void answer({ action: "approve", selectHere, allowDelegation: selectHere && allowDelegation })}
            >
              {busy ? "Saving…" : existing === null ? "Approve & create" : "Approve changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

const deletePayloadSchema = z.object({
  soul: soulSummarySchema,
  /** How many threads run as it now; they run without a soul afterwards. */
  threads: z.number().int().min(0).default(0),
});

/** The confirmation `souls_delete` waits on. Nothing is deleted without it. */
export function SoulDeleteReview({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = deletePayloadSchema.safeParse(interaction.payload);
  const [busy, setBusy] = useState(false);

  if (!parsed.success) {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <p className="text-sm text-destructive">
          This delete confirmation is malformed, so nothing will be deleted.
        </p>
        <Button variant="outline" size="sm" onClick={() => void cancel()}>
          Dismiss
        </Button>
      </div>
    );
  }

  const { soul, threads } = parsed.data;
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await submit({ action: "delete" });
    } catch (cause) {
      setBusy(false);
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        <span className="shrink-0 overflow-hidden rounded-lg border border-border/70 shadow-sm">
          <SoulPortrait soul={soul} className="size-12" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-base font-semibold">Delete {soul.name}?</p>
          <p className="text-sm text-muted-foreground">
            {threads === 0
              ? "No thread runs as this soul."
              : `${threads} ${threads === 1 ? "thread runs" : "threads run"} as this soul and will run without one from their next session.`}{" "}
            This cannot be undone.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void cancel()}>
          Keep {soul.name}
        </Button>
        <Button variant="destructive" size="sm" disabled={busy} onClick={() => void confirm()}>
          {busy ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </div>
  );
}
