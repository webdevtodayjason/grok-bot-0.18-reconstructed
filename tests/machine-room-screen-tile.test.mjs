// ui/machine-room/screen-tile.js, the module that gives the rail tile a picture and keeps it current.
//
// CONSOLE-4 item C wrote this file for a bug Jason reported in his own words: "The Titan screen at
// the top right says 'Click to open,' but there's a broken image there." Two causes, and the second
// one is the reason a unit test can say anything useful at all -- the tile had no frame to show
// because no reader was ever mounted for an idle agent, so a lot of what is below is about when a
// reader exists, what it is allowed to accept as a picture, and where the picture is kept.
//
// SCREEN-TILE-1 then reversed item C's "a still by default" rule, on Jason's ask of 2026-09-10:
// "It gets recorded once and stays that way. It never updates." The three tests that used to pin
// the still say so in their titles, and they now assert the OPPOSITE behaviour on purpose. The half
// of the old rule that survives -- an idle agent is photographed, never streamed -- is asserted
// beside them, because that half was a privacy decision and not a performance one.
//
// The module is loaded the way the other sibling modules are tested: read the shipped file and
// evaluate it against a stub global. There is no build step, so this is the source that ships.
// Every DOM, storage and timer reference in it goes through that global, which is what makes a
// browserless test of a browser module honest rather than a re-implementation.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await readFile(path.join(repoRoot, "ui/machine-room/screen-tile.js"), "utf8");
const stylesheet = await readFile(path.join(repoRoot, "ui/machine-room/screen-tile.css"), "utf8");
// SCREEN-TILE-1's caption is styled in the tile's own block of styles.css, and its seam is one
// property on the sync object in app.js. Both are read here so neither can quietly go away.
const mainSheet = await readFile(path.join(repoRoot, "ui/machine-room/styles.css"), "utf8");
const appSource = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");

// A "this rule is in there" assertion has to run on the CSS, not on the prose explaining it.
const cssOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");

// ---- the stub browser ---------------------------------------------------------------------------
// Enough DOM for the module and nothing more. Elements answer the three things it asks of them:
// a dataset, querySelector over their own subtree, and hidden/src as plain properties.

function makeElement(tag, attrs = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    dataset: {},
    style: {},
    attributes: {},
    hidden: false,
    textContent: "",
    tabIndex: 0,
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name.startsWith("data-")) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        this.dataset[key] = String(value);
      }
    },
    getAttribute(name) { return this.attributes[name] ?? null; },
    // SCREEN-TILE-1 asks the tile whether the browser is painting it. checkVisibility is the real
    // answer and the one the module prefers; the bounding box is its fallback for a browser too old
    // to have it, and both are stubbed so both paths are exercised.
    painted: true,
    checkVisibility() { return this.painted; },
    rect: { width: 390, height: 244 },
    getBoundingClientRect() { return { ...this.rect }; },
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    remove() {
      const kids = this.parent?.children;
      if (kids) kids.splice(kids.indexOf(this), 1);
      this.parent = null;
    },
    // Only the selector shapes the module actually uses.
    querySelector(selector) {
      for (const child of this.walk()) if (matches(child, selector)) return child;
      return null;
    },
    *walk() { for (const child of this.children) { yield child; yield* child.walk(); } },
  };
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  if (attrs.class) el.className = attrs.class;
  return el;
}

function matches(el, selector) {
  if (selector === "canvas") return el.tagName === "CANVAS";
  if (selector === ".rail-screen-button") return el.className === "rail-screen-button";
  if (selector === "img[data-rail-screen]") return el.tagName === "IMG" && "railScreen" in el.dataset;
  if (selector === "[data-rail-screen-plate]") return "railScreenPlate" in el.dataset;
  if (selector === "[data-rail-screen-age]") return "railScreenAge" in el.dataset;
  return false;
}

function makeWindow({ seat = undefined, storageThrows = false } = {}) {
  const store = new Map();
  const body = makeElement("body");
  const byId = new Map();
  const timers = new Map();
  const wakes = new Map();
  // A round number well clear of zero, so a stamp of 0 can never be mistaken for a real one.
  const clock = { at: 1_700_000_000_000 };
  let nextTimer = 1;
  const win = {
    location: { origin: "https://console.example" },
    document: {
      visibilityState: "visible",
      body,
      listeners: {},
      createElement: (tag) => {
        const el = makeElement(tag);
        if (tag === "canvas") {
          el.width = 0;
          el.height = 0;
          el.getContext = () => ({
            drawImage() {},
            getImageData: (x, y, w, h) => win.__imageData ?? { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) },
          });
          el.toDataURL = () => win.__dataUrl ?? "";
        }
        return el;
      },
      getElementById: (id) => byId.get(id) ?? null,
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    },
    localStorage: {
      getItem: (k) => { if (storageThrows) throw new Error("site data blocked"); return store.has(k) ? store.get(k) : null; },
      setItem: (k, v) => { if (storageThrows) throw new Error("site data blocked"); store.set(k, String(v)); },
      removeItem: (k) => { if (storageThrows) throw new Error("site data blocked"); store.delete(k); },
    },
    setInterval: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => { timers.delete(id); },
    // SCREEN-TILE-1's idle wake is a setTimeout the module owns, held separately from the reader's
    // interval so a test can assert that a render did not touch it.
    setTimeout: (fn, ms) => { const id = nextTimer++; wakes.set(id, { fn, ms, at: clock.at + ms }); return id; },
    clearTimeout: (id) => { wakes.delete(id); },
    // The module reads the clock through `global` (never the ambient Date), so a test winds time
    // forward here rather than monkey-patching the process's own Date.now.
    Date: { now: () => clock.at },
    __store: store,
    __byId: byId,
    __timers: timers,
    __wakes: wakes,
    __clock: clock,
    __seat: seat,
  };
  return win;
}

