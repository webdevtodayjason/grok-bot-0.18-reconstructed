// ui/discover-edge.mjs -- the welcome bar's six steps, each one read from evidence.
//
// DISCOVER-1. Jason, 2026-09-13 07:31, with three Hugging Face screenshots: a "Welcome to Titanium
// Bot" pill in the console header that opens a list of steps with counts and strikethroughs, and a
// bar that fills as the person discovers the product. Post-onboarding; if they skip onboarding the
// steps are still there. Measured, never self-reported; per person; Hide retires it, Settings brings
// it back.
//
// THE ONE RULE THIS FILE IS. A step is ticked because something in this product can be READ saying it
// happened, and never because a page told the relay it did. There is no POST that marks a step done
// and there is no counter this file increments. That is not fastidiousness: a checklist a browser can
// tick is a checklist that tells a customer they have made a voice call when they have not, and the
// first time somebody reads "Make a voice call ✓" on a workspace with no key on it, the whole bar is
// worth nothing. The only thing a person writes here is whether they want to see the bar at all.
//
// WHERE EACH STEP'S EVIDENCE ACTUALLY LIVES, measured before a line of this was written, because
// three of the six are not where the brief guessed they were. docs/DISCOVER-1-REPORT.md carries the
// measurement and the two corrections; this is the short form:
//
//   1. hello    the BOX, getAgentTranscriptTail on Titan's conversation. A person's own message is
//               an entry with kind "message" and role "user" -- gateway-adapter.js:236 is where that
//               is written down ("send-message is the agent speaking; message with role user is the
//               operator"), and it is the only thing in a transcript that a person typed.
//   2. voice    the CONTROL PLANE, voice_sessions, through GET /v1/relay/discover. The brief said cp
//               and the brief was right: the rows are there and nowhere else.
//   3. connect  the BOX, the marketplace's own pair -- listInstalledMcpServers for the servers and
//               listConnectorSecretFields for what the host's 0600 store actually HOLDS for each one
//               (gateway-adapter.js installedConnectorPlugins reads exactly these two, in this
//               order, and its comment records why `stored` and not `fields` is the honest list).
//   4. memory   the BOX, getAgentMemories on the same agent step 1 read.
//   5. screen   THE RELAY, discover.json in this workspace's own state directory. There was no such
//               flag before this wave; the write is one line in the desktop websocket's upgrade in
//               ui/server.mjs, which is the moment the screen is actually opened and the only place
//               in this product that knows it happened.
//   6. pocket   THE RELAY, not the control plane. A device bearer's row lives in the tenant's state
//               directory (ui/auth-device.mjs rule 2, and cp/cli.mjs:1646 says it in one sentence:
//               "a device row lives in the tenant's state directory, not in this container"). The
//               brief said cp device sessions; there is no such table and there cannot be one, for
//               the reason ui/session-token.mjs gives -- the relay must be able to check a bearer
//               with the control plane down.
//
// EVERY READ HAS A BUDGET AND A MISSING READ IS NOT-DONE, NEVER AN ERROR. This is drawn in the window
// bar of a console that is otherwise working. A box that is slow, a control plane that is down, a
// host too old for one of these commands: all of them mean a step this relay could not see, which is
// the same answer as a step that has not happened, and it is drawn as an unticked row rather than as
// a red badge over a product that is fine. The reads run TOGETHER rather than one after another, so
// the whole answer costs one budget and not six.
//
// Nothing here imports anything outside node builtins, because the relay image has no node_modules.
import { chmod, chown, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The six, in the order the brief lists them, which is the order they are drawn in.
 *
 * The labels are HERE and not in the page, for the reason every other label in this relay is: the
 * gate reads the wire and the console draws what the wire says, so there is one copy of each sentence
 * and a change to one of them cannot leave the two surfaces disagreeing.
 *
 * `of` is what would tick the step. It is 1 on all six because one of anything is discovery -- the
 * bar is not a quota -- and it is on the wire anyway so the dropdown can draw "1 of 1" beside a count
 * without the page inventing the denominator.
 */
export const DISCOVER_STEPS = [
  { id: "hello", label: "Say hello to Titan", of: 1 },
  { id: "voice", label: "Make a voice call", of: 1 },
  { id: "connect", label: "Connect an app", of: 1 },
  { id: "memory", label: "Give Titan a memory", of: 1 },
  { id: "screen", label: "Watch his screen", of: 1 },
  { id: "pocket", label: "Put him in your pocket", of: 1 },
];

export const DISCOVER_STEP_IDS = DISCOVER_STEPS.map((step) => step.id);

/** The brief's number. One and a half seconds per read, and what has not answered by then is absent. */
export const DISCOVER_READ_BUDGET_MS = 1_500;

/**
 * How far back step 1 looks for a person's own message.
 *
 * A TAIL AND NOT THE WHOLE HISTORY, because getAgentTranscriptTail is the bounded read the console
 * itself uses (gateway-adapter.js TAIL_LIMIT is 150) and reading a year of conversation to answer a
 * checkbox is the kind of thing that makes a console slow for everybody. 200 entries measured at
 * roughly 1,535 bytes per five entries (docs/APPS.md) is about 60 KB, which fits the budget with room.
 *
 * THE COST IS HONEST AND IS WRITTEN DOWN: a conversation whose last 200 entries are all the agent's
 * own work would read as "no user message", and the step would untick. In practice a turn is bounded
 * by the person who started it, so 200 entries covers many turns; and an unticked step on a bar that
 * is about discovering the product is a wrong answer nobody acts on, which is the right way round
 * from a ticked step nobody earned.
 */
export const DISCOVER_TAIL_LIMIT = 200;

/**
 * How many connectors step 3 will ask about. listConnectorSecretFields is one call per server, so a
 * box with fifty connectors would otherwise be fifty calls inside one budget. They go out together
 * and the first credential found is enough for the tick; the cap bounds the fan-out, not the answer.
 */
export const DISCOVER_CONNECTOR_FANOUT = 16;

/**
 * The desktop flag's file and its bound.
 *
 * Two hundred people per workspace, oldest first out, which is the bound ui/voice-edge.mjs puts on
 * the talk-mode map and for the same reason: a map that grows by one for every person who ever opens
 * a screen is a file somebody eventually finds at a gigabyte. The cost of falling off is that that
 * person's welcome bar unticks one row, which is a cost worth paying and not worth a table.
 */
export const DISCOVER_STATE_FILE = "discover.json";
export const DISCOVER_DESKTOP_SUBS = 200;

const str = (value) => (typeof value === "string" ? value : "");
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const whole = (value) => Math.max(0, Math.trunc(num(value)));

/** The sentinel a read that did not answer inside its budget resolves to. Never thrown, never logged
 *  as an error: see the header. It is distinguishable from 0 so the answer can say which happened. */
const MISSING = Symbol("discover.read.missing");

/**
 * One read, bounded.
 *
 * The signal is handed DOWN as well as raced, so a fetch that misses its budget is actually aborted
 * rather than left holding a socket until the box gets round to it. A dep that ignores the signal
 * still cannot hold the answer up, because the race settles either way.
 */
export async function withBudget(run, { budgetMs = DISCOVER_READ_BUDGET_MS, onMiss = null } = {}) {
  const controller = new AbortController();
  let timer = null;
  // NOT unref'd, and that is deliberate. The budget is the only thing that ends a read which never
  // settles, so a timer the event loop is allowed to walk away from is a read with no budget at all:
  // the process would drain, the race would still be pending, and the answer would never be built.
  // It cannot leak -- the finally below clears it -- and it lives for at most one budget.
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { try { controller.abort(); } catch { /* already gone */ } resolve(MISSING); }, budgetMs);
  });
  try {
    // A THROW AND A TIMEOUT ARE THE SAME ANSWER, and only the throw is offered to onMiss. A read that
    // ran out of time is the ordinary shape of a busy box and logging one per poll would be a log
    // nobody can read; a read that threw is usually a command this host does not have, which is worth
    // one line the first time somebody goes looking.
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)).catch((error) => {
        if (onMiss != null) onMiss(error);
        return MISSING;
      }),
      deadline,
    ]);
  } finally {
    if (timer != null) clearTimeout(timer);
  }
}

