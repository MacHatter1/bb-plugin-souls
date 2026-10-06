// Pixel-art portraits: every soul gets a 24×24 character of its own.
//
// A portrait is generated, never stored as an image: the soul's id seeds the
// choices, its emoji hints at a fitting species or prop (an owl for 🦉, a
// robot for 🛰️), and an optional `look` pins any trait explicitly. The same
// soul always draws the same face. Pure, so the server, the UI and the tests
// all share it; the colours are the art itself, not UI chrome.

export const PORTRAIT_SIZE = 24;

export const SPECIES = ["human", "robot", "owl", "cat", "ghost"] as const;
export const HAIR = ["short", "long", "bun", "spiky", "curly", "bald", "ponytail"] as const;
export const HEADWEAR = ["none", "beanie", "cap", "wizard", "headset", "crown", "beret", "tophat"] as const;
export const ACCESSORY = ["none", "glasses", "shades", "monocle", "beard", "scarf", "bowtie"] as const;
export const PALETTE_NAMES = ["ember", "ocean", "forest", "dusk", "rose", "slate", "gold", "mint"] as const;

export type Species = (typeof SPECIES)[number];
export type Hair = (typeof HAIR)[number];
export type Headwear = (typeof HEADWEAR)[number];
export type Accessory = (typeof ACCESSORY)[number];
export type PaletteName = (typeof PALETTE_NAMES)[number];

export type Look = {
  species: Species;
  hair: Hair;
  headwear: Headwear;
  accessory: Accessory;
  palette: PaletteName;
  /** Rerolls everything not pinned. */
  seed: string;
};

/** A portrait: `size × size` colours, row by row; null is transparent. */
/**
 * A portrait: the backdrop colour, then `size × size` figure colours row by
 * row (null shows the backdrop), and the eyes-closed pixels for a blink.
 */
export type Portrait = {
  size: number;
  background: string;
  pixels: (string | null)[];
  blink: Array<{ x: number; y: number; colour: string }>;
};

// PICO-8's palette, the house style for every portrait.
const P = {
  black: "#000000", navy: "#1d2b53", plum: "#7e2553", green: "#008751",
  brown: "#ab5236", ash: "#5f574f", silver: "#c2c3c7", cream: "#fff1e8",
  red: "#ff004d", orange: "#ffa300", yellow: "#ffec27", lime: "#00e436",
  blue: "#29adff", lavender: "#83769c", pink: "#ff77a8", peach: "#ffccaa",
} as const;

const OUTLINE = "#1a1c2c";

/** Backdrop, clothes and accent for each palette. */
const PALETTES: Record<PaletteName, { bg: string; cloth: string; accent: string }> = {
  ember: { bg: "#ffd7b5", cloth: P.red, accent: P.yellow },
  ocean: { bg: "#bfe6ff", cloth: P.blue, accent: P.orange },
  forest: { bg: "#c8f2c4", cloth: P.green, accent: P.yellow },
  dusk: { bg: "#d9cdf0", cloth: P.lavender, accent: P.pink },
  rose: { bg: "#ffd1e3", cloth: P.plum, accent: P.peach },
  slate: { bg: "#d6d8de", cloth: P.navy, accent: P.blue },
  gold: { bg: "#fff2a8", cloth: P.brown, accent: P.yellow },
  mint: { bg: "#c9f5e6", cloth: "#1f8a70", accent: P.pink },
};

const SKIN = ["#ffccaa", "#f2b48c", "#d08b5b", "#a0663e", "#6b4226"];
const HAIR_COLOURS = [P.navy, P.ash, P.brown, P.orange, "#e8c45c", P.plum, P.silver, P.black];
const FUR = [P.orange, P.ash, P.cream, "#3b3b4f", P.silver];
const FEATHERS = [P.brown, "#8a6a4a", P.silver, P.ash];

/**
 * Emoji that suggest a species or a prop; anything else is left to chance.
 * Base code points only, so an emoji matches with or without its U+FE0F
 * variation selector (🛰 and 🛰️ are both a robot).
 */
