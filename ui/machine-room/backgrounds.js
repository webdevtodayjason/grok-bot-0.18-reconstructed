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
  const CHOICE_KEY = "machineRoom.background";
  // What a browser with nothing stored opens on. Jason's nebula is the product brand's plate
  // (2026-09-06); "original" is still in the picker one click away, so this is a default, not a
  // removal.
  const DEFAULT_CHOICE = "titan-nebula";
  const CUSTOM_KEY = "machineRoom.backgrounds.custom";
  const MAX_EDGE = 1920;
  const BUDGET_BYTES = 4_000_000; // localStorage is ~5MB; leave the app its share.

  // Names follow the operator's own filenames. Renaming someone's pictures for them is how you
  // end up with a label that argues with the thumbnail.
  const BUILT_IN = [
    { id: "original", name: "Original", full: "assets/warmwind-landscape.svg", thumb: "assets/warmwind-landscape.svg" },
    { id: "bg1-misty", name: "Misty" },
    { id: "bg1-misty2", name: "Misty II" },
    { id: "bg1-misty3", name: "Misty III" },
    { id: "bg2-misty-dessert", name: "Desert Mist" },
    { id: "bg2-nebulous", name: "Nebulous" },
    { id: "bg2-Pine-mist", name: "Pine Mist" },
    // Jason's nebula for the product brand (2026-09-06): teal and violet on near-black, the console's own
    // teal reads as part of the picture.
    { id: "titan-nebula", name: "Titan Nebula" },
    // The Habitat series (Jason, 2026-09-07): alien terrain under the console's own blues and violets.
    // A `series` groups tiles under one heading in the picker; seasonal sets come the same way, one
    // line each, with the season in the series name.
    { id: "habitat-1", name: "Habitat I", series: "Habitat" },
  ].map((b) => ({
    ...b,
    full: b.full ?? `assets/backgrounds/${b.id}.webp`,
    thumb: b.thumb ?? `assets/backgrounds/${b.id}.thumb.webp`,
  }));

  const read = (key, fallback) => {
    try { return JSON.parse(global.localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const write = (key, value) => {
    try { global.localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  };

  const customs = () => read(CUSTOM_KEY, []);
  const all = () => [...BUILT_IN, ...customs()];

  function apply(id) {
    const choice = all().find((b) => b.id === id);
    const root = doc.documentElement;
    // "original" means the handoff's own stack, so the override is removed rather than pointed at
    // the same plate -- one code path owns the default.
    if (!choice || choice.id === "original") {
      root.removeAttribute("data-bg");
      root.style.removeProperty("--machine-room-bg");
      return;
    }
    root.style.setProperty("--machine-room-bg", `url("${choice.full}")`);
    root.dataset.bg = choice.id;
  }

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
    const swatches = plain.map(swatch).join("")
      + [...bySeries].map(([name, tiles]) => `<p class="field-hint bg-series" style="flex-basis:100%;margin:10px 0 2px">${esc(name)}</p>${tiles.map(swatch).join("")}`).join("");
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
  // page, and the DOM half returns rather than throwing on a stub.
  global.__machineRoomBackgrounds = { DEFAULT_CHOICE, BUILT_IN };
  if (!doc) return;

  // Restore before first paint so the chosen plate is never seen swapping in.
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
