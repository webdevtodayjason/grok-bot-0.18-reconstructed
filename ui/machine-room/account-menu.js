/*
 * The account menu at the foot of the roster (SETTINGS-2, docs/SETTINGS.md section 3).
 * ==================================================================================
 * The original product puts the workspace's own tile at the bottom-left of the conversation list,
 * with a small download arrow beside the name when a newer build is waiting. Pressing it opens a
 * short menu: the update banner, weekly usage, the mobile app, Support, Settings, a rule, Log out.
 * That is what this file builds, and it is the phone's SECOND route into Settings -- the roster
 * drawer's foot -- because at phone widths the shelf gear is display:none (MOBILE-2c).
 *
 * It is a sibling module on the verified CONSOLE-4 seam, the same contract push-settings.js keeps:
 * it publishes window.__accountMenu at load, reads window.__mrUi and window.__mrSettings lazily,
 * finds its own host in the DOM, and no-ops with either absent. app.js is not touched by it.
 *
 * THE ROWS ARE NOT DEFINED HERE. settings.js owns accountMenuRows(facts) so that one list answers
 * the unit test, this menu and the gate; this file renders that list and presses the actions.
 *
 * WHAT "RESTART TO UPDATE" MEANS ON A WEB CONSOLE, said plainly rather than pretended about: the
 * reference is a desktop app and restarts itself. This is a page, so accepting an update reloads it
 * once the host has taken the update. The dialog says that in its own words.
 */