const EMOJI_HINTS: Array<[RegExp, Partial<Look>]> = [
  [/🦉/u, { species: "owl" }],
  [/🤖|🦾|⚙|🔧|🛰|🚀|💾|🖥/u, { species: "robot" }],
  [/🐱|🐈|😺|😸|😼|🐯/u, { species: "cat" }],
  [/👻|☁|🌫|🕯/u, { species: "ghost" }],
  [/🧙|🔮|🪄|✨/u, { headwear: "wizard" }],
  [/👑/u, { headwear: "crown" }],
  [/🎩/u, { headwear: "tophat" }],
  [/🎧|🎙|📞/u, { headwear: "headset" }],
  [/🧢|🎖/u, { headwear: "cap" }],
  [/📝|✍|🖋|🎨|🖌/u, { headwear: "beret" }],
  [/🕶|😎/u, { accessory: "shades" }],
  [/🧐/u, { accessory: "monocle" }],
  [/🧪|🔬|🧬|📐|🧭|📚|🤓/u, { accessory: "glasses" }],
  [/🧔/u, { accessory: "beard" }],
];

/** What each species can wear: no glasses without eyes to frame, no beard on a cat. */
const ACCESSORIES: Record<Species, readonly Accessory[]> = {
  human: ACCESSORY,
  cat: ["none", "glasses", "shades", "monocle", "scarf", "bowtie"],
  robot: ["none", "monocle", "scarf", "bowtie"],
  owl: ["none", "monocle"],
  ghost: ["none", "glasses", "shades", "monocle"],
};

export function accessoriesFor(species: Species): readonly Accessory[] {
  return ACCESSORIES[species];
}

/** Only humans draw hair; other species ignore it. */
export function hasHair(species: Species): boolean {
  return species === "human";
}

/** FNV-1a, then mulberry32: a small, stable PRNG per seed string. */
function random(seed: string): () => number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let state = hash >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T;
}

/** Every trait, settled: pinned ones win, then emoji hints, then the seed. */
export function resolveLook(id: string, emoji: string, pinned: Partial<Look> | null = null): Look {
  const seed = pinned?.seed ?? id;
  const next = random(seed);
  const hinted: Partial<Look> = {};
  for (const [pattern, hint] of EMOJI_HINTS) if (pattern.test(emoji)) Object.assign(hinted, hint);
  // Every roll happens, in the same order, whatever is pinned: pinning one
  // trait must never reshuffle the others.
  const rolls = Array.from({ length: 8 }, () => next());
  const choose = <T,>(items: readonly T[], roll: number) => items[Math.floor(roll * items.length)] as T;
  const rolledSpecies: Species = (rolls[0] as number) < 0.6 ? "human" : choose(SPECIES, rolls[1] as number);
  const species = pinned?.species ?? hinted.species ?? rolledSpecies;
  const rolled: Look = {
    species,
    hair: choose(HAIR, rolls[2] as number),
    headwear: (rolls[3] as number) < 0.45 ? "none" : choose(HEADWEAR, rolls[4] as number),
    accessory: (rolls[5] as number) < 0.5 ? "none" : choose(ACCESSORY, rolls[6] as number),
    palette: choose(PALETTE_NAMES, rolls[7] as number),
    seed,
  };
  const look = {
    ...rolled,
    ...hinted,
    ...Object.fromEntries(Object.entries(pinned ?? {}).filter(([, value]) => value !== undefined)),
    species,
    seed,
  } as Look;
  // A trait the species cannot wear is not drawn, so it does not count.
  return ACCESSORIES[species].includes(look.accessory) ? look : { ...look, accessory: "none" };
}

// --- drawing ---------------------------------------------------------------

/** Regions that get rim light and shadow; details stay flat. */
const SHADED = new Set(["skin", "hair", "cloth", "hat", "metal", "feather", "belly", "fur", "ghost", "scarf"]);
/** Small marks painted onto a surface: shading looks through them. */
const DETAILS = new Set(["eye", "glint", "nose", "mouth", "blush", "brow", "mark", "inner", "iris", "disc"]);
/** What closes in a blink. */
const EYES = new Set(["eye", "glint", "iris", "disc"]);

class Sprite {
  readonly size = PORTRAIT_SIZE;
  readonly colour: (string | null)[];
  readonly region: string[];
  /** The surface under any detail painted on it, for shading. */
  readonly base: string[];
  /** The surface colour under any detail, for closing the eyes. */
  readonly baseColour: (string | null)[];

