import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ACCESSORY, HEADWEAR, PORTRAIT_SIZE, SPECIES, accessoriesFor, drawPortrait, portraitRuns, resolveLook } from "./portrait.ts";
import { soulPortrait, type Soul } from "./shared.ts";
import plugin from "./server.ts";

test("the same soul always draws the same portrait", () => {
  const a = drawPortrait("soul_abc", "🦉");
  const b = drawPortrait("soul_abc", "🦉");
  assert.equal(a.size, PORTRAIT_SIZE);
  assert.equal(a.pixels.length, PORTRAIT_SIZE * PORTRAIT_SIZE);
  assert.deepEqual(a.pixels, b.pixels);
  assert.notDeepEqual(drawPortrait("soul_xyz", "🦉").pixels, a.pixels, "another soul, another face");
});

test("the emoji hints at a species, and a pinned trait wins", () => {
  assert.equal(resolveLook("x", "🦉").species, "owl");
  assert.equal(resolveLook("x", "🛰️").species, "robot");
  assert.equal(resolveLook("x", "☁️").species, "ghost");
  assert.equal(resolveLook("x", "🎩").headwear, "tophat");
  assert.equal(resolveLook("x", "🦉", { species: "cat" }).species, "cat");
  assert.notEqual(resolveLook("x", "", { seed: "one" }).seed, resolveLook("x", "", { seed: "two" }).seed);
});

test("an emoji hints the same with or without its variation selector", () => {
  for (const [bare, dressed] of [["🛰", "🛰️"], ["☁", "☁️"], ["🖥", "🖥️"], ["🕯", "🕯️"]] as const)
    assert.equal(resolveLook("x", bare).species, resolveLook("x", dressed).species, bare);
  assert.equal(resolveLook("x", "🛰").species, "robot");
  assert.equal(resolveLook("x", "☁").species, "ghost");
  assert.equal(resolveLook("x", "🎖").headwear, "cap");
  assert.equal(resolveLook("x", "🕶").accessory, "shades");
});

test("a species never resolves an accessory it cannot wear", () => {
  assert.equal(resolveLook("x", "", { species: "owl", accessory: "glasses" }).accessory, "none");
  assert.equal(resolveLook("x", "", { species: "cat", accessory: "beard" }).accessory, "none");
  assert.equal(resolveLook("x", "", { species: "ghost", accessory: "scarf" }).accessory, "none");
  assert.equal(resolveLook("x", "", { species: "robot", accessory: "monocle" }).accessory, "monocle");
  for (const species of SPECIES)
    for (const accessory of ACCESSORY) {
      const look = resolveLook("x", "", { species, accessory });
      assert.ok(accessoriesFor(species).includes(look.accessory), `${species}/${accessory}`);
      if (accessory === "none" || accessoriesFor(species).includes(accessory)) continue;
      // An accessory a species cannot wear draws exactly what none draws.
      assert.deepEqual(
        drawPortrait("x", "", { species, accessory }).pixels,
        drawPortrait("x", "", { species, accessory: "none" }).pixels,
        `${species}/${accessory}`,
      );
    }
  // Every accessory a species can wear changes its portrait.
  for (const species of SPECIES)
    for (const accessory of accessoriesFor(species)) {
      if (accessory === "none") continue;
      assert.notDeepEqual(
        drawPortrait("x", "", { species, accessory }).pixels,
        drawPortrait("x", "", { species, accessory: "none" }).pixels,
        `${species} wears ${accessory}`,
      );
    }
});

test("pinning one trait leaves the others where they were", () => {
  const auto = resolveLook("soul_stable", "");
  // A human can wear every accessory, so it shows the rolled one.
  const rolled = resolveLook("soul_stable", "", { species: "human" }).accessory;
  for (const species of SPECIES) {
    const pinned = resolveLook("soul_stable", "", { species });
    assert.equal(pinned.palette, auto.palette);
    assert.equal(pinned.headwear, auto.headwear);
    // Kept where the species can wear it; otherwise it is not drawn, so none.
    assert.equal(pinned.accessory, accessoriesFor(species).includes(rolled) ? rolled : "none");
  }
  assert.equal(resolveLook("soul_stable", "", { headwear: "crown" }).palette, auto.palette);
});

test("every species, headwear and accessory draws a full, outlined portrait", () => {
  for (const species of SPECIES)
    for (const headwear of HEADWEAR)
      for (const accessory of ACCESSORY) {
        const portrait = drawPortrait("soul_grid", "", { species, headwear, accessory });
        const hex = /^#[0-9a-f]{6}$/;
        assert.match(portrait.background, hex);
        assert.ok(portrait.pixels.every((pixel) => pixel === null || hex.test(pixel)), `${species}/${headwear}/${accessory}`);
        assert.ok(portrait.pixels.includes("#1a1c2c"), "outlined");
        assert.ok(portrait.blink.length > 0, `${species} can blink`);
        const figure = portrait.pixels.filter((pixel) => pixel !== null).length;
        const covered = portraitRuns(portrait).reduce((sum, run) => sum + run.width, 0);
        assert.equal(covered, figure);
      }
});

test("a created soul keeps the face its draft was previewed with", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "souls", agentSkillIds: ["souls"] });
  try {
    await plugin(bb);
    const preview = soulPortrait({ name: "Hazel", emoji: "🦉", look: null });
    const { soul } = (await harness.behavior.callRpc("souls_create", {
      draft: { name: "Hazel", emoji: "🦉" },
      origin: "manual",
    })) as { soul: Soul };
    assert.equal(soul.look?.seed, "Hazel");
    assert.deepEqual(soulPortrait(soul).pixels, preview.pixels);
    const { soul: renamed } = (await harness.behavior.callRpc("souls_update", {
      id: soul.id,
      patch: { name: "Hazel the Wise" },
    })) as { soul: Soul };
    assert.deepEqual(soulPortrait(renamed).pixels, preview.pixels, "a rename keeps the face");
  } finally {
    await harness.lifecycle.dispose();
  }
});