/** True when a read answered at all. Exported because the tests assert on the distinction. */
export const answered = (value) => value !== MISSING;
export const MISSING_READ = MISSING;

/**
 * The roster, whatever shape the host answers in. MEASURED on grok-bot-local-vm 2026-09-10 and
 * written down in ui/voice-edge.mjs rosterOf: POST /api/listAgents answers a BARE ARRAY, not
 * `{agents:[...]}`. Reading only the wrapped shape is how a box with nine bots on it reads as empty.
 */
export function rosterOf(answer) {
  if (Array.isArray(answer)) return answer;
  return Array.isArray(answer?.agents) ? answer.agents : [];
}

/**
 * Which conversation is Titan's.
 *
 * The SAME chain ui/voice-edge.mjs resolveVoiceAgent walks, deliberately: a bot called Titan, else
 * the first bot on the roster, else nobody. The voice lands on that bot and the mail lands on that
 * bot (ui/mail-edge.mjs), so the welcome bar reading a different one would tick "Say hello to Titan"
 * off a conversation the person has never seen named Titan. Groups are never it.
 *
 * It is not imported from voice-edge because that module is four thousand lines of realtime bridge
 * and this file is reached on every console load; the chain is six lines and the two are pinned
 * together by a test rather than by an import.
 */
export function titanOf(agents) {
  const roster = rosterOf(agents).filter((agent) => agent != null && agent.isGroup !== true && agent.kind !== "room");
  const localpart = (name) => str(name).toLowerCase().replace(/[\s-]+/g, "").replace(/[^a-z0-9._]+/g, "");
  const named = roster.find((agent) => localpart(agent.name) === "titan");
  const chosen = named ?? roster[0] ?? null;
  return chosen == null ? { id: "", name: "" } : { id: String(chosen.id ?? ""), name: str(chosen.name) };
}