  constructor(background: string) {
    this.colour = new Array<string | null>(this.size * this.size).fill(background);
    this.region = new Array<string>(this.size * this.size).fill("bg");
    this.base = new Array<string>(this.size * this.size).fill("bg");
    this.baseColour = new Array<string | null>(this.size * this.size).fill(background);
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  set(x: number, y: number, region: string, colour: string): void {
    if (!this.inside(x, y)) return;
    const index = y * this.size + x;
    this.colour[index] = colour;
    this.region[index] = region;
    if (!DETAILS.has(region)) {
      this.base[index] = region;
      this.baseColour[index] = colour;
    }
  }

  regionAt(x: number, y: number): string {
    return this.inside(x, y) ? (this.region[y * this.size + x] as string) : "bg";
  }

  baseAt(x: number, y: number): string {
    return this.inside(x, y) ? (this.base[y * this.size + x] as string) : "bg";
  }

  /** Every pixel whose centre falls inside the ellipse, optionally clipped. */
  ellipse(cx: number, cy: number, rx: number, ry: number, region: string, colour: string, keep = (_x: number, _y: number) => true): void {
    for (let y = 0; y < this.size; y += 1)
      for (let x = 0; x < this.size; x += 1) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1 && keep(x, y)) this.set(x, y, region, colour);
      }
  }

  rect(x0: number, y0: number, x1: number, y1: number, region: string, colour: string): void {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) this.set(x, y, region, colour);
  }

  points(points: ReadonlyArray<readonly [number, number]>, region: string, colour: string): void {
    for (const [x, y] of points) this.set(x, y, region, colour);
  }

  /** Mirror a left-side shape onto the right of the 24px canvas. */
  mirrored(points: ReadonlyArray<readonly [number, number]>, region: string, colour: string): void {
    for (const [x, y] of points) {
      this.set(x, y, region, colour);
      this.set(this.size - 1 - x, y, region, colour);
    }
  }

  /** Rim light on the top-left edge of each shaded region, shadow bottom-right. */
  shade(): void {
    const next = [...this.colour];
    for (let y = 0; y < this.size; y += 1)
      for (let x = 0; x < this.size; x += 1) {
        const region = this.regionAt(x, y);
        const colour = this.colour[y * this.size + x];
        if (!SHADED.has(region) || colour === null || colour === undefined) continue;
        if (this.baseAt(x + 1, y) !== region || this.baseAt(x, y + 1) !== region)
          next[y * this.size + x] = mix(colour, OUTLINE, 0.28);
        else if (this.baseAt(x - 1, y) !== region || this.baseAt(x, y - 1) !== region)
          next[y * this.size + x] = mix(colour, "#ffffff", 0.22);
      }
    this.colour.splice(0, this.colour.length, ...next);
  }

  /** A one-pixel dark outline around the figure, the pixel-art way. */
  outline(): void {
    const edge: number[] = [];
    for (let y = 0; y < this.size; y += 1)
      for (let x = 0; x < this.size; x += 1) {
        if (this.regionAt(x, y) !== "bg") continue;
        const touches = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const region = this.regionAt(x + (dx as number), y + (dy as number));
          return region !== "bg" && region !== "line";
        });
        if (touches) edge.push(y * this.size + x);
      }
    for (const index of edge) {
      this.colour[index] = OUTLINE;
      this.region[index] = "outline";
    }
  }
}

/** Blend two #rrggbb colours. */
function mix(a: string, b: string, amount: number): string {
  const channel = (hex: string, offset: number) => parseInt(hex.slice(1 + offset, 3 + offset), 16);
  const value = (offset: number) =>
    Math.round(channel(a, offset) * (1 - amount) + channel(b, offset) * amount)
      .toString(16)
      .padStart(2, "0");
  return `#${value(0)}${value(2)}${value(4)}`;
}

type Kit = { sprite: Sprite; look: Look; next: () => number; skin: string; hair: string };

function shoulders({ sprite, look }: Kit, colour = PALETTES[look.palette].cloth): void {
  sprite.rect(6, 19, 17, 19, "cloth", colour);
  sprite.rect(4, 20, 19, 23, "cloth", colour);
  sprite.rect(3, 22, 20, 23, "cloth", colour);
}

