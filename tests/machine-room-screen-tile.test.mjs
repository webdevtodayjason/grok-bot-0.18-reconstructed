// CONSOLE-4 item C: ui/machine-room/screen-tile.js, the module that gives the rail tile a picture.
//
// The bug this file exists to keep closed is one Jason reported in his own words: "The Titan screen
// at the top right says 'Click to open,' but there's a broken image there." Two causes, and the
// second one is the reason a unit test can say anything useful at all -- the tile had no frame to
// show because no reader was ever mounted for an idle agent, so every assertion below is about when
// a reader exists, what it is allowed to accept as a picture, and where the picture is kept.
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
  return false;
}

function makeWindow({ seat = undefined, storageThrows = false } = {}) {
  const store = new Map();
  const body = makeElement("body");
  const byId = new Map();
  const timers = new Map();
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
    __store: store,
    __byId: byId,
    __timers: timers,
    __seat: seat,
  };
  return win;
}

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
  assert.equal(win.__timers.size, 1, "and one timer");
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
  assert.equal(win.__timers.size, 1, "the old timer went with it");
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

// -- the cadence, and the still ------------------------------------------------------------------

test("a working agent refreshes every five seconds; anything else is warming up at one", () => {
  const win = makeWindow();
  const tile = load(win);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "working" });
  assert.equal(tile.state().everyMs, tile.limits.WORKING_REFRESH_MS);
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  assert.equal(tile.state().everyMs, tile.limits.WARMUP_POLL_MS, "the cadence changes without remounting");
  assert.equal(win.__timers.size, 1, "one timer through the change");
});

test("an idle agent takes one frame and lets the client go; a working one keeps reading", () => {
  const withStatus = (status) => {
    const win = makeWindow();
    const tile = load(win);
    railTile(win, "titan");
    tile.sync({ agentId: "titan", seat: 3, status });
    painting(clientOf(win));
    win.__dataUrl = REAL_SAMPLE;
    win.__imageData = CONTRAST;
    tickOnce(win);
    return { win, tile };
  };

  const idle = withStatus("idle");
  assert.equal(idle.tile.frameFor("titan"), REAL_SAMPLE, "the still landed");
  assert.equal(idle.tile.state().mounted, false, "and the client went: a still by default, not a screen-share");

  const working = withStatus("working");
  assert.equal(working.tile.frameFor("titan"), REAL_SAMPLE);
  assert.equal(working.tile.state().mounted, true, "a working agent keeps a reader so the picture moves");
});

test("an idle agent whose still is already in hand mounts nothing at all", () => {
  const win = makeWindow();
  const tile = load(win);
  win.__store.set(`${tile.limits.IDLE_PREFIX}titan`, REAL_SAMPLE);
  railTile(win, "titan");
  tile.sync({ agentId: "titan", seat: 3, status: "idle" });
  assert.equal(tile.state().mounted, false, "there is a picture; opening a websocket to take the same one again is work for nobody");
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
  tile.state();
  const held = win.__timers.values().next().value;
  const realNow = Date.now;
  Date.now = () => realNow() + 25_000;
  try { held.fn(); } finally { Date.now = realNow; }
  assert.equal(tile.state().mounted, false, "a client that cannot paint is not going to");
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