/**
 * How many of a person's own messages are in this window.
 *
 * `kind: "message"` with `role: "user"` and nothing else. A send-message entry is the AGENT speaking
 * (gateway-adapter.js:236), a tool row is machinery, and a turn-failed line is the host's. Counting
 * any of those would tick "say hello" for a workspace where the only thing that ever happened was an
 * automation firing on a schedule.
 */
export function userMessagesIn(entries) {
  const list = Array.isArray(entries) ? entries : (Array.isArray(entries?.entries) ? entries.entries : []);
  let seen = 0;
  for (const entry of list) if (entry?.kind === "message" && entry?.role === "user") seen += 1;
  return seen;
}

/**
 * How many connectors the host's own store holds a credential for.
 *
 * `stored` and NOT `fields`. The two lists answer two different questions and the difference is a
 * real bug that shipped: `fields` is the union of what MAY be stored and the env keys an entry leaves
 * empty, so a freshly added connector with no key in it comes back with a field name on it. Only a
 * name the host reports HOLDING counts, which is the rule gateway-adapter.js:1646 records after the
 * TinyFish card claimed a value nobody had entered.
 */
export function connectorsWithCredential(rows) {
  let held = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const stored = Array.isArray(row?.stored) ? row.stored : (Array.isArray(row?.fields?.stored) ? row.fields.stored : []);
    if (stored.map((one) => str(one?.name ?? one)).filter((one) => one.length > 0).length > 0) held += 1;
  }
  return held;
}

/** Rows out of getAgentMemories, whatever shape a host answers in. */
export function memoriesIn(answer) {
  if (Array.isArray(answer)) return answer.length;
  if (Array.isArray(answer?.memories)) return answer.memories.length;
  if (Array.isArray(answer?.facts)) return answer.facts.length;
  return 0;
}

// ---- the relay's own flag: this person opened the desktop once ---------------------------------
//
// It is a FILE and not a control-plane row on purpose. The write happens inside a websocket upgrade
// (ui/server.mjs), which is the hottest path in this relay and the one path that must not learn how
// to wait for another service; and a workspace with no control plane at all -- every single-box
// install and every gate on a laptop -- has to tick this step like everybody else.