function drawHuman(kit: Kit): void {
  const { sprite, look, next, skin, hair } = kit;
  shoulders(kit);
  // An open collar in the skin tone.
  sprite.points([[10, 19], [11, 19], [12, 19], [13, 19], [11, 20], [12, 20]], "skin", skin);
  sprite.rect(10, 16, 13, 18, "skin", skin);
  sprite.ellipse(12, 11, 5.8, 6.3, "skin", skin);
  sprite.mirrored([[5, 11], [5, 12]], "skin", skin);
  if (look.hair === "long")
    for (let y = 7; y <= 19; y += 1) sprite.mirrored([[5, y], [6, y]], "hair", hair);
  if (look.hair !== "bald") {
    sprite.ellipse(12, 9.4, 6.4, 5.6, "hair", hair, (_x, y) => y <= 7);
    sprite.mirrored([[6, 8], [6, 9], [7, 8]], "hair", hair);
    // A fringe that varies with the seed.
    const fringe = next() < 0.5 ? [8, 9, 10] : [12, 13, 14, 15];
    for (const x of fringe) sprite.set(x, 8, "hair", hair);
  }
  // Hair that rises above the head only shows when no hat sits on it.
  const bareTop = look.headwear === "none" || look.headwear === "headset";
  if (look.hair === "bun" && bareTop) sprite.ellipse(12, 3.2, 2.4, 2.1, "hair", hair);
  if (look.hair === "spiky" && bareTop) for (const x of [7, 9, 11, 13, 15]) sprite.points([[x, 3], [x + 1, 2]], "hair", hair);
  if (look.hair === "curly") {
    sprite.points([[5, 6], [5, 8], [18, 6], [18, 8]], "hair", hair);
    if (bareTop) sprite.points([[8, 3], [12, 2], [16, 3]], "hair", hair);
  }
  if (look.hair === "ponytail") sprite.rect(18, 9, 19, 15, "hair", hair);
  // Brows, eyes, mouth.
  sprite.mirrored([[8, 9], [9, 9]], "brow", mix(hair, OUTLINE, 0.3));
  if (next() < 0.45) sprite.mirrored([[9, 11], [9, 12]], "eye", OUTLINE);
  else {
    sprite.mirrored([[8, 11], [9, 11], [8, 12], [9, 12]], "eye", OUTLINE);
    sprite.mirrored([[9, 11]], "glint", P.cream);
  }
  sprite.set(12, 13, "nose", mix(skin, OUTLINE, 0.22));
  sprite.points([[11, 15], [12, 15]], "mouth", mix(skin, OUTLINE, 0.55));
  if (next() < 0.6) sprite.points([[10, 14], [13, 14]], "mouth", mix(skin, OUTLINE, 0.55));
  if (next() < 0.5) sprite.mirrored([[7, 13]], "blush", mix(skin, P.red, 0.35));
}

function drawRobot(kit: Kit): void {
  const { sprite, look } = kit;
  const metal = look.palette === "slate" ? P.silver : mix(P.silver, PALETTES[look.palette].cloth, 0.25);
  const accent = PALETTES[look.palette].accent;
  shoulders(kit, mix(metal, OUTLINE, 0.15));
  sprite.rect(10, 16, 13, 18, "joint", P.ash);
  sprite.rect(6, 5, 17, 16, "metal", metal);
  sprite.points([[6, 5], [17, 5], [6, 16], [17, 16]], "bg", PALETTES[look.palette].bg);
  sprite.rect(11, 2, 12, 4, "joint", P.ash);
  sprite.ellipse(12, 1.6, 1.6, 1.3, "light", accent);
  sprite.rect(7, 9, 16, 12, "visor", P.navy);
  sprite.mirrored([[9, 10], [10, 10], [9, 11], [10, 11]], "light", accent);
  sprite.mirrored([[9, 10]], "glint", P.cream);
  for (let x = 9; x <= 14; x += 1) sprite.set(x, 14, "grille", x % 2 === 0 ? P.navy : P.ash);
  sprite.mirrored([[5, 10], [5, 11]], "light", accent);
}

