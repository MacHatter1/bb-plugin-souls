import assert from "node:assert/strict";
import { test } from "node:test";
import { githubAgentFile, importGithubAgentFile } from "./soul-import-github.ts";
import { MAX_AGENT_IMPORT_LENGTH } from "./shared.ts";

const blob = "https://github.com/example/repo/blob/main/agents/reviewer.toml";
const raw = "https://raw.githubusercontent.com/example/repo/main/agents/reviewer.toml";
const source = 'developer_instructions = "Read before reviewing."';

const fetcher = (response: Response): typeof fetch => async () => response;

test("GitHub blob, raw and raw.githubusercontent links resolve to the raw TOML file", () => {
  for (const url of [blob, `${blob}?plain=1#L2`, blob.replace("/blob/", "/raw/"), raw]) {
    assert.deepEqual(githubAgentFile(url), { url: raw, filename: "reviewer.toml" });
  }
  assert.deepEqual(githubAgentFile("https://github.com/example/repo/blob/refs/heads/feature/review/agents/Zo%C3%AB%20reviewer.toml"), {
    url: "https://raw.githubusercontent.com/example/repo/refs/heads/feature/review/agents/Zo%C3%AB%20reviewer.toml",
    filename: "Zoë reviewer.toml",
  });
});

test("URL validation only allows HTTPS GitHub file URLs with no credentials or custom port", () => {
  for (const url of [
    "not a url", "http://github.com/example/repo/blob/main/reviewer.toml",
    "https://github.com:8443/example/repo/blob/main/reviewer.toml",
    "https://user:secret@github.com/example/repo/blob/main/reviewer.toml",
    "https://localhost/reviewer.toml", "https://127.0.0.1/reviewer.toml",
    "https://github.com.example.org/example/repo/blob/main/reviewer.toml",
    "https://api.github.com/repos/example/repo/contents/reviewer.toml",
    "https://github.com/example/repo/tree/main/agents",
    "https://github.com/example/repo/blob/main/reviewer.yaml",
    "https://raw.githubusercontent.com/example/repo/reviewer.toml",
    "https://github.com/example/repo/blob/main/agents%2Freviewer.toml",
    "https://raw.githubusercontent.com/example/repo/main/agents%5Creviewer.toml",
    "https://raw.githubusercontent.com/example/repo/main/reviewer.toml/",
  ]) assert.throws(() => githubAgentFile(url), /GitHub.*TOML|GitHub.*\.toml/i, url);
});

test("fetching a URL preserves instructions and uses the remote filename for older configs", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const result = await importGithubAgentFile(blob, async (url, init) => {
    request = { url: String(url), init };
    return new Response(source);
  });
  assert.equal(result.agents[0]!.draft.name, "reviewer");
  assert.equal(result.agents[0]!.draft.personality, "Read before reviewing.");
  assert.equal(request?.url, raw);
  assert.equal(request?.init?.redirect, "error");
  assert.ok(request?.init?.signal instanceof AbortSignal);
  assert.equal(request?.init?.credentials, "omit");
});

test("GitHub imports support Markdown, .agent.md, JSON and JSONC with remote filename hints", async () => {
  for (const [filename, content] of [
    ["reviewer.md", "---\ndescription: Review changes.\n---\nBe precise."],
    ["reviewer.agent.md", "---\n---\nBe precise."],
    ["reviewer.json", '{"prompt":"Be precise."}'],
    ["reviewer.jsonc", '// A profile\n{"prompt":"Be precise.",}'],
  ]) {
    const url = `https://github.com/example/repo/blob/main/agents/${filename}`;
    assert.equal(githubAgentFile(url).filename, filename);
    const result = await importGithubAgentFile(url, fetcher(new Response(content!)));
    assert.equal(result.agents[0]!.draft.name, "reviewer");
    assert.equal(result.agents[0]!.draft.personality, "Be precise.");
  }
  const result = await importGithubAgentFile("https://github.com/example/repo/blob/main/opencode.jsonc",
    fetcher(new Response('{"agent":{"reviewer":{"prompt":"Review."},"planner":{"prompt":"Plan."}}}')));
  assert.deepEqual(result.agents.map((agent) => agent.draft.name), ["reviewer", "planner"]);
});

test("GitHub's explicit format override is applied after a safe download", async () => {
  const result = await importGithubAgentFile(blob, fetcher(new Response("---\nname: Reviewer\n---\nBe precise.")), "markdown");
  assert.equal(result.agents[0]!.draft.name, "Reviewer");
});

test("invalid URLs never trigger a fetch", async () => {
  let calls = 0;
  await assert.rejects(importGithubAgentFile("https://localhost/reviewer.toml", async () => {
    ++calls;
    return new Response(source);
  }), /GitHub/);
  assert.equal(calls, 0);
});

test("HTTP failures, redirects and missing bodies report actionable errors", async () => {
  await assert.rejects(importGithubAgentFile(blob, fetcher(new Response("not found", { status: 404 }))), /404.*public|public.*404/i);
  await assert.rejects(importGithubAgentFile(blob, fetcher(new Response(null, { status: 302, headers: { location: "http://localhost/" } }))), /redirect/i);
  await assert.rejects(importGithubAgentFile(blob, fetcher(new Response(null))), /empty/i);
});

test("the byte limit rejects an oversized Content-Length before reading", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const response = new Response(body, { headers: { "content-length": String(MAX_AGENT_IMPORT_LENGTH + 1) } });
  await assert.rejects(importGithubAgentFile(blob, fetcher(response)), /too large/);
  assert.equal(cancelled, true);
});

test("streaming enforces the actual byte limit without trusting Content-Length", async () => {
  for (const headers of [new Headers(), new Headers({ "content-length": "1" })]) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64_000));
        controller.enqueue(new Uint8Array(64_001));
      },
      cancel() { cancelled = true; },
    });
    await assert.rejects(importGithubAgentFile(blob, fetcher(new Response(body, { headers }))), /too large/);
    assert.equal(cancelled, true);
  }
  await assert.rejects(importGithubAgentFile(blob, fetcher(new Response("é".repeat(64_001)))), /too large/);
});

test("invalid UTF-8 or TOML is rejected, not silently repaired", async () => {
  await assert.rejects(importGithubAgentFile(blob, fetcher(new Response(new Uint8Array([0xff])))), /UTF-8/i);
  await assert.rejects(importGithubAgentFile(blob, fetcher(new Response('name = "unfinished'))), /Invalid agent TOML/);
});

test("network and timeout failures are handled without saving a draft", async () => {
  await assert.rejects(importGithubAgentFile(blob, async () => { throw new TypeError("fetch failed"); }), /Could not fetch GitHub agent file/);
  await assert.rejects(importGithubAgentFile(blob, async () => { throw new DOMException("Timeout", "TimeoutError"); }), /timed out/i);
});
