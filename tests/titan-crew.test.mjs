// AVATAR-1. The console draws every agent as one of the Titan crew on a live canvas, so three
// answers have to be pinned: which character an agent gets, what mood it is in, and that the copy
// of the kit the console loads is still the kit.
//
// The crew list in ui/machine-room/mascot-crew.js is a mirror of the kit's own agents.json. A
// mirror that can drift is a second opinion, so the first test here diffs them; the second diffs
// the vendored titan-mascot.js against the kit byte for byte.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// mascot-crew.js and backgrounds.js are classic browser scripts, not modules: each hangs one
// object on the window it is handed. Evaluating them against a stub is how the browser loads them,
// so the test exercises the same file the page does rather than a module build of it.
function loadBrowserScript(relativePath, stub = {}) {
  const source = readFileSync(path.join(repoRoot, relativePath), "utf8");
  new Function("window", source)(stub);
  return stub;
}
const crew = loadBrowserScript("ui/machine-room/mascot-crew.js").TitanCrew;

const agent = (id, createdAt, extra = {}) => ({ id, name: id, createdAt, isGroup: false, avatarShape: null, ...extra });

test("the console's crew list is the kit's agents.json, name for name and colour for colour", async () => {
  const kit = JSON.parse(await readFile(path.join(repoRoot, "docs/design/titan-mascot-kit/agents.json"), "utf8"));
  assert.equal(crew.CREW.length, kit.length, "the crew is 13: Titan plus twelve companions");
  assert.deepEqual(crew.CREW.map((c) => c.name), kit.map((c) => c.name));
  // colors[1] is the mid stop of the body gradient, and the one written to the profile's
  // avatarColor so the desktop app's avatar matches the face the console draws.
  assert.deepEqual(crew.CREW.map((c) => c.color.toUpperCase()), kit.map((c) => c.colors[1].toUpperCase()));
  assert.equal(crew.CREW[0].name, "Titan", "variant 0 is Titan, on the site and here");
});

test("the vendored titan-mascot.js is the kit's file, byte for byte", async () => {
  const [kit, vendored] = await Promise.all([
    readFile(path.join(repoRoot, "docs/design/titan-mascot-kit/titan-mascot.js")),
    readFile(path.join(repoRoot, "ui/machine-room/assets/titan-mascot.js")),
  ]);
  assert.ok(kit.equals(vendored), "ui/machine-room/assets/titan-mascot.js has drifted from the kit");
});

test("the oldest agent is Titan and the rest take companions in creation order", () => {
  const map = crew.assignCrew([agent("c", 300), agent("a", 100), agent("b", 200)]);
  assert.equal(map.get("a").character, "Titan");
  assert.equal(map.get("a").source, "first");
  assert.equal(map.get("b").character, crew.CREW[1].name);
  assert.equal(map.get("c").character, crew.CREW[2].name);
  assert.equal(map.get("b").source, "order");
});

test("an agent actually named Titan is Titan even when it is not the oldest", () => {
  const map = crew.assignCrew([agent("old", 100), { ...agent("new", 900), name: "titan" }]);
  assert.equal(map.get("new").character, "Titan");
  assert.notEqual(map.get("old").character, "Titan");
});

test("groups take no character; a room draws its members", () => {
  const map = crew.assignCrew([agent("a", 100), { ...agent("room", 200), isGroup: true }]);
  assert.equal(map.has("room"), false);
  assert.equal(map.get("a").character, "Titan");
});

test("the crew wraps when it runs out, rather than leaving the extras blank", () => {
  // One Titan plus twenty companions: twelve distinct faces, then the walk comes round again.
  const roster = Array.from({ length: 21 }, (_, i) => agent(`a${i}`, 100 + i));
  const map = crew.assignCrew(roster);
  assert.equal(map.size, 21, "every agent gets a face");
  const companions = roster.slice(1).map((a) => map.get(a.id).character);
  assert.equal(new Set(companions.slice(0, 12)).size, 12, "the first twelve companions are all different");
  assert.equal(companions[12], companions[0], "the thirteenth wraps to the first companion again");
  assert.equal(companions.includes("Titan"), false, "Titan is never handed out as a companion");
});

test("a stored choice wins over creation order, and the walk steps around it", () => {
  const map = crew.assignCrew([
    agent("a", 100),
    agent("b", 200, { avatarShape: "titan:Pixel" }),
    agent("c", 300),
    agent("d", 400),
  ]);
  assert.equal(map.get("b").character, "Pixel");
  assert.equal(map.get("b").source, "stored");
  // c and d take the walk's next free companions and neither of them is the one b is holding.
  assert.equal(map.get("c").character, crew.CREW[1].name);
  assert.equal(map.get("d").character, crew.CREW[2].name);
  assert.equal([map.get("c").character, map.get("d").character].includes("Pixel"), false);
});