function drawOwl(kit: Kit): void {
  const { sprite, look, next } = kit;
  const feather = pick(next, FEATHERS);
  const belly = feather === P.silver ? P.cream : mix(feather, P.cream, 0.55);
  sprite.ellipse(12, 15.5, 8.6, 9.2, "feather", feather);
  sprite.ellipse(12, 9.5, 7.2, 5.8, "feather", feather);
  sprite.mirrored([[5, 3], [5, 4], [6, 4], [6, 5]], "feather", feather);
  sprite.ellipse(12, 19.5, 4.8, 5, "belly", belly);
  for (const [x, y] of [[10, 17], [14, 17], [12, 20]] as const) sprite.set(x, y, "mark", mix(belly, feather, 0.5));
  sprite.mirrored([[4, 14], [4, 15], [4, 16], [5, 17], [4, 18], [5, 19]], "wing", mix(feather, OUTLINE, 0.35));
  // Big round eyes in a facial disc.
  sprite.ellipse(9, 10, 2.9, 2.9, "disc", P.cream);
  sprite.ellipse(15, 10, 2.9, 2.9, "disc", P.cream);
  sprite.ellipse(9, 10, 1.6, 1.6, "iris", look.palette === "ocean" ? P.orange : P.yellow);
  sprite.ellipse(15, 10, 1.6, 1.6, "iris", look.palette === "ocean" ? P.orange : P.yellow);
  sprite.points([[8, 9], [8, 10], [14, 9], [14, 10]], "eye", OUTLINE);
  sprite.points([[8, 9], [14, 9]], "glint", P.cream);
  sprite.points([[11, 12], [12, 12], [11, 13], [12, 13], [11, 14]], "beak", P.orange);
}

function drawCat(kit: Kit): void {
  const { sprite, look, next } = kit;
  const fur = pick(next, FUR);
  shoulders(kit);
  sprite.rect(10, 16, 13, 18, "fur", fur);
  sprite.ellipse(12, 12, 6.6, 5.9, "fur", fur);
  sprite.mirrored([[6, 4], [6, 5], [7, 5], [6, 6], [7, 6], [8, 6], [6, 7], [7, 7], [8, 7], [9, 7]], "fur", fur);
  sprite.mirrored([[7, 6], [7, 7], [8, 7]], "inner", P.pink);
  if (next() < 0.5) sprite.mirrored([[9, 7], [10, 7]], "mark", mix(fur, OUTLINE, 0.35));
  const eye = look.palette === "forest" ? P.yellow : P.lime;
  sprite.mirrored([[8, 11], [9, 11], [8, 12], [9, 12]], "iris", eye);
  sprite.mirrored([[9, 11], [9, 12]], "eye", OUTLINE);
  sprite.points([[11, 14], [12, 14]], "nose", P.pink);
  sprite.points([[10, 15], [11, 15], [12, 15], [13, 15]], "mouth", mix(fur, OUTLINE, 0.6));
  sprite.set(11, 15, "fur", fur);
  sprite.set(12, 15, "fur", fur);
  sprite.mirrored([[10, 15], [11, 16]], "mouth", mix(fur, OUTLINE, 0.6));
}

function drawGhost(kit: Kit): void {
  const { sprite, look, next } = kit;
  const body = look.palette === "slate" ? P.cream : mix(P.cream, PALETTES[look.palette].bg, 0.25);
  sprite.ellipse(12, 11, 7.4, 7.4, "ghost", body, (_x, y) => y <= 11);
  sprite.rect(5, 11, 18, 20, "ghost", body);
  for (let x = 5; x <= 18; x += 1) if (Math.floor((x - 5) / 2) % 2 === 0) sprite.set(x, 21, "ghost", body);
  sprite.mirrored([[8, 10], [9, 10], [8, 11], [9, 11], [8, 12], [9, 12]], "eye", OUTLINE);
  if (next() < 0.7) sprite.mirrored([[7, 14]], "blush", P.pink);
  if (next() < 0.5) sprite.points([[11, 15], [12, 15], [11, 16], [12, 16]], "mouth", OUTLINE);
}

