/*
 * AVATAR-1: the agents on this page are the Titan crew, and they move.
 * --------------------------------------------------------------------
 * Jason, 2026-09-06: "that blue canvas mascot is how we're going to make our first bot. Titan will
 * always be the first one for everybody, and we will use all the other bot characters. Inside the
 * dashboard I want them to be little mini canvases where they're actually moving."
 *
 * This file is the wiring. Who is who and what mood each one is in are decided in mascot-crew.js,
 * which is pure and tested; the drawing is assets/titan-mascot.js, which is the design kit's own
 * file, vendored byte for byte. Nothing here draws a character.
 *
 * It hooks app.js at exactly one point. `avatarMarkup` is the single funnel every face on the page
 * goes through -- roster card, chat header pill, Agent details, the composer's chip strip, the Now
 * island -- so `window.titanAvatarMarkup` is consulted there and answers with a <titan-mascot> or
 * with nothing. Answering with nothing is a real answer, and it is given in three cases:
 *
 *   - the operator chose one of the two opt-outs in Agent details: the classic flat mark, or the
 *     picture they uploaded to the host. A character is the default, so both have to be said out
 *     loud rather than inferred -- an agent with an uploaded avatar and no choice on record still
 *     gets a character, because the point of this change is that the crew is the product's face;
 *   - the record is a room, which draws the faces of its members rather than one of its own;
 *   - this browser cannot run the canvas, or its owner asked for `prefers-reduced-motion: reduce`,
 *     in which case the kit's own still for that character and mood is shown instead.
 *
 * MOTION AND THE MAIN THREAD. Nine agents means nine canvases. Each one is a 120-point contour
 * redrawn per frame, so they have to stop when nobody is looking: the mascot element already stops
 * itself when the document is hidden or it leaves the viewport, and this file adds a second
 * observer for the case its own cannot see -- a card inside the roster's collapsed Hidden group,
 * which is laid out but not on screen. Measured with all nine on the roster, main-thread work over
 * ten seconds is reported by scripts/verify-dashboard.mjs.
 */
