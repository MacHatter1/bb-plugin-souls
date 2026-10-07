// Import only produces drafts. The editor's explicit Create soul action is
// the sole save path; source changes invalidate previews, Back preserves edits.
import { useEffect, useId, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server";
import type { ImportedAgent } from "../soul-import-formats";
import { MAX_AGENT_IMPORT_LENGTH, type AgentImportFormat, type Soul } from "../shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { SoulEditorDialog } from "./soul-form";

type SourceMethod = "upload" | "paste" | "github";
type Phase = "source" | "choose" | "review";
const METHODS: { id: SourceMethod; label: string; icon: string }[] = [
  { id: "upload", label: "Upload file", icon: "ArrowUp" },
  { id: "paste", label: "Paste text", icon: "Copy" },
  { id: "github", label: "GitHub URL", icon: "ExternalLink" },
];
const MARKDOWN_EXAMPLE = `---
name: Reviewer
description: Review changes for correctness.
model: inherit
---

Read the code before suggesting changes.
Report only findings you can substantiate.
`;
const EXAMPLES: Record<AgentImportFormat, string> = {
  auto: MARKDOWN_EXAMPLE,
  markdown: MARKDOWN_EXAMPLE,
  toml: `name = "Reviewer"
description = "Review changes for correctness."
model = "gpt-5"
model_reasoning_effort = "high"
developer_instructions = """
Read the code before suggesting changes.
Report only findings you can substantiate.
"""`,
  json: `{
  "name": "Reviewer",
  "description": "Review changes for correctness.",
  "prompt": "Read the code before suggesting changes."
}`,
};

function sourceLabel(method: SourceMethod, filename: string, githubUrl: string): string {
  if (method === "github") {
    try { return decodeURIComponent(new URL(githubUrl).pathname.split("/").pop() || "GitHub file"); }
    catch { return "GitHub file"; }
  }
  return filename || "Pasted definition";
}

export function SoulImportDialog({ open, onOpenChange, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (soul: Soul) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const id = useId();
  const [method, setMethod] = useState<SourceMethod>("upload");
  const [phase, setPhase] = useState<Phase>("source");
  const [file, setFile] = useState<{ name: string; size: number; source: string } | null>(null);
  const [source, setSource] = useState("");
  const [filename, setFilename] = useState("");
  const [format, setFormat] = useState<AgentImportFormat>("auto");
  const [githubUrl, setGithubUrl] = useState("");
  const [candidates, setCandidates] = useState<ImportedAgent[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<"file" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const ticket = useRef(0);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setMethod("upload");
      setPhase("source");
      setFile(null);
      setSource("");
      setFilename("");
      setFormat("auto");
      setGithubUrl("");
      setCandidates([]);
      setSelected(null);
      setQuery("");
      setBusy(null);
      setError(null);
      setDragging(false);
      dragDepth.current = 0;
    }
    // Dismissing/unmounting must never reopen the dialog on a late result.
    return () => { ++ticket.current; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (phase === "choose") search.current?.focus();
    if (phase === "source") tabs.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }, [open, phase]);

  const invalidate = () => {
    setCandidates([]);
    setSelected(null);
    setQuery("");
    setError(null);
  };
  const changeMethod = (next: SourceMethod) => {
    if (next === method || busy !== null) return;
    setMethod(next);
    invalidate();
  };

  const loadFile = async (incoming: File) => {
    if (busy !== null) return;
    const mine = ++ticket.current;
    invalidate();
    setFile(null);
    if (incoming.size > MAX_AGENT_IMPORT_LENGTH) {
      setError("This file is too large. Choose an agent file under 128 KB.");
      return;
    }
    setBusy("file");
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await incoming.arrayBuffer());
      if (ticket.current !== mine) return;
      if (text.trim() === "") {
        setError("This file is empty. Choose a file containing an agent definition.");
        return;
      }
      setFile({ name: incoming.name, size: incoming.size, source: text });
    } catch {
      if (ticket.current === mine) setError("Could not read this file. Choose a valid UTF-8 agent file.");
    } finally {
      if (ticket.current === mine) setBusy(null);
    }
  };

  const activeSource = method === "upload" ? file?.source ?? "" : source;
  const activeFilename = method === "upload" ? file?.name ?? "" : filename;
  const ready = busy === null && (method === "github" ? githubUrl : activeSource).trim() !== "";
  const convert = async () => {
    if (!ready) return;
    // Back keeps edited drafts until the source/options are changed.
    if (candidates.length > 0) {
      setPhase(candidates.length > 1 ? "choose" : "review");
      return;
    }
    const mine = ++ticket.current;
    setBusy("preview");
    setError(null);
    try {
      const result = method === "github"
        ? await rpc.call("souls_import_github", { url: githubUrl.trim(), format })
        : await rpc.call("souls_import_preview", { source: activeSource, filename: activeFilename, format });
      if (ticket.current !== mine) return;
      setCandidates(result.agents);
      setSelected(result.agents.length === 1 ? 0 : null);
      setQuery("");
      setPhase(result.agents.length === 1 ? "review" : "choose");
    } catch (cause) {
      if (ticket.current === mine) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (ticket.current === mine) setBusy(null);
    }
  };

  const chosen = selected === null ? undefined : candidates[selected];
  const needle = query.trim().toLocaleLowerCase();
  const visible = candidates.map((agent, index) => ({ agent, index })).filter(({ agent }) =>
    `${agent.draft.name} ${agent.sourceName ?? ""} ${agent.draft.role}`.toLocaleLowerCase().includes(needle));
  const formId = `${id}-source`;
  const title = sourceLabel(method, activeFilename, githubUrl);
  const action = candidates.length > 1 ? "Choose an agent" : candidates.length === 1 ? "Continue review"
    : method === "github" ? "Fetch and review" : "Review draft";

  return (
    <>
      <Dialog open={open && phase !== "review"} onOpenChange={onOpenChange}>
        <DialogContent className={cn(
          "flex max-h-[90dvh] w-full flex-col gap-0 overflow-hidden p-0",
          phase === "choose" ? "sm:max-w-3xl" : "sm:max-w-xl",
        )}>
          <DialogHeader className="shrink-0 border-b border-border px-5 py-5 sm:px-6 sm:pr-12">
            <p className="mb-1 text-xs font-medium text-muted-foreground">1 of 2 · Import</p>
            <DialogTitle className="text-lg leading-tight">{phase === "choose" ? "Choose your agent" : "Import an agent"}</DialogTitle>
            <DialogDescription>
              {phase === "choose" ? "Pick one definition to turn into a soul." : "Bring an existing agent into your soul library."}
            </DialogDescription>
          </DialogHeader>

          {phase === "choose" ? (
            <div className="min-h-0 space-y-4 overflow-y-auto p-5 sm:p-6">
              <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                <Icon name="FileText" className="size-4 shrink-0" />
                <span className="min-w-0 truncate" title={title}>{title}</span>
                <span className="shrink-0">· {candidates.length} agents</span>
              </div>
              <div className="relative">
                <span aria-hidden className="pointer-events-none absolute left-3 top-2.5 text-muted-foreground"><Icon name="Search" className="size-4" /></span>
                <Input ref={search} aria-label="Search agents" className="pl-9" placeholder="Search by name or description…" value={query} onChange={(event) => setQuery(event.target.value)} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <fieldset className="min-w-0 sm:h-80">
                  <legend className="sr-only">Agent definition</legend>
                  <div className="max-h-56 space-y-2 overflow-y-auto p-0.5 sm:h-full sm:max-h-none" aria-label="Agent definitions">
                    {visible.map(({ agent, index }) => (
                      <label key={index} className={cn(
                        "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors hover:bg-state-hover",
                        selected === index ? "border-foreground/30 bg-state-active" : "border-border",
                      )}>
                        <input
                          type="radio" name={`${id}-agent`} value={index} checked={selected === index}
                          onChange={() => setSelected(index)}
                          className="mt-0.5 size-4 shrink-0 accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        />
                        <span className="min-w-0 space-y-1">
                          <span className="block break-words text-sm font-medium">{agent.draft.name}</span>
                          {agent.sourceName === undefined || agent.sourceName === agent.draft.name ? null : <span className="block break-words font-mono text-xs text-muted-foreground">{agent.sourceName}</span>}
                          <span className="block break-words text-xs leading-relaxed text-muted-foreground">{agent.draft.role || "No description provided."}</span>
                        </span>
                      </label>
                    ))}
                    {visible.length > 0 ? null : <p role="status" className="px-3 py-8 text-center text-sm text-muted-foreground">No matching agents. Try another search.</p>}
                  </div>
                </fieldset>
                <div className="flex min-w-0 flex-col rounded-lg border border-border bg-muted/30 p-4 sm:h-80">
                  {chosen === undefined ? (
                    <div className="flex min-h-40 flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                      <span aria-hidden><Icon name="FileText" className="size-6" /></span>
                      <p>Select an agent to preview its instructions.</p>
                    </div>
                  ) : (
                    <div className="flex min-h-0 flex-1 flex-col gap-3" aria-live="polite">
                      <div className="shrink-0">
                        <p className="break-words text-sm font-medium">{chosen.draft.name}</p>
                        <p className="mt-1 text-xs text-muted-foreground">{chosen.draft.personality.length.toLocaleString()} characters · Instructions</p>
                      </div>
                      <pre tabIndex={0} role="region" aria-label="Selected agent instructions" className="min-h-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:max-h-none sm:flex-1 [overflow-wrap:anywhere]">{chosen.draft.personality}</pre>
                      <p className="shrink-0 text-xs text-muted-foreground">You can edit everything in the next step.</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <form id={formId} className="min-h-0 space-y-4 overflow-y-auto p-5 sm:p-6" aria-busy={busy !== null} onSubmit={(event) => { event.preventDefault(); void convert(); }}>
              <div
                ref={tabs} role="tablist" aria-label="Import source" className="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1"
                onKeyDown={(event) => {
                  const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
                  if (!keys.includes(event.key) || busy !== null) return;
                  event.preventDefault();
                  const current = METHODS.findIndex((item) => item.id === method);
                  const next = event.key === "Home" ? 0 : event.key === "End" ? METHODS.length - 1
                    : (current + (event.key === "ArrowRight" ? 1 : -1) + METHODS.length) % METHODS.length;
                  changeMethod(METHODS[next]!.id);
                  event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
                }}
              >
                {METHODS.map((item) => (
                  <button
                    key={item.id} id={`${id}-tab-${item.id}`} role="tab" type="button"
                    aria-selected={method === item.id} aria-controls={`${id}-panel-${item.id}`}
                    tabIndex={method === item.id ? 0 : -1} disabled={busy !== null}
                    onClick={() => changeMethod(item.id)}
                    className={cn("flex min-w-0 items-center justify-center gap-2 rounded-md px-2 py-2 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 sm:text-sm",
                      method === item.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    <span aria-hidden className="hidden sm:block"><Icon name={item.icon} className="size-4" /></span>{item.label}
                  </button>
                ))}
              </div>

              <div id={`${id}-panel-${method}`} role="tabpanel" aria-labelledby={`${id}-tab-${method}`}>
                {method === "upload" ? (
                  <div className="space-y-3">
                    <input
                      ref={fileInput} type="file" aria-label="Agent file" hidden
                      accept=".toml,.md,.json,.jsonc,text/plain,application/toml,application/json,text/markdown" disabled={busy !== null}
                      onChange={(event) => { const incoming = event.target.files?.[0]; event.target.value = ""; if (incoming !== undefined) void loadFile(incoming); }}
                    />
                    <div
                      className={cn("rounded-xl border-2 border-dashed transition-colors", dragging ? "border-foreground/50 bg-state-active" : "border-border")}
                      onDragEnter={(event) => {
                        if (!event.dataTransfer.types.includes("Files")) return;
                        event.preventDefault();
                        if (busy !== null) return;
                        ++dragDepth.current; setDragging(true);
                      }}
                      onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragging(false); }}
                      onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = busy === null ? "copy" : "none"; } }}
                      onDrop={(event) => {
                        event.preventDefault(); dragDepth.current = 0; setDragging(false);
                        if (busy !== null) return;
                        if (event.dataTransfer.files.length !== 1) { setError("Drop one agent file at a time. A configuration file can contain multiple agents."); return; }
                        void loadFile(event.dataTransfer.files[0]!);
                      }}
                    >
                      {file === null ? (
                        <button type="button" disabled={busy !== null} onClick={() => fileInput.current?.click()} className="flex min-h-32 w-full flex-col items-center justify-center gap-3 rounded-xl px-4 py-6 text-center outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60">
                          <span aria-hidden className="rounded-lg border border-border bg-background p-2.5"><Icon name={busy === "file" ? "Loading" : "ArrowUp"} className={cn("size-5 text-muted-foreground", busy === "file" && "motion-safe:animate-spin")} /></span>
                          <span><span className="block text-sm font-medium">{busy === "file" ? "Reading your file…" : dragging ? "Drop your agent file" : "Choose a file or drag it here"}</span><span className="mt-1 block text-xs text-muted-foreground">TOML · Markdown · JSON / JSONC <span className="whitespace-nowrap">· Up to 128 KB</span></span></span>
                        </button>
                      ) : (
                        <div className="space-y-4 p-4">
                          <div className="flex items-center gap-3">
                            <span aria-hidden className="shrink-0 rounded-lg border border-border bg-background p-2.5"><Icon name="FileText" className="size-5" /></span>
                            <div className="min-w-0 flex-1" role="status">
                              <p className="truncate text-sm font-medium" title={file.name}>{file.name}</p>
                              <p className="mt-1 text-xs text-muted-foreground">{file.size < 1000 ? `${file.size} bytes` : `${(file.size / 1000).toFixed(1)} KB`} · File loaded</p>
                            </div>
                            <Button type="button" variant="ghost" size="icon" aria-label="Remove file" disabled={busy !== null} onClick={() => { setFile(null); invalidate(); }}><Icon name="X" /></Button>
                          </div>
                          <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => fileInput.current?.click()}>Replace file</Button>
                        </div>
                      )}
                    </div>
                    <p className="text-xs leading-relaxed text-muted-foreground">Agent definitions only. Plain AGENTS.md files aren’t supported.</p>
                  </div>
                ) : method === "paste" ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor={`${id}-contents`} className="text-sm font-medium">Agent definition</label>
                      {source !== "" ? <span className="text-xs text-muted-foreground">{source.length.toLocaleString()} characters</span> : <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => { setSource(EXAMPLES[format]); invalidate(); }}>Use example</Button>}
                    </div>
                    <Textarea id={`${id}-contents`} className="min-h-52 resize-y font-mono text-xs leading-relaxed" rows={9} placeholder={EXAMPLES[format]} value={source} disabled={busy !== null} onChange={(event) => { setSource(event.target.value); invalidate(); }} />
                    <label className="block space-y-1.5">
                      <span className="text-xs font-medium">Filename <span className="font-normal text-muted-foreground">(optional)</span></span>
                      <Input className="h-8 text-xs" placeholder="reviewer.agent.md" maxLength={255} value={filename} disabled={busy !== null} onChange={(event) => { setFilename(event.target.value); invalidate(); }} />
                      <span className="block text-xs text-muted-foreground">Supplies the name if the definition doesn't have one.</span>
                    </label>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <label className="block space-y-2">
                      <span className="text-sm font-medium">GitHub file URL</span>
                      <Input type="url" placeholder="https://github.com/owner/repo/blob/main/agent.md" value={githubUrl} maxLength={2048} disabled={busy !== null} onChange={(event) => { setGithubUrl(event.target.value); invalidate(); }} />
                    </label>
                    <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
                      <p>Link to a file in a public repository. GitHub file pages and raw.githubusercontent.com links both work.</p>
                      <p className="mt-2">Private repository? Upload the file or paste its contents instead.</p>
                    </div>
                  </div>
                )}
              </div>

              <details className="rounded-lg border border-border px-3 py-2.5">
                <summary className="cursor-pointer text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">Import options <span className="ml-2 font-normal text-muted-foreground">{format === "auto" ? "Auto-detect format" : format === "markdown" ? "Markdown" : format === "json" ? "JSON / JSONC" : "Codex TOML"}</span></summary>
                <label className="mt-3 block space-y-1.5 text-xs">
                  <span>File format</span>
                  <select className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" value={format} disabled={busy !== null} onChange={(event) => { setFormat(event.target.value as AgentImportFormat); invalidate(); }}>
                    <option value="auto">Auto-detect</option><option value="toml">Codex TOML</option><option value="markdown">Markdown + YAML frontmatter</option><option value="json">JSON / JSONC</option>
                  </select>
                  <span className="block text-muted-foreground">Usually detected from the filename or contents. Override only if needed.</span>
                </label>
              </details>
              {candidates.length === 0 ? null : <p role="status" className="text-xs text-muted-foreground">Your draft edits are kept. Changing the source or import options starts a new preview.</p>}

            </form>
          )}

          <div className="shrink-0 border-t border-border px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6">
            {phase !== "source" || error === null ? null : (
                <div role="alert" className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  <span aria-hidden className="mt-0.5 shrink-0"><Icon name="AlertCircle" className="size-4" /></span>
                  <p tabIndex={0} className="min-w-0 max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground [overflow-wrap:anywhere]">{error}</p>
                </div>
              )}
            <DialogFooter className="flex-row items-center justify-between gap-2 sm:justify-between sm:space-x-0">
              {phase === "choose" ? <Button type="button" variant="ghost" className="h-10 px-2 sm:h-9 sm:px-4" onClick={() => setPhase("source")}><Icon name="ArrowLeft" />Back</Button> : <Button type="button" variant="ghost" className="h-10 px-2 sm:h-9 sm:px-4" onClick={() => onOpenChange(false)}>Cancel</Button>}
              {phase === "choose" ? (
                <div className="flex items-center gap-2">
                  <Button type="button" variant="ghost" className="h-10 px-2 sm:h-9 sm:px-4" onClick={() => onOpenChange(false)}>Cancel</Button>
                  <Button type="button" aria-label="Review agent" className="h-10 sm:h-9" disabled={chosen === undefined} onClick={() => setPhase("review")}><span>Review<span className="hidden sm:inline"> agent</span></span><Icon name="ArrowRight" /></Button>
                </div>
              ) : (
                <Button type="submit" className="h-10 sm:h-9" form={formId} disabled={!ready}>
                  {busy === null ? null : <Icon name="Loading" className="motion-safe:animate-spin" />}
                  {busy === "file" ? "Reading file…" : busy === "preview" ? method === "github" ? "Fetching file…" : "Reading definition…" : action}
                  {busy === null ? <Icon name="ArrowRight" /> : null}
                </Button>
              )}
            </DialogFooter>
            <p className="mt-3 text-center text-xs text-muted-foreground">Nothing is saved until you click Create soul.</p>
          </div>
        </DialogContent>
      </Dialog>
      {open && phase === "review" && chosen !== undefined ? (
        <SoulEditorDialog
          open existing={null} initialDraft={chosen.draft} importWarnings={chosen.warnings}
          onOpenChange={onOpenChange} onSaved={onSaved}
          onBack={(draft) => {
            setCandidates((current) => current.map((agent, index) => index === selected ? { ...agent, draft } : agent));
            setPhase(candidates.length > 1 ? "choose" : "source");
          }}
        />
      ) : null}
    </>
  );
}
