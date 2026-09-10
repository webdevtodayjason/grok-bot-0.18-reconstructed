/*
 * Notifications, the person's own switches (PUSH-1, docs/APPS.md).
 * -----------------------------------------------------------------
 * A sibling module on the verified CONSOLE-4 seam, the way gap-badge.js, screen-tile.js and
 * files-viewer.js are: loaded before app.js, it publishes window.__pushSettings at load and reads
 * app.js's published helpers lazily through window.__mrUi. app.js is NOT touched by this file, and
 * neither is gateway-adapter.js.
 *
 * HOW IT GETS ON SCREEN, and why it is not a second panel. SETTINGS-2 gave Notifications a section
 * of its own on the settings surface, and its body carries one empty slot, [data-push-mount]. This
 * file appends its <section class="settings-section"> into that slot when it appears, through a
 * MutationObserver on #panel-content and through the surface's own call after it paints that body.
 * Where there is no surface at all -- the panel app.js still draws when settings.js is not served --
 * it falls back to that panel's .settings-list, which is where this card has always gone.
 *
 * Keyed on the STRUCTURE and never on a string of copy. Keying on the panel's eyebrow would have
 * made this section disappear the day somebody reworded "Global router & policy", silently, with the
 * routes still live and nothing on screen to reach them -- which is exactly what SETTINGS-2 then did
 * to that wording.
 *
 * WHAT IT CAN AND CANNOT DO, said plainly, because the limits are the design:
 *
 *   - It reads and writes /push/settings and /push/devices, which are the relay's routes behind
 *     whatever already authenticated the page. From the console that is the session cookie; from a
 *     phone app it is the device bearer. This file never holds a credential of its own.
 *
 *   - It never shows a device token. A device row is for recognising your own phone and revoking it,
 *     and the token is the one field on it that is of no use to a person and of use to anybody else.
 *
 *   - Quiet hours hold the ALERT and never the badge. That is the server's rule, not this page's, and
 *     the copy says so rather than implying a silence this page cannot deliver.
 *
 *   - The badge a phone shows counts CARDS. The number in this console's own rail counts AGENTS, at
 *     most one per agent, and misses two of the six kinds. The two will therefore disagree in front
 *     of a customer. That is written on this card in plain words rather than left to be discovered,
 *     and the fix is filed as PUSH-3 with the phone pane as owner.
 *
 * ABSENT-MODULE BEHAVIOUR IS A GATE ASSERTION, NOT A COMMENT. With this file not loaded the console
 * boots exactly as it did before and Settings simply has one fewer section. Nothing in app.js
 * reaches into window.__pushSettings, which is what makes that true by construction.
 */
