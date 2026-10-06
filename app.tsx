// bb-plugin-souls — frontend.
//
// Five surfaces, one data model:
//   • navPanel  "Souls"      — the library: browse, hand-edit, delete, start an
//                              AI-led interview.
//   • composer `+` menu row + banner — pick the soul this thread runs as, and
//                              see it above the composer while it is active.
//   • appOverlay             — the same picker when no composer banner is
//                              mounted to open it.
//   • pendingInteraction     — the review card `souls_propose` and
//                              `souls_update` wait on, and the delete
//                              confirmation `souls_delete` waits on.
//   • messageDirective       — `::soul{id="…"}`, posted by an agent once it
//                              has loaded its persona.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { SOUL_DIRECTIVE } from "./shared";
import { SoulEmbed } from "./components/soul-embed";
import {
  ComposerSoulBanner,
  SoulPickerOverlay,
  requestSoulPicker,
} from "./components/soul-picker";
import { SoulDeleteReview, SoulReview } from "./components/soul-review";
import { SoulsPage, SoulsPageHeader } from "./components/souls-page";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "souls",
    title: "Souls",
    icon: "Bot",
    // Routed at /plugins/souls/souls.
    path: "souls",
    component: SoulsPage,
    headerContent: SoulsPageHeader,
  });

  // The AI-led interview ends here: `souls_propose` (and `souls_update` for a
  // smaller edit) calls bb.ui.requestInput with rendererId "soul-review" and
  // waits for this card's submit.
  app.slots.pendingInteraction({ id: "soul-review", component: SoulReview });
  // `souls_delete` waits on this before it deletes anything.
  app.slots.pendingInteraction({ id: "soul-delete", component: SoulDeleteReview });

  // A thread's instructions only point at its persona; the agent posts this
  // after loading it with `souls_get`.
  app.slots.messageDirective({ id: SOUL_DIRECTIVE, component: SoulEmbed });

  app.slots.experimental_appOverlay({
    id: "soul-picker",
    component: SoulPickerOverlay,
  });

  app.composer.customize({
    id: "souls",
    // A thread binds a soul to itself; the compose screen holds the choice
    // until the thread it starts exists. A side chat or a queued-message
    // editor is not the thread, so neither gets a picker.
    scopes: ["thread", "new-thread"],
    // Bare chrome: the banner draws its own row, and draws nothing without a
    // soul. It stays mounted either way to own the picker.
    banners: [{ id: "soul", chrome: "bare", component: ComposerSoulBanner }],
    plusMenu: [
      {
        id: "soul",
        label: "Choose a soul…",
        description: "Run this thread as one of your agent personas",
        run: ({ composer }) => {
          const scope = composer.scope;
          if (scope.kind === "thread") requestSoulPicker(scope.threadId, composer);
          else if (scope.kind === "new-thread") requestSoulPicker(null, composer);
        },
      },
    ],
  });
});