// Wind the clock and fire every wake whose moment has come, the way a browser would. Deadlines are
// absolute, so three five-second steps reach a thirty-second wake exactly as one thirty-second step
// does -- which is the whole point of the test that renders in between them.
const advance = (win, ms) => {
  win.__clock.at += ms;
  for (const [id, wake] of [...win.__wakes]) {
    if (wake.at <= win.__clock.at) { win.__wakes.delete(id); wake.fn(); }
  }
};

const load = (win) => { new Function("window", source)(win); return win.__screenTile; };

// A rail tile in the shape app.js emits after this wave: no <img> until there is a src.
function railTile(win, agentId, plateText = "Click to open this computer's screen") {
  const tile = makeElement("section", { id: "rail-screen" });
  const button = makeElement("button", { class: "rail-screen-button", "data-agent-id": agentId });
  button.className = "rail-screen-button";
  const plate = makeElement("span", { "data-rail-screen-plate": "" });
  plate.textContent = plateText;
  button.appendChild(plate);
  tile.appendChild(button);
  const caption = makeElement("small", { id: "rail-screen-caption" });
  caption.textContent = `${agentId}'s screen`;
  win.__byId.set("rail-screen", tile);
  win.__byId.set("rail-screen-caption", caption);
  return { tile, button, plate };
}

// The two real samples, at their measured lengths. A solid-white frame off Titan's seat mid
// handshake was 1,043 characters; the desktop behind it was 7,591.
const WHITE_SAMPLE = `data:image/webp;base64,${"A".repeat(1043 - 23)}`;
const REAL_SAMPLE = `data:image/webp;base64,${"B".repeat(7591 - 23)}`;

const flush = () => new Promise((resolve) => setImmediate(resolve));
const tickOnce = (win) => { for (const timer of win.__timers.values()) timer.fn(); };

// The pixels behind the two samples. spreadOf steps four pixels in both axes, so a frame small
// enough that only one pixel is sampled would read as flat whatever is in it -- these are 16x16
// with a gradient across x, which is what a real desktop looks like to that sampler.
const CONTRAST = (() => {
  const width = 16;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const value = (x * 16) % 256;
      data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
    }
  }
  return { width, height, data };
})();
const BLANK = { width: 16, height: 16, data: new Uint8ClampedArray(16 * 16 * 4).fill(255) };

// A client that has painted a framebuffer, ready to be read off.
const painting = (client) => { client.contentDocument = { querySelector: () => Object.assign(makeElement("canvas"), { width: 1280, height: 800 }) }; return client; };
const clientOf = (win) => win.document.body.children.find((el) => el.tagName === "IFRAME");

// -- the blank-frame guard ------------------------------------------------------------------------

test("the guard rejects the measured white frame and accepts the measured real one", () => {
  const tile = load(makeWindow());
  assert.equal(WHITE_SAMPLE.length, 1043, "the white sample is the length that was measured");
  assert.equal(REAL_SAMPLE.length, 7591, "the real sample is the length that was measured");
  assert.equal(tile.frameLooksReal(WHITE_SAMPLE, 220), false, "1,043 characters is a solid fill however much spread is claimed");
  assert.equal(tile.frameLooksReal(REAL_SAMPLE, 220), true);
});

test("the guard rejects a long frame with no colour spread, so length alone can never pass one", () => {
  const tile = load(makeWindow());
  assert.equal(tile.frameLooksReal(REAL_SAMPLE, 0), false, "a big flat fill is still a blank screen");
  assert.equal(tile.frameLooksReal(REAL_SAMPLE, tile.limits.MIN_SPREAD - 1), false);
  assert.equal(tile.frameLooksReal(REAL_SAMPLE, tile.limits.MIN_SPREAD), true);
});

test("the guard rejects anything that is not an image data URL", () => {
  const tile = load(makeWindow());
  for (const bad of ["", null, undefined, 42, "https://console.example/shot.webp", `data:text/html,${"x".repeat(9000)}`]) {
    assert.equal(tile.frameLooksReal(bad, 220), false, `accepted ${String(bad).slice(0, 32)}`);
  }
});

test("spreadOf reads a solid fill as zero and a two-tone frame as the gap between them", () => {
  const tile = load(makeWindow());
  const solid = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4).fill(255) };
  assert.equal(tile.spreadOf(solid), 0);
  const twoTone = { width: 8, height: 8, data: new Uint8ClampedArray(8 * 8 * 4) };
  // Row 0 white, the rest left black. The sampler steps by four in both axes, so row 0 is read.
  for (let x = 0; x < 8; x += 1) twoTone.data.set([255, 255, 255, 255], x * 4);
  assert.ok(tile.spreadOf(twoTone) >= tile.limits.MIN_SPREAD, "a white row on black is contrast");
  assert.equal(tile.spreadOf(null), 0);
  assert.equal(tile.spreadOf({ width: 0, height: 0, data: new Uint8ClampedArray() }), 0);
});

