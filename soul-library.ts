// Pure library presentation rules. No storage, navigation or thread authority.
import type { SoulSummary } from "./shared.ts";

export type LibraryFilter = "all" | "in-use";
export type LibrarySort = "name" | "recent";
const names = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function soulBlurb(soul: SoulSummary): string {
  return soul.tagline || soul.role;
}

export function librarySouls(
  souls: readonly SoulSummary[],
  query: string,
  filter: LibraryFilter,
  sort: LibrarySort,
  counts: ReadonlyMap<string, number> | null,
): SoulSummary[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return souls
    .filter((soul) => {
      if (filter === "in-use" && (counts?.get(soul.id) ?? 0) < 1) return false;
      const text =
        `${soul.name} ${soul.tagline} ${soul.role} ${soul.expertise.join(" ")}`.toLocaleLowerCase();
      return words.every((word) => text.includes(word));
    })
    .sort((a, b) => {
      if (sort === "recent") {
        const difference =
          (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
        if (difference !== 0) return difference;
      }
      return names.compare(a.name, b.name) || a.id.localeCompare(b.id);
    });
}

export function librarySelection(
  visible: readonly SoulSummary[],
  pickedId: string | null,
): SoulSummary | null {
  return visible.find((soul) => soul.id === pickedId) ?? visible[0] ?? null;
}

/** Invalid legacy timestamps never become an invented date. */
export function soulUpdatedLabel(value: string): string | null {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(time);
}
