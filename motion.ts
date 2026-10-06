// What a thread is doing, and how its soul's portrait shows it.
//
// The server reads the thread's latest work item into an `Activity`; the
// banner adds what the host's live thread view knows (waiting for the user,
// an error, starting up) to settle a `Mood`. Each mood is a small, looping
// pixel animation: the figure's own motion, plus an overlay sprite drawn on
// the portrait's 24×24 grid. Pure, so the server and the UI share it.

export const ACTIVITIES = [
  "thinking", "writing", "running", "editing", "reading", "browsing",
  "working", "delegating", "compacting",
] as const;
export type Activity = (typeof ACTIVITIES)[number];
export type Mood = Activity | "idle" | "waiting" | "error" | "starting";

/** The activity a started work item stands for. */
export function activityForItem(itemType: string | undefined): Activity {
  switch (itemType) {
    case "reasoning": return "thinking";
    case "agentMessage": return "writing";
    // A long command can move to a background shell; it is still a command.
    case "commandExecution": case "backgroundTask": return "running";
    case "fileChange": return "editing";
    case "fileRead": case "listFiles": case "search": case "imageView": return "reading";
    case "webSearch": case "webFetch": return "browsing";
    case "contextCompaction": return "compacting";
    case "delegation": return "delegating";
    default: return "working";
  }
}

/** What the host's live thread view says, in the fields a mood needs. */
export type LiveThread = {
  status: string;
  runtimeStatus?: string;
  hasPendingInteraction: boolean;
};

/** The mood to show: blocked on the user first, then errors, then the work. */
export function moodFor(thread: LiveThread | null, activity: Activity | null): Mood {
  if (thread === null) return "idle";
  if (thread.hasPendingInteraction) return "waiting";
  if (thread.status === "error") return "error";
  const runtime = thread.runtimeStatus ?? thread.status;
  if (["starting", "provisioning", "waiting-for-host", "host-reconnecting"].includes(runtime)) return "starting";
  if (thread.status === "active") return activity ?? "thinking";
  return "idle";
}

/** What the banner says for each mood; null keeps the tagline. */
export const MOOD_LABEL: Record<Mood, string | null> = {
  idle: null,
  thinking: "Thinking…",
  writing: "Writing a reply…",
  running: "Running a command…",
  editing: "Editing files…",
  reading: "Reading the code…",
  browsing: "Searching the web…",
  working: "Working…",
  delegating: "Delegating…",
  compacting: "Compacting its context…",
  waiting: "Waiting for you",
  error: "Hit an error",
  starting: "Waking up…",
};

// --- sprites -----------------------------------------------------------------

/** Sprite colours: PICO-8, like the portraits. '.' is transparent. */
const INK: Record<string, string> = {
  o: "#1a1c2c", w: "#fff1e8", n: "#1d2b53", y: "#ffec27", r: "#ff004d",
  b: "#29adff", l: "#00e436", p: "#ff77a8", k: "#ffccaa", g: "#c2c3c7",
};

export type Pixel = { x: number; y: number; colour: string };

/** A grid of characters, placed at (x, y) on the portrait. */
function sprite(rows: readonly string[], x: number, y: number): Pixel[] {
  const pixels: Pixel[] = [];
  rows.forEach((row, dy) => {
    [...row].forEach((char, dx) => {
      const colour = INK[char];
      if (colour !== undefined) pixels.push({ x: x + dx, y: y + dy, colour });
    });
  });
  return pixels;
}

const BUBBLE = [".ooooooo.", "owwwwwwwo", "owwwwwwwo", "owwwwwwwo", ".ooooooo."];
const thought = (dots: number) =>
  sprite([...BUBBLE, "...o.....", "..o......"], 15, 0).concat(
    [2, 4, 6].slice(0, dots).map((dx) => ({ x: 15 + dx, y: 2, colour: INK.n as string })),
  );
const speech = (raised: number) =>
  sprite([BUBBLE[0] as string, BUBBLE[1] as string, BUBBLE[2] as string, BUBBLE[3] as string, ".owooooo.", ".oo......"], 15, 0).concat(
    [2, 4, 6].map((dx, index) => ({ x: 15 + dx, y: index === raised ? 1 : 2, colour: INK.n as string })),
  );
const exclaim = (dy: number) =>
  sprite([".oooo.", "oyyyyo", "oynnyo", "oynnyo", "oynnyo", "oyyyyo", "oynnyo", "oyyyyo", ".oooo."], 18, dy);