// -- the store ------------------------------------------------------------------------------------

test("an idle still cannot evict a hand-off frame, and its own index holds at three", () => {
  const win = makeWindow();
  // HANDBACK-1's newest-eight, already in this origin's storage exactly as app.js writes it.
  const handoffKeys = Array.from({ length: 8 }, (_, i) => `agent-${i}::req-${i}`);
  for (const key of handoffKeys) win.__store.set(`mr-box-handoff-frame:${key}`, REAL_SAMPLE);
  win.__store.set("mr-box-handoff-frames", JSON.stringify(handoffKeys));

  const tile = load(win);
  // Six idle stills through the same storage, twice the module's own cap.
  for (let i = 0; i < 6; i += 1) {
    railTile(win, `idle-${i}`);
    win.__dataUrl = REAL_SAMPLE;
    win.__imageData = null;
    // Write through the public path the reader uses.
    win.__screenTile.sync({ agentId: `idle-${i}`, seat: 3, status: "working" });
    painting(clientOf(win));
    win.__imageData = CONTRAST;
    tickOnce(win);
  }

  for (const key of handoffKeys) {
    assert.equal(win.__store.get(`mr-box-handoff-frame:${key}`), REAL_SAMPLE, `idle writes removed hand-off frame ${key}`);
  }
  assert.equal(JSON.parse(win.__store.get("mr-box-handoff-frames")).length, 8, "the newest-eight budget still holds eight");

  const idleIndex = JSON.parse(win.__store.get(tile.limits.IDLE_INDEX));
  assert.equal(idleIndex.length, tile.limits.IDLE_KEEP, "the idle index is capped at three");
  assert.deepEqual(idleIndex, ["idle-5", "idle-4", "idle-3"], "newest first");
  const idleKeys = [...win.__store.keys()].filter((k) => k.startsWith(tile.limits.IDLE_PREFIX));
  assert.equal(idleKeys.length, tile.limits.IDLE_KEEP, "and three keys is all it left behind");
});

test("frameFor answers nothing for an agent with no frame, and reads a stored one back", () => {
  const win = makeWindow();
  const tile = load(win);
  assert.equal(tile.frameFor("nobody"), "");
  assert.equal(tile.frameFor(""), "");
  win.__store.set(`${tile.limits.IDLE_PREFIX}seen-before`, REAL_SAMPLE);
  assert.equal(tile.frameFor("seen-before"), REAL_SAMPLE, "a reload still shows the last thing the screen looked like");
});

test("a browser with site data blocked throws on the accessor and the module carries on", () => {
  const win = makeWindow({ storageThrows: true });
  const tile = load(win);
  assert.equal(tile.frameFor("anyone"), "");
  assert.doesNotThrow(() => tile.sync({ agentId: "anyone", seat: 3, status: "idle" }));
});

// -- the three seat branches --------------------------------------------------------------------
// A seat number, a null seat, and no seat FIELD at all. The tile draws a plate in all three until a
// frame lands, because frameFor is what app.js asks for the picture and nothing here invents one.

test("frameFor returns nothing in all three seat branches, so the tile renders a plate", () => {
  for (const seat of [3, null, undefined]) {
    const win = makeWindow();
    const tile = load(win);
    railTile(win, "titan");
    tile.sync({ agentId: "titan", seat, status: "idle" });
    assert.equal(tile.frameFor("titan"), "", `seat ${String(seat)} invented a frame`);
    const { tile: node } = { tile: win.__byId.get("rail-screen") };
    assert.equal(node.querySelector("img[data-rail-screen]"), null, `seat ${String(seat)} put an <img> on the page with no src`);
    assert.equal(node.querySelector("[data-rail-screen-plate]").hidden, false, `seat ${String(seat)} hid the plate with no picture behind it`);
  }
});

test("a null seat is the shared screen and an absent one is not, so only the second draws nothing", () => {
  const shared = makeWindow();
  load(shared);
  railTile(shared, "titan");
  shared.__screenTile.sync({ agentId: "titan", seat: null, status: "idle" });
  assert.equal(shared.__screenTile.state().display, 1, "null means display 1, the shared screen");

  const silent = makeWindow();
  load(silent);
  railTile(silent, "titan");
  silent.__screenTile.sync({ agentId: "titan", seat: undefined, status: "idle" });
  assert.equal(silent.__screenTile.state().mounted, false, "a host that did not say gets no client mounted");
});

test("a seat of 1 or 0 is the shared screen, and a seat above it is the agent's own", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  for (const [seat, display] of [[0, 1], [1, 1], [3, 3], [{ display: 5, shared: false }, 5], [{ display: 1, shared: true }, 1]]) {
    tile.teardown();
    tile.sync({ agentId: "titan", seat, status: "working" });
    assert.equal(tile.state().display, display, `seat ${JSON.stringify(seat)}`);
  }
});

// -- the host question ----------------------------------------------------------------------------

test("the seat is asked for with { id } and never { agentId }", async () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  const calls = [];
  tile.configure({ gateway: (method, args) => { calls.push({ method, args }); return Promise.resolve({ agentId: "titan", boxSeat: 4 }); } });

  tile.sync({ agentId: "titan", seat: undefined, status: "idle" });
  await flush();

  assert.equal(calls.length, 1, "asked once");
  assert.equal(calls[0].method, "getForeverBoxStatus");
  assert.deepEqual(Object.keys(calls[0].args), ["id"], "the argument shape is { id } and nothing else");
  assert.equal(calls[0].args.id, "titan");
  assert.equal(calls[0].args.agentId, undefined, "the agentId form answers a stub with no boxSeat field at all");
  assert.equal(tile.state().display, 4, "and the answer mounts the reader on the seat it named");
});