(function attachMascots(global) {
  "use strict";

  const doc = global.document;
  if (!doc) return;

  const crew = global.TitanCrew;
  const reducedMotion = global.matchMedia ? global.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  // A browser without custom elements gets the stills. So does one that asked for less motion.
  const canAnimate = () => Boolean(crew) && typeof global.customElements === "object" && !reducedMotion.matches;

  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---- state -------------------------------------------------------------------------------
  // Who is who, recomputed from the roster whenever it changes. Empty until the adapter is up,
  // which is before app.js's first render (app.js publishes the adapter, then renders).
  let assignment = new Map();
  // agent id -> the moment its celebration ends. A turn that landed a reply is excited for six
  // seconds; nothing else needs a clock, so nothing else is kept here.
  const celebrating = new Map();
  const lastStatus = new Map();
  let celebrationTimer = null;
  let adapter = null;
  // Records the crew has no face for: groups, and anything the roster no longer holds. See
  // ensureAssignment below for why this has to be remembered rather than re-derived per face.
  const faceless = new Set();

  function rosterOf(snapshot) {
    if (!snapshot) return [];
    return [...(snapshot.workers ?? []), ...(snapshot.rooms ?? [])];
  }

  function reassign(snapshot) {
    if (!crew) return;
    assignment = crew.assignCrew(rosterOf(snapshot));
    faceless.clear();
  }

  /** Status transitions, read off the roster the page already paints. */
  function trackMoods(snapshot) {
    const now = Date.now();
    for (const record of rosterOf(snapshot)) {
      const previous = lastStatus.get(record.id);
      const until = crew ? crew.celebrationUntil(previous, record, now) : 0;
      if (until) celebrating.set(record.id, until);
      lastStatus.set(record.id, record.status);
    }
    scheduleCelebrationEnd();
  }

  /**
   * One timer for the whole page, set to the next celebration that expires. When it fires the
   * faces still on screen are re-read rather than redrawn: the mood is an attribute, and the
   * element crossfades between moods on its own.
   */
  function scheduleCelebrationEnd() {
    if (celebrationTimer !== null) { global.clearTimeout(celebrationTimer); celebrationTimer = null; }
    let soonest = Infinity;
    const now = Date.now();
    for (const [id, until] of celebrating) {
      if (until <= now) { celebrating.delete(id); continue; }
      soonest = Math.min(soonest, until);
    }
    if (soonest === Infinity) return;
    celebrationTimer = global.setTimeout(() => { celebrationTimer = null; syncMoods(); scheduleCelebrationEnd(); }, Math.max(50, soonest - now));
  }

  const recordById = (id) => {
    const snapshot = adapter && typeof adapter.getSnapshot === "function" ? adapter.getSnapshot() : null;
    return rosterOf(snapshot).find((r) => r.id === id) ?? null;
  };

  function moodOf(record) {
    if (!crew || !record) return "calm";
    return crew.moodFor(record, { now: Date.now(), celebratingUntil: celebrating.get(record.id) ?? 0 });
  }

  /** Move the moods of the faces already on screen without rebuilding any of them. */
  function syncMoods() {
    const snapshot = adapter && typeof adapter.getSnapshot === "function" ? adapter.getSnapshot() : null;
    const roster = new Map(rosterOf(snapshot).map((r) => [r.id, r]));
    doc.querySelectorAll("[data-titan-agent]").forEach((frame) => {
      const record = roster.get(frame.dataset.titanAgent);
      if (!record) return;
      if (crew.attentionFor(record)) frame.dataset.titanAttention = "1";
      else delete frame.dataset.titanAttention;
      const mood = moodOf(record);
      if (frame.dataset.titanMood === mood) return;
      frame.dataset.titanMood = mood;
      const mascot = frame.querySelector("titan-mascot");
      if (mascot) { mascot.setAttribute("mood", mood); return; }
      const still = frame.querySelector("img");
      const face = assignment.get(record.id);
      if (still && face && face.index >= 0) still.src = crew.stillFor(face.index, mood);
    });
  }

  /**
   * The map is rebuilt when the adapter says the roster changed -- but app.js subscribed first, so
   * on the event that carries a new agent or a just-written character it redraws before this file
   * has caught up, and the face for one frame would be the old one. Rather than fight the order,
   * the record app.js is drawing right now is checked against the map, and the map is rebuilt when
   * they disagree. It is one `storedChoice` per face drawn, and a rebuild only when something
   * actually moved.
   */
  function ensureAssignment(worker) {
    const face = assignment.get(worker.id);
    const stored = crew.storedChoice(worker);
    const agrees = stored == null
      ? Boolean(face) && face.source !== "stored"
      : Boolean(face) && face.source === "stored" && (stored === face.opt || stored === face.character);
    // A group takes no character, and neither does a record the roster does not hold. Rebuilding
    // the map for one of those would rebuild it again on the next face drawn and never settle, so
    // the answer is remembered until the next roster event clears it.
    if (agrees || worker.isGroup === true || faceless.has(worker.id)) return face ?? null;
    reassign(adapter && typeof adapter.getSnapshot === "function" ? adapter.getSnapshot() : null);
    const found = assignment.get(worker.id) ?? null;
    if (!found) faceless.add(worker.id);
    return found;
  }

  // ---- the hook app.js calls ---------------------------------------------------------------
  global.titanAvatarMarkup = function titanAvatarMarkup(worker, className, title) {
    try {
      return crewFaceMarkup(worker, className, title);
    } catch (error) {
      // This runs inside app.js's own render, and every face on the page goes through it. A throw
      // here would take the roster, the transcript and the panel with it, so the answer to a bug
      // in this file is the mark app.js was drawing before, not a blank console.
      console.warn("[titan] the crew face was not drawn:", error);
      return "";
    }
  };

  function crewFaceMarkup(worker, className, title) {
    if (!crew || !worker || !worker.id) return "";
    ensureAdapter();
    const face = ensureAssignment(worker);
    if (!face || face.opt || face.index < 0) return "";
    const name = title || worker.name || "Agent";
    const mood = moodOf(worker);
    const label = `${name}, drawn as ${crew.CREW[face.index].name}`;
    const frame = `class="${esc(className)} titan-avatar" data-titan-agent="${esc(worker.id)}" data-titan-character="${esc(crew.CREW[face.index].name)}" data-titan-mood="${esc(mood)}"${crew.attentionFor(worker) ? ' data-titan-attention="1"' : ""} role="img" aria-label="${esc(label)}"`;
    if (!canAnimate()) {
      return `<span ${frame}><img src="${esc(crew.stillFor(face.index, mood))}" alt="" /></span>`;
    }
    // tracking="off" everywhere it is drawn small. Thirteen faces all following the pointer at
    // once reads as a room of staring eyes, not as company. Agent details turns it back on --
    // syncPanel() below -- because that is one face, at 64px, being looked at deliberately.
    return `<span ${frame}><titan-mascot variant="${face.index}" mood="${esc(mood)}" tracking="off"></titan-mascot></span>`;
  }

  // ---- pausing what nobody is looking at ----------------------------------------------------
  // The mascot element runs its own IntersectionObserver, which covers scrolling. It cannot see
  // the case this one is for: a card inside the roster's collapsed <details>, which the browser
  // lays out at zero height. Pausing is an attribute; playing again is deliberate, and is never
  // done under reduced motion, where play() would override the preference the element respects.
  const parked = new WeakSet();
  const viewport = typeof global.IntersectionObserver === "function"
    ? new global.IntersectionObserver((entries) => {
        for (const entry of entries) {
          const mascot = entry.target.querySelector("titan-mascot");
          if (!mascot || typeof mascot.pause !== "function") continue;
          if (!entry.isIntersecting) { mascot.pause(); parked.add(mascot); continue; }
          // Not play(): the kit's play() marks the element manually played for good, which would keep
          // it moving if the viewer turns reduced motion on later. Dropping the attribute pause() set
          // hands the decision back to the preference.
          if (parked.has(mascot) && !reducedMotion.matches) { mascot.removeAttribute("paused"); parked.delete(mascot); }
        }
      }, { rootMargin: "40px" })
    : null;

  function observeFaces() {
    if (!viewport) return;
    doc.querySelectorAll(".titan-avatar").forEach((frame) => {
      if (frame.dataset.titanWatched === "1") return;
      frame.dataset.titanWatched = "1";
      viewport.observe(frame);
    });
  }

  // ---- Agent details: the character row ------------------------------------------------------
  function characterRowMarkup(worker, face) {
    const chosen = (value) => (face && face.opt === value ? " selected" : "");
    const options = [
      // The name alone. The blurb is longer than the control and was cut mid-word; it belongs on
      // the line under the label, where there is room for it.
      ...crew.CREW.map((c, i) => `<option value="${esc(c.name)}"${face && !face.opt && face.index === i ? " selected" : ""}>${esc(c.name)}</option>`),
      // Only offered where there is one. An option that draws nothing is not an option.
      worker.avatarVersion != null ? `<option value="${esc(crew.UPLOADED)}"${chosen(crew.UPLOADED)}>The picture uploaded to the host</option>` : "",
      `<option value="${esc(crew.CLASSIC)}"${chosen(crew.CLASSIC)}>Classic avatar (the flat mark)</option>`,
    ].join("");
    // Say which answer this is. "Chosen" and "worked out from the roster" are different facts and
    // an operator deciding whether to change it should not have to guess which one is on screen.
    const note = !face ? ""
      : face.opt === "uploaded" ? "This agent is drawn as the picture uploaded to the host."
      : face.opt === "classic" ? "This agent is drawn as the flat mark rather than a character."
      : face.source === "stored" ? "This character was chosen for this agent and the host is holding it."
      : face.source === "first" ? "The first agent on an instance is always Titan."
      : face.source === "hash" ? "This host reports no creation date for this agent, so the character is picked from its id and stays the same."
      : "Worked out from the order the agents on this box were created. Pick one and the host holds it instead.";
    const blurb = face && !face.opt && face.index >= 0 ? `${crew.CREW[face.index].blurb} ` : "";
    // The row is rebuilt when this key moves: a new choice, or an avatar arriving on the host,
    // which is what makes "the picture uploaded to the host" an option at all.
    const key = `${worker.id}:${worker.avatarVersion ?? ""}:${face ? face.opt ?? face.character : ""}`;
    return `<div class="setting-row" data-titan-character-row data-titan-row-key="${esc(key)}"><div><strong>Character</strong><small data-titan-character-note>${esc(blurb + note)}</small></div><div class="field" style="margin:0"><label class="sr-only" for="agent-character">Character</label><select id="agent-character" data-character-for="${esc(worker.id)}">${options}</select></div></div>`;
  }

  function syncPanel() {
    const panel = doc.getElementById("panel-content");
    if (!panel) return;
    // Agent details is the one surface where a crew member looks back at the pointer.
    panel.querySelectorAll(".titan-avatar > titan-mascot[tracking]").forEach((m) => m.removeAttribute("tracking"));
    if (!crew || !adapter || typeof adapter.setCharacter !== "function") return;
    const upload = panel.querySelector("[data-avatar-for]");
    if (!upload) return;
    const worker = recordById(upload.dataset.avatarFor);
    if (!worker) return;
    const face = ensureAssignment(worker);
    const existing = panel.querySelector("[data-titan-character-row]");
    const markup = characterRowMarkup(worker, face);
    const key = /data-titan-row-key="([^"]*)"/.exec(markup)[1];
    if (existing) {
      if (existing.dataset.titanRowKey === key) return;
      existing.remove();
    }
    const row = upload.closest(".setting-row");
    if (!row) return;
    row.insertAdjacentHTML("afterend", markup);
    const select = panel.querySelector("[data-character-for]");
    const note = panel.querySelector("[data-titan-character-note]");
    select.addEventListener("change", () => {
      const choice = select.value;
      select.disabled = true;
      if (note) note.textContent = "Writing it to the host…";
      adapter.setCharacter(worker.id, choice)
        .then((saved) => {
          if (!note) return;
          const index = crew.indexOfCharacter(saved);
          note.textContent = index >= 0
            ? `${crew.CREW[index].blurb} The host is holding ${saved} for this agent.`
            : `The host is holding the ${saved === crew.UPLOADED ? "uploaded picture" : "classic mark"} for this agent.`;
        })
        .catch((error) => { if (note) note.textContent = `The host did not take it: ${error.message}`; })
        .finally(() => { select.disabled = false; repaintPanelFace(worker.id); });
    });
  }

  /**
   * The panel is drawn once, on the click that opened it, so the face in its header does not
   * follow a character chosen underneath it. One element, replaced in place.
   */
  function repaintPanelFace(agentId) {
    const frame = doc.querySelector("#panel-content .context-profile-avatar");
    const worker = recordById(agentId);
    if (!frame || !worker) return;
    const drawn = global.titanAvatarMarkup(worker, "context-profile-avatar", worker.name);
    frame.outerHTML = drawn || `<img class="context-profile-avatar" src="${esc(worker.avatar)}" alt="${esc(worker.name)}" />`;
    afterRender();
  }

  // ---- wiring --------------------------------------------------------------------------------
  function afterRender() {
    observeFaces();
    syncPanel();
  }

  function ensureAdapter() {
    if (adapter || !global.__machineRoomAdapter) return;
    adapter = global.__machineRoomAdapter;
    const snapshot = typeof adapter.getSnapshot === "function" ? adapter.getSnapshot() : null;
    reassign(snapshot);
    // Seed the status map without celebrating: a page that opens on an agent which finished a turn
    // an hour ago should not throw it a party.
    for (const record of rosterOf(snapshot)) lastStatus.set(record.id, record.status);
    if (typeof adapter.subscribe === "function") {
      adapter.subscribe((event) => {
        reassign(event && event.snapshot);
        trackMoods(event && event.snapshot);
        // app.js redraws on the same event; this runs after that redraw rather than racing it.
        global.setTimeout(afterRender, 0);
      });
    }
  }

  // The hook has to exist before app.js's first render, so this file is loaded ahead of it and the
  // adapter is picked up lazily -- app.js publishes it on the line before it renders. The poll is
  // the belt to that braces: nothing else here depends on it arriving on any particular tick.
  ensureAdapter();
  const waiting = global.setInterval(() => { ensureAdapter(); if (adapter) { global.clearInterval(waiting); afterRender(); } }, 200);
  if (reducedMotion.addEventListener) reducedMotion.addEventListener("change", () => global.setTimeout(afterRender, 0));

  // The panel is filled by a click, not by an adapter event, so its row is injected on the same
  // two buttons' clicks the background picker uses -- plus any redraw of the panel itself.
  const watchPanel = () => {
    const panel = doc.getElementById("panel-content");
    if (!panel || panel.dataset.titanWatched === "1") return;
    panel.dataset.titanWatched = "1";
    new global.MutationObserver(() => global.setTimeout(afterRender, 0)).observe(panel, { childList: true, subtree: true });
  };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", watchPanel);
  else watchPanel();

  global.__titanMascots = { assignmentOf: (id) => assignment.get(id) ?? null, moodOf, syncMoods, afterRender };
})(window);