const terminal = (cursor: boolean) =>
  sprite(["ooooooooo", "onnnnnnno", "onlnnnnno", "onnlnnnno", cursor ? "onlnwwnno" : "onlnnnnno", "onnnnnnno", "ooooooooo"], 15, 17);
const pencil = (dx: number, dy: number) =>
  sprite([".....oo", "....opo", "...oyo.", "..oyo..", ".oyo...", "oko....", "no....."], 16 + dx, 16 + dy);
const magnifier = (dx: number, dy: number) =>
  sprite([".ooo...", "obwbo..", "obbbo..", ".ooon..", "....nn.", ".....nn"], 16 + dx, 17 + dy);
const sparkle = (x: number, y: number) => sprite([".y.", "yyy", ".y."], x, y);
const spinner = (step: number) => {
  const ring = sprite([".ooo.", "o...o", "o...o", "o...o", ".ooo."], 17, 1);
  const [dx, dy] = ([[2, 0], [4, 2], [2, 4], [0, 2]] as const)[step] ?? [2, 0];
  return ring.filter((pixel) => !(pixel.x === 17 + dx && pixel.y === 1 + dy)).concat({ x: 17 + dx, y: 1 + dy, colour: INK.y as string });
};
const sweat = (dy: number) => sprite([".o.", "obo", "obo", ".o."], 18, 3 + dy);
const snooze = (dy: number) => sprite(["nnn", "..n", ".n.", "nnn"], 18, 2 + dy).concat(sprite(["nn", ".n", "nn"], 21, dy));

export type MoodMotion = {
  /** Overlay frames, shown in turn for `frameMs` each. */
  frames: Pixel[][];
  frameMs: number;
  /** The figure's offsets (x, y), held in turn for `figureMs` each. */
  figure: ReadonlyArray<readonly [number, number]>;
  figureMs: number;
  /** "blink" blinks every few seconds; "closed" keeps the eyes shut. */
  eyes: "blink" | "closed";
};

const STILL: ReadonlyArray<readonly [number, number]> = [[0, 0]];
const NOD: ReadonlyArray<readonly [number, number]> = [[0, 0], [0, 1]];

export const MOTION: Record<Mood, MoodMotion> = {
  idle: { frames: [], frameMs: 0, figure: [[0, 0], [0, 0], [0, 0], [0, 1]], figureMs: 800, eyes: "blink" },
  thinking: { frames: [thought(1), thought(2), thought(3), thought(0)], frameMs: 380, figure: NOD, figureMs: 1200, eyes: "blink" },
  writing: { frames: [speech(0), speech(1), speech(2)], frameMs: 220, figure: NOD, figureMs: 440, eyes: "blink" },
  running: { frames: [terminal(true), terminal(false)], frameMs: 480, figure: NOD, figureMs: 720, eyes: "blink" },
  editing: { frames: [pencil(0, 0), pencil(-1, 1)], frameMs: 240, figure: NOD, figureMs: 720, eyes: "blink" },
  reading: { frames: [magnifier(0, 0), magnifier(1, 0), magnifier(1, 1), magnifier(0, 1)], frameMs: 320, figure: STILL, figureMs: 0, eyes: "blink" },
  browsing: { frames: [magnifier(0, 0), magnifier(-1, 0), magnifier(-1, -1), magnifier(0, -1)], frameMs: 320, figure: STILL, figureMs: 0, eyes: "blink" },
  working: { frames: [sparkle(19, 1), sparkle(16, 5)], frameMs: 420, figure: NOD, figureMs: 840, eyes: "blink" },
  delegating: { frames: [sparkle(19, 1), sparkle(16, 5), sparkle(20, 6)], frameMs: 300, figure: NOD, figureMs: 600, eyes: "blink" },
  compacting: { frames: [spinner(0), spinner(1), spinner(2), spinner(3)], frameMs: 160, figure: STILL, figureMs: 0, eyes: "blink" },
  waiting: { frames: [exclaim(0), exclaim(1)], frameMs: 360, figure: [[0, 0], [0, -1], [0, 0], [0, 0]], figureMs: 240, eyes: "blink" },
  error: { frames: [sweat(0), sweat(1), sweat(2)], frameMs: 300, figure: [[0, 0], [-1, 0], [1, 0], [-1, 0], [0, 0], [0, 0], [0, 0], [0, 0]], figureMs: 110, eyes: "blink" },
  starting: { frames: [snooze(0), snooze(-1)], frameMs: 600, figure: STILL, figureMs: 0, eyes: "closed" },
};