test("a status with no boxSeat field is not read as a shared seat", async () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  // Exactly the 104 B stub the { agentId } form answers, in case anything ever hands one over.
  tile.configure({ gateway: () => Promise.resolve({ state: "absent", vncUrl: null, handoff: null, hostVersion: "2fcb12d" }) });
  tile.sync({ agentId: "titan", seat: undefined, status: "idle" });
  await flush();
  assert.equal(tile.state().mounted, false, "a stub with no boxSeat is 'this host cannot say', not 'the shared screen'");
});

test("the host is asked once per agent, not once per render", async () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  let asked = 0;
  tile.configure({ gateway: () => { asked += 1; return Promise.resolve(null); } });
  for (let i = 0; i < 5; i += 1) { tile.sync({ agentId: "titan", seat: undefined, status: "idle" }); await flush(); }
  assert.equal(asked, 1, "five renders, one question");
});

// -- the reader's life ----------------------------------------------------------------------------

test("sync mounts at most one client, whatever it is called with", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  for (let i = 0; i < 6; i += 1) tile.sync({ agentId: "titan", seat: 3, status: "working" });
  const clients = win.document.body.children.filter((el) => el.tagName === "IFRAME");
  assert.equal(clients.length, 1, "six renders, one client");
  // Two intervals and no more: the reader's own cadence, and SCREEN-TILE-1's one-second caption
  // clock. Six renders adding six of either is exactly the leak these counts exist to catch.
  assert.equal(win.__timers.size, 2, "and one reader interval beside the caption's clock");
});

test("the client is view_only, on the page's own origin, and built on the seat it was given", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 5, status: "working" });
  const client = win.document.body.children.find((el) => el.tagName === "IFRAME");
  assert.ok(client, "a client was mounted");
  assert.match(client.src, /^https:\/\/console\.example\/vnc\/5\/vnc\.html\?/, "the page's origin, not the host's 127.0.0.1 form");
  assert.match(client.src, /view_only=1/, "this client can never take a keystroke");
  assert.match(client.src, /resize=scale/, "vnc.html with resize=scale, not the lite client's top-left corner");
  assert.equal(client.attributes["data-screen-tile-source"], "1", "the gate counts readers by this attribute");
  assert.equal(client.attributes["aria-hidden"], "true");
  assert.equal(client.tabIndex, -1);
});

test("the conversation moving to another agent tears the client down and mounts one for the new one", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  const first = win.document.body.children.find((el) => el.tagName === "IFRAME");
  railTile(win, "dispatch");
  tile.sync({ agentId: "dispatch", seat: 4, status: "working" });
  const clients = win.document.body.children.filter((el) => el.tagName === "IFRAME");
  assert.equal(clients.length, 1, "still one client");
  assert.notEqual(clients[0], first, "and it is a new one");
  assert.equal(tile.state().agentId, "dispatch");
  assert.equal(win.__timers.size, 2, "the old reader's timer went with it, leaving one reader interval and the caption clock");
});

test("a render that merely carried no display does NOT tear the client down", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  const before = tile.state();
  assert.equal(before.mounted, true);
  // The roster is rebuilt from listAgents and the box status is a separate read, so the record is
  // briefly seatless between the two. Tearing down here took the first frame from 1.4 s to 33 s.
  tile.sync({ agentId: "titan", seat: undefined, status: "working" });
  const after = tile.state();
  assert.equal(after.mounted, true, "a seatless render is not the end of anything");
  assert.equal(after.startedAt, before.startedAt, "and it is the same client, not a remount");
});

test("a hidden tab drops the client, and it comes back when the tab does", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, true);

  win.document.visibilityState = "hidden";
  win.document.listeners.visibilitychange.forEach((fn) => fn());
  assert.equal(tile.state().mounted, false, "nobody is looking, so no websocket is held open on a seat");
  assert.equal(win.document.body.children.filter((el) => el.tagName === "IFRAME").length, 0);

  tile.sync({ agentId: "titan", seat: 3, status: "working", visible: false });
  assert.equal(tile.state().mounted, false, "and a render while hidden does not bring it back");

  win.document.visibilityState = "visible";
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, true);
});

test("HANDBACK-1's reader owns the agent while a hand-off is pending, so this one stands down", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  win.__machineRoomHandoff = { screen: () => ({ agentId: "titan", readerDisplay: 3 }) };
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, false, "two clients on one seat is two handshakes and two copies");

  // A hand-off on somebody else is not this agent's business.
  win.__machineRoomHandoff = { screen: () => ({ agentId: "dispatch", readerDisplay: 4 }) };
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, true);

  // And a screen() with no reader running is not an owner either.
  tile.teardown();
  win.__machineRoomHandoff = { screen: () => ({ agentId: "titan", readerDisplay: null }) };
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, true);
});

test("a room and an empty conversation mount nothing", () => {
  const win = makeWindow();
  const tile = load(win);
  tile.sync({ agentId: "", seat: 3, status: "idle" });
  assert.equal(tile.state().mounted, false);
  tile.sync({});
  assert.equal(tile.state().mounted, false);
});