function drawHeadwear({ sprite, look }: Kit): void {
  const { accent, cloth } = PALETTES[look.palette];
  const hat = mix(cloth, OUTLINE, 0.2);
  const owl = look.species === "owl";
  const top = look.species === "robot" ? 4 : owl ? 3 : 4;
  switch (look.headwear) {
    case "beanie":
      sprite.ellipse(12, top + 4.5, 6.6, 4.6, "hat", hat, (_x, y) => y <= top + 4);
      sprite.rect(6, top + 4, 17, top + 5, "band", mix(hat, "#ffffff", 0.3));
      sprite.ellipse(12, top - 0.5, 1.5, 1.4, "hat", accent);
      break;
    case "cap":
      sprite.ellipse(12, top + 4.5, 6.4, 4.4, "hat", hat, (_x, y) => y <= top + 4);
      sprite.rect(5, top + 5, 18, top + 5, "brim", mix(hat, OUTLINE, 0.35));
      sprite.set(12, top, "hat", accent);
      break;
    case "wizard":
      for (let y = 0; y <= top + 3; y += 1) {
        const half = Math.floor((y + 1) / 2) + 1;
        sprite.rect(12 - half, y, 11 + half, y, "hat", P.navy);
      }
      sprite.rect(4, top + 4, 19, top + 4, "brim", P.navy);
      sprite.points([[12, 3], [11, 5], [13, 6]], "star", P.yellow);
      break;
    case "headset":
      for (let x = 7; x <= 16; x += 1) sprite.set(x, top - 1, "band", OUTLINE);
      sprite.mirrored([[6, top], [5, top + 1]], "band", OUTLINE);
      sprite.rect(3, 9, 5, 13, "cup", P.ash);
      sprite.rect(18, 9, 20, 13, "cup", P.ash);
      sprite.points([[6, 14], [7, 15], [8, 15], [9, 15]], "line", OUTLINE);
      sprite.set(9, 15, "light", accent);
      break;
    case "crown":
      sprite.rect(7, top + 1, 16, top + 2, "hat", P.yellow);
      sprite.points([[7, top], [7, top - 1], [10, top], [10, top - 1], [13, top], [13, top - 1], [16, top], [16, top - 1]], "hat", P.yellow);
      sprite.points([[9, top + 1], [14, top + 1]], "gem", P.red);
      break;
    case "beret":
      sprite.ellipse(11, top + 2, 6.8, 2.6, "hat", hat);
      sprite.set(11, top - 1, "hat", hat);
      break;
    case "tophat":
      sprite.rect(8, 0, 15, top + 2, "hat", P.navy);
      sprite.rect(8, top + 1, 15, top + 1, "band", accent);
      sprite.rect(5, top + 3, 18, top + 3, "brim", P.navy);
      break;
    case "none":
      break;
  }
}

/** Where each species' eyes sit: top row, bottom row. */
const EYE_ROWS: Record<Species, readonly [number, number] | null> = {
  human: [11, 12], cat: [11, 12], ghost: [10, 12], owl: null, robot: null,
};

function drawLenses(sprite: Sprite, species: Species, dark: boolean): void {
  const rows = EYE_ROWS[species];
  if (rows === null) return;
  const [top, bottom] = rows;
  const frame = dark ? OUTLINE : "#3b2f4a";
  for (const [x0, pupil] of [[7, 9], [13, 14]] as const) {
    for (let x = x0; x <= x0 + 3; x += 1) {
      sprite.set(x, top - 1, "frame", frame);
      sprite.set(x, bottom + 1, "frame", frame);
    }
    for (let y = top; y <= bottom; y += 1) {
      sprite.set(x0, y, "frame", frame);
      sprite.set(x0 + 3, y, "frame", frame);
      sprite.set(x0 + 1, y, "lens", dark ? OUTLINE : "#dff3ff");
      sprite.set(x0 + 2, y, "lens", dark ? OUTLINE : "#dff3ff");
      if (!dark) sprite.set(pupil, y, "eye", OUTLINE);
    }
    sprite.set(x0 + (dark ? 1 : 2), top, "glint", dark ? "#5d6b8a" : "#ffffff");
  }
  sprite.points([[11, top], [12, top]], "frame", frame);
  sprite.points([[6, top], [17, top]], "frame", frame);
}