(function attachAccountMenu(global) {
  "use strict";

  const ui = () => global.__mrUi ?? {};
  const settings = () => global.__mrSettings ?? null;
  const host = () => ui().settingsHost ?? {};
  const adapter = () => global.__machineRoomAdapter ?? null;
  const doc = () => global.document ?? null;

  const esc = (value) => (ui().escapeHtml ?? ((v) => String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")))(value);
  const toast = (words) => { const say = ui().showToast; if (typeof say === "function") say(words); };

  // Where the app store listing will be when there is one. Until then it is the product's own page,
  // which exists; a row pointing at a 404 is worse than a row that lands somewhere honest.
  const MOBILE_PAGE = "https://titanium.bot/app";

  let open = false;

  const rowsNow = () => (settings()?.accountMenuRows?.(settings()?.facts?.() ?? {}) ?? []);

  function rowMarkup(row) {
    if (row.kind === "rule") return `<div class="account-menu-rule" role="separator"></div>`;
    if (row.kind === "banner") {
      return `<div class="account-menu-banner" data-account-row="${esc(row.id)}"><span>${esc(row.label)}</span>`
        + `<button class="primary-button" type="button" data-account-action="${esc(row.action)}">${esc(row.button)}</button></div>`;
    }
    if (row.kind === "submenu") {
      return `<details class="account-menu-submenu" data-account-row="${esc(row.id)}"><summary>${esc(row.label)}<span aria-hidden="true">›</span></summary>`
        + row.items.map((item) => `<button class="account-menu-item" type="button" data-account-action="${esc(item.action)}" data-account-row="${esc(item.id)}">${esc(item.label)}</button>`).join("")
        + `</details>`;
    }
    return `<button class="account-menu-item" type="button" data-account-action="${esc(row.action)}" data-account-row="${esc(row.id)}">`
      + `<span>${esc(row.label)}</span>${row.chevron ? `<span aria-hidden="true">›</span>` : ""}</button>`;
  }

  function tileMarkup() {
    const facts = settings()?.facts?.() ?? {};
    const name = facts.workspaceName ?? (typeof host().workspaceName === "function" ? host().workspaceName() : null) ?? "Your workspace";
    const initial = String(name).trim().slice(0, 1).toUpperCase();
    return `<button class="account-tile" type="button" data-account-tile aria-expanded="${open}" aria-haspopup="menu">`
      + `<span class="account-tile-avatar" aria-hidden="true">${esc(initial)}</span>`
      + `<span class="account-tile-name">${esc(name)}</span>`
      + (facts.updateAvailable === true ? `<span class="account-tile-update" aria-label="An update is waiting">⤓</span>` : "")
      + `</button>`
      + (open ? `<div class="account-menu" role="menu" data-account-menu>${rowsNow().map(rowMarkup).join("")}</div>` : "");
  }

  function draw() {
    const document_ = doc();
    const roster = document_?.getElementById("worker-roster");
    if (roster == null) return;
    let foot = roster.querySelector("[data-account-foot]");
    if (foot == null) {
      foot = document_.createElement("div");
      foot.className = "account-foot";
      foot.setAttribute("data-account-foot", "");
      roster.appendChild(foot);
    }
    foot.innerHTML = tileMarkup();
  }

  function updateDialog() {
    const document_ = doc();
    const facts = settings()?.facts?.() ?? {};
    const existing = document_.querySelector("[data-update-dialog]");
    if (existing != null) existing.remove();
    const node = document_.createElement("div");
    node.className = "account-update-dialog";
    node.setAttribute("data-update-dialog", "");
    node.setAttribute("role", "dialog");
    node.setAttribute("aria-label", "Update ready");
    node.innerHTML = `<div class="account-update-frame"><strong>Update ready</strong>`
      + `<p>Restart to finish installing Titanium Bot${facts.version ? ` ${esc(facts.version)}` : ""}. Your bots and work will be right where you left them.</p>`
      + `<p class="account-update-note">This console is a page, so restarting means reloading it.</p>`
      + `<div class="account-update-actions"><button class="ghost-button" type="button" data-account-action="update-not-now">Not now</button>`
      + `<button class="primary-button" type="button" data-account-action="update-restart">Restart to update</button></div></div>`;
    document_.body.appendChild(node);
  }

  async function act(action, node) {
    const api = adapter();
    const h = host();
    if (action === "open-settings") { close(); settings()?.open?.("general"); return; }
    if (action === "open-usage") { close(); settings()?.open?.("usage"); return; }
    if (action === "get-the-app") { close(); global.open?.(MOBILE_PAGE, "_blank", "noopener"); return; }
    if (action === "send-feedback") { close(); if (typeof h.openReport === "function") h.openReport(); else toast("This console cannot open a report from here."); return; }
    if (action === "self-test") { close(); if (typeof h.runSelfTest !== "function" || h.runSelfTest() == null) toast("This console cannot send a prompt from here."); return; }
    if (action === "about") {
      const facts = settings()?.facts?.() ?? {};
      toast(facts.version ? `Titanium Bot ${facts.version}` : "Titanium Bot");
      return;
    }
    if (action === "sign-out") {
      try { await global.fetch("/logout", { method: "POST" }); } catch { /* going anyway */ }
      global.location?.assign?.("/login");
      return;
    }
    if (action === "install-update") { close(); updateDialog(); return; }
    if (action === "update-not-now") { doc().querySelector("[data-update-dialog]")?.remove(); return; }
    if (action === "update-restart") {
      doc().querySelector("[data-update-dialog]")?.remove();
      const id = typeof h.leadId === "function" ? h.leadId() : null;
      if (id == null || typeof api?.updateBox !== "function") { toast("This console cannot take the update from here."); return; }
      node.disabled = true;
      try {
        await api.updateBox(id);
        toast("Updating. This page reloads when it is done.");
        global.setTimeout(() => global.location?.reload?.(), 1500);
      } catch (error) { toast(`The update did not start: ${error.message}`); }
      return;
    }
  }

  function close() { if (!open) return; open = false; draw(); }

  function wire() {
    const document_ = doc();
    if (document_ == null) return;
    document_.addEventListener("click", (event) => {
      const tile = event.target.closest?.("[data-account-tile]");
      if (tile != null) { open = !open; draw(); return; }
      const control = event.target.closest?.("[data-account-action]");
      if (control != null) { void act(control.dataset.accountAction, control); return; }
      // Anywhere else closes it, the way every other menu on this console behaves.
      if (open && event.target.closest?.("[data-account-menu]") == null) close();
    });
    document_.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (document_.querySelector("[data-update-dialog]") != null) { document_.querySelector("[data-update-dialog]").remove(); return; }
      close();
    });
  }

  function boot() {
    draw();
    wire();
    // The roster is rebuilt wholesale on every render, so the tile is put back when it goes. Keyed on
    // the node being gone rather than on a render event, so it survives whatever app.js does next.
    const roster = doc()?.getElementById("worker-roster");
    if (roster == null) return;
    try {
      new global.MutationObserver(() => { if (roster.querySelector("[data-account-foot]") == null) draw(); })
        .observe(roster, { childList: true });
    } catch { /* no observer, one tile, drawn once */ }
    // The update arrow and the weekly figure come from the same facts the surface reads, so the tile
    // is redrawn once they have landed.
    global.setTimeout(() => { void settings()?.refresh?.().then(draw).catch(() => {}); }, 2500);
  }

  if (doc() != null) {
    if (doc().readyState === "loading") doc().addEventListener("DOMContentLoaded", boot);
    else boot();
  }

  global.__accountMenu = { draw, close, rowsNow, _tileMarkup: tileMarkup, _rowMarkup: rowMarkup, isOpen: () => open };
})(typeof window !== "undefined" ? window : globalThis);