// -- the three cadences ---------------------------------------------------------------------------
//
// SCREEN-TILE-1 DELIBERATELY REVERSED "a still by default". The three tests below used to assert
// that an idle agent took one photograph and never took another, and that an idle agent with a
// picture in hand mounted nothing at all for the rest of the session. That was CONSOLE-4's rule and
// it was the bug Jason reported on 2026-09-10: "It gets recorded once and stays that way. It never
// updates." These are not weakened tests -- they assert the opposite behaviour on purpose, and the
// half of the old rule that survives (an idle agent is never a HELD client) is asserted beside them.

test("SCREEN-TILE-1 reversal: a live agent holds its client at three seconds; an idle one does not hold one at all", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().everyMs, tile.limits.LIVE_REFRESH_MS, "a working agent is watched, not photographed");
  assert.equal(tile.state().live, true);
  assert.equal(win.__timers.size, 2, "the reader's interval and the caption's one-second clock, and nothing else");

  // The turn ends. The client it already paid a handshake for stays until its next frame, and then
  // tick() lets it go -- which is the mount-grab-release half of the rule that did not change.
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  assert.equal(tile.state().live, false, "an idle agent is no longer held");
  painting(clientOf(win));
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.equal(tile.state().mounted, false, "it took its frame and let the seat go");
  assert.equal(tile.frameFor("titan"), REAL_SAMPLE);
});

test("SCREEN-TILE-1 reversal: an idle agent with a picture in hand remounts after thirty seconds", () => {
  const win = makeWindow();
  const tile = load(win);
  win.__store.set(`${tile.limits.IDLE_PREFIX}titan`, REAL_SAMPLE);
  win.__store.set(`${tile.limits.IDLE_PREFIX_AT}titan`, String(win.__clock.at));
  railTile(win, "titan");

  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  assert.equal(tile.state().mounted, false, "the picture is seconds old; nothing to mount yet");
  assert.equal(tile.state().idleWakeAt, win.__clock.at + tile.limits.IDLE_REFRESH_MS, "but the module armed its own wake");

  advance(win, tile.limits.IDLE_REFRESH_MS);
  assert.equal(tile.state().mounted, true, "thirty seconds on, it goes and takes a new one — this is the whole of SCREEN-TILE-1");
  assert.equal(tile.state().live, false, "and it is a grab, not a held stream: the CONSOLE-4 privacy rule where it still applies");
});

test("SCREEN-TILE-1 reversal: a stored still with no stamp on it is replaced at once rather than trusted", () => {
  const win = makeWindow();
  const tile = load(win);
  // Exactly what a console that ran the CONSOLE-4 module left in this browser: a frame and no time.
  win.__store.set(`${tile.limits.IDLE_PREFIX}titan`, REAL_SAMPLE);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  assert.equal(tile.state().mounted, true, "a picture that cannot say when it was taken is not a picture of now");
});

test("a render does not push the idle wake back, however many renders arrive", () => {
  const win = makeWindow();
  const tile = load(win);
  win.__store.set(`${tile.limits.IDLE_PREFIX}titan`, REAL_SAMPLE);
  win.__store.set(`${tile.limits.IDLE_PREFIX_AT}titan`, String(win.__clock.at));
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  const armedFor = tile.state().idleWakeAt;

  // The adapter's heartbeat is 15 s and every beat renders. A wake recomputed per render would be
  // pushed past thirty seconds for ever and the tile would never refresh once -- which is the exact
  // failure this shape exists to avoid.
  for (let beat = 0; beat < 3; beat += 1) {
    advance(win, 5000);
    tile.sync({ agentId: "titan", seat: 3, status: "idle" });
    assert.equal(tile.state().idleWakeAt, armedFor, `render ${beat + 1} moved the wake`);
  }
  assert.equal(win.__wakes.size, 1, "and there is still exactly one of them");
  advance(win, tile.limits.IDLE_REFRESH_MS - 15_000);
  assert.equal(tile.state().mounted, true, "the wake fired on the moment it was armed for");
});

test("a hidden tab stops the wake as well as the client, and coming back re-arms it", () => {
  const win = makeWindow();
  const tile = load(win);
  win.__store.set(`${tile.limits.IDLE_PREFIX}titan`, REAL_SAMPLE);
  win.__store.set(`${tile.limits.IDLE_PREFIX_AT}titan`, String(win.__clock.at));
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  assert.equal(win.__wakes.size, 1);

  win.document.visibilityState = "hidden";
  win.document.listeners.visibilitychange.forEach((fn) => fn());
  assert.equal(win.__wakes.size, 0, "a backgrounded console holds no timer waiting to open a websocket");
  assert.equal(tile.state().idleWakeAt, null);
  advance(win, tile.limits.IDLE_REFRESH_MS * 3);
  assert.equal(tile.state().mounted, false, "and nothing woke up while nobody was looking");

  // Coming back is the adapter's own resume() rendering, which is a sync.
  win.document.visibilityState = "visible";
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  assert.equal(tile.state().mounted, true, "the picture is minutes old now, so the tile takes one immediately");
});