export function normalizeDiscoverState(raw) {
  const value = raw == null || typeof raw !== "object" || Array.isArray(raw) ? {} : raw;
  const desktop = {};
  const source = value.desktop == null || typeof value.desktop !== "object" || Array.isArray(value.desktop) ? {} : value.desktop;
  for (const [sub, at] of Object.entries(source)) {
    if (typeof sub !== "string" || sub.length > 256) continue;
    const when = whole(at);
    if (when <= 0) continue;
    desktop[sub] = when;
  }
  const keys = Object.keys(desktop);
  if (keys.length <= DISCOVER_DESKTOP_SUBS) return { desktop };
  // Oldest first out, by the instant each was recorded rather than by insertion order: a JSON object
  // read back from disk does not promise the order it was written in for every key shape.
  const kept = {};
  for (const sub of keys.sort((a, b) => desktop[b] - desktop[a]).slice(0, DISCOVER_DESKTOP_SUBS)) kept[sub] = desktop[sub];
  return { desktop: kept };
}

/**
 * The forgiving read, for the WRITE path. A file that is missing, unreadable or not JSON reads as an
 * empty state, so a person opening the desktop always gets their flag recorded. The cost is that a
 * corrupt file loses the rows in it, which is the right way round: the alternative is a console that
 * stops recording screens because of a file nobody can fix.
 */
export async function readDiscoverState(file) {
  try { return normalizeDiscoverState(JSON.parse(await readFile(file, "utf8"))); }
  catch { return { desktop: {} }; }
}

/**
 * The strict read, for the ANSWER.
 *
 * ENOENT IS AN ANSWER: a workspace nobody has ever opened a screen on has no file, and reading that
 * as "no" is a measurement rather than a guess. Anything else -- a permission, a directory where a
 * file should be, half a file -- is a read that did not happen, and the step has to be drawn as
 * unreadable rather than as a confident no. Both end up unticked; only one of them is honest about
 * why, and the difference is what stops a broken volume from looking like a person who never pressed
 * the button.
 */
export async function readDesktopFlags(file) {
  let raw;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") return { desktop: {} };
    throw error;
  }
  return normalizeDiscoverState(JSON.parse(raw));
}

