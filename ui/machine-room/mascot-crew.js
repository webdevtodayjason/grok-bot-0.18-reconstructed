/*
 * The Titan crew: who is who, and what mood each one is in.
 * ---------------------------------------------------------
 * Pure. No DOM, no adapter, no timers -- so `tests/titan-crew.test.mjs` can evaluate it against a
 * bare stub and mascots.js can stay a thin layer of wiring over it. It is a classic browser script
 * like backgrounds.js beside it, not a module: it hangs one object on `window.TitanCrew`.
 *
 * The roster below mirrors docs/design/titan-mascot-kit/agents.json, which is the kit's own file
 * and the source of truth for names, colours and eye shapes. The test fails if the two drift, so
 * this copy can never quietly become a second opinion. Index 0 is Titan; the twelve after him are
 * the companions, in the kit's order, and that order is also the order they are handed out in.
 *
 * WHERE A CHOICE LIVES. The host's agent profile has no field of its own for this, and it drops
 * any key it does not know (measured on the box 2026-09-06: updateAgent { id, profile } with a
 * `character` key answers 200 and listAgents comes back without it). It does keep `avatarShape`,
 * and it keeps an arbitrary string there rather than only the desktop app's eight shape names --
 * also measured. So a choice is written as `titan:<name>` in avatarShape: namespaced, so it can
 * never be mistaken for one of the desktop app's shapes, and so a shape the desktop app wrote is
 * never mistaken for a crew choice. A partial profile write leaves avatarShape alone, so a rename
 * from any surface does not wipe the choice.
 *
 * WITH NO CHOICE STORED, nobody is left facing a blank. The crew is derived from the roster the
 * host already answers: the oldest agent is Titan, and the rest take companions in the order they
 * were created. An agent the host reports without a createdAt -- an older bundle -- falls back to
 * a companion picked from a hash of its id, stepping past any companion already spoken for.
 */