test("a tile the browser is not painting reads nothing, which is the phone's closed rail drawer", () => {
  const win = makeWindow();
  const tile = load(win);
  const { button } = railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, true, "on a desktop the tile is on screen and reads");

  // The drawer shuts. It is `visibility: hidden` and translated off the right edge, so the BOX is
  // still a healthy 274x172 -- measured at 390x844 on grok-bot-local-vm -- and only the browser's
  // own checkVisibility tells the truth about it. Nobody can see the picture, so nothing is read.
  button.painted = false;
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, false, "a picture nobody can see is not worth a websocket");
  assert.equal(tile.state().idleWakeAt, null, "and no wake is left armed to open one in thirty seconds");

  button.painted = true;
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, true, "the drawer opens and it reads again");
});

test("a browser with no checkVisibility falls back to the tile's box rather than going blind", () => {
  const win = makeWindow();
  const tile = load(win);
  const { button } = railTile(win, "titan");
  delete button.checkVisibility;
  button.rect = { width: 0, height: 0 };
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, false, "a tile laid out to nothing is not worth a websocket either");
  button.rect = { width: 390, height: 244 };
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().mounted, true);
});

test("a held client lets go when the tile stops being painted under it", () => {
  const win = makeWindow();
  const tile = load(win);
  const { button } = railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));
  // A window resize does not necessarily render, so tick() asks the question too.
  button.painted = false;
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.equal(tile.state().mounted, false, "the reader went with the drawer, without waiting for a render");
});

test("a browser tool row keeps the tile live for a minute after the turn ends", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  // `status` is agent.isRunning, false the instant a turn ends. This is the seam app.js drives.
  const opened = { id: "tool-9", kind: "Shell", text: "Opened wikipedia.org" };
  tile.sync({ agentId: "titan", seat: 3, status: "idle", activity: opened });
  assert.equal(tile.state().live, true, "it just opened a page; the picture is about to change");

  advance(win, tile.limits.ACTIVITY_WINDOW_MS - 1000);
  tile.sync({ agentId: "titan", seat: 3, status: "idle", activity: opened });
  assert.equal(tile.state().live, true, "still inside the minute");

  advance(win, 2000);
  tile.sync({ agentId: "titan", seat: 3, status: "idle", activity: opened });
  assert.equal(tile.state().live, false, "and past it, the tile goes back to a photograph every thirty seconds");
});

test("only a screen tool row makes the tile live, and only a NEW one restarts the minute", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");

  tile.sync({ agentId: "titan", seat: 3, status: "idle", activity: { id: "tool-1", kind: "Read", text: "Read notes.md · /home/box/notes.md" } });
  assert.equal(tile.state().live, false, "reading a file changes no screen");
  tile.sync({ agentId: "titan", seat: 3, status: "idle", activity: { id: "tool-2", kind: "Shell", text: "Fetched titanium.bot" } });
  assert.equal(tile.state().live, false, "and neither does curl");

  tile.sync({ agentId: "titan", seat: 3, status: "idle", activity: { id: "tool-3", kind: "Computer", text: "Computer · click" } });
  assert.equal(tile.state().live, true, "computerUseToolCall does");

  // The same row again, over and over, is one action. A render that re-stamped it would hold the
  // tile live for ever off a single click.
  advance(win, tile.limits.ACTIVITY_WINDOW_MS + 1000);
  tile.sync({ agentId: "titan", seat: 3, status: "idle", activity: { id: "tool-3", kind: "Computer", text: "Computer · click" } });
  assert.equal(tile.state().live, false, "the same row is the same action, not a fresh one");
});

test("the reader's URL asks for the cheap picture, which is what makes the idle cadence legal", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 4, status: "working" });
  const client = clientOf(win);
  assert.match(client.src, /quality=0/, "18.0 KiB a mount against 35.0 KiB at the client's default, measured on grok-bot-local-vm");
  assert.match(client.src, /compression=9/);
});

// -- how old the picture is -----------------------------------------------------------------------

test("capturedAt moves with every accepted frame and a refused one never touches it", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));

  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  const first = tile.capturedAtFor("titan");
  assert.equal(first, win.__clock.at, "the stamp is the moment the frame was taken");

  // A client that goes blank mid-session: the caption must go on ageing the last real picture
  // rather than claiming the blank one is fresh.
  advance(win, 3000);
  win.__dataUrl = WHITE_SAMPLE;
  win.__imageData = BLANK;
  tickOnce(win);
  assert.equal(tile.capturedAtFor("titan"), first, "a refused frame is not a picture and does not date one");

  advance(win, 3000);
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.equal(tile.capturedAtFor("titan"), win.__clock.at, "and the next real one does");
  assert.equal(win.__store.get(`${tile.limits.IDLE_PREFIX_AT}titan`), String(win.__clock.at), "it is persisted beside the frame, so a reload can still date it");
});

