/*
 * Background picker for the Machine Room.
 * ---------------------------------------
 * Lives beside app.js rather than inside it: app.js stays byte-identical to the handoff, and this
 * file hangs its own listeners on the same two settings buttons. Because it loads last, its
 * listener runs after the panel has been filled, so it appends its section to the open dialog.
 *
 * Uploads stay in this browser. There is no upload endpoint, and inventing one would mean writing
 * operator files into the served directory -- so the picture is downscaled in a canvas and kept in
 * localStorage, and the panel says so out loud rather than implying it synced anywhere.
 */
(function attachBackgrounds(global) {
  "use strict";

  const doc = global.document;
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
  // 'boot' as it is undefined", no .bg-grid in Operator settings at all, no way to choose a plate,
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
      const saySo = () => global.setTimeout(() => {
        const panel = doc.getElementById("panel-content");
        if (!panel || doc.getElementById("bg-section")) return;
        if (!/Global router|Operator settings/i.test(doc.getElementById("panel-title")?.textContent ?? "")) return;
        panel.insertAdjacentHTML("beforeend", '<section class="settings-section" id="bg-section"><h3>Background</h3><p>The plate list did not load with this page, so there is nothing to pick from here. A reload usually fixes it.</p></section>');
      }, 0);
      const bindNote = () => ["settings-button", "shelf-settings"].forEach((id) => doc.getElementById(id)?.addEventListener("click", saySo));
      if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", bindNote);
      else bindNote();
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
    return `
      <section class="settings-section" id="bg-section">
        <h3>Background</h3>
        <p>The plate behind the Machine Room. The dusk and mist atmospheres still apply on top.</p>
        <div class="bg-grid">${swatches}</div>
        <label class="ghost-button" style="display:inline-flex;margin-top:14px;cursor:pointer">
          Upload a background<input type="file" accept="image/*" id="bg-upload" hidden />
        </label>
        <p class="bg-note">Uploads are resized and kept in this browser only -- they do not sync to other machines, and clearing site data removes them.</p>
      </section>`;
  }

  function inject() {
    const panel = doc.getElementById("panel-content");
    if (!panel || doc.getElementById("bg-section")) return;
    // Only the settings panel; the same dialog is reused for every capability.
    if (!/Global router|Operator settings/i.test(doc.getElementById("panel-title")?.textContent ?? "")) return;
    panel.insertAdjacentHTML("beforeend", sectionMarkup());

    const redraw = () => { doc.getElementById("bg-section")?.remove(); inject(); };

    panel.querySelectorAll("[data-bg-id]").forEach((el) => {
      el.addEventListener("click", (event) => {
        const remove = event.target.closest("[data-bg-remove]");
        if (remove) { event.stopPropagation(); removeCustom(remove.dataset.bgRemove, redraw); return; }
        choose(el.dataset.bgId);
        panel.querySelectorAll("[data-bg-id]").forEach((x) => x.setAttribute("aria-pressed", String(x === el)));
      });
    });

    panel.querySelector("#bg-upload")?.addEventListener("change", async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      const note = panel.querySelector(".bg-note");
      try {
        await addCustom(file, redraw);
      } catch (error) {
        if (note) note.textContent = `Could not add that one: ${error.message}`;
      }
    });
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

  // This file is appended after boot, so DOMContentLoaded has already fired and waiting for it
  // would mean waiting forever. Bind now if the document is ready, otherwise wait once.
  function bind() {
    ["settings-button", "shelf-settings"].forEach((id) => {
      doc.getElementById(id)?.addEventListener("click", () => global.setTimeout(inject, 0));
    });
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", bind);
  else bind();
})(window);