(function attachTitanCrew(global) {
  "use strict";

  // name / description / mid colour, from agents.json. The mid colour is written to the profile's
  // avatarColor beside the shape, so the desktop app's own avatar for this agent comes up in the
  // same colour instead of arguing with the face the console draws.
  const CREW = [
    { name: "Titan", color: "#00C8F0", blurb: "The familiar face at the centre of your control room." },
    { name: "Scribe", color: "#A88CEB", blurb: "A soft violet silhouette with a thoughtful, half-open eye." },
    { name: "Orbit", color: "#6AABEF", blurb: "A bright blue explorer with an eye shaped for curiosity." },
    { name: "Flux", color: "#51CCAB", blurb: "A fluid mint companion that never quite sits still." },
    { name: "Nova", color: "#F08E87", blurb: "A warm coral spark with a wide, welcoming eye." },
    { name: "Echo", color: "#C59BDC", blurb: "A lilac ripple with a gently tapered eye." },
    { name: "Pip", color: "#EAC66E", blurb: "A sunny little presence with a tall, attentive eye." },
    { name: "Ripple", color: "#65CCC9", blurb: "A cool aqua companion with a flowing outline." },
    { name: "Moss", color: "#A1BF77", blurb: "An easygoing green companion with a relaxed gaze." },
    { name: "Comet", color: "#F5AD70", blurb: "An orange glow with a playful, shifting silhouette." },
    { name: "Wisp", color: "#A0AFE7", blurb: "An airy periwinkle shape with a curious little gaze." },
    { name: "Lumen", color: "#86D0E0", blurb: "A clear sky-blue companion with an open, attentive eye." },
    { name: "Pixel", color: "#E496BE", blurb: "A pink companion with a softly geometric personality." },
  ];

  const SHAPE_PREFIX = "titan:";
  // The two opt-outs. Both are stored choices like any other, not the absence of one: an agent with
  // no stored choice gets a crew face, so "draw the flat mark instead" and "draw the picture I
  // uploaded instead" each have to be sayable rather than inferred.
  const CLASSIC = "classic";
  const UPLOADED = "uploaded";
  const OPTIONS = [CLASSIC, UPLOADED];
  const CELEBRATION_MS = 6000;

  const slugOf = (name) => String(name).toLowerCase();
  const nameIndex = new Map(CREW.map((c, i) => [slugOf(c.name), i]));

  /** The crew index for a name, or -1. Case-insensitive, because the profile is operator-editable. */
  function indexOfCharacter(name) {
    if (typeof name !== "string") return -1;
    const found = nameIndex.get(slugOf(name.trim()));
    return found == null ? -1 : found;
  }

  /** The value written into the profile's avatarShape for a choice. */
  function shapeValueFor(choice) {
    if (OPTIONS.includes(choice)) return `${SHAPE_PREFIX}${choice}`;
    const index = indexOfCharacter(choice);
    if (index < 0) throw new RangeError(`${choice} is not one of the Titan crew`);
    return `${SHAPE_PREFIX}${CREW[index].name}`;
  }

  /**
   * The choice the host is holding for this agent, or null when it holds none. Anything in
   * avatarShape without the prefix belongs to the desktop app's avatar editor and is left alone.
   */
  function storedChoice(agent) {
    const shape = agent == null ? null : agent.avatarShape;
    if (typeof shape !== "string" || !shape.startsWith(SHAPE_PREFIX)) return null;
    const rest = shape.slice(SHAPE_PREFIX.length).trim();
    if (OPTIONS.includes(slugOf(rest))) return slugOf(rest);
    const index = indexOfCharacter(rest);
    return index < 0 ? null : CREW[index].name;
  }

  /** A companion (never Titan) from the agent id, for a host that answers no createdAt. */
  function hashIndex(id) {
    let hash = 0;
    const text = String(id ?? "");
    for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return 1 + (hash % (CREW.length - 1));
  }

  const creationOf = (agent) => (Number.isFinite(Number(agent && agent.createdAt)) ? Number(agent.createdAt) : null);

  /**
   * Who is who, for one instance's roster.
   *
   * Returns a Map of agent id -> { character, index, source, opt }. `source` says how the answer
   * was reached -- "stored" (the host holds it), "first" (Titan), "order" (creation order) or
   * "hash" (no createdAt to order by) -- so a panel can tell the operator which it is looking at
   * rather than implying every face was chosen deliberately. `opt` is null for a character, or
   * "classic" / "uploaded" where the operator asked for something other than a character.
   *
   * Groups take no character: a room draws the faces of its members.
   */
  function assignCrew(agents) {
    const rows = (Array.isArray(agents) ? agents : []).filter((a) => a && a.isGroup !== true && a.id != null);
    // Creation order, with the id as the tiebreak so two agents minted in the same millisecond do
    // not swap faces between two reads of the same roster.
    const ordered = rows.filter((a) => creationOf(a) != null)
      .sort((a, b) => creationOf(a) - creationOf(b) || String(a.id).localeCompare(String(b.id)));
    const unordered = rows.filter((a) => creationOf(a) == null);

    // Titan is the one named Titan if the instance has one, else the oldest agent on it.
    const named = ordered.find((a) => slugOf(String(a.name ?? "")) === "titan")
      ?? unordered.find((a) => slugOf(String(a.name ?? "")) === "titan");
    const first = ordered[0] ?? unordered[0] ?? null;
    const titanId = named ? named.id : (first ? first.id : null);

    const out = new Map();
    const taken = new Set();
    for (const agent of rows) {
      const stored = storedChoice(agent);
      if (stored == null) continue;
      const opted = OPTIONS.includes(stored);
      const index = opted ? -1 : indexOfCharacter(stored);
      if (index >= 0) taken.add(index);
      out.set(agent.id, { character: opted ? null : CREW[index].name, index, source: "stored", opt: opted ? stored : null });
    }

    const step = (i) => (i + 1 > CREW.length - 1 ? 1 : i + 1);
    let cursor = 1;
    const give = (agent, index, source) => {
      taken.add(index);
      out.set(agent.id, { character: CREW[index].name, index, source, opt: null });
    };

    for (const agent of ordered) {
      if (out.has(agent.id)) continue;
      if (agent.id === titanId) { give(agent, 0, "first"); continue; }
      // Skip companions already spoken for, and stop skipping once every one of them is: past that
      // the crew wraps and faces repeat, which is the honest outcome of a 20-agent instance.
      let guard = 0;
      while (taken.has(cursor) && guard < CREW.length - 1) { cursor = step(cursor); guard += 1; }
      give(agent, cursor, "order");
      cursor = step(cursor);
    }
    for (const agent of unordered) {
      if (out.has(agent.id)) continue;
      if (agent.id === titanId) { give(agent, 0, "first"); continue; }
      // The hash is where the walk starts, not where it stops. Two ids can hash to the same
      // companion, and a roster with the same face twice is worse than one whose faces depend on
      // who else is on it -- which is true of the creation-order walk above as well.
      let index = hashIndex(agent.id);
      let guard = 0;
      while (taken.has(index) && guard < CREW.length - 1) { index = step(index); guard += 1; }
      give(agent, index, "hash");
    }
    return out;
  }

  /**
   * The mood one roster record is in. Calm idle, curious mid-turn and curious while the agent waits
   * on a person (the waiting itself is shown by attentionFor, a turn of the face, not a bounce), and
   * excited for a few seconds after a turn lands, which is the only one that needs a clock:
   * `celebratingUntil` is the timestamp the caller got from `celebrationUntil` below.
   */
  function moodFor(record, options) {
    const now = options && Number.isFinite(options.now) ? options.now : Date.now();
    const until = options && Number.isFinite(options.celebratingUntil) ? options.celebratingUntil : 0;
    // A person is wanted: attentive, not bouncing. The turn that asks for them is attentionFor.
    if (record && record.needsYou === true) return "curious";
    if (record && record.status === "working") return "curious";
    if (until > now) return "excited";
    return "calm";
  }

  /**
   * A turn that finished with a reply delivered: working -> ready. A turn that ended in "attention"
   * did not deliver anything (it failed, or it is waiting on a person, which moodFor already reads
   * as excited), so it earns no celebration. Returns 0 when there is nothing to celebrate.
   */
  /**
   * Whether the face should ask for a person: two counterclockwise turns, a rest, and again (Jason,
   * 2026-09-07). Only a record that needs someone earns it; a bounce never leaves the ring for it.
   */
  function attentionFor(record) {
    return Boolean(record && record.needsYou === true);
  }

  function celebrationUntil(previousStatus, record, now, ms) {
    if (previousStatus !== "working") return 0;
    if (!record || record.status !== "ready") return 0;
    return (Number.isFinite(now) ? now : Date.now()) + (Number.isFinite(ms) ? ms : CELEBRATION_MS);
  }

  /** The still the kit ships for a character in a mood, relative to the console's own directory. */
  function stillFor(index, mood) {
    const safe = CREW[index] ? index : 0;
    const state = mood === "curious" || mood === "excited" ? mood : "calm";
    return `assets/characters/${slugOf(CREW[safe].name)}-${state}.png`;
  }

  global.TitanCrew = { attentionFor, CREW, CLASSIC, UPLOADED, OPTIONS, SHAPE_PREFIX, CELEBRATION_MS, indexOfCharacter, shapeValueFor, storedChoice, hashIndex, assignCrew, moodFor, celebrationUntil, stillFor };
})(typeof window !== "undefined" ? window : globalThis);
