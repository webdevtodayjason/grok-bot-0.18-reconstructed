/*
 * CONSOLE-4 item C: the rail's screen tile shows a picture or a plate, and never a broken image.
 * ---------------------------------------------------------------------------------------------
 * What Jason saw on console.titanium.bot: "The Titan screen at the top right says 'Click to open,'
 * but there's a broken image there." Two causes behind that one glyph, and both had to go:
 *
 *   1. renderScreenTile always emitted the <img> and marked it hidden, while styles.css says
 *      `.rail-screen-button img { display: block }`. A UA sheet's [hidden] rule is one selector;
 *      that one is two, so it wins, and Chrome paints its broken-image glyph plus the alt text for
 *      an <img> with no src. Measured on his console 2026-09-08: hidden true, computed display
 *      block, no src, naturalWidth 0, a 231x75 box. The same stylesheet already fixes this exact
 *      trap one screen up for .handoff-island[hidden]; screen-tile.css now carries the belt for
 *      this one, so no future path can re-open it whatever app.js emits.
 *   2. Behind the glyph there was nothing to show anyway. HANDBACK-1's reader only ever mounts
 *      while a hand-off is PENDING, so an idle agent -- which is what Titan is nearly all day --
 *      had no frame in memory, none in storage, and no client running to make one.
 *
 * This module is cause 2. It mounts one hidden view_only noVNC client for the agent whose
 * conversation is open, exactly the way boxHandoffEnsureThumb builds one, takes a still, and gets
 * out of the way. app.js reads it through two functions and nothing else:
 *
 *   window.__screenTile.frameFor(agentId)                          -> "" or a data URL
 *   window.__screenTile.sync({ agentId, seat, status, visible })   -> mount / refresh / tear down
 *
 * FIVE RULES, every one of them load-bearing and every one of them measured before it was written.
 *
 * ONE READER AT A TIME. HANDBACK-1's reader owns the agent while a hand-off is pending; this one
 * stands down for it rather than opening a second websocket to the same seat. Two clients on one
 * display is two handshakes, two framebuffers and two copies of the same picture.
 *
 * A STILL BY DEFAULT. Refreshing only while the record's status is `working`. The alternative is a
 * standing screen-share of the operator's own browsing: the seat read on 2026-09-08 had Gmail, a
 * GitHub account and a YouTube channel open on it. A tile that keeps repainting an idle desktop is
 * a privacy decision nobody made, not a feature.
 *
 * NEVER TEAR DOWN ON A RENDER THAT MERELY CARRIED NO DISPLAY. The roster is rebuilt from listAgents
 * and the box status is a separate read, so a record is briefly seatless between the two. The
 * comment in app.js records what tearing down there cost: noVNC restarted its handshake on every
 * heartbeat and the first frame went from about 1.4 s to 33 s. Only a different agent, a hidden
 * tab, or being finished stops this reader.
 *
 * REFUSE A FRAME THAT CANNOT BE TOLD FROM BLANK. A client caught mid-handshake paints a white
 * rectangle, and a confident white rectangle reads worse than a plate that says what clicking does.
 * Measured on Titan's seat: the first sample was 1,043 characters of solid white, the next 7,591 of
 * the real desktop. Length alone is a weak test -- a genuinely dark screen compresses small too --
 * so the guard also reads the colour spread off the thumbnail's own pixels before it encodes.
 *
 * ASK THE HOST WITH { id }, NEVER { agentId }. getForeverBoxStatus adds boxSeat only when it has an
 * agent to add it for, and the agentId form silently answers a stub with no boxSeat FIELD at all.
 * Measured on grok-bot-local-vm 2026-09-08: {id} answered 128 B carrying "boxSeat":null, {agentId}
 * answered 104 B carrying no boxSeat key -- which is the difference between "the shared screen" and
 * "this host cannot say", and a caller that cannot tell them apart draws the wrong plate.
 *
 * Every DOM, storage and timer reference goes through `global`, so the whole file loads under
 * node --test against a stub with no browser anywhere near it.
 */
