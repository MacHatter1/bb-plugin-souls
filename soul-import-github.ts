// The only network import path. Fetch public GitHub files on the server,
// never arbitrary hosts, redirects, credentials or referenced config files.
import { MAX_AGENT_IMPORT_LENGTH, type AgentImportFormat } from "./shared.ts";
import { importAgentFile } from "./soul-import-formats.ts";

const URL_ERROR = "Use an HTTPS GitHub agent file URL (.toml, .md, .json or .jsonc) (github.com/owner/repo/blob/ref/file.toml or raw.githubusercontent.com/owner/repo/ref/file.toml).";

export function githubAgentFile(input: string): { url: string; filename: string } {
  if (input.length > 2048) throw new Error(URL_ERROR);
  let link: URL;
  try { link = new URL(input.trim()); }
  catch { throw new Error(URL_ERROR); }
  if (link.protocol !== "https:" || link.username !== "" || link.password !== "" || link.port !== "")
    throw new Error(URL_ERROR);

  let parts: string[];
  try { parts = link.pathname.slice(1).split("/").map(decodeURIComponent); }
  catch { throw new Error(URL_ERROR); }
  if (link.hostname === "github.com" || link.hostname === "www.github.com") {
    if (parts.length < 5 || (parts[2] !== "blob" && parts[2] !== "raw")) throw new Error(URL_ERROR);
    parts.splice(2, 1);
  } else if (link.hostname !== "raw.githubusercontent.com") {
    throw new Error(URL_ERROR);
  }
  if (parts.length < 4 || parts.some((part) => part === "" || part === "." || part === ".." || /[\\/\u0000-\u001f\u007f]/.test(part)))
    throw new Error(URL_ERROR);
  if (!/^[a-zA-Z0-9_.-]+$/.test(parts[0]!) || !/^[a-zA-Z0-9_.-]+$/.test(parts[1]!)) throw new Error(URL_ERROR);
  const filename = parts[parts.length - 1]!;
  if (!/\.(?:toml|md|jsonc?)$/i.test(filename)) throw new Error(URL_ERROR);

  // Rebuild from decoded segments; queries (including private-repo tokens)
  // and line anchors are deliberately not forwarded.
  const raw = new URL("https://raw.githubusercontent.com");
  raw.pathname = "/" + parts.map(encodeURIComponent).join("/");
  return { url: raw.href, filename };
}

export async function importGithubAgentFile(input: string, fetchFile: typeof fetch = globalThis.fetch, format: AgentImportFormat = "auto") {
  const file = githubAgentFile(input);
  const signal = AbortSignal.timeout(10_000);
  let source = "";
  try {
    const response = await fetchFile(file.url, {
      signal, redirect: "error", credentials: "omit", headers: { Accept: "text/plain" },
    });
    const tooLarge = () => new Error(`Agent file is too large (maximum ${MAX_AGENT_IMPORT_LENGTH} bytes).`);
    if (!response.ok || Number(response.headers.get("content-length")) > MAX_AGENT_IMPORT_LENGTH) {
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400) throw new Error("GitHub agent file redirects are not allowed.");
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}. Check that the file exists in a public repository, or upload/paste it instead.`);
      throw tooLarge();
    }
    if (response.body === null) throw new Error("GitHub returned an empty agent file.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_AGENT_IMPORT_LENGTH) throw tooLarge();
        try { source += decoder.decode(value, { stream: true }); }
        catch { throw new Error("GitHub agent file must be valid UTF-8."); }
      }
      try { source += decoder.decode(); }
      catch { throw new Error("GitHub agent file must be valid UTF-8."); }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (source.trim() === "") throw new Error("GitHub returned an empty agent file.");
  } catch (cause) {
    if (signal.aborted || (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")))
      throw new Error("Fetching GitHub agent file timed out. Try again, or upload/paste the file instead.");
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Could not fetch GitHub agent file: ${message.slice(0, 400)}`);
  }
  return importAgentFile(source, file.filename, format);
}