(function attachPushSettings(global) {
  "use strict";

  const ui = () => global.__mrUi ?? {};
  const escapeHtml = (value) => (ui().escapeHtml ?? ((v) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")))(value);

  const SECTION_MARK = "data-push-settings";

  // The six kinds, with the words a person reads rather than the words the wire uses. The wire names
  // are the keys, so this table and ui/push-edge.mjs's PUSH_CARD_KINDS cannot drift apart silently:
  // a kind the server adds and this table does not have is drawn with its own name.
  const KIND_COPY = {
    "auto-review": ["Actions waiting for your review", "An agent wants to do something your review rule holds back. These expire in ten minutes."],
    "local-tool": ["Permission to run something here", "An agent wants to run a tool on the box itself. These expire in ten minutes."],
    widget: ["Questions an agent asked you", "A multiple-choice question in a conversation."],
    // SETTINGS-2, a copy edit and nothing else: this card is a customer's, and both halves of this
    // pair carried a word a customer has no business reading ("Credentials", "a key").
    secret: ["When your agent needs a sign-in from you", "A tool asked for a login and he cannot go on without it."],
    "box-handoff": ["The keyboard, handed to you", "An agent needs you to do a step on its computer yourself."],
    report: ["Problems an agent wants to report", "An agent wrote up something that went wrong and is waiting for you to send it."],
  };
  const KIND_ORDER = ["auto-review", "local-tool", "box-handoff", "secret", "widget", "report"];

  const PLATFORM_WORDS = { ios: "iPhone or iPad", android: "Android phone", desktop: "Desktop app" };

  const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
  const hourLabel = (hour) => {
    const h = ((Number(hour) % 24) + 24) % 24;
    if (h === 0) return "midnight";
    if (h === 12) return "noon";
    return h < 12 ? `${h} in the morning` : `${h - 12} in the evening`;
  };

  const when = (ms) => {
    const at = Number(ms);
    if (!Number.isFinite(at) || at <= 0) return "";
    try { return new Date(at).toLocaleString(); } catch { return ""; }
  };

  // Every read and write this file does. Same-origin, credentials included, and no token anywhere in
  // a URL: the session cookie or the device bearer the page already holds is the whole mechanism.
  async function call(method, pathname, body) {
    const response = await global.fetch(pathname, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text.length > 0 ? JSON.parse(text) : null; } catch { parsed = null; }
    if (!response.ok) {
      throw new Error(String(parsed?.message ?? parsed?.error ?? `the relay answered ${response.status}`));
    }
    return parsed ?? {};
  }

  // ---- the markup ------------------------------------------------------------------------------
  //
  // Built as a string and handed to innerHTML the way every other section on this panel is, so the
  // card looks like its neighbours without a second stylesheet trying to match them. Every value
  // that came off the wire goes through escapeHtml: a device name is typed on a phone.

  function switchRow(kind, on) {
    const [title, detail] = KIND_COPY[kind] ?? [kind, ""];
    return `<div class="setting-row"><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(detail)}</small></div>`
      + `<button class="switch" type="button" data-push-kind="${escapeHtml(kind)}" aria-pressed="${on ? "true" : "false"}"></button></div>`;
  }

  function hourOptions(selected) {
    return HOURS.map((hour) => `<option value="${hour}"${Number(selected) === hour ? " selected" : ""}>${escapeHtml(hourLabel(hour))}</option>`).join("");
  }

  function devicesMarkup(devices) {
    if (!Array.isArray(devices) || devices.length === 0) {
      return `<p class="push-empty">No phone or desktop app is registered yet. Install the app, sign in, and it appears here.</p>`;
    }
    return devices.map((device) => {
      const name = String(device.name ?? "").trim() || (PLATFORM_WORDS[device.platform] ?? String(device.platform ?? "a device"));
      const registered = when(device.createdAt);
      const refreshed = when(device.tokenAt);
      const detail = [
        PLATFORM_WORDS[device.platform] ?? String(device.platform ?? ""),
        registered ? `added ${registered}` : "",
        refreshed && refreshed !== registered ? `last checked in ${refreshed}` : "",
      ].filter((part) => part.length > 0).join(" · ");
      return `<div class="setting-row"><div><strong>${escapeHtml(name)}</strong><small>${escapeHtml(detail)}</small></div>`
        + `<button class="ghost-button" type="button" data-push-revoke="${escapeHtml(device.deviceId)}">Stop notifying it</button></div>`;
    }).join("");
  }

  function sectionMarkup({ settings, devices, kinds }) {
    const quiet = settings?.quietHours ?? {};
    const known = Array.isArray(kinds) && kinds.length > 0 ? kinds : KIND_ORDER;
    const ordered = [...KIND_ORDER.filter((kind) => known.includes(kind)), ...known.filter((kind) => !KIND_ORDER.includes(kind))];
    return `<section class="settings-section" ${SECTION_MARK}><h3>Notifications</h3>`
      + `<p>Which cards wake your phone or your desktop app. A card that needs you sends one notification, and answering it anywhere clears the count everywhere.</p>`
      + ordered.map((kind) => switchRow(kind, settings?.kinds?.[kind] !== false)).join("")
      + `<div class="setting-row"><div><strong>Quiet hours</strong><small>Alerts are held until the window ends, and a card still waiting then gets one catch-up. The count on the app icon still drops while you sleep, silently.</small></div>`
      + `<button class="switch" type="button" data-push-quiet aria-pressed="${quiet.on === true ? "true" : "false"}"></button></div>`
      + `<div class="push-quiet-window"><label for="push-quiet-from">From</label><select id="push-quiet-from" data-push-from>${hourOptions(quiet.from ?? 22)}</select>`
      + `<label for="push-quiet-to">until</label><select id="push-quiet-to" data-push-to>${hourOptions(quiet.to ?? 7)}</select>`
      + `<small data-push-offset>${escapeHtml(offsetWords(settings?.utcOffsetMinutes))}</small></div>`
      + `<div class="form-actions"><button class="primary-button" type="button" data-push-save>Save notifications</button><small data-push-note></small></div>`
      + `<h3>Devices</h3><p>Every phone and desktop app signed in to this workspace. Stopping one takes effect at once and does not sign it out.</p>`
      + devicesMarkup(devices)
      + `<p class="push-divergence">The number on the app icon counts cards. The count in this console's own rail counts conversations, so the two can differ while more than one card is waiting on the same agent.</p>`
      + `</section>`;
  }

  function offsetWords(minutes) {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value === 0) return "Hours are read in UTC until the app sends its own offset.";
    const sign = value < 0 ? "-" : "+";
    const abs = Math.abs(value);
    return `Hours are read at UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}, which is what your app last reported.`;
  }

  // ---- the live card ----------------------------------------------------------------------------

  let held = { settings: null, devices: [], kinds: KIND_ORDER };

  function noteInto(section, words, bad) {
    const note = section.querySelector("[data-push-note]");
    if (!note) return;
    note.textContent = String(words ?? "");
    note.className = bad ? "push-note bad" : "push-note";
  }

  function bind(section) {
    section.addEventListener("click", async (event) => {
      const toggle = event.target.closest?.("[data-push-kind], [data-push-quiet]");
      if (toggle) {
        toggle.setAttribute("aria-pressed", toggle.getAttribute("aria-pressed") === "true" ? "false" : "true");
        return;
      }
      const revoke = event.target.closest?.("[data-push-revoke]");
      if (revoke) {
        const deviceId = revoke.dataset.pushRevoke;
        revoke.disabled = true;
        try {
          await call("DELETE", `/push/devices/${encodeURIComponent(deviceId)}`);
          await fill(section);
        } catch (error) { noteInto(section, String(error.message), true); revoke.disabled = false; }
        return;
      }
      const save = event.target.closest?.("[data-push-save]");
      if (!save) return;
      save.disabled = true;
      const kinds = {};
      for (const node of section.querySelectorAll("[data-push-kind]")) kinds[node.dataset.pushKind] = node.getAttribute("aria-pressed") === "true";
      const body = {
        kinds,
        quietHours: {
          on: section.querySelector("[data-push-quiet]")?.getAttribute("aria-pressed") === "true",
          from: Number(section.querySelector("[data-push-from]")?.value ?? 22),
          to: Number(section.querySelector("[data-push-to]")?.value ?? 7),
        },
        // The browser's own offset, sent on every save, so the console and the app agree about what
        // "ten in the evening" means without either of them holding a zone database.
        utcOffsetMinutes: -new Date().getTimezoneOffset(),
      };
      try {
        const answer = await call("PUT", "/push/settings", body);
        held = { ...held, settings: answer.settings ?? body };
        noteInto(section, "Saved.", false);
        const offset = section.querySelector("[data-push-offset]");
        if (offset) offset.textContent = offsetWords(held.settings?.utcOffsetMinutes);
      } catch (error) { noteInto(section, String(error.message), true); }
      finally { save.disabled = false; }
    });
  }

  /** Re-reads both routes and redraws the card in place. */
  async function fill(section) {
    let settings = null;
    let devices = [];
    let kinds = KIND_ORDER;
    try {
      const answer = await call("GET", "/push/settings");
      settings = answer.settings ?? null;
      if (Array.isArray(answer.kinds) && answer.kinds.length > 0) kinds = answer.kinds;
    } catch (error) {
      // A relay without the push routes is not a fault worth a red card on somebody's Settings: it
      // is an older deployment, and saying so in one sentence is the honest answer.
      section.innerHTML = `<h3>Notifications</h3><p>This console cannot reach its notification settings yet: ${escapeHtml(error.message)}</p>`;
      return;
    }
    try { devices = (await call("GET", "/push/devices")).devices ?? []; } catch { devices = []; }
    held = { settings, devices, kinds };
    const fresh = global.document.createElement("div");
    fresh.innerHTML = sectionMarkup(held);
    const next = fresh.firstElementChild;
    section.innerHTML = next.innerHTML;
  }

  /**
   * Where this card belongs on whatever Settings is open, and nowhere else.
   *
   * SETTINGS-2: the surface paints ONE body at a time, and the Notifications body carries the slot
   * this aims at. With the surface on screen and that slot absent, the person is looking at another
   * section and there is nothing to mount into -- a null is the right answer, not a miss, and it is
   * what stops this card being appended to the Operator section's card stack. The .settings-list
   * fallback is the panel that shipped before the surface, which app.js still draws when settings.js
   * is not served: keyed on the STRUCTURE, never on a string of copy, exactly as before.
   */
  function pushTarget(panel) {
    if (typeof panel?.querySelector !== "function") return null;
    const slot = panel.querySelector("[data-push-mount]");
    if (slot != null) return slot;
    return panel.querySelector("[data-settings-surface]") == null ? panel.querySelector(".settings-list") : null;
  }

  /** Appends the card to an open Settings panel, once. */
  function mount(panel) {
    const list = pushTarget(panel);
    if (!list || list.querySelector(`[${SECTION_MARK}]`)) return;
    const host = global.document.createElement("section");
    host.className = "settings-section";
    host.setAttribute(SECTION_MARK, "");
    host.innerHTML = `<h3>Notifications</h3><p class="push-empty">Reading your notification settings…</p>`;
    list.appendChild(host);
    bind(host);
    void fill(host).catch(() => { /* fill writes its own sentence */ });
  }

  function watch() {
    const doc = global.document;
    const panel = doc?.getElementById?.("panel-content");
    if (panel == null) return null;
    // openPanel replaces innerHTML wholesale on every open, so the card is mounted on the mutation
    // rather than once at load: a listener bound to the node would be thrown away with it.
    const observer = new global.MutationObserver(() => mount(panel));
    observer.observe(panel, { childList: true });
    mount(panel);
    return observer;
  }

  function ensureStylesheet() {
    const doc = global.document;
    if (!doc?.head || doc.querySelector('link[href$="push-settings.css"]')) return;
    const link = doc.createElement("link");
    link.rel = "stylesheet";
    link.href = "push-settings.css";
    doc.head.appendChild(link);
  }

  if (global.document != null) {
    ensureStylesheet();
    if (global.document.readyState === "loading") global.document.addEventListener("DOMContentLoaded", () => { watch(); });
    else watch();
  }

  global.__pushSettings = {
    // The pure pieces, exported for the unit test and the gate rather than re-implemented there.
    sectionMarkup,
    devicesMarkup,
    switchRow,
    offsetWords,
    hourLabel,
    mount,
    fill,
    watch,
    KIND_COPY,
    KIND_ORDER,
    state: () => held,
  };
})(typeof window !== "undefined" ? window : globalThis);
