/*
 * The plate, before the first pixel. Owner: CONSOLE-4 item A.
 * ----------------------------------------------------------
 * Jason, 2026-09-08: "console.titanium.bot initially shows the original background with the
 * mountains, then reloads with whatever background the user chose."
 *
 * The choice was never wrong -- backgrounds.js has answered the nebula since 5637e4b and the relay
 * serves that byte for byte. The bug is load order. index.html used to chain
 * __bootMachineRoom -> app.js -> backgrounds.js, so nothing set data-bg until fourteen serial
 * gateway round trips had finished, and styles.css painted the warmwind mountains for the whole of
 * that. Measured on grok-bot-local-vm over loopback with a warm box: 1,183 ms of mountains with no
 * saved choice, 1,309 ms with habitat-3 saved. On Jason's console those round trips run at 77 to
 * 128 ms TTFB rather than loopback, so his flash is longer.
 *
 * So this file runs FIRST: a classic blocking <script src> in <head>, placed BEFORE the stylesheet
 * links. Before them it executes immediately; after them a classic script waits for the sheets to
 * load, which is the cost this file exists to remove.
 *
 * It is also the one home for the three constants that decide a plate -- the default, the built-in
 * list, and the id-to-file rule. backgrounds.js reads them from here rather than keeping a second
 * copy: two copies means a plate added to one of them flashes twice, which is worse than the bug
 * being fixed.
 */
(function bgBoot(global) {
  "use strict";

  const doc = global.document;
  const CHOICE_KEY = "machineRoom.background";
  const CUSTOM_KEY = "machineRoom.backgrounds.custom";

  // Names follow the operator's own filenames. Renaming someone's pictures for them is how you
  // end up with a label that argues with the thumbnail.
  //
  // `default: true` marks what a browser with nothing stored opens on, and DEFAULT_CHOICE is read
  // off it rather than written twice. Jason's nebula is the product brand's plate (2026-09-06) and
  // measured on this Mac 2026-09-08 at mean thumbnail luminance 68.6 of 255, within a point of the
  // darkest tile in the set -- so it answers "not that weird mountain one" and is the product's
  // own. "Original" stays in the picker one click away: this is a default, not a removal.
  const BUILT_IN = [
    { id: "original", name: "Original", full: "assets/warmwind-landscape.svg", thumb: "assets/warmwind-landscape.svg" },
    { id: "bg1-misty", name: "Misty" },
    { id: "bg1-misty2", name: "Misty II" },
    { id: "bg1-misty3", name: "Misty III" },
    { id: "bg2-misty-dessert", name: "Desert Mist" },
    { id: "bg2-nebulous", name: "Nebulous" },
    { id: "bg2-Pine-mist", name: "Pine Mist" },
    { id: "titan-nebula", name: "Titan Nebula", default: true },
    // The Habitat series (Jason, 2026-09-07): alien terrain under the console's own blues and violets.
    // A `series` groups tiles under one heading in the picker; seasonal sets come the same way, one
    // line each, with the season in the series name.
    { id: "habitat-1", name: "Habitat I", series: "Habitat" },
    { id: "habitat-2", name: "Habitat II", series: "Habitat" },
    { id: "habitat-3", name: "Habitat III", series: "Habitat" },
    { id: "habitat-4", name: "Habitat IV", series: "Habitat" },
    { id: "habitat-5", name: "Habitat V", series: "Habitat" },
    // The Lab series (Jason, 2026-09-07 08:56).
    { id: "lab-1", name: "The Lab I", series: "The Lab" },
    { id: "lab-2", name: "The Lab II", series: "The Lab" },
    { id: "lab-3", name: "The Lab III", series: "The Lab" },
    // Two painted plates for the regular set (Jason, 2026-09-07, from bg2.png and bg3.png): named
    // here for what they show, since the files carried no name of their own.
    { id: "crystal-dunes", name: "Crystal Dunes" },
    { id: "deep-current", name: "Deep Current" },
  ].map((b) => ({
    ...b,
    full: b.full ?? urlFor(b.id, "full"),
    thumb: b.thumb ?? urlFor(b.id, "thumb"),
  }));

  const DEFAULT_CHOICE = (BUILT_IN.find((b) => b.default) ?? BUILT_IN[0]).id;

  /** The one id-to-file rule. `kind` is "full" or "thumb". */
  function urlFor(id, kind) {
    return `assets/backgrounds/${id}${kind === "thumb" ? ".thumb" : ""}.webp`;
  }

  /**
   * The stored choice, or the default. Every read is guarded: a browser with site data blocked
   * throws on the accessor itself, and a console that will not paint because storage said no is a
   * worse bug than the one this file fixes.
   */
  function storedChoice() {
    try {
      const raw = global.localStorage.getItem(CHOICE_KEY);
      const id = raw == null ? null : JSON.parse(raw);
      return typeof id === "string" && id ? id : DEFAULT_CHOICE;
    } catch {
      return DEFAULT_CHOICE;
    }
  }

  /**
   * The operator's own uploads. Read ONLY when the id being applied is one of them: that array
   * holds data URLs up to 4,000,000 bytes, and JSON.parsing it unconditionally in <head> would
   * block the first paint by exactly the cost this file removes.
   */
  function customUrl(id) {
    try {
      const list = JSON.parse(global.localStorage.getItem(CUSTOM_KEY)) ?? [];
      return (Array.isArray(list) ? list : []).find((b) => b && b.id === id)?.full ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Stamp the plate on <html>. data-bg is set for EVERY id, "original" included.
   *
   * It used to be removed for "original", which let the stylesheet's own mountains stand in as the
   * default. That is what made a browser with no stored choice -- and a browser whose storage
   * throws -- open on a photograph. styles.css now paints a flat brand ground instead, and
   * backgrounds.css carries html[data-bg="original"] for the mountains, so one code path owns
   * every plate and picking Original still gives you the mountains.
   */
  function apply(id) {
    if (!doc) return null;
    const root = doc.documentElement;
    const full = String(id ?? "").startsWith("custom-")
      ? customUrl(id)
      : (BUILT_IN.find((b) => b.id === id)?.full ?? null);
    const chosen = full ? id : DEFAULT_CHOICE;
    const url = full ?? BUILT_IN.find((b) => b.id === DEFAULT_CHOICE)?.full ?? "";
    root.style.setProperty("--machine-room-bg", `url("${url}")`);
    root.dataset.bg = chosen;
    return chosen;
  }

  global.__mrBg = { CHOICE_KEY, CUSTOM_KEY, DEFAULT_CHOICE, BUILT_IN, urlFor, apply, storedChoice };

  if (!doc) return;
  apply(storedChoice());
})(typeof window !== "undefined" ? window : globalThis);
