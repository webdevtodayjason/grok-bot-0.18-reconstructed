/*
 * Background picker for the Machine Room.
 * ---------------------------------------
 * Lives beside app.js rather than inside it: app.js stays byte-identical to the handoff, and this
 * file finds its own place on the Settings surface.
 *
 * SETTINGS-2: it used to hang listeners on the two gear buttons and then guard on the panel's TITLE
 * matching /Global router|Operator settings/. Both are gone. The title guard was the dangerous
 * half: the settings surface renames that panel to "Settings", and with the guard in place this
 * picker would simply have stopped appearing -- no error, no page error, and nothing in the suite
 * pinning it. It now listens for the surface's own document event, titanbot:settings-section, and
 * mounts into General -> Appearance and nowhere else. tests/machine-room-settings.test.mjs pins
 * that, because nothing pinned the old guard.
 *
 * BG-PICKER-1: the tiles used to sit INLINE in the Background row's one control slot -- 18 faces plus
 * an Upload label, the busiest row left on the surface, and the reason settings.css had to cap the grid
 * at 300 px (220 px on a phone) to keep General under its ceiling. The row is now one Choose control
 * whose face names the chosen plate, and the gallery is a SUB-VIEW of General: a back control, a title,
 * and the same grid with no cap on it, because in a sub-view the gallery is the whole body. Measured on
 * grok-bot-local-vm, real Chrome, 2026-09-10, before the change: the row was 816x441.63 at 1440x900 and
 * 360x361.63 at 390x844, and taking the grid out of it gives back 362 px and 282 px of General.
 *
 * Uploads stay in this browser. There is no upload endpoint, and inventing one would mean writing
 * operator files into the served directory -- so the picture is downscaled in a canvas and kept in
 * localStorage, and the panel says so out loud rather than implying it synced anywhere.
 */