/** Written the way ui/voice-edge.mjs writes its own: 0600, owned like the parent, renamed over. */
export async function writeDiscoverState(next, { file, ownLikeParent = null } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(normalizeDiscoverState(next), null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  if (ownLikeParent != null) await ownLikeParent(tmp);
  else { try { const parent = await stat(path.dirname(file)); await chown(tmp, parent.uid, parent.gid); } catch { /* not ours to own */ } }
  await rename(tmp, file);
}

// ---- the answer ---------------------------------------------------------------------------------

/**
 * What GET /discover answers, and the ONE place the shape is built.
 *
 * pct is over STEPS and not over counts: six steps, each worth a sixth, rounded. A bar weighted by
 * how many memories somebody wrote would move when nothing was discovered, which is the opposite of
 * what the bar is for.
 */
export function discoverShape(measured, { hidden = false } = {}) {
  const steps = DISCOVER_STEPS.map((step) => {
    const found = measured?.[step.id] ?? null;
    const count = whole(found?.count);
    // `read` false is the honest third state: not-done because nothing could be read, as against
    // not-done because it has not happened. It is never used to draw an error; the console may use
    // it for a tooltip and the gate asserts on it.
    const read = found?.read === true;
    return { id: step.id, label: step.label, done: read && count >= step.of, count, of: step.of, read };
  });
  const done = steps.filter((step) => step.done).length;
  return { steps, done, of: steps.length, pct: Math.round((done / steps.length) * 100), hidden: hidden === true };
}

// ---- the edge -----------------------------------------------------------------------------------

/**
 * Everything this edge needs, injected, so the whole of it is testable without a box, a control plane
 * or a docker daemon. Nothing is reached for: the relay hands over the three seams it already has
 * (the gateway call, the device store, the tenant's own state file) and nothing more.
 */
export function createDiscoverEdge({
  gatewayCall,
  cpRead = null,
  cpWrite = null,
  devicesFor = () => [],
  stateFileFor,
  ownLikeParent = null,
  readBody = null,
  fail = null,
  budgetMs = DISCOVER_READ_BUDGET_MS,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const call = (t, command, args, signal) => Promise.resolve(gatewayCall(t, command, args, { signal }));

  /** A step that could not be read. Its own helper so the three words are written once. */
  const missed = () => ({ read: false, count: 0 });
  const counted = (count) => ({ read: true, count: whole(count) });

  // ---- the six reads ---------------------------------------------------------------------------

  /** Steps 1 and 4 share one roster read: they are two questions about the same agent, and asking
   *  listAgents twice inside one answer is a second copy of an eleven kilobyte list for nothing. */
  async function readTitan(t) {
    const answer = await withBudget((signal) => call(t, "listAgents", {}, signal),
      { budgetMs, onMiss: (error) => error && log(`discover ${t.slug}: the roster could not be read (${str(error?.message) || error})`) });
    return answered(answer) ? titanOf(answer) : null;
  }

  async function readHello(t, titan) {
    if (titan == null || titan.id.length === 0) return missed();
    const answer = await withBudget((signal) => call(t, "getAgentTranscriptTail", { id: titan.id, limit: DISCOVER_TAIL_LIMIT }, signal), { budgetMs });
    return answered(answer) ? counted(userMessagesIn(answer)) : missed();
  }

  async function readMemory(t, titan) {
    if (titan == null || titan.id.length === 0) return missed();
    const answer = await withBudget((signal) => call(t, "getAgentMemories", { id: titan.id }, signal), { budgetMs });
    return answered(answer) ? counted(memoriesIn(answer)) : missed();
  }

  /**
   * The marketplace's own pair, inside ONE budget: the servers, then what the host's store holds for
   * each. A host too old for either command answers nothing and the step is simply unticked, which is
   * the same fallback the Marketplace panel itself takes for a box without the connector plane.
   */
  async function readConnect(t) {
    const answer = await withBudget(async (signal) => {
      const installed = await call(t, "listInstalledMcpServers", {}, signal);
      const servers = (Array.isArray(installed) ? installed : (Array.isArray(installed?.servers) ? installed.servers : []))
        .map((row) => str(row?.name ?? row?.id))
        .filter((name) => name.length > 0)
        .slice(0, DISCOVER_CONNECTOR_FANOUT);
      if (servers.length === 0) return [];
      // A connector that is installed but not in connectors.json genuinely throws here -- an account
      // server has no stdio spec and no secret fields -- and a throw for one must not lose the
      // answer for the rest, which is the same catch gateway-adapter.js puts on this exact call.
      return await Promise.all(servers.map((server) =>
        call(t, "listConnectorSecretFields", { server }, signal).catch(() => null)));
    }, { budgetMs });
    return answered(answer) ? counted(connectorsWithCredential(answer)) : missed();
  }

  /** The control plane's two facts, in one round trip. See cp/server.mjs for why they share one. */
  async function readControlPlane(t, sub) {
    if (cpRead == null) return null;
    const answer = await withBudget((signal) => Promise.resolve(cpRead({ slug: t.slug, sub, signal })), { budgetMs });
    return answered(answer) && answer != null && typeof answer === "object" ? answer : null;
  }

  /** This person's own desktop flag, out of this workspace's own state directory. */
  async function readScreen(t, sub) {
    const file = str(stateFileFor?.(t));
    if (file.length === 0) return missed();
    const answer = await withBudget(() => readDesktopFlags(file), { budgetMs });
    if (!answered(answer)) return missed();
    return counted(whole(answer.desktop?.[sub]) > 0 ? 1 : 0);
  }

  /**
   * This person's live device bearers. Synchronous on the relay (a file behind an mtime-gated cache)
   * and still given a budget, because a dep is a dep and a slow disk is a slow disk.
   *
   * REVOKED ROWS DO NOT COUNT. ui/auth-device.mjs keeps a revoked row so the id cannot be reissued,
   * and a person who has revoked every phone they own does not have Titan in their pocket.
   */
  async function readPocket(t, sub) {
    const answer = await withBudget(() => Promise.resolve(devicesFor(t, sub)), { budgetMs });
    if (!answered(answer)) return missed();
    const rows = Array.isArray(answer) ? answer : [];
    return counted(rows.filter((row) => row != null && whole(row.revokedAt) === 0).length);
  }

  /** Every read, together. One budget for the whole answer rather than six in a row. */
  async function read({ t, sub = "" }) {
    const who = str(sub);
    const [titan, connect, plane, screen, pocket] = await Promise.all([
      readTitan(t), readConnect(t), readControlPlane(t, who), readScreen(t, who), readPocket(t, who),
    ]);
    const [hello, memory] = await Promise.all([readHello(t, titan), readMemory(t, titan)]);
    return discoverShape({
      hello,
      // A relay with no control plane -- every single-box install -- has nowhere to read a voice call
      // from, so the step is unreadable rather than zero. The same is true of an outage, and they are
      // deliberately the same answer: neither one is evidence that no call was made.
      voice: plane == null ? missed() : counted(plane.voiceCalls),
      connect,
      memory,
      screen,
      pocket,
    }, { hidden: plane?.hidden === true });
  }

  /**
   * The desktop pane, recorded at the moment it opens.
   *
   * Called from the websocket upgrade, never awaited by it, and it can never fail that upgrade: a
   * person whose screen would not open because a checklist could not be written would be the worst
   * trade in this wave. A failed write is one log line and an unticked row.
   *
   * The read-modify-write is not locked. Two upgrades in the same millisecond can lose one of two
   * entries, and the cost of that is one person's row unticking until they next open the screen.
   */
  async function noteDesktop({ t, sub = "" }) {
    const file = str(stateFileFor?.(t));
    if (file.length === 0) return false;
    try {
      const state = await readDiscoverState(file);
      const who = str(sub);
      if (whole(state.desktop?.[who]) > 0) return false;
      await writeDiscoverState({ desktop: { ...state.desktop, [who]: now() } }, { file, ownLikeParent });
      return true;
    } catch (error) {
      log(`discover ${t?.slug ?? "?"}: the desktop flag could not be written (${str(error?.message) || error})`);
      return false;
    }
  }

  /** POST /discover/hide and /discover/show, which are one write with two spellings. */
  async function setHidden({ t, sub = "" }, hidden) {
    if (cpWrite == null) return { ok: false, why: "this console has no control plane, so there is nowhere to keep that choice" };
    const answer = await withBudget((signal) => Promise.resolve(cpWrite({ slug: t.slug, sub: str(sub), hidden: hidden === true, signal })), { budgetMs });
    if (!answered(answer) || answer === false) {
      return { ok: false, why: "that choice did not reach the control plane, so it was not saved" };
    }
    return { ok: true, hidden: hidden === true };
  }

  const send = (res, status, body) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  /**
   * The three routes. Mounted behind the session in ui/server.mjs exactly as /voice/settings is, so
   * the tenant and the person are already resolved when this is reached and nothing here re-derives
   * either of them.
   */
  async function handle(req, res, url, { t, sub = "" } = {}) {
    const method = str(req?.method) || "GET";
    if (url.pathname === "/discover") {
      if (method !== "GET") return refuse(res, 405, "read the welcome bar with GET");
      return send(res, 200, await read({ t, sub }));
    }
    const wants = url.pathname === "/discover/hide" ? true : url.pathname === "/discover/show" ? false : null;
    if (wants == null) return refuse(res, 404, `not found: ${method} ${url.pathname}`);
    if (method !== "POST") return refuse(res, 405, "hide and show are POSTs");
    // The body is DRAINED and ignored. Both routes are a verb in their own path and there is nothing
    // a caller could put in a body that would change what either of them does; leaving a body unread
    // is what turns a refusal into the proxy's 502 (see drainThenEnd in ui/server.mjs).
    if (readBody != null) await readBody(req, 4 * 1024).catch(() => "");
    const answer = await setHidden({ t, sub }, wants);
    if (!answer.ok) return refuse(res, 503, answer.why);
    // THE FLAG AND NOT THE WHOLE BAR. Re-reading six steps to answer a button press would put a
    // second round of box reads on a click whose whole effect is that the pill goes away, and the
    // page already holds the steps it drew. A caller that wants them asks GET /discover.
    return send(res, 200, { ok: true, hidden: wants });
  }

  function refuse(res, status, message) {
    if (fail != null) return fail(res, status, message);
    return send(res, status, { error: message });
  }

  return { handle, read, setHidden, noteDesktop };
}