/** Draws `look.accessory`, which `resolveLook` has already matched to the species. */
function drawAccessory({ sprite, look, hair }: Kit): void {
  const { accent } = PALETTES[look.palette];
  const eyesAt = look.species === "owl" ? 10 : 11;
  switch (look.accessory) {
    case "glasses":
      drawLenses(sprite, look.species, false);
      break;
    case "shades":
      drawLenses(sprite, look.species, true);
      break;
    case "monocle":
      sprite.points([[13, eyesAt - 1], [14, eyesAt - 1], [15, eyesAt - 1], [16, eyesAt], [16, eyesAt + 1], [15, eyesAt + 2], [14, eyesAt + 2], [13, eyesAt + 2], [12, eyesAt + 1], [12, eyesAt]], "frame", P.yellow);
      sprite.points([[16, eyesAt + 3], [16, eyesAt + 4], [17, eyesAt + 5]], "line", P.yellow);
      break;
    case "beard":
      sprite.ellipse(12, 14.6, 5.2, 3.2, "hair", hair, (_x, y) => y >= 14);
      sprite.points([[10, 14], [11, 14], [12, 14], [13, 14]], "hair", hair);
      sprite.points([[11, 15], [12, 15]], "mouth", mix(hair, OUTLINE, 0.45));
      break;
    case "scarf":
      sprite.rect(7, 17, 16, 18, "scarf", accent);
      sprite.rect(14, 19, 15, 21, "scarf", accent);
      break;
    case "bowtie":
      sprite.points([[10, 19], [10, 20], [11, 19], [11, 20], [12, 19], [12, 20], [13, 19], [13, 20], [9, 19], [9, 20], [14, 19], [14, 20]], "bow", accent);
      sprite.points([[11, 19], [12, 20]], "bow", mix(accent, OUTLINE, 0.3));
      break;
    case "none":
      break;
  }
}

/** Draw a soul's portrait. */
export function drawPortrait(id: string, emoji: string, pinned: Partial<Look> | null = null): Portrait {
  const look = resolveLook(id, emoji, pinned);
  const next = random(`${look.seed}:${look.species}:draw`);
  const sprite = new Sprite(PALETTES[look.palette].bg);
  const kit: Kit = { sprite, look, next, skin: pick(next, SKIN), hair: pick(next, HAIR_COLOURS) };
  if (look.species === "human") drawHuman(kit);
  if (look.species === "robot") drawRobot(kit);
  if (look.species === "owl") drawOwl(kit);
  if (look.species === "cat") drawCat(kit);
  if (look.species === "ghost") drawGhost(kit);
  drawAccessory(kit);
  drawHeadwear(kit);
  sprite.shade();
  sprite.outline();
  return {
    size: sprite.size,
    background: PALETTES[look.palette].bg,
    pixels: sprite.colour.map((colour, index) => (sprite.region[index] === "bg" ? null : colour)),
    blink: blinkFrame(sprite, look.species),
  };
}

/**
 * The eyes closed: each eye pixel takes the surface under it, and the lowest
 * pixel of each eye column becomes a lash line. A robot's eye lights go dark.
 */
function blinkFrame(sprite: Sprite, species: Species): Portrait["blink"] {
  const closed: Portrait["blink"] = [];
  const lowest = new Map<number, number>();
  for (let y = 0; y < sprite.size; y += 1)
    for (let x = 0; x < sprite.size; x += 1) {
      const region = sprite.regionAt(x, y);
      if (species === "robot") {
        if (region === "light" && y >= 9 && y <= 12) closed.push({ x, y, colour: P.navy });
        continue;
      }
      if (!EYES.has(region)) continue;
      closed.push({ x, y, colour: sprite.baseColour[y * sprite.size + x] ?? OUTLINE });
      lowest.set(x, Math.max(lowest.get(x) ?? -1, y));
    }
  if (species === "owl") {
    // An owl's big eyes close across the middle of each disc.
    for (const pixel of closed) if (pixel.y === 10) pixel.colour = mix(pixel.colour, OUTLINE, 0.55);
    return closed;
  }
  for (const pixel of closed)
    if (lowest.get(pixel.x) === pixel.y) pixel.colour = mix(pixel.colour, OUTLINE, 0.55);
  return closed;
}

/** The portrait as horizontal runs of one colour: few rects, crisp edges. */
export function portraitRuns(portrait: Portrait): Array<{ x: number; y: number; width: number; colour: string }> {
  const runs: Array<{ x: number; y: number; width: number; colour: string }> = [];
  for (let y = 0; y < portrait.size; y += 1) {
    let x = 0;
    while (x < portrait.size) {
      const colour = portrait.pixels[y * portrait.size + x];
      let width = 1;
      while (x + width < portrait.size && portrait.pixels[y * portrait.size + x + width] === colour) width += 1;
      if (colour !== null && colour !== undefined) runs.push({ x, y, width, colour });
      x += width;
    }
  }
  return runs;
}
