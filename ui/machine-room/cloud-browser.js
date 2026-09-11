/*
 * CLOUD-BROWSER-1 — the cloud browser, from the console's side.
 * -------------------------------------------------------------
 * Two things on screen, and neither of them is a new panel:
 *
 *   1. a strip in the Computer card that says WHERE the browser runs -- this computer or a cloud
 *      one -- and what this month has cost in minutes and gigabytes;
 *   2. a "Take over in the cloud browser" row BESIDE the hand-off card, drawn only while the same
 *      agent actually has a live cloud session open.
 *
 * WHY IT IS ITS OWN FILE, and this is the whole reason it exists rather than living in app.js.
 * Three waves are building on this branch at once. marketplace-bots.js already proved the shape: an
 * IIFE on a window global with its own relay gateway, so app.js and gateway-adapter.js stay other
 * people's files. Nothing here reaches into either.
 *
 * WHY IT DOES NOT TOUCH THE HAND-OFF CARD. request_box_help takes instruction, reason, domain and
 * idp_domain and nothing else, and its card paints a thumbnail off the box's own noVNC seat chosen
 * from `boxSeat`. HANDBACK-2 is the row where painting the wrong seat showed a person another
 * agent's wallpaper and they decided on it. So: no new tool parameter, no repointed seat, and no
 * cloud session ever painting :1. The live view is a fact about the AGENT, answered by its own
 * gateway command, and drawn next to the card rather than inside it.
 *
 * WHY THERE IS NO THUMBNAIL OF THE CLOUD BROWSER. Every box desktop mount is same-origin
 * `${origin}/vnc/<display>/` on purpose, which is what makes its canvas readable for a thumbnail.
 * A vendor's live view is third party, so no thumbnail can ever be read from one. And a vendor may
 * refuse framing outright -- Browserbase documents an iframe embed verbatim with
 * sandbox="allow-same-origin allow-scripts", Browser Use's liveUrl is a page, and either can start
 * sending frame-ancestors tomorrow. So the frame is always drawn beside a plain link, and a refused
 * frame is never left as a blank rectangle: an onload that never fires flips the row to the link.
 *
 * WORDS. Nothing on this page names a vendor to the person. "A cloud browser" is what it is called,
 * because which company runs it is an operator's business and not a customer's, and because a
 * vendor name in a sentence Titan repeats is a tool name by another route.
 *
 * MOUNTING. Two ways in, and it works with either:
 *   - window.__cloudBrowser.computerStrip(state) / .handoffStrip(state), called from app.js's
 *     Computer card paint and beside the hand-off card;
 *   - failing that, it finds the cards itself and keeps them up to date. That second road is what
 *     makes this file useful the moment index.html loads it, with no edit to anybody else's paint.
 */
