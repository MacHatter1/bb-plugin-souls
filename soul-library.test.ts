import test from "node:test";
import assert from "node:assert/strict";
import {
  librarySelection,
  librarySouls,
  soulBlurb,
  soulUpdatedLabel,
} from "./soul-library.ts";
import { soulSummarySchema } from "./shared.ts";

const summary = (id: string, name: string, extras = {}) =>
  soulSummarySchema.parse({
    id,
    name,
    tagline: "",
    emoji: "✨",
    role: "",
    expertise: [],
    origin: "manual",
    model: null,
    updatedAt: "2026-10-01T12:00:00Z",
    ...extras,
  });
const rows = [
  summary("b", "Specialist 10", {
    role: "Backend engineer",
    expertise: ["Postgres"],
    updatedAt: "2026-10-03T12:00:00Z",
  }),
  summary("a", "Ada", {
    tagline: "Exacting code reviewer",
    role: "Reviews TypeScript",
    expertise: ["Security"],
  }),
  summary("c", "Specialist 2", {
    role: "Backend engineer",
    updatedAt: "invalid legacy date",
  }),
];

test("library searches all summary fields and combines case-insensitive terms across them", () => {
  assert.deepEqual(
    librarySouls(rows, "  ENGINEER  postgres  ", "all", "name", null).map(
      (s) => s.id,
    ),
    ["b"],
  );
  assert.deepEqual(
    librarySouls(rows, "reviewer security", "all", "name", null).map(
      (s) => s.id,
    ),
    ["a"],
  );
  assert.deepEqual(librarySouls(rows, "no match", "all", "name", null), []);
});
test("library sorts names naturally without mutating the RPC summaries", () => {
  assert.deepEqual(
    librarySouls(rows, "", "all", "name", null).map((s) => s.id),
    ["a", "c", "b"],
  );
  assert.deepEqual(
    rows.map((s) => s.id),
    ["b", "a", "c"],
  );
});
test("recent sort uses saved timestamps, tolerates legacy dates and breaks ties by name/id", () => {
  assert.deepEqual(
    librarySouls(rows, "", "all", "recent", null).map((s) => s.id),
    ["b", "a", "c"],
  );
  const ties = [summary("z", "Ada"), summary("a", "ada")];
  assert.deepEqual(
    librarySouls(ties, "", "all", "recent", null).map((s) => s.id),
    ["a", "z"],
  );
});
test("in-use filtering requires positive known selections; unknown does not become an active soul", () => {
  const counts = new Map([
    ["b", 2],
    ["a", 0],
  ]);
  assert.deepEqual(
    librarySouls(rows, "", "in-use", "name", counts).map((s) => s.id),
    ["b"],
  );
  assert.deepEqual(librarySouls(rows, "", "in-use", "name", null), []);
  assert.deepEqual(librarySouls(rows, "ada", "in-use", "name", counts), []);
});
test("selection stays on a visible choice, falls back honestly for search, and handles empty results", () => {
  assert.equal(librarySelection(rows, "a")?.id, "a");
  assert.equal(librarySelection(rows, "missing")?.id, "b");
  assert.equal(librarySelection([], "a"), null);
});
test("blurb and date presentation never manufacture content", () => {
  assert.equal(soulBlurb(rows[1]!), "Exacting code reviewer");
  assert.equal(soulBlurb(rows[0]!), "Backend engineer");
  assert.equal(soulUpdatedLabel("bad timestamp"), null);
  assert.equal(soulUpdatedLabel(""), null);
  assert.ok(soulUpdatedLabel(rows[0]!.updatedAt));
});
