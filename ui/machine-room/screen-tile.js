/*
 * The rail's screen tile: a picture of the agent's screen that keeps up with the agent.
 * ------------------------------------------------------------------------------------
 * CONSOLE-4 item C built this module to put a picture in the tile at all, because HANDBACK-1's
 * reader only ever ran while a hand-off was pending and an idle agent had nothing to show. It shipped
 * with a rule called A STILL BY DEFAULT: one frame, then let the client go.
 *
 * SCREEN-TILE-1 reverses that rule for a working agent, on Jason's ask, 2026-09-10 10:55, in his own
 * words: "the AI's desktop in the right-hand corner has a screenshot that does not stay up to date.
 * It gets recorded once and stays that way. It never updates. For instance, Titan was on a different
 * web page, but when I looked at it on my desktop, I saw the original web page it loaded with."
 *
 * Reproduced on grok-bot-local-vm 2026-09-10 before a line was changed: 25 s after the box's browser
 * moved from example.com to wikipedia.org the tile still drew Example Domain, and the frame string
 * was byte-identical at 4,143 characters with no reader mounted. Two lines did that. One dropped the
 * client after a single good frame for anything that was not `working`; the other then refused to
 * mount at all for an idle agent that already had a frame -- and that frame is persisted, so it
 * survived reloads. "It gets recorded once and stays that way" was exactly what the code did.
 *
 * THE REVERSAL, WRITTEN DOWN AS A REVERSAL. CONSOLE-4 made the still a PRIVACY decision, not a
 * performance one: the seat read on 2026-09-08 had Gmail, a GitHub account and a YouTube channel open
 * on it, and a tile that keeps repainting an idle desktop is a standing screen-share nobody asked
 * for. Jason has now asked for the live tile, so the reversal is his to make -- and it is bounded
 * rather than abandoned. An agent that is WORKING is watched; an agent that is idle is photographed
 * every 30 s by a client that mounts, takes one frame and lets go. An idle agent is never a standing
 * stream of the operator's own browsing, which is the half of CONSOLE-4's rule that still applies.
 *
 * THREE CADENCES.
 *
 *   LIVE   hold the client and capture every 3 s, while the record's status is `working` OR the
 *          agent's newest tool row was a browser or desktop action inside the last 60 s. The second
 *          half matters because `working` is `agent.isRunning`, which is only ever true DURING a
 *          turn, and Jason looks at the tile between turns.
 *   IDLE   every 30 s: mount, take one frame that passes the blank guard, release the client.
 *          Bounded by construction.
 *   OFF    a hidden tab, no conversation, a room, HANDBACK-1 holding the agent, or a tile laid out
 *          to nothing -- a closed rail drawer at phone width, which is where the data ceiling in
 *          docs/APPS.md actually lives. The desktop dialog is a pause rather than a teardown: it
 *          closes in seconds and remounting costs the handshake again.
 *
 * THE IDLE WAKE IS THIS MODULE'S OWN CLOCK. sync() is only ever called from a render, and the
 * adapter's heartbeat is 15 s, so a 30 s cadence hung off renders would be reset by every heartbeat
 * and never fire. `nextIdleAt` is an absolute timestamp and the setTimeout behind it is armed once;
 * a render that arrives while it is armed leaves it alone. That is the failure this shape exists to
 * avoid, and there is a test named for it.
 *
 * WHAT THIS COSTS, measured on grok-bot-local-vm 2026-09-10 in real Chrome with CDP websocket frame
 * accounting at 1440x1000, the 390x244 thumbnail. scripts/verify-cost.mjs sums Network.dataReceived,
 * which is HTTP only, so none of this is counted anywhere else:
 *
 *   one mount to a real frame, &quality=0&compression=9        17.5 KiB   1,267 ms
 *   the same at the client's default quality                   51.9 KiB   1,275 ms
 *   holding a client on a settled screen                        0 bytes
 *   the tile following a whole page change                     21.4 KiB   3.56 s after the launcher
 *   a forced working minute                              6.2 to 137.1 KiB across runs
 *   an idle minute, one grab                                   18.3 KiB
 *   an idle grab over a photo-heavy page                       75.0 KiB
 *   a hidden tab, and a shut rail drawer at 390x844             0 bytes
 *
 * The cheap reader URL is worth roughly a third of a mount and the thumbnail is not visibly worse for
 * it (4,207 characters against 4,263). But the honest headline is the middle of that table: A GRAB
 * COSTS WHATEVER IS ON THE SCREEN. Two grabs a minute is about 36.6 KiB over a settled desktop and
 * about 150 KiB over a photo-heavy page, against a docs/APPS.md idle figure of 100 KiB -- which is
 * decoded API bytes at PHONE width and excludes noVNC by name as COST-2. That is why this module
 * asks the browser whether the tile is being PAINTED before it opens anything: in the case where
 * that ceiling really applies the rail is a shut drawer, and this then costs zero. On a desktop
 * console the cost is real, the gate prints it every run, and the lever for it is the cadence. The
 * desktop dialog's own client is untouched either way.
 *
 * THE CAPTION. Every accepted frame stamps `capturedAt`, and a one-second clock writes "as of 3 s
 * ago" onto the picture. It is re-added after every render on purpose: renderScreenTile rewrites the
 * whole tile's innerHTML at least every heartbeat, so a caption emitted once would blink out and
 * back. It is drawn absolutely over the bottom of the picture, so it can appear and disappear
 * without moving anything in the rail.
 *
 * app.js reads this module through two functions and drives it with one:
 *
 *   window.__screenTile.frameFor(agentId)                                    -> "" or a data URL
 *   window.__screenTile.sync({ agentId, seat, status, visible, activity })   -> mount / hold / release
 *
 * THE RULES CONSOLE-4 SET THAT STILL HOLD, every one of them measured before it was written.
 *
 * ONE READER AT A TIME. HANDBACK-1's reader owns the agent while a hand-off is pending; this one
 * stands down for it rather than opening a second websocket to the same seat. Two clients on one
 * display is two handshakes, two framebuffers and two copies of the same picture.
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
 * so the guard also reads the colour spread off the thumbnail's own pixels before it encodes. A
 * refused frame never touches `capturedAt`, so the caption can never claim a picture is fresher than
 * the last one a person could actually see.
 *
 * ASK THE HOST WITH { id }, NEVER { agentId }. getForeverBoxStatus adds boxSeat only when it has an
 * agent to add it for, and the agentId form silently answers a stub with no boxSeat FIELD at all.
 * Measured on grok-bot-local-vm 2026-09-08: {id} answered 128 B carrying "boxSeat":null, {agentId}
 * answered 104 B carrying no boxSeat key -- which is the difference between "the shared screen" and
 * "this host cannot say", and a caller that cannot tell them apart draws the wrong plate.
 *
 * Every DOM, storage, timer and clock reference goes through `global`, so the whole file loads under
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
  // was sized for. IDLE_PREFIX_AT is the frame's capture time, kept in a PARALLEL key rather than
  // inside the frame value or inside the index: HANDBACK-1 reads nothing here, and the index is a
  // plain list of ids that the eviction test reads back verbatim.
  const IDLE_PREFIX = "mr-screen-tile-frame:";
  const IDLE_PREFIX_AT = "mr-screen-tile-frame-at:";
  const IDLE_INDEX = "mr-screen-tile-frames";
  const IDLE_KEEP = 3;

  // The three cadences. Three seconds while the agent is live, because that is the tile keeping up
  // with something that is moving; thirty while it is idle, which is a mount, one frame and a
  // release rather than a held client; one second while a client is warming up, because the first
  // frame is the one the person is waiting for.
  const LIVE_REFRESH_MS = 3000;
  const IDLE_REFRESH_MS = 30_000;
  const WARMUP_POLL_MS = 1000;
  // A client that has not produced a real frame in this long is not going to. Give the plate back
  // rather than leaving a websocket open on a seat forever.
  const WARMUP_CEILING_MS = 20_000;
  // How long a browser or desktop tool row keeps the tile live after the turn that made it ends.
  // `working` is agent.isRunning and is false the moment a turn finishes, which is exactly when
  // Jason looks at the tile.
  const ACTIVITY_WINDOW_MS = 60_000;
  // The caption's own clock. It rewrites one text node and nothing else.
  const AGE_TICK_MS = 1000;
  // SEAT-FOCUS-1's fallback cadence. The reach-in listener below hands the keyboard back before a
  // person could notice; this is what covers a frame whose own document cannot be read, and a
  // quarter of a second is the worst it costs.
  const HANDBACK_POLL_MS = 250;

  // The blank-frame guard's two thresholds. 2,048 sits an order above the 1,043-character white
  // sample and well under the 7,591-character real one, and the spread is read off the pixels.
  const MIN_FRAME_CHARS = 2048;
  // Out of 255. A solid fill scores 0; the real desktop sample scored well over 200.
  const MIN_SPREAD = 10;

  const doc = () => global.document ?? null;
  // The clock goes through `global` like everything else, so a test can wind it forward without
  // patching the process's own Date. In a browser `window.Date` IS Date, so this is the same call.
  const now = () => (typeof global.Date?.now === "function" ? global.Date.now() : Date.now());

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

  // ---- how old the picture is, in words --------------------------------------------------------

  // Plain words, no clock face and no vendor units. Seconds up to a minute, because the whole point
  // of the caption is telling "this is live" from "this is from before lunch"; past that a person
  // only needs the order of magnitude.
  function ageWords(ms) {
    const elapsed = Math.max(0, Math.round(Number(ms) || 0));
    const seconds = Math.round(elapsed / 1000);
    if (seconds < 60) return `as of ${seconds} s ago`;
    const minutes = Math.round(seconds / 60);
    if (minutes === 1) return "as of a minute ago";
    if (minutes < 60) return `as of ${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours === 1) return "as of an hour ago";
    return `as of ${hours} h ago`;
  }

  // ---- the store ------------------------------------------------------------------------------

  const frames = new Map();
  const capturedAts = new Map();

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
      if (stored) {
        frames.set(agentId, stored);
        const at = Number(store.getItem(IDLE_PREFIX_AT + agentId));
        if (Number.isFinite(at) && at > 0) capturedAts.set(agentId, at);
        return stored;
      }
    } catch { /* a live frame lands in a few seconds anyway */ }
    return "";
  }

  // When the picture this agent's tile is drawing was taken, or null for a frame left behind by a
  // session that stamped nothing. Null is a real answer: the caption says nothing rather than lying,
  // and sync() treats it as old enough to replace.
  function capturedAtFor(agentId) {
    if (!agentId) return null;
    if (!capturedAts.has(agentId)) frameFor(agentId);
    const at = capturedAts.get(agentId);
    return Number.isFinite(at) && at > 0 ? at : null;
  }

  function rememberFrame(agentId, dataUrl, at) {
    if (!agentId || !dataUrl) return;
    frames.set(agentId, dataUrl);
    capturedAts.set(agentId, at);
    const store = storage();
    if (!store) return;
    try {
      store.setItem(IDLE_PREFIX + agentId, dataUrl);
      store.setItem(IDLE_PREFIX_AT + agentId, String(at));
      let order = [];
      try { order = JSON.parse(store.getItem(IDLE_INDEX) ?? "[]"); } catch { order = []; }
      order = [agentId, ...(Array.isArray(order) ? order : []).filter((id) => id !== agentId)];
      // Only keys this index put there are ever removed. A hand-off frame lives under a different
      // prefix and is not in this list, so it cannot be reached from here at all.
      order.slice(IDLE_KEEP).forEach((old) => {
        try { store.removeItem(IDLE_PREFIX + old); } catch { /* nothing to do */ }
        try { store.removeItem(IDLE_PREFIX_AT + old); } catch { /* nothing to do */ }
      });
      order = order.slice(0, IDLE_KEEP);
      store.setItem(IDLE_INDEX, JSON.stringify(order));
    } catch { /* the in-memory copy is still the frame this session draws */ }
  }

  // Drop everything this module remembers about one agent's picture: the in-memory copy, its stamp
  // and both storage keys. Nothing in the app calls this -- a gate and the unit tests do, to set up
  // the state a person sees before any picture exists. Without it that state is unreachable once the
  // tile has painted once, because the in-memory copy outlives a storage wipe and the tile then
  // draws a stale picture where the gate wanted the plate's words.
  function forget(agentId) {
    if (!agentId) return;
    frames.delete(agentId);
    capturedAts.delete(agentId);
    const store = storage();
    if (!store) return;
    try { store.removeItem(IDLE_PREFIX + agentId); } catch { /* nothing to do */ }
    try { store.removeItem(IDLE_PREFIX_AT + agentId); } catch { /* nothing to do */ }
    try {
      let order = [];
      try { order = JSON.parse(store.getItem(IDLE_INDEX) ?? "[]"); } catch { order = []; }
      order = (Array.isArray(order) ? order : []).filter((id) => id !== agentId);
      store.setItem(IDLE_INDEX, JSON.stringify(order));
    } catch { /* the in-memory copy is gone either way */ }
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

  // ---- was this agent just doing something on a screen -----------------------------------------

  // A tool row that means the picture is about to change. `Computer` is computerUseToolCall's own
  // label in TOOL_LABELS; `Opened <host>` is what shellHeadline makes of `box-chrome <url>`, which
  // is how an agent opens a page on its seat. A fetch is not on this list: curl changes no screen.
  const BROWSER_ROW_TEXT = /^Opened\s/;
  const BROWSER_ROW_KINDS = new Set(["Computer"]);
  // Tool rows carry no timestamp of their own -- the console builds them from the conversation
  // outline, which has none -- so this module stamps the moment IT first saw a given row. First
  // sight is the honest reading of "the agent just did this": the row reached the console on the
  // poll after the tool call, not before it.
  const activity = { agentId: "", id: "", at: 0, browser: false };
  function noteActivity(agentId, row) {
    if (activity.agentId !== agentId) { activity.agentId = agentId; activity.id = ""; activity.at = 0; activity.browser = false; }
    const id = String(row?.id ?? "");
    if (!id || id === activity.id) return;
    activity.id = id;
    activity.at = now();
    activity.browser = BROWSER_ROW_KINDS.has(String(row?.kind ?? "")) || BROWSER_ROW_TEXT.test(String(row?.text ?? ""));
  }
  function browsingLately(agentId) {
    if (!activity.browser || activity.agentId !== agentId) return false;
    return now() - activity.at < ACTIVITY_WINDOW_MS;
  }

  // ---- the reader ------------------------------------------------------------------------------

  let reader = null;
  let idleWake = null;
  let ageTimer = null;
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

  // IS THE TILE ACTUALLY ON SCREEN. A visible tab is not the same question: at phone width the rails
  // are drawers, so the tile is laid out at zero size inside a closed one, and a rail can be
  // collapsed on a desktop too. Reading a seat for a picture nobody can see is the same waste as
  // reading one for a hidden tab, and this is the case where docs/APPS.md's idle ceiling actually
  // lives -- it is a phone-width, API-bytes ceiling. A DOM that cannot answer (the unit test's stub,
  // an element with no layout) is treated as on screen: refusing to draw because a measurement was
  // unavailable is how a tile goes blank for everybody.
  function tileOnScreen() {
    const d = doc();
    if (!d) return true;
    let button = null;
    try { button = d.getElementById("rail-screen")?.querySelector?.(".rail-screen-button") ?? null; } catch { return true; }
    if (!button) return true;
    // checkVisibility is the browser's OWN answer to "is this being painted", and it is the right
    // question rather than a bounding box: the phone's closed rail drawer is `visibility: hidden`
    // and translated off the right edge (styles.css, the drawer block), so the box still measures a
    // healthy 274x172 -- measured on grok-bot-local-vm at 390x844 -- while nothing is on screen. It
    // also covers display:none anywhere up the tree and opacity:0. Deliberately NOT a viewport
    // intersection test: a rail scrolled so the tile is above the fold is still being painted, and
    // treating that as invisible would leave a stale picture waiting for whoever scrolls back.
    if (typeof button.checkVisibility === "function") {
      try { return button.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true }) === true; } catch { /* an older browser answers below */ }
    }
    if (typeof button.getBoundingClientRect !== "function") return true;
    try {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    } catch { return true; }
  }

  // ---- the idle wake, this module's own clock ---------------------------------------------------

  function disarmIdle() {
    if (!idleWake) return;
    try { global.clearTimeout(idleWake.timer); } catch { /* nothing to do */ }
    idleWake = null;
  }

  // Armed ONCE, for an absolute moment. A render that arrives while it is armed for the same agent
  // does nothing at all -- which is the whole reason this is a timestamp and a setTimeout rather
  // than something recomputed per render. sync() only ever runs from a render and the adapter's
  // heartbeat is 15 s, so a rolling timer would be pushed back for ever and a 30 s cadence would
  // never fire once.
  function armIdle(agentId, delayMs) {
    if (!agentId) return;
    if (idleWake && idleWake.agentId === agentId) return;
    disarmIdle();
    const at = now() + Math.max(0, delayMs);
    const fire = () => {
      idleWake = null;
      const last = state.last;
      if (!last || last.agentId !== agentId) return;
      // Straight back through sync, so every guard -- a hidden tab, a hand-off, a seat the host
      // never named -- applies to the wake exactly as it applies to a render.
      sync(last);
    };
    let timer = null;
    try { timer = global.setTimeout(fire, Math.max(0, at - now())); } catch { timer = null; }
    idleWake = { agentId, at, timer };
  }

  // ---- SEAT-FOCUS-1: a picture nobody can click never holds the keyboard -----------------------
  //
  // There are two of these readers -- this module's, and app.js's hand-off thumb. Both are 1280x800
  // noVNC clients parked at left:-10000px with pointer-events:none, opacity 0, aria-hidden and
  // view_only=1. About two seconds after each mount the client inside focuses its own canvas, and
  // from that moment document.activeElement is the IFRAME: every document-level key goes into the
  // frame and never reaches the page.
  //
  // MEASURED on grok-bot-local-vm, real Chrome, 1440x900, 2026-09-10: with a reader holding the
  // keyboard, a real Escape and a real space bar produced ZERO keydown events on a capture-phase
  // listener on document. So voice.js's own handlers never ran -- Escape did not leave talk mode and
  // the space bar did not talk -- and an OPEN desktop dialog did not close on Escape either. Nothing
  // was logged and nothing on screen said why. The filed row blamed the desktop dialog's seat; the
  // thief is this off-screen picture, and the window is 2 to 3 s per idle grab and the whole time a
  // working agent's client is held, which is the one-in-three flakiness verify-voice --leg nokey had.
  //
  // THE MECHANISM THE ROW PROPOSED DOES NOT FIRE, measured twice. A focus that lands INSIDE an iframe
  // raises no `focus` event on the iframe ELEMENT and no `focusin` on the parent document: 0 and 0 in
  // the product across a mount a 250 ms poll caught seven times, and 0 and 0 again in an isolated
  // harness whose same-origin child focuses a <canvas tabindex=0>, which is noVNC's exact shape.
  // `inert` on the frame does not stop the steal either. Two things do, and both are armed here:
  //
  //   A focusin listener on the FRAME'S OWN document. Readable because both readers build their src
  //   on window.location.origin, so the client is same origin by construction -- it is NOT cross
  //   origin, which is the other thing the filed row had wrong. In the harness this handed the
  //   keyboard back before the poll saw anything at all, and the very first Escape reached the page.
  //
  //   A 250 ms poll for the frame's lifetime, which catches the steal within a quarter second. It
  //   stays even though the listener works: if a future image ever serves the client from the box's
  //   own address the listener silently stops installing, and this is what is left.
  //
  // blur() is enough and it sticks -- activeElement stayed BODY for 14 s and the client never took it
  // back. That is narrower than the blanket claim beside app.js's teach frame that a VNC client keeps
  // focus whatever the page does: that claim holds for a frame a PERSON clicks, whose pointer events
  // re-focus it. These two get no pointer events at all.
  //
  // SCOPED TO THE TWO READERS AND NOTHING ELSE, by their own attributes. The seat inside the desktop
  // dialog is the pane a person opened, is meant to hold the keys, says so in its own copy, and
  // app.js's paste bridge depends on it. Because the readers are unreachable by any pointer the rule
  // needs no "unless the person put it there" exception -- which is just as well, since a pointerdown
  // inside an iframe is not visible to the parent document at all.
  const READER_FRAME_ATTRIBUTES = ["data-screen-tile-source", "data-box-handoff-thumb-source"];
  let handBacks = 0;

  function isReaderFrame(frame) {
    if (frame == null) return false;
    if (String(frame.tagName ?? "").toUpperCase() !== "IFRAME") return false;
    return READER_FRAME_ATTRIBUTES.some((name) => {
      try { return frame.getAttribute?.(name) != null; } catch { return false; }
    });
  }

  // CONSOLE-6. WHERE THE KEYBOARD IS HANDED BACK TO, which SEAT-FOCUS-1 never said.
  //
  // blur() on the frame takes the keyboard off the reader and leaves it on <body>, which is nobody.
  // A person typing a message when the reader wakes therefore loses the caret and every character
  // after it, with nothing on screen to say why. Measured on grok-bot-local-vm in real Chrome
  // 2026-09-11, typing two characters a second into the message box for 75 s: the caret sat in the
  // box until 31.0 s, the idle reader mounted at 30.0 s, and from then on the caret was on <body>
  // and 88 of 150 characters went nowhere. Jason, the same morning: "when it flickers I lose where
  // my cursor is, so I have to target the field again to continue typing."
  //
  // So the page remembers the last thing a person actually put the caret in and puts it back. The
  // memory is one listener for the life of the page, armed with the first reader, and it ignores the
  // readers themselves: handing the keyboard back to the frame it was just taken from would be a
  // loop, and the seat inside the desktop dialog is meant to keep the keys and is not a reader.
  let lastFocus = null;
  let focusMemoryArmed = false;
  function rememberFocus() {
    if (focusMemoryArmed) return;
    const d = doc();
    if (d == null || typeof d.addEventListener !== "function") return;
    focusMemoryArmed = true;
    d.addEventListener("focusin", (event) => {
      const target = event?.target ?? null;
      if (target == null || target === d.body || isReaderFrame(target)) return;
      lastFocus = target;
    }, true);
  }

  /**
   * Arm the hand-back for one reader frame, and answer with the disarm its owner's teardown calls.
   * Safe to hand anything: a frame that is not one of the two readers is left alone, which is how
   * the rule stays off the seat a person opened.
   */
  function keepKeyboardOff(frame) {
    if (!isReaderFrame(frame)) return () => {};
    rememberFocus();
    let poll = null;
    let inner = null;
    const handBack = () => {
      const d = doc();
      if (d == null || d.activeElement !== frame) return false;
      try { frame.blur?.(); } catch { return false; }
      handBacks += 1;
      // Back where it was, if that is still a thing on the page. preventScroll, because a caret put
      // back is not a reason to move the conversation the person is reading.
      const back = lastFocus;
      if (back != null && back.isConnected === true && typeof back.focus === "function") {
        try { back.focus({ preventScroll: true }); } catch { /* a node that will not take it */ }
      }
      return true;
    };
    // The reach-in. Wrapped because reading contentDocument on a frame this page may not read throws
    // on the property access itself, and that is not an error -- it is the case the poll is for.
    const reachIn = () => {
      try {
        const document_ = frame.contentDocument;
        if (document_ == null || typeof document_.addEventListener !== "function") return;
        if (document_ === inner) return;
        inner = document_;
        document_.addEventListener("focusin", handBack, true);
      } catch { /* the poll still covers it */ }
    };
    function disarm() {
      if (poll != null) { try { global.clearInterval(poll); } catch { /* nothing to do */ } poll = null; }
      try { frame.removeEventListener?.("load", reachIn); } catch { /* a stub element */ }
      if (inner != null) {
        try { inner.removeEventListener?.("focusin", handBack, true); } catch { /* gone with the frame */ }
        inner = null;
      }
    }
    reachIn();
    // And again when the client's own document arrives, which is after this mount returns.
    try { frame.addEventListener?.("load", reachIn); } catch { /* a stub element */ }
    try {
      poll = global.setInterval(() => {
        // A frame already out of the document cannot hold anything, and its owner may not have been
        // the one that took it out.
        if (frame.isConnected === false) { disarm(); return; }
        reachIn();
        handBack();
      }, HANDBACK_POLL_MS);
    } catch { poll = null; }
    return disarm;
  }

  function teardown() {
    disarmIdle();
    if (!reader) return;
    try { global.clearInterval(reader.timer); } catch { /* nothing to do */ }
    // SEAT-FOCUS-1's hand-back goes out with the frame it was armed for.
    try { reader.keyboard?.(); } catch { /* nothing to do */ }
    try { reader.frame.remove(); } catch { /* already gone with the document */ }
    reader = null;
  }

  function mount(agentId, display, everyMs, hold) {
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
    //
    // quality=0&compression=9 is the cheap reader. Measured on grok-bot-local-vm 2026-09-10 with CDP
    // websocket frame accounting: one mount to a real frame costs 17.5 KiB against 51.9 KiB at the
    // client's default, in the same 1.27 s, with the 390x244 thumbnail not visibly worse for it
    // (4,207 characters against 4,263). It is a third of the cost for the same picture; it is not,
    // on its own, what makes the idle cadence cheap -- a grab costs whatever is on the screen, and
    // the header records the range.
    const origin = global.location?.origin ?? "";
    frame.src = `${origin}/vnc/${display}/vnc.html`
      + `?path=${encodeURIComponent(`/vnc/${display}/websockify`)}`
      + "&autoconnect=1&resize=scale&reconnect=1&bell=0&view_only=1"
      + "&quality=0&compression=9";
    d.body.appendChild(frame);
    reader = {
      agentId,
      display,
      frame,
      everyMs,
      // `hold` is the cadence in one word: a held client is the live tile, an unheld one is a
      // mount-grab-release that lets go of the seat as soon as it has a picture.
      hold: hold === true,
      startedAt: now(),
      timer: global.setInterval(tick, everyMs),
      // SEAT-FOCUS-1. A picture nobody can click never holds the keyboard.
      keyboard: keepKeyboardOff(frame),
    };
  }

  function retime(everyMs, hold) {
    if (!reader) return;
    reader.hold = hold === true;
    if (reader.everyMs === everyMs) return;
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

  // A one-shot grab whose client never painted anything: let it go and come back at the idle
  // cadence rather than holding a websocket open on a seat that is not answering.
  function giveUp(held) {
    const agentId = held.agentId;
    teardown();
    armIdle(agentId, IDLE_REFRESH_MS);
  }

  function tick() {
    const held = reader;
    if (!held) return;
    // The person is looking at the real thing. Reading a second copy of it while the desktop view
    // is open is work for nobody, and it is a pause rather than a teardown: the dialog closes in
    // seconds and remounting would cost the handshake again.
    if (desktopDialogOpen()) return;
    // A hidden tab is not a pause. Chrome throttles the timer anyway and there is nobody to show a
    // frame to, so the client goes and the wake goes with it. A tile that has been laid out to
    // nothing -- a closed rail drawer at phone width -- is the same case, checked here as well as in
    // sync() because a window resize does not necessarily render.
    if (!pageVisible() || !tileOnScreen()) { teardown(); return; }
    let source = null;
    try { source = held.frame.contentDocument?.querySelector("canvas") ?? null; } catch { source = null; }
    if (!source || !source.width || !source.height) {
      if (!held.hold && now() - held.startedAt > WARMUP_CEILING_MS) giveUp(held);
      return;
    }
    const shot = capture(source);
    if (!shot || !frameLooksReal(shot.dataUrl, shot.spread)) {
      if (!held.hold && now() - held.startedAt > WARMUP_CEILING_MS) giveUp(held);
      return;
    }
    // Only an ACCEPTED frame moves the stamp. A blank one refused above leaves the caption reading
    // the age of the last picture a person could actually see, which is the true answer.
    const at = now();
    rememberFrame(held.agentId, shot.dataUrl, at);
    paint(held.agentId, shot.dataUrl, at);
    startAgeClock();
    // A held client is the live cadence and keeps reading. A one-shot grab has what it came for: the
    // client goes and the next wake is 30 s out, so an idle agent is a photograph every half minute
    // rather than a standing stream of somebody's browsing.
    if (!held.hold) { const agentId = held.agentId; teardown(); armIdle(agentId, IDLE_REFRESH_MS); }
  }

  // Straight into the element, never through a render. Rebuilding the transcript to show a new
  // frame would throw the reader back to the bottom every few seconds, which is the scar
  // paintBoxHandoffFrame already carries -- and app.js now emits no <img> at all until it has a
  // src, so the first frame has to create the element rather than fill one in.
  function paint(agentId, dataUrl, at) {
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
    paintAge(at == null ? capturedAtFor(agentId) : at);
  }

  // The other direction from paint(): the module has NO picture for the agent whose tile this is, so
  // whatever is on the glass is somebody else's or a photograph of a session that is gone. paint()
  // hides the plate when it draws, and app.js rebuilds the tile on its own renders -- but sync() can
  // arrive first (a conversation driven straight at the module, or an agent whose card did not open),
  // and then the tile shows a picture the module would refuse to date. The <img> is REMOVED rather
  // than hidden: `.rail-screen-button img { display: block }` outranks [hidden] on specificity, which
  // is the CONSOLE-4 broken-glyph trap one file over. With no plate span to put back -- app.js emits
  // one only when it rendered without a frame -- nothing is touched, because an empty tile reads
  // worse than a picture a few seconds old and the next render rebuilds it anyway.
  function showPlateOnly(agentId) {
    const d = doc();
    if (!d || !agentId) return;
    const tile = d.getElementById("rail-screen");
    const button = tile?.querySelector?.(".rail-screen-button") ?? null;
    if (!button) return;
    if ((button.dataset?.agentId ?? "") !== agentId) return;
    const plate = tile.querySelector?.("[data-rail-screen-plate]") ?? null;
    if (!plate) return;
    const img = button.querySelector("img[data-rail-screen]");
    if (img?.remove) img.remove();
    plate.hidden = false;
    const note = button.querySelector("[data-rail-screen-age]");
    if (note?.remove) note.remove();
  }

  // The age caption, written onto the picture and re-written after every render. renderScreenTile
  // rebuilds #rail-screen wholesale at least once a heartbeat, so this element cannot be emitted
  // once and left alone; it is created when it is missing and its text is replaced when it is not.
  // It is laid out absolutely over the bottom of the picture, so it can appear and disappear
  // without moving anything else in the rail.
  function paintAge(at) {
    const d = doc();
    if (!d) return;
    const agentId = state.last?.agentId ?? "";
    const stamp = Number(at);
    if (!agentId || !Number.isFinite(stamp) || stamp <= 0) return;
    const tile = d.getElementById("rail-screen");
    const button = tile?.querySelector?.(".rail-screen-button") ?? null;
    if (!button) return;
    if ((button.dataset?.agentId ?? "") !== agentId) return;
    // Only over a picture. A plate is not a stale photograph, it is the absence of one, and dating
    // it would read as a picture that failed to load rather than as a tile with nothing in it yet.
    if (!button.querySelector("img[data-rail-screen]")) return;
    let note = button.querySelector("[data-rail-screen-age]");
    if (!note) {
      note = d.createElement("small");
      note.setAttribute("data-rail-screen-age", "");
      note.className = "rail-screen-age";
      button.appendChild(note);
    }
    const words = ageWords(now() - stamp);
    if (note.textContent !== words) note.textContent = words;
  }

  // One second, and it only ever replaces that one string. It runs while the tab is visible and
  // there is a conversation open; it stops with the tab, so a backgrounded console holds no timer.
  function ageTick() {
    if (!pageVisible()) { stopAgeClock(); return; }
    const agentId = state.last?.agentId ?? "";
    if (!agentId) { stopAgeClock(); return; }
    paintAge(capturedAtFor(agentId));
  }

  function startAgeClock() {
    if (ageTimer != null) return;
    if (!pageVisible()) return;
    try { ageTimer = global.setInterval(ageTick, AGE_TICK_MS); } catch { ageTimer = null; }
  }

  function stopAgeClock() {
    if (ageTimer == null) return;
    try { global.clearInterval(ageTimer); } catch { /* nothing to do */ }
    ageTimer = null;
  }

  // ---- the one function app.js drives ----------------------------------------------------------

  function sync(input) {
    const options = input ?? {};
    const agentId = options.agentId ?? "";
    const status = String(options.status ?? "");
    const visible = options.visible === undefined ? pageVisible() : options.visible !== false;
    state.last = { agentId, seat: options.seat, status, visible, activity: options.activity ?? null };
    if (agentId) noteActivity(agentId, options.activity);
    // LIVE is a working turn OR a browser or desktop tool row inside the last minute. The second
    // half is what makes the tile keep up BETWEEN turns, which is when Jason looks at it: `working`
    // is agent.isRunning and is false the instant a turn ends.
    const live = status === "working" || browsingLately(agentId);

    // No conversation, a room, a hidden tab, or a tile nobody can see: nothing to read for and
    // nobody to show it to. The last of those is the phone, where the rails are drawers.
    if (!agentId || !visible || !tileOnScreen()) { teardown(); stopAgeClock(); return readState(); }

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

    startAgeClock();
    // Nothing in hand for this agent: put the words back before anything else, so a tile never shows
    // a picture the module itself would not date.
    if (!frameFor(agentId)) showPlateOnly(agentId);

    if (reader && reader.agentId === agentId) {
      // A live agent holds its client at the live cadence. An agent that has just STOPPED being live
      // keeps the client it has until its next frame and then lets go through tick(): pulling a held
      // reader down to a one-shot here would throw away a handshake that is already paid for.
      if (reader.display !== display) mount(agentId, display, live ? LIVE_REFRESH_MS : WARMUP_POLL_MS, live);
      else retime(live ? LIVE_REFRESH_MS : (reader.hold ? reader.everyMs : WARMUP_POLL_MS), live);
      if (!live && !reader.hold) armIdle(agentId, IDLE_REFRESH_MS);
      return readState();
    }

    if (live) { mount(agentId, display, LIVE_REFRESH_MS, true); return readState(); }

    // Idle, and no reader running. With no picture at all, take one now -- the tile is showing a
    // plate and the person is waiting for the first frame. With a picture in hand, wait for the
    // wake: what is on screen is at most 30 s old, and mounting a client on every render is the
    // thing the old still-by-default rule was right to avoid.
    if (!frameFor(agentId)) { mount(agentId, display, WARMUP_POLL_MS, false); return readState(); }
    const capturedAt = capturedAtFor(agentId);
    const age = capturedAt == null ? Infinity : now() - capturedAt;
    if (age >= IDLE_REFRESH_MS) { mount(agentId, display, WARMUP_POLL_MS, false); return readState(); }
    armIdle(agentId, IDLE_REFRESH_MS - age);
    return readState();
  }

  function readState() {
    const forAgent = reader?.agentId ?? state.last?.agentId ?? "";
    return {
      agentId: reader?.agentId ?? null,
      display: reader?.display ?? null,
      mounted: reader != null,
      everyMs: reader?.everyMs ?? null,
      startedAt: reader?.startedAt ?? null,
      // SCREEN-TILE-1. Which cadence this is, and when the module next means to wake itself up.
      // Both are read by the gate: "a client is held" and "a client happens to be up right now" are
      // different claims, and an idle wake that a render had reset would show here as a number that
      // keeps moving.
      live: reader?.hold === true,
      idleWakeAt: idleWake?.at ?? null,
      capturedAt: capturedAtFor(forAgent),
      // SEAT-FOCUS-1. How many times a reader took the keyboard and was handed it straight back. A
      // gate reads this to prove it reproduced the swallow rather than measuring an empty page.
      handBacks,
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
    // SEAT-FOCUS-1. app.js's hand-off thumb is the other reader of exactly this shape, so the rule
    // lives here once and that mount arms it for its own frame. Handing it anything else is a no-op.
    keepKeyboardOff,
    handBacks: () => handBacks,
    // Read-only, for the gate and the unit test. Nothing in the app calls these.
    state: readState,
    frameLooksReal,
    spreadOf,
    ageWords,
    capturedAtFor,
    forget,
    limits: { MIN_FRAME_CHARS, MIN_SPREAD, IDLE_KEEP, IDLE_PREFIX, IDLE_PREFIX_AT, IDLE_INDEX, LIVE_REFRESH_MS, IDLE_REFRESH_MS, WARMUP_POLL_MS, WARMUP_CEILING_MS, ACTIVITY_WINDOW_MS, AGE_TICK_MS, HANDBACK_POLL_MS, THUMB_W, THUMB_H, READER_FRAME_ATTRIBUTES },
    // app.js hands over its gateway caller here. Without one this module never asks the host
    // anything and simply uses the seat it is given.
    configure(options) {
      if (typeof options?.gateway === "function") gateway = options.gateway;
      return global.__screenTile;
    },
  };

  // A tab that goes away drops the client, the idle wake and the caption's clock, rather than
  // leaving a websocket open and two timers running on a seat nobody is watching. It all comes back
  // on the render the adapter's own resume() causes. Registered once, and only where there is a
  // document to register it on.
  doc()?.addEventListener?.("visibilitychange", () => { if (!pageVisible()) { teardown(); stopAgeClock(); } });
})(typeof window !== "undefined" ? window : globalThis);