(function attachBackgrounds(global) {
  "use strict";

  const doc = global.document;

  // SETTINGS-2: the one place on the surface this picker belongs, found by structure rather than by
  // a string of copy. Its control slot is the Background row's; falling back to the Appearance card
  // keeps the tiles on screen if that row is ever renamed.
  function appearanceSlot() {
    if (!doc) return null;
    const general = doc.querySelector('[data-settings-section="general"]');
    if (!general) return null;
    return general.querySelector('[data-settings-mount="background"]')
      ?? general.querySelector('[data-settings-group="appearance"] .settings-card')
      ?? null;
  }

  // CONSOLE-4: the default, the built-in list, the id-to-file rule and apply() all live in
  // bg-boot.js, which runs in <head> before the first stylesheet so the chosen plate is on <html>
  // before anything paints. This file owns the PICKER and the uploads and reads the rest from
  // there. Deliberately no fallback copy of those constants: a second copy means a plate added to
  // one of them flashes twice, which is worse than the flash this arrangement removes.
  const boot = global.__mrBg;
  // bg-boot.js is a blocking <head> script, so its absence is a deploy fault rather than a state
  // this file should ever see -- but without this guard the destructure below threw at module top
  // level and took the WHOLE picker with it. Measured on console.titanium.bot 2026-09-08 with only
  // bg-boot.js blocked in the browser: pageerror "Cannot destructure property 'CHOICE_KEY' of
  // 'boot' as it is undefined", no .bg-grid on the settings surface at all, no way to choose a plate,
  // and nothing on screen saying why -- the module's own __machineRoomBackgrounds publication is
  // three hundred lines below the throw and never ran either.
  //
  // The fallback is deliberately NOT a second copy of the default and the list: two copies is the
  // bug bg-boot.js exists to remove, and a test pins the literal id to one file. So an empty set,
  // published under the name the rest of the console reads, plus one line in settings where the
  // tiles would have been.
  if (!boot) {
    global.__machineRoomBackgrounds = { DEFAULT_CHOICE: "", BUILT_IN: [] };
    if (doc) {
      // SETTINGS-2: the same mount the working path uses. It listens for the surface's own section
      // event rather than for a press on a gear, so the note lands in Appearance and nowhere else.
      const saySo = (event) => {
        if (event?.detail?.id !== "general") return;
        const slot = appearanceSlot();
        if (!slot || doc.getElementById("bg-section")) return;
        slot.insertAdjacentHTML("beforeend", '<section class="settings-section" id="bg-section"><p>The plate list did not load with this page, so there is nothing to pick from here. A reload usually fixes it.</p></section>');
      };
      doc.addEventListener("titanbot:settings-section", saySo);
    }
    return;
  }
  const { CHOICE_KEY, CUSTOM_KEY, DEFAULT_CHOICE, BUILT_IN, apply } = boot;
  const MAX_EDGE = 1920;
  const BUDGET_BYTES = 4_000_000; // localStorage is ~5MB; leave the app its share.

  const read = (key, fallback) => {
    try { return JSON.parse(global.localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  };

  const customs = () => read(CUSTOM_KEY, []);
  const all = () => [...BUILT_IN, ...customs()];
  const chosenPlate = () => {
    const id = read(CHOICE_KEY, DEFAULT_CHOICE);
    return all().find((b) => b.id === id) ?? null;
  };

  function choose(id) {
    write(CHOICE_KEY, id);
    apply(id);
  }

  // Downscale before storing: a 1.5MB photograph base64s to 2MB, and two of those fill the quota.
  function shrink(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_EDGE / img.width);
        const canvas = doc.createElement("canvas");
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("that file is not an image this browser can read")); };
      img.src = url;
    });
  }

  async function addCustom(file, onDone) {
    const data = await shrink(file);
    const next = [...customs(), {
      id: `custom-${Date.now()}`,
      name: file.name.replace(/\.[^.]+$/, "").slice(0, 28) || "Uploaded",
      full: data, thumb: data, custom: true,
    }];
    const weight = next.reduce((n, b) => n + b.full.length, 0);
    if (weight > BUDGET_BYTES) throw new Error("this browser is out of room for more backgrounds; remove one first");
    if (!write(CUSTOM_KEY, next)) throw new Error("this browser refused to save it");
    choose(next[next.length - 1].id);
    onDone();
  }

  function removeCustom(id, onDone) {
    write(CUSTOM_KEY, customs().filter((b) => b.id !== id));
    if (read(CHOICE_KEY, DEFAULT_CHOICE) === id) choose(DEFAULT_CHOICE);
    onDone();
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function sectionMarkup() {
    const current = read(CHOICE_KEY, DEFAULT_CHOICE);
    const swatch = (b) => `
      <button class="bg-swatch" type="button" data-bg-id="${esc(b.id)}" aria-pressed="${b.id === current}" title="${esc(b.name)}">
        <img src="${esc(b.thumb)}" alt="" loading="lazy" />
        <span>${esc(b.name)}</span>
        ${b.custom ? `<span class="bg-remove" role="button" tabindex="0" data-bg-remove="${esc(b.id)}" title="Remove">×</span>` : ""}
      </button>`;
    // Tiles with a series sit under their own small heading, after the plain ones and before the
    // operator's uploads, so a set reads as a set.
    const plain = all().filter((b) => !b.series);
    const bySeries = new Map();
    for (const b of all()) if (b.series) bySeries.set(b.series, [...(bySeries.get(b.series) ?? []), b]);
    // CONSOLE-4: a real heading row, spanning the whole grid. It used to carry
    // `style="flex-basis:100%"` while .bg-grid is display:grid, where flex-basis does nothing at
    // all -- so "Habitat" and "The Lab" each took one 185x104 cell between two tiles and read on
    // screen as a blank tile with a label on it. Jason, 2026-09-08: "they're just blank spots."
    // The span now lives in backgrounds.css, where the grid is.
    const swatches = plain.map(swatch).join("")
      + [...bySeries].map(([name, tiles]) => `<p class="field-hint bg-series">${esc(name)}</p>${tiles.map(swatch).join("")}`).join("");
    // The heading and the blurb are the Background ROW's now -- a label and one explanation line,
    // like every other row on the surface -- so this section carries the tiles and the upload only.
    return `
      <section class="settings-section" id="bg-section">
        <div class="bg-grid">${swatches}</div>
        <label class="ghost-button" style="display:inline-flex;margin-top:14px;cursor:pointer">
          Upload a background<input type="file" accept="image/*" id="bg-upload" hidden />
        </label>
        <p class="bg-note">Uploads are resized and kept in this browser only -- they do not sync to other machines, and clearing site data removes them.</p>
      </section>`;
  }

  // BG-PICKER-1: the row's one control. Its FACE is the plate that is chosen, which is the whole value
  // of the row -- a person reading General sees what the background is without opening anything. The
  // accessible name says what pressing it does, because "Titan Nebula" on its own does not.
  function rowMarkup() {
    const face = chosenPlate()?.name ?? "Choose a picture";
    return `<button class="ghost-button" type="button" data-bg-open aria-label="Choose a background, now ${esc(face)}">${esc(face)}</button>`;
  }

  // Every listener the gallery needs, on the gallery's own root rather than on the whole panel, so the
  // same wiring serves the sub-view and the inline fallback below. Idempotent: the surface re-fills a
  // sub-view on every paint and this must not stack listeners.
  function wireSection(root) {
    if (!root || root.dataset.bgWired === "1") return;
    root.dataset.bgWired = "1";
    // A redraw is for the list CHANGING -- an upload added, a custom removed -- and it rebuilds the
    // gallery in place, wherever it is.
    const redraw = () => {
      const parent = root.parentNode;
      if (!parent) return;
      root.remove();
      parent.insertAdjacentHTML("beforeend", sectionMarkup());
      wireSection(parent.querySelector("#bg-section"));
    };

    root.querySelectorAll("[data-bg-id]").forEach((el) => {
      el.addEventListener("click", (event) => {
        const remove = event.target.closest("[data-bg-remove]");
        if (remove) { event.stopPropagation(); removeCustom(remove.dataset.bgRemove, redraw); return; }
        // Applied the moment it is pressed, the way it always was. Back is not a Save.
        choose(el.dataset.bgId);
        root.querySelectorAll("[data-bg-id]").forEach((x) => x.setAttribute("aria-pressed", String(x === el)));
      });
    });

    root.querySelector("#bg-upload")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const note = root.querySelector(".bg-note");
      try {
        await addCustom(file, redraw);
      } catch (error) {
        if (note) note.textContent = `Could not add that one: ${error.message}`;
      }
    });
  }

  // The gallery as a sub-view of General. settings.js paints the body, keeps it through its own
  // repaints, and calls fill on each one; this module draws what is inside it and wires it.
  function openPicker() {
    global.__mrSettings.openSubview({
      id: "background",
      section: "general",
      title: "Background",
      markup: sectionMarkup,
      fill: (host) => wireSection(host.querySelector("#bg-section")),
    });
  }

  function inject() {
    const slot = appearanceSlot();
    if (!slot) return;
    // NO SEAM, NO BUTTON. A Choose control on a console whose settings module cannot open a sub-view
    // would be a button that does nothing, silently -- the exact failure shape this wave keeps finding.
    // So where the seam is absent the tiles go back inline, which is what shipped before.
    if (typeof global.__mrSettings?.openSubview !== "function") {
      if (doc.getElementById("bg-section")) return;
      slot.insertAdjacentHTML("beforeend", sectionMarkup());
      wireSection(doc.getElementById("bg-section"));
      return;
    }
    if (slot.querySelector("[data-bg-open]")) return;
    slot.insertAdjacentHTML("beforeend", rowMarkup());
    slot.querySelector("[data-bg-open]").addEventListener("click", openPicker);
  }

  // The two constants above are the whole of what tests/titan-crew.test.mjs reads, and it loads
  // this file with no document at all -- so they are published before the first line that needs a
  // page, and the DOM half returns rather than throwing on a stub. They come from bg-boot.js now
  // and are re-published here unchanged, because this is the name the rest of the console knows.
  global.__machineRoomBackgrounds = { DEFAULT_CHOICE, BUILT_IN };
  if (!doc) return;

  // bg-boot.js already did this in <head>, before the first stylesheet. Repeated here because it
  // is idempotent and because this file also has to cover the operator's own uploads, whose data
  // URLs bg-boot only reads when the stored id is one of them.
  apply(read(CHOICE_KEY, DEFAULT_CHOICE));

  // SETTINGS-2: one listener on the surface's own event, and no listener on any gear. The event
  // carries the section that was just painted, so the tiles are put back every time General is
  // opened -- including after a repaint the surface does for itself -- and never anywhere else.
  doc.addEventListener("titanbot:settings-section", (event) => {
    if (event?.detail?.id !== "general") return;
    inject();
  });
})(window);