test("a stored choice can override Titan, and can be the classic mark", () => {
  const map = crew.assignCrew([agent("a", 100, { avatarShape: "titan:classic" }), agent("b", 200, { avatarShape: "titan:Titan" })]);
  assert.equal(map.get("a").classic, true);
  assert.equal(map.get("a").character, null);
  assert.equal(map.get("b").character, "Titan");
});

test("a shape the desktop app wrote is not read as a crew choice", () => {
  for (const shape of ["blob", "pebble", "squircle", "", null, "titan:Nobody"]) {
    assert.equal(crew.storedChoice({ avatarShape: shape }), null, `avatarShape ${JSON.stringify(shape)} is not a crew choice`);
  }
  assert.equal(crew.storedChoice({ avatarShape: "titan:Moss" }), "Moss");
  assert.equal(crew.storedChoice({ avatarShape: "titan:moss" }), "Moss", "the profile is operator-editable, so the read is case-insensitive");
  assert.equal(crew.shapeValueFor("Moss"), "titan:Moss");
  assert.equal(crew.shapeValueFor(crew.CLASSIC), "titan:classic");
  assert.throws(() => crew.shapeValueFor("Nobody"), RangeError);
});

test("an agent the host reports without a createdAt falls back to a stable hash, never to Titan", () => {
  const first = crew.assignCrew([agent("anchor", 100), agent("legacy", undefined)]);
  const again = crew.assignCrew([agent("anchor", 100), agent("legacy", undefined)]);
  assert.equal(first.get("legacy").source, "hash");
  assert.equal(first.get("legacy").character, again.get("legacy").character, "the same id gets the same face every read");
  assert.notEqual(first.get("legacy").character, "Titan");
  // With nothing but createdAt-less agents, the first one still has to be somebody's Titan.
  const none = crew.assignCrew([agent("only", undefined)]);
  assert.equal(none.get("only").character, "Titan");
});

test("mood follows the status the roster already paints", () => {
  const now = 1_000_000;
  assert.equal(crew.moodFor({ status: "ready" }, { now }), "calm");
  assert.equal(crew.moodFor({ status: "working" }, { now }), "curious");
  assert.equal(crew.moodFor({ status: "attention", needsYou: true }, { now }), "excited");
  // A failed turn is "attention" without needsYou. That is not a celebration and not a question.
  assert.equal(crew.moodFor({ status: "attention", needsYou: false }, { now }), "calm");
  // needsYou outranks a turn still running, because the person is the one being waited on.
  assert.equal(crew.moodFor({ status: "working", needsYou: true }, { now }), "excited");
});

test("a delivered reply is excited for six seconds and then calm again", () => {
  const now = 1_000_000;
  const until = crew.celebrationUntil("working", { status: "ready" }, now);
  assert.equal(until, now + 6000);
  assert.equal(crew.moodFor({ status: "ready" }, { now: now + 5999, celebratingUntil: until }), "excited");
  assert.equal(crew.moodFor({ status: "ready" }, { now: now + 6000, celebratingUntil: until }), "calm");
  // Nothing to celebrate: the agent was not running, or the turn did not land a reply.
  assert.equal(crew.celebrationUntil("ready", { status: "ready" }, now), 0);
  assert.equal(crew.celebrationUntil("working", { status: "attention" }, now), 0);
  assert.equal(crew.celebrationUntil("working", { status: "working" }, now), 0);
});

test("every crew member has the three stills the kit ships", async () => {
  for (let i = 0; i < crew.CREW.length; i += 1) {
    for (const mood of ["calm", "curious", "excited"]) {
      const rel = crew.stillFor(i, mood);
      assert.equal(rel, `assets/characters/${crew.CREW[i].name.toLowerCase()}-${mood}.png`);
      await readFile(path.join(repoRoot, "ui/machine-room", rel));
    }
  }
  assert.equal(crew.stillFor(0, "nonsense"), "assets/characters/titan-calm.png", "an unknown mood shows the calm still");
});

test("Titan Nebula is the background a fresh browser opens on", () => {
  // No document on the stub: every DOM path is a no-op and the two constants are what is left.
  const globals = loadBrowserScript("ui/machine-room/backgrounds.js", { document: undefined, localStorage: { getItem: () => null, setItem: () => {} } });
  assert.equal(globals.__machineRoomBackgrounds.DEFAULT_CHOICE, "titan-nebula");
  const ids = globals.__machineRoomBackgrounds.BUILT_IN.map((b) => b.id);
  assert.ok(ids.includes("titan-nebula"), "the nebula is in the picker");
  assert.ok(ids.includes("original"), "and the handoff's own plate is still offered");
});