// Also found by the integration: the module hid the plate when it painted, and nothing put the words
// back. An agent with no picture (a fresh one, or one whose frame this session forgot) therefore kept
// the LAST picture on the glass until app.js happened to re-render -- which for an agent whose card
// never opened is never.
test("a sync with no picture in hand puts the plate's words back instead of leaving a stale one", () => {
  const win = makeWindow();
  const tile = load(win);
  const { button } = railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.ok(button.querySelector("img[data-rail-screen]"), "a picture is on the glass");
  assert.equal(button.querySelector("[data-rail-screen-plate]").hidden, true, "and the plate is out of the way");

  tile.forget("titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(button.querySelector("img[data-rail-screen]"), null, "the stale picture is removed, not hidden: display:block outranks [hidden] here");
  assert.equal(button.querySelector("[data-rail-screen-plate]").hidden, false, "the words are back in front");
  assert.equal(button.querySelector("[data-rail-screen-age]"), null, "and nothing is dating a picture that is not there");
});

// The integration of console polish 3 found this hole: the old --tile leg wiped the storage key to
// set up "no picture yet" and the in-memory copy went on answering, so the tile drew a stale picture
// where the leg expected the plate's words. forget() is the only way back to that state, and it has
// to clear BOTH halves or the leg is measuring a cache.
test("forget() drops both halves of a remembered picture, so the no-picture state is reachable again", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.ok(tile.frameFor("titan"), "a picture is in hand to begin with");
  assert.ok(win.__store.get(`${tile.limits.IDLE_PREFIX}titan`), "and it is persisted");

  // A storage wipe alone is what the gate used to do, and it is not enough.
  win.__store.delete(`${tile.limits.IDLE_PREFIX}titan`);
  assert.ok(tile.frameFor("titan"), "the in-memory copy outlives a storage wipe, which is the trap");

  tile.forget("titan");
  assert.equal(tile.frameFor("titan"), "", "forget() leaves no picture at all");
  assert.equal(tile.capturedAtFor("titan"), null, "and no stamp to age");
  assert.equal(win.__store.get(`${tile.limits.IDLE_PREFIX_AT}titan`), undefined, "including the stamp's own key");
  const index = JSON.parse(win.__store.get(tile.limits.IDLE_INDEX) ?? "[]");
  assert.ok(!index.includes("titan"), "and the id is out of the index, so eviction cannot reach for a key that is gone");
});

test("the age caption says how old the picture is, in words, and is re-added after a render", () => {
  const win = makeWindow();
  const tile = load(win);
  const { button } = railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  const note = button.querySelector("[data-rail-screen-age]");
  assert.ok(note, "the caption is drawn on the picture");
  assert.equal(note.textContent, "as of 0 s ago");

  // renderScreenTile rewrites the whole tile at least once a heartbeat. The module's own clock puts
  // the caption back; a caption emitted once by app.js would blink out and stay out.
  const fresh = railTile(win, "titan");
  assert.equal(fresh.button.querySelector("[data-rail-screen-age]"), null, "the render wiped it");
  fresh.button.appendChild(Object.assign(makeElement("img", { "data-rail-screen": "" }), { src: REAL_SAMPLE }));
  // Only the caption's own one-second clock is left running, so what puts the words back is that
  // clock and not another frame landing.
  tile.teardown();
  advance(win, 3000);
  tickOnce(win);
  assert.equal(fresh.button.querySelector("[data-rail-screen-age]")?.textContent, "as of 3 s ago", "and it came back on the module's own clock");
});

test("the age is never written over a plate, because a plate is not a stale photograph", () => {
  const win = makeWindow();
  const tile = load(win);
  const { button, plate } = railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));
  win.__dataUrl = WHITE_SAMPLE;
  win.__imageData = BLANK;
  tickOnce(win);
  assert.equal(plate.hidden, false, "no picture yet");
  assert.equal(button.querySelector("[data-rail-screen-age]"), null, "and nothing dating one");
});

test("the age wording at three seconds, forty-five, two minutes and an hour", () => {
  const tile = load(makeWindow());
  assert.equal(tile.ageWords(3000), "as of 3 s ago");
  assert.equal(tile.ageWords(45_000), "as of 45 s ago");
  assert.equal(tile.ageWords(60_000), "as of a minute ago");
  assert.equal(tile.ageWords(120_000), "as of 2 min ago");
  assert.equal(tile.ageWords(45 * 60_000), "as of 45 min ago");
  assert.equal(tile.ageWords(60 * 60_000), "as of an hour ago");
  assert.equal(tile.ageWords(3 * 60 * 60_000), "as of 3 h ago");
  assert.equal(tile.ageWords(-5), "as of 0 s ago", "a clock that went backwards is not a picture from the future");
});

test("a blank frame is refused and the plate holds; the real one behind it is taken", () => {
  const win = makeWindow();
  const tile = load(win);
  const { tile: node, plate } = railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));

  // The first sample off Titan's seat: solid white, mid handshake.
  win.__dataUrl = WHITE_SAMPLE;
  win.__imageData = BLANK;
  tickOnce(win);
  assert.equal(tile.frameFor("titan"), "", "a white rectangle is not a picture of anything");
  assert.equal(plate.hidden, false, "and the plate stays until a real one lands");
  assert.equal(node.querySelector("img[data-rail-screen]"), null, "no <img> was created for it");

  // The next one: the real desktop.
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.equal(tile.frameFor("titan"), REAL_SAMPLE);
  assert.equal(plate.hidden, true, "the plate steps aside for the picture");
  const img = node.querySelector("img[data-rail-screen]");
  assert.ok(img, "and the <img> is created only now, with a src on it");
  assert.equal(img.src, REAL_SAMPLE);
  assert.equal(img.hidden, false);
  assert.equal(img.getAttribute("alt"), "titan's screen", "the caption is the alt text, so a screen reader hears the same thing");
});

test("a frame is never painted into a tile showing another agent", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));
  // The person moved on; the tile is drawing somebody else now.
  const moved = railTile(win, "dispatch");
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.equal(moved.tile.querySelector("img[data-rail-screen]"), null, "Titan's screen never appears under Dispatch's name");
  assert.equal(moved.plate.hidden, false);
});