(function attachCloudBrowser(global) {
  "use strict";

  const UNKNOWN_COMMAND = /unknown gateway method/i;

  // The same route gateway-adapter.js uses: the relay holds the gateway token and proxies
  // /api/<method>. A host older than this wave answers "unknown gateway method", which is the one
  // string that separates "this box has no cloud browser yet" from "the host refused".
  function relayGateway() {
    return {
      async call(method, args) {
        const response = await global.fetch(`/api/${method}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args == null ? {} : args),
        });
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        if (!response.ok) throw new Error((body && body.error) || `${method} failed (${response.status})`);
        return body;
      },
    };
  }

  const escapeHtml = (value) => String(value ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  // Only http(s) is ever put in a frame or a link. A live view is a URL a vendor gave us, and a
  // javascript: or data: URL that arrived from anywhere is not something to hand a click to.
  function safeUrl(value) {
    const raw = String(value ?? "").trim();
    if (raw.length === 0) return "";
    try {
      const parsed = new URL(raw);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : "";
    } catch {
      return "";
    }
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /**
   * The month's cost, in the two units that actually make it up. Minutes alone under-report a cloud
   * browser by an order of magnitude: browser time is cents an hour and a residential proxy is
   * dollars a gigabyte, so a strip that showed only minutes would read as free.
   */
  function usageSentence(usage) {
    if (usage == null || !(usage.sessions > 0)) return "No cloud browsing this month.";
    const parts = [plural(usage.sessions, "session", "sessions"), `${Math.round((usage.minutes ?? 0) * 10) / 10} min`];
    if (typeof usage.proxyBytes === "number") {
      parts.push(`${(usage.proxyBytes / (1024 * 1024 * 1024)).toFixed(2)} GB through the exit`);
    } else {
      // Never a zero here. A zero reads as "no traffic", and on a residential exit that is the most
      // expensive wrong number on this page.
      parts.push("traffic not reported by this browser");
    }
    return `This month: ${parts.join(", ")}.`;
  }

  // ------------------------------------------------------------------ the live state
  //
  // One poll, shared. The strip and the hand-off row want the same answer, and two timers asking
  // the same question twice a second is how a console starts costing the box something.
  const state = { sessions: [], usage: null, available: [], asked: false, supported: true, at: 0 };
  let timer = null;

  async function refresh() {
    if (!state.supported) return state;
    try {
      const answer = await relayGateway().call("listCloudBrowserSessions", {});
      state.sessions = Array.isArray(answer && answer.sessions) ? answer.sessions : [];
      state.usage = (answer && answer.usage) || null;
      state.available = Array.isArray(answer && answer.available) ? answer.available : [];
      state.asked = true;
      state.at = Date.now();
    } catch (error) {
      // A host that has never heard of this command is a box older than the wave, not a failure.
      // It is asked once and then left alone: retrying a command that does not exist, forever, is
      // the shape of a console that quietly burns a box's CPU.
      if (UNKNOWN_COMMAND.test(String((error && error.message) || ""))) state.supported = false;
      state.asked = true;
    }
    paint();
    return state;
  }

  function start() {
    if (timer != null || !state.supported) return;
    void refresh();
    // Fifteen seconds, the same beat the rail's own heartbeat runs at. A live view does not need to
    // be discovered faster than a person can look up at it.
    timer = global.setInterval(() => { void refresh(); }, 15_000);
  }

  // ------------------------------------------------------------------ the Computer card strip
  const STRIP_ID = "cloud-browser-strip";

  // Geometry is inline rather than in a stylesheet on purpose: this wave adds no CSS file and edits
  // none, so nothing here can collide with the two other waves painting the same console. The
  // classes are still on every node so a later pass can style them properly from styles.css.
  const STRIP_STYLE = "display:flex;flex-direction:column;gap:2px;margin-top:6px;font-size:11px;line-height:1.35;opacity:0.85";
  const FRAME_STYLE = "width:100%;height:320px;border:0;border-radius:8px;background:#0d0f14;display:block";

  function stripMarkup() {
    const open = state.sessions.length;
    const where = open > 0
      ? `Running in a cloud browser right now (${plural(open, "page", "pages")} open).`
      : "Running on this computer.";
    return `<div class="cloud-browser-strip" id="${STRIP_ID}" style="${STRIP_STYLE}">`
      + `<strong>Where the browser runs</strong>`
      + `<span class="cloud-browser-where">${escapeHtml(where)}</span>`
      + `<small class="cloud-browser-usage">${escapeHtml(usageSentence(state.usage))}</small>`
      + `</div>`;
  }

  /**
   * The strip, as markup, for app.js's Computer card paint to drop in. Returns "" when there is
   * nothing honest to say yet -- a control that cannot work is not drawn, which is the same rule
   * marketplace-bots.js holds to.
   */
  function computerStrip() {
    if (!state.supported) return "";
    if (!state.asked) { start(); return ""; }
    return stripMarkup();
  }

  // ------------------------------------------------------------------ the take-over row
  function handoffRowMarkup(session) {
    const live = safeUrl(session.liveViewUrl);
    const agentId = escapeHtml(session.agentId || "");
    const head = `<div class="cloud-browser-head"><strong>Cloud browser</strong>`
      + `<span class="status-pill attention"><span class="status-dot working"></span>Open</span></div>`;
    // No vendor name in anything a person reads, and no page address either: the address is the
    // agent's business and the live view is where the person actually looks.
    const words = `<p class="cloud-browser-words">This page is open in a browser somewhere else, `
      + `not on this computer's screen. Take over there to finish the step it is waiting on.</p>`;
    if (live.length === 0) {
      // A session with no live view is still worth saying out loud: the person needs to know the
      // page is not on the screen they are looking at.
      return `<div class="inline-card cloud-browser-card" data-cloud-browser-card data-agent-id="${agentId}">`
        + head + words
        + `<p class="cloud-browser-words">This browser did not give a page you can drive. Ask the agent to hand the step back and try it on this computer's screen instead.</p>`
        + `</div>`;
    }
    return `<div class="inline-card cloud-browser-card" data-cloud-browser-card data-agent-id="${agentId}" data-session-id="${escapeHtml(session.sessionId || "")}">`
      + head + words
      // sandbox is exactly what the vendor documents for an embed and nothing more: same-origin so
      // its own scripts can reach its own session, scripts so it can draw. No allow-top-navigation,
      // no allow-popups, no allow-downloads.
      + `<iframe class="cloud-browser-frame" data-cloud-browser-frame title="The page in the cloud browser"`
      + ` style="${FRAME_STYLE}" sandbox="allow-same-origin allow-scripts" src="${escapeHtml(live)}"></iframe>`
      // The link is drawn ALWAYS, not as an error state. A vendor that refuses framing leaves the
      // frame blank with no event to hook, and a blank rectangle beside a decision is worse than
      // no rectangle at all.
      + `<div class="inline-card-actions"><a class="card-action primary" target="_blank" rel="noopener noreferrer"`
      + ` href="${escapeHtml(live)}">Take over in the cloud browser</a></div>`
      + `</div>`;
  }

  /** The row for one agent, as markup, or "" when that agent has no cloud session open. */
  function handoffStrip(view) {
    if (!state.supported) return "";
    if (!state.asked) { start(); return ""; }
    const agentId = (view && (view.agentId || view.id)) || "";
    const session = state.sessions.find((row) => row && row.agentId === agentId);
    return session == null ? "" : handoffRowMarkup(session);
  }

  // ------------------------------------------------------------------ finding the cards ourselves
  //
  // The two call sites above are the clean road. This is the one that works without them: the
  // hand-off card carries data-handoff-card and data-agent-id, and the rail's screen tile lives in
  // #rail-screen. Both are read, never written -- nothing here edits a node app.js owns, it only
  // adds a sibling of its own and removes the siblings it added.
  //
  // CONSOLE-6. EVERY WRITE BELOW IS GUARDED ON A CHANGE, and that is what stops this module from
  // repainting the console sixty times a second for the life of the page. The observer under it
  // watches the whole body, so a write made here is a mutation that wakes it, which schedules
  // another paint one frame later, which writes again: an unconditional `held.outerHTML = markup`
  // is a loop with nothing outside it to stop it. Measured on grok-bot-local-vm in real Chrome
  // 2026-09-11, on an idle console with nobody typing: #rail-screen's children were replaced 603
  // times in 10 seconds, one every 17 ms, with the strip's words identical every time. Jason, the
  // same morning: "The entire page flickers when I am typing in the bot."
  //
  // So the last markup this module actually wrote is remembered and compared. Comparing against
  // the element's own outerHTML would not do: the browser normalises attribute quoting and order,
  // so a generated string and a parsed one are never equal and the loop would survive the guard.
  let paintedStrip = "";
  function paint() {
    const document_ = global.document;
    if (document_ == null) return;

    for (const card of document_.querySelectorAll("[data-handoff-card]")) {
      const agentId = card.getAttribute("data-agent-id") || "";
      const session = state.sessions.find((row) => row && row.agentId === agentId);
      const existing = card.nextElementSibling;
      const mine = existing != null && existing.hasAttribute && existing.hasAttribute("data-cloud-browser-card")
        ? existing
        : null;
      const wanted = session == null ? "" : handoffRowMarkup(session);
      if (wanted.length === 0) {
        if (mine != null) mine.remove();
        continue;
      }
      // Repainting a live iframe restarts the vendor's session view and throws away whatever the
      // person had done in it, so an unchanged row is left exactly where it is. The markup itself
      // is what is compared, on the node this module put there: the session id was compared before,
      // and a session with no live view carries no data-session-id at all, so that test read null
      // against "" and rebuilt the card on every frame -- the same loop as the strip, on a card in
      // the middle of the conversation.
      if (mine != null && mine.__cloudBrowserMarkup === wanted) continue;
      if (mine != null) mine.remove();
      card.insertAdjacentHTML("afterend", wanted);
      const added = card.nextElementSibling;
      if (added != null) added.__cloudBrowserMarkup = wanted;
    }

    const rail = document_.querySelector("#rail-screen");
    if (rail != null) {
      const held = document_.getElementById(STRIP_ID);
      const markup = computerStrip();
      if (markup.length === 0) {
        if (held != null) held.remove();
        paintedStrip = "";
      } else if (held == null) {
        rail.insertAdjacentHTML("beforeend", markup);
        paintedStrip = markup;
      } else if (markup !== paintedStrip) {
        held.outerHTML = markup;
        paintedStrip = markup;
      }
    }
  }

  // The console repaints the transcript wholesale on every update, which takes our sibling with it.
  // One observer puts it back. It is debounced to a frame because a transcript repaint fires many
  // mutations and re-adding an iframe per mutation is how a page starts flickering.
  let scheduled = false;
  function observe() {
    const document_ = global.document;
    if (document_ == null || document_.body == null) return;
    const observer = new global.MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      global.requestAnimationFrame(() => { scheduled = false; paint(); });
    });
    observer.observe(document_.body, { childList: true, subtree: true });
  }

  global.__cloudBrowser = {
    computerStrip,
    handoffStrip,
    refresh,
    start,
    // Exposed so a test can drive the markup without a browser, the way marketplace-bots.js exposes
    // its import sequence: the words on the card ARE the contract, and a click is no place to pin them.
    _state: state,
    _handoffRowMarkup: handoffRowMarkup,
    _usageSentence: usageSentence,
    _safeUrl: safeUrl,
  };

  if (global.document != null) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", () => { observe(); start(); });
    } else {
      observe();
      start();
    }
  }
})(typeof window === "undefined" ? globalThis : window);