(function attachScreenTile(global) {
  "use strict";

  // The thumbnail's own size. 390x244 is 16:10, the shape of the box's framebuffer and the shape
  // .rail-screen-button reserves, so a frame drawn into the tile is never letterboxed.
  const THUMB_W = 390;
  const THUMB_H = 244;

  // Display 1 is the box's shared screen. Anything above it is an agent's own seat.
  const SHARED_DISPLAY = 1;

  // Idle stills live under their own prefix and their own index. That separation is the whole
  // point: HANDBACK-1 evicts down to its newest eight by walking ITS index, so a key that is not in
  // that index can never be chosen for eviction, and a hand-off frame a resolved card still draws
  // from can never be pushed out by a tile still. Three is the cap here -- a measured idle frame is
  // about 5.7 KB, so the two stores together sit near 63 KB, well inside what the newest-eight rule
  // was sized for.
  const IDLE_PREFIX = "mr-screen-tile-frame:";
  const IDLE_INDEX = "mr-screen-tile-frames";
  const IDLE_KEEP = 3;

  // How often a frame is taken. Five seconds while the agent is working, because that is the only
  // time the picture is telling anyone something new; one second while warming up, because the
  // first frame is the one the person is waiting for.
  const WORKING_REFRESH_MS = 5000;
  const WARMUP_POLL_MS = 1000;
  // A client that has not produced a real frame in this long is not going to. Give the plate back
  // rather than leaving a websocket open on a seat forever.
  const WARMUP_CEILING_MS = 20_000;

  // The blank-frame guard's two thresholds. 2,048 sits an order above the 1,043-character white
  // sample and well under the 7,591-character real one, and the spread is read off the pixels.
  const MIN_FRAME_CHARS = 2048;
  // Out of 255. A solid fill scores 0; the real desktop sample scored well over 200.
  const MIN_SPREAD = 10;

  const doc = () => global.document ?? null;

  // ---- the blank-frame guard, pure ------------------------------------------------------------

  // Luminance spread across a sample of the thumbnail. Every fourth pixel across both axes, which
  // is 24,000 reads on a 390x244 frame and costs under a millisecond.
  function spreadOf(imageData) {
    const data = imageData?.data;
    const width = Number(imageData?.width) || 0;
    const height = Number(imageData?.height) || 0;
    if (!data || !width || !height) return 0;
    let min = 255;
    let max = 0;
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const i = (y * width + x) * 4;
        // Rec. 601 luma, integer-cheap. The exact coefficients do not matter here: this is asking
        // "is anything on this screen a different brightness from anything else", not measuring
        // colour.
        const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
        if (lum < min) min = lum;
        if (lum > max) max = lum;
        if (max - min >= MIN_SPREAD) return max - min;
      }
    }
    return max - min;
  }

  // A frame is real when it is an image data URL, long enough not to be a solid fill, and carries
  // some contrast. `spread` is optional so a caller with only the string can still be refused for
  // being obviously blank; where the pixels are available both halves run.
  function frameLooksReal(dataUrl, spread) {
    if (typeof dataUrl !== "string" || dataUrl.length === 0) return false;
    if (!dataUrl.startsWith("data:image/")) return false;
    if (dataUrl.length < MIN_FRAME_CHARS) return false;
    if (spread != null && Number(spread) < MIN_SPREAD) return false;
    return true;
  }

  // ---- the store ------------------------------------------------------------------------------

  const frames = new Map();

  function storage() {
    // The accessor itself throws in a browser with site data blocked, which is why every read and
    // write below is wrapped rather than the object being held once.
    try { return global.localStorage ?? null; } catch { return null; }
  }

  function frameFor(agentId) {
    if (!agentId) return "";
    const held = frames.get(agentId);
    if (held) return held;
    const store = storage();
    if (!store) return "";
    try {
      const stored = store.getItem(IDLE_PREFIX + agentId);
      if (stored) { frames.set(agentId, stored); return stored; }
    } catch { /* a live frame lands in a few seconds anyway */ }
    return "";
  }

  function rememberFrame(agentId, dataUrl) {
    if (!agentId || !dataUrl) return;
    frames.set(agentId, dataUrl);
    const store = storage();
    if (!store) return;
    try {
      store.setItem(IDLE_PREFIX + agentId, dataUrl);
      let order = [];
      try { order = JSON.parse(store.getItem(IDLE_INDEX) ?? "[]"); } catch { order = []; }
      order = [agentId, ...(Array.isArray(order) ? order : []).filter((id) => id !== agentId)];
      // Only keys this index put there are ever removed. A hand-off frame lives under a different
      // prefix and is not in this list, so it cannot be reached from here at all.
      order.slice(IDLE_KEEP).forEach((old) => { try { store.removeItem(IDLE_PREFIX + old); } catch { /* nothing to do */ } });
      order = order.slice(0, IDLE_KEEP);
      store.setItem(IDLE_INDEX, JSON.stringify(order));
    } catch { /* the in-memory copy is still the frame this session draws */ }
  }

  // ---- what the host said about the seat -------------------------------------------------------

  // A seat reaches this module in whatever shape app.js holds it: {display, shared} is what
  // boxHandoffSeatOf answers, a bare number is what the wire carries, null is the shared screen,
  // and undefined is a host that did not say. Only the last one means "draw nothing".
  function displayOf(seat) {
    if (seat === undefined) return undefined;
    if (seat === null) return SHARED_DISPLAY;
    if (typeof seat === "number") return Number.isFinite(seat) && seat > SHARED_DISPLAY ? seat : SHARED_DISPLAY;
    const display = Number(seat?.display);
    if (!Number.isFinite(display)) return undefined;
    return display > SHARED_DISPLAY ? display : SHARED_DISPLAY;
  }

  // The one gateway read this module makes, and it exists only for the window in which a roster
  // record is a placeholder: listAgents has answered, loadContext has not, so the record carries no
  // boxSeat and app.js has nothing to pass. Asked once per agent, never repeated on a failure that
  // would just be asked again on the next render, and ALWAYS with { id }.
  let gateway = null;
  const seatAsked = new Map();
  function askForSeat(agentId) {
    if (!agentId || typeof gateway !== "function") return;
    if (seatAsked.has(agentId)) return;
    seatAsked.set(agentId, true);
    let answer = null;
    try { answer = gateway("getForeverBoxStatus", { id: agentId }); } catch { return; }
    Promise.resolve(answer).then((status) => {
      // Absent field, not a null one. null IS an answer -- it says the shared screen -- and reading
      // one for the other is what draws somebody else's wallpaper under this agent's name.
      if (!status || !Object.prototype.hasOwnProperty.call(status, "boxSeat")) return;
      const seat = status.boxSeat;
      const last = state.last;
      if (!last || last.agentId !== agentId) return;
      sync({ ...last, seat: seat === null ? null : Number(seat) });
    }).catch(() => { /* the next render asks app.js's own copy again */ });
  }

  // ---- the reader ------------------------------------------------------------------------------

  let reader = null;
  const state = { last: null };

  // HANDBACK-1's reader, read only. While it holds an agent this module does not open a second
  // client on the same seat.
  function handoffReaderAgent() {
    try {
      const screen = global.__machineRoomHandoff?.screen?.();
      return screen && screen.readerDisplay != null ? (screen.agentId ?? null) : null;
    } catch { return null; }
  }

  function desktopDialogOpen() {
    try { return doc()?.getElementById("desktop-dialog")?.open === true; } catch { return false; }
  }

  function pageVisible() {
    const d = doc();
    if (!d || typeof d.visibilityState !== "string") return true;
    return d.visibilityState === "visible";
  }

  function teardown() {
    if (!reader) return;
    try { global.clearInterval(reader.timer); } catch { /* nothing to do */ }
    try { reader.frame.remove(); } catch { /* already gone with the document */ }
    reader = null;
  }

  function mount(agentId, display, everyMs) {
    const d = doc();
    if (!d) return;
    teardown();
    const frame = d.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("data-screen-tile-source", "1");
    frame.tabIndex = -1;
    frame.title = "Off-screen reader for this agent's screen";
    // Off-screen rather than display:none, and a real framebuffer size: noVNC scales what it is
    // given, and a 1px client would hand back a 1px picture.
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:1280px;height:800px;border:0;pointer-events:none;opacity:0;";
    // view_only, so this client can never take a keystroke from anywhere, and the URL is built on
    // the PAGE's origin -- the host's own 127.0.0.1 form is the viewer's machine through the relay,
    // which is the bug VNC-2 closed. vnc.html and not vnc_lite: the lite client ignores
    // resize=scale and paints the top-left corner of the screen only.
    const origin = global.location?.origin ?? "";
    frame.src = `${origin}/vnc/${display}/vnc.html`
      + `?path=${encodeURIComponent(`/vnc/${display}/websockify`)}`
      + "&autoconnect=1&resize=scale&reconnect=1&bell=0&view_only=1";
    d.body.appendChild(frame);
    reader = {
      agentId,
      display,
      frame,
      everyMs,
      startedAt: Date.now(),
      timer: global.setInterval(tick, everyMs),
    };
  }

  function retime(everyMs) {
    if (!reader || reader.everyMs === everyMs) return;
    try { global.clearInterval(reader.timer); } catch { /* nothing to do */ }
    reader.everyMs = everyMs;
    reader.timer = global.setInterval(tick, everyMs);
  }

  // Draw the client's canvas down to the tile's size and read the pixels back before encoding, so
  // the guard runs on the picture rather than on a guess about its length.
  function capture(source) {
    const d = doc();
    if (!d) return null;
    let canvas = null;
    let context = null;
    try {
      canvas = d.createElement("canvas");
      canvas.width = THUMB_W;
      canvas.height = THUMB_H;
      context = canvas.getContext("2d");
      context.drawImage(source, 0, 0, source.width, source.height, 0, 0, THUMB_W, THUMB_H);
    } catch { return null; }
    let spread = null;
    try { spread = spreadOf(context.getImageData(0, 0, THUMB_W, THUMB_H)); } catch { spread = null; }
    let dataUrl = "";
    // A browser with no webp encoder answers a PNG data URL, which is still a picture.
    try { dataUrl = canvas.toDataURL("image/webp", 0.6); } catch { return null; }
    return { dataUrl, spread };
  }

  function tick() {
    const held = reader;
    if (!held) return;
    // The person is looking at the real thing. Reading a second copy of it while the desktop view
    // is open is work for nobody, and it is a pause rather than a teardown: the dialog closes in
    // seconds and remounting would cost the handshake again.
    if (desktopDialogOpen()) return;
    // A hidden tab is not a pause. Chrome throttles the timer anyway and there is nobody to show a
    // frame to, so the client goes.
    if (!pageVisible()) { teardown(); return; }
    let source = null;
    try { source = held.frame.contentDocument?.querySelector("canvas") ?? null; } catch { source = null; }
    if (!source || !source.width || !source.height) {
      if (held.everyMs !== WORKING_REFRESH_MS && Date.now() - held.startedAt > WARMUP_CEILING_MS) teardown();
      return;
    }
    const shot = capture(source);
    if (!shot || !frameLooksReal(shot.dataUrl, shot.spread)) {
      if (held.everyMs !== WORKING_REFRESH_MS && Date.now() - held.startedAt > WARMUP_CEILING_MS) teardown();
      return;
    }
    rememberFrame(held.agentId, shot.dataUrl);
    paint(held.agentId, shot.dataUrl);
    // A still by default: the frame is in hand, so the client goes until the agent is working
    // again. Only a working agent keeps a reader alive.
    if (held.everyMs !== WORKING_REFRESH_MS) teardown();
  }

  // Straight into the element, never through a render. Rebuilding the transcript to show a new
  // frame would throw the reader back to the bottom every few seconds, which is the scar
  // paintBoxHandoffFrame already carries -- and app.js now emits no <img> at all until it has a
  // src, so the first frame has to create the element rather than fill one in.
  function paint(agentId, dataUrl) {
    const d = doc();
    if (!d || !agentId || !dataUrl) return;
    const tile = d.getElementById("rail-screen");
    const button = tile?.querySelector?.(".rail-screen-button") ?? null;
    if (!button) return;
    if ((button.dataset?.agentId ?? "") !== agentId) return;
    let img = button.querySelector("img[data-rail-screen]");
    if (!img) {
      img = d.createElement("img");
      img.setAttribute("data-rail-screen", "");
      img.setAttribute("data-agent-id", agentId);
      const caption = d.getElementById("rail-screen-caption")?.textContent?.trim();
      img.setAttribute("alt", caption || "This agent's screen");
      button.appendChild(img);
    }
    img.src = dataUrl;
    img.hidden = false;
    const plate = tile.querySelector("[data-rail-screen-plate]");
    if (plate) plate.hidden = true;
  }

  // ---- the one function app.js drives ----------------------------------------------------------

  function sync(input) {
    const options = input ?? {};
    const agentId = options.agentId ?? "";
    const status = String(options.status ?? "");
    const working = status === "working";
    const visible = options.visible === undefined ? pageVisible() : options.visible !== false;
    state.last = { agentId, seat: options.seat, status, visible };

    // No conversation, a room, or a hidden tab: nothing to read for and nobody to show it to.
    if (!agentId || !visible) { teardown(); return readState(); }

    // HANDBACK-1 owns the agent while a hand-off is pending. One reader at a time.
    if (handoffReaderAgent() === agentId) { teardown(); return readState(); }

    const display = displayOf(options.seat);
    if (display === undefined) {
      // The host did not say which screen. A render that merely carried no display is NOT the end
      // of anything, so a reader already running for this agent keeps running; a placeholder record
      // gets one question, with { id }.
      if (!reader || reader.agentId !== agentId) askForSeat(agentId);
      return readState();
    }

    const everyMs = working ? WORKING_REFRESH_MS : WARMUP_POLL_MS;
    if (reader && reader.agentId === agentId) {
      if (reader.display !== display) mount(agentId, display, everyMs);
      else retime(everyMs);
      return readState();
    }
    // A still already in hand and an idle agent: nothing to mount. The tile is drawing it already.
    if (!working && frameFor(agentId)) { teardown(); return readState(); }
    mount(agentId, display, everyMs);
    return readState();
  }

  function readState() {
    return {
      agentId: reader?.agentId ?? null,
      display: reader?.display ?? null,
      mounted: reader != null,
      everyMs: reader?.everyMs ?? null,
      startedAt: reader?.startedAt ?? null,
    };
  }

  global.__screenTile = {
    // What app.js calls.
    frameFor,
    sync,
    // Whether a client is warming up for this agent, so the plate can say "Connecting" only when
    // something is connecting.
    reading: (agentId) => reader != null && reader.agentId === agentId,
    teardown,
    // Read-only, for the gate and the unit test. Nothing in the app calls these.
    state: readState,
    frameLooksReal,
    spreadOf,
    limits: { MIN_FRAME_CHARS, MIN_SPREAD, IDLE_KEEP, IDLE_PREFIX, IDLE_INDEX, WORKING_REFRESH_MS, WARMUP_POLL_MS, THUMB_W, THUMB_H },
    // app.js hands over its gateway caller here. Without one this module never asks the host
    // anything and simply uses the seat it is given.
    configure(options) {
      if (typeof options?.gateway === "function") gateway = options.gateway;
      return global.__screenTile;
    },
  };

  // A tab that goes away drops the client rather than leaving a websocket open on a seat nobody is
  // watching. Registered once, and only where there is a document to register it on.
  doc()?.addEventListener?.("visibilitychange", () => { if (!pageVisible()) teardown(); });
})(typeof window !== "undefined" ? window : globalThis);