test("the desktop view being open pauses the reader rather than tearing it down", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  const dialog = makeElement("dialog", { id: "desktop-dialog" });
  dialog.open = true;
  win.__byId.set("desktop-dialog", dialog);
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  painting(clientOf(win));
  win.__dataUrl = REAL_SAMPLE;
  win.__imageData = CONTRAST;
  tickOnce(win);
  assert.equal(tile.frameFor("titan"), "", "the person is looking at the real thing; a second copy is work for nobody");
  assert.equal(tile.state().mounted, true, "and it is a pause, not a teardown: the dialog closes in seconds");
  dialog.open = false;
  tickOnce(win);
  assert.equal(tile.frameFor("titan"), REAL_SAMPLE, "and it picks straight back up");
});

test("a client that never paints anything gives up rather than holding a seat open forever", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  clientOf(win).contentDocument = { querySelector: () => null };
  tickOnce(win);
  assert.equal(tile.state().mounted, true, "still inside the warm-up window");
  // Wind the clock past the ceiling without waiting for it.
  win.__clock.at += 25_000;
  tickOnce(win);
  assert.equal(tile.state().mounted, false, "a client that cannot paint is not going to");
  // And it comes back at the idle cadence rather than giving up on the agent for the session --
  // a seat that is not answering now may be answering in half a minute.
  assert.equal(tile.state().idleWakeAt, win.__clock.at + tile.limits.IDLE_REFRESH_MS);
});

// -- the stylesheet's belt -------------------------------------------------------------------------

test("screen-tile.css carries the [hidden] belt that keeps the broken glyph off the page", () => {
  const css = cssOnly(stylesheet);
  assert.match(css, /\.rail-screen-button img\[hidden\]/, "the rule Jason's broken image needed");
  assert.match(css, /\.rail-screen-button img:not\(\[src\]\)/, "and the way in [hidden] would miss");
  assert.match(css, /\.rail-screen-button img\[src=""\]/, "and a src cleared to empty");
  const block = css.slice(css.indexOf(".rail-screen-button img[hidden]"));
  assert.match(block.slice(0, 200), /display:\s*none/, "the belt has to actually say display: none");
});

test("the reader's own client is laid out off-screen by the stylesheet as well as inline", () => {
  const css = cssOnly(stylesheet);
  assert.match(css, /iframe\[data-screen-tile-source\]/);
  const block = css.slice(css.indexOf("iframe[data-screen-tile-source]"));
  assert.match(block, /pointer-events:\s*none/);
  assert.match(block, /left:\s*-10000px/);
});

test("the age caption is laid out so it cannot move the rail, in both themes", () => {
  const css = cssOnly(mainSheet);
  assert.match(css, /\.rail-screen-button\s*\{[^}]*position:\s*relative/, "the caption is positioned against the button");
  const block = css.slice(css.indexOf(".rail-screen-age"));
  assert.match(block.slice(0, 400), /position:\s*absolute/, "absolute, so appearing and disappearing moves nothing");
  assert.match(block.slice(0, 400), /pointer-events:\s*none/, "and it never eats the click that opens the desktop view");
  assert.match(css, /\[data-theme="mist"\]\s*\.rail-screen-age/, "mist gets its own ink: the picture under it is a screenshot either way");
});

test("app.js hands the newest tool row over, which is the whole of this wave's seam in that file", () => {
  const call = appSource.slice(appSource.indexOf("window.__screenTile?.sync?.({"));
  assert.match(call.slice(0, 600), /activity:\s*newestToolRow\(lead\)/, "the one property this wave added to the sync object");
  assert.match(appSource, /function newestToolRow\(record\)/, "and the reader it comes from");
  // It must read a tool row and nothing else: a text bubble is not work on a screen.
  const helper = appSource.slice(appSource.indexOf("function newestToolRow(record)"));
  assert.match(helper.slice(0, 600), /row\?\.type === "system" && row\.kind/, "a tool row is a system message carrying a kind");
});

test("the plate draws the product's own mark and no other asset", () => {
  const css = cssOnly(stylesheet);
  assert.match(css, /\.rail-screen-plate\s*\{[^}]*background-image:\s*url\("data:image\/svg\+xml,/, "the mark is inline, so the plate costs no request");
  assert.doesNotMatch(css, /url\((?!["']?data:)/, "nothing here reaches for a file that could 404 into another broken image");
});

// -- what this module must never do ----------------------------------------------------------------

test("the module never rewrites a hand-off function and never allocates a seat", () => {
  const codeOnly = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  for (const name of ["ensureForeverBox", "ensureDesktop", "handoffCardMarkup", "boxHandoffEnsureThumb", "handBackForeverBox"]) {
    assert.doesNotMatch(codeOnly, new RegExp(name), `screen-tile.js calls ${name}; a thumbnail must never allocate a seat or redraw a hand-off`);
  }
  assert.match(codeOnly, /__machineRoomHandoff\?\.screen\?\.\(\)/, "it READS HANDBACK-1's reader rather than reimplementing it");
});

test("the module writes only its own storage prefix", () => {
  const codeOnly = source.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  const writes = [...codeOnly.matchAll(/(?:setItem|removeItem)\(([^,)]+)/g)].map((m) => m[1].trim());
  assert.ok(writes.length > 0, "it does write");
  for (const target of writes) {
    assert.ok(/IDLE_PREFIX|IDLE_INDEX/.test(target), `writes to ${target}, which is outside this module's own keys`);
  }
});
