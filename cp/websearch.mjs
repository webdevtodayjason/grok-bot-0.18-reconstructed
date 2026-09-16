// cp/websearch.mjs -- BASELINE-1 piece 1: web search for every tenant, from the control plane.
//
// THE MEASUREMENT THIS EXISTS FOR, taken on the R750 2026-09-15. Ten workspaces. Three boxes carried
// a TinyFish section in connector-env-secrets.json (demo, titanium, richard-avery), each holding the
// operator's own 44-character key and no endpoints, so each was calling TinyFish's own hosts on one
// shared credential. The other seven carried no connector-env-secrets.json at all, and on those
// every WebSearch a customer asked for answered "No web search service is set up on this machine".
//
// The metering proxy has had per-tenant /tinyfish/fetch and /tinyfish/search pass-throughs since
// PROXY-1, and the host has read its credential and its two endpoints out of one 0600 file since the
// same wave. The piece that never existed is the writer: the only way to put those three values in a
// box was a person with a shell inside the container. So this is the writer, and it goes through the
// box's own gateway (BASELINE-1 added getWebSearchRoute and setWebSearchRoute), which means the
// operator and an agent can both run it and neither needs a shell on the server.
//
// THREE RULES IT KEEPS, and each one is a measured failure somewhere in this repo's history.
//
//  1. A DOOR WITH NO KEY BEHIND IT IS NOT A FEATURE. Measured on the R750 on 2026-09-08 and again on
//     2026-09-15: PROXY_TINYFISH_KEY_1 and PROXY_TINYFISH_KEY_2 are set as names and hold zero
//     characters, so both pass-throughs serve with an empty x-api-key. Pointing a customer's box at
//     them would take a box that says "nothing is set up here", which is true and actionable, and
//     give it a box that fails upstream while booking a metered request, which is neither. So the
//     proxy is asked first and nothing is written when its TinyFish doors are empty.
//  2. ONE WORKSPACE AT A TIME, and the next one only after the last one is proved. --all is a loop
//     over the same single-tenant path, not a fan-out.
//  3. NOTHING IS WRITTEN THAT CANNOT BE PROVED, AND NOTHING IS PROVED BY ASSERTION. Every credential
//     in this file travels as a length and twelve characters of its sha256, the same evidence shape
//     `proxy migrate` uses, so the output is safe to paste into a ticket.
//
// Everything here takes its I/O as an option so a test can drive the whole path with a fake box, a
// fake proxy and an invented key, which is what tests/cp-websearch.test.mjs does.

import { createHash } from "node:crypto";

/** The section in connector-env-secrets.json the host's route resolver reads. */
export const WEB_SEARCH_SERVER = "tinyfish";

/**
 * The proxy's two pass-through paths.
 *
 * PINNED IN THREE PLACES and they may not disagree: the proxy's own config mounts them, the host
 * names them in source/host/extensions/inference/tinyfish-route.ts as PROXY_TINYFISH_FETCH_PATH and
 * PROXY_TINYFISH_SEARCH_PATH, and this file writes them into boxes. tests/cp-websearch.test.mjs
 * reads the host's constants out of the source and fails if these two drift from them, because a
 * control plane writing a path the proxy does not mount is a 404 on every customer's first question.
 */
export const PROXY_TINYFISH_FETCH_PATH = "/tinyfish/fetch";
export const PROXY_TINYFISH_SEARCH_PATH = "/tinyfish/search";

/** A credential by its hash, never by its value. Everything printed about a key goes through here. */
export const sha12 = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex").slice(0, 12);

/**
 * Where a box dials, given this control plane's proxy address.
 *
 * `config.proxyUrl` already has a trailing /v1 stripped by loadConfig, which is one of PROXY-1's six
 * live defects: every mint was going to /v1/key/generate and every box to /v1/v1 before that strip
 * landed. Stripping again here is cheap and means this function is right whatever it is handed.
 */
export function webSearchEndpointsFor(proxyUrl) {
  const base = String(proxyUrl ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  if (base.length === 0) return null;
  return {
    fetchEndpoint: `${base}${PROXY_TINYFISH_FETCH_PATH}`,
    searchEndpoint: `${base}${PROXY_TINYFISH_SEARCH_PATH}`,
  };
}

/**
 * Whether the proxy's TinyFish doors have a credential behind them.
 *
 * The same question `tenantRoutesFor` in cp/proxy.mjs asks, with the opposite answer on the
 * unreadable case, and the asymmetry is deliberate. That function decides whether to LEAVE a door on
 * a key a customer already has, so a proxy that will not answer is no reason to take a working door
 * away mid-turn. This one decides whether to WRITE a new door into a customer's box, and writing a
 * door nobody could confirm is how a fleet ends up pointed at something that 401s.
 */
export function proxyTinyFishState(passThrough) {
  if (passThrough?.ok !== true) {
    return { ok: false, why: `the proxy could not be asked what it carries (${passThrough?.why ?? "no answer"}), so nothing was written` };
  }
  const rows = Array.isArray(passThrough.rows) ? passThrough.rows : [];
  const tinyfish = rows.filter((row) => String(row?.path ?? "").startsWith("/tinyfish/"));
  if (tinyfish.length === 0) {
    return { ok: false, why: "this proxy mounts no /tinyfish/ pass-through at all, so there is nothing to point a box at" };
  }
  // content-type is not a credential, which is why a row holding only that one fails this.
  const carries = (row) => Object.entries(row?.headerSet ?? {})
    .some(([name, has]) => has === true && String(name).toLowerCase() !== "content-type");
  const live = tinyfish.filter(carries).map((row) => String(row.path));
  const wanted = [PROXY_TINYFISH_FETCH_PATH, PROXY_TINYFISH_SEARCH_PATH];
  const dead = wanted.filter((path) => !live.includes(path));
  if (dead.length > 0) {
    return {
      ok: false,
      why: `the proxy serves ${dead.join(" and ")} with an empty credential header, so a box pointed at it would fail upstream on every question and book a metered request doing it`,
      fix: "set PROXY_TINYFISH_KEY_1 on the proxy service to the operator's TinyFish key and recreate it, then run this again",
    };
  }
  return { ok: true, paths: live };
}

/**
 * What to do about one workspace, given what its box says it has and what it should have.
 *
 * `route` is the box's own answer to getWebSearchRoute. `key` is that workspace's virtual key at the
 * proxy. Nothing in here does any I/O, so every branch is a case in the suite rather than a thing
 * somebody has to arrange a box to see.
 */
export function webSearchPlan({ slug, route, key, endpoints }) {
  const where = String(slug ?? "this workspace");
  if (endpoints == null) {
    return { action: "stop", why: "this control plane has no proxy address (CP_PROXY_URL is not set), so there is nowhere to point a box" };
  }
  if (key == null || String(key).length === 0) {
    return { action: "stop", why: `${where} has no key at the proxy yet; run \`proxy mint ${where}\` first` };
  }
  if (route == null) {
    return { action: "stop", why: `${where}'s box could not be asked what it has, so nothing was written` };
  }
  // A box running the TinyFish connector itself already answers, and the connector wins over the
  // REST route in resolveWebFallback whatever this file writes. Writing anyway would put a second
  // credential in a box for a route that never runs, which is a credential nobody is watching.
  //
  // IT IS NOT A CLEAN PASS, and the line says so. Measured on the R750 2026-09-15: demo, titanium
  // and richard-avery all run this connector, so all three answer web questions today on the
  // OPERATOR's credential rather than on their own, and none of those questions is metered to the
  // workspace that asked. Moving them is PROXY-7's migration, which uninstalls a connector a
  // customer has installed, and that is a bigger decision than this command is allowed to make.
  if (route.route === "connector") {
    return {
      action: "skip",
      why: `${where} runs the connector itself, which already answers and outranks this route.`
        + " It answers on the connector's own credential, so nothing it asks is metered to this workspace;"
        + " moving it off is the PROXY-7 migration and not this command",
    };
  }
  const wantKey = sha12(key);
  const same = route.keySha256 === wantKey
    && route.fetchEndpoint === endpoints.fetchEndpoint
    && route.searchEndpoint === endpoints.searchEndpoint;
  if (same) {
    return { action: "already", why: `${where} already holds its own key against both proxy addresses`, keySha256: wantKey };
  }
  // What is actually changing, in the words an operator needs to decide whether to run it. A box
  // holding somebody else's key is the PROXY-7 state: the operator's own 44-character TinyFish key,
  // copied into three boxes, readable by the agent host, which runs as root inside the box.
  const changes = [];
  if (route.keyLength === 0) changes.push("it holds no key at all today");
  else if (route.keySha256 !== wantKey) {
    changes.push(`it holds a different key today (${route.keyLength} characters, sha256 ${route.keySha256}), which this replaces with this workspace's own`);
  }
  if (route.fetchEndpoint !== endpoints.fetchEndpoint) changes.push(`fetch moves from ${route.fetchEndpoint} to ${endpoints.fetchEndpoint}`);
  if (route.searchEndpoint !== endpoints.searchEndpoint) changes.push(`search moves from ${route.searchEndpoint} to ${endpoints.searchEndpoint}`);
  return { action: "write", changes, keySha256: wantKey, ...endpoints };
}

/**
 * Whether a search answer is a real one.
 *
 * The door proof asks the proxy the same question a box's host asks it, on the same address with the
 * same bearer. A 200 carrying no result is the shape a dead pass-through returns, so the count is
 * what decides rather than the status: "it answered" is not "it answered with something".
 */
export function judgeSearchAnswer({ status, body }) {
  if (Number(status) !== 200) {
    return { ok: false, why: `the search address answered HTTP ${status}`, results: 0 };
  }
  let parsed = body;
  if (typeof body === "string") {
    try { parsed = JSON.parse(body); } catch { return { ok: false, why: "the search address answered something that is not json", results: 0 }; }
  }
  const rows = Array.isArray(parsed?.results) ? parsed.results : (Array.isArray(parsed) ? parsed : []);
  const usable = rows.filter((row) => String(row?.url ?? row?.title ?? "").trim().length > 0);
  if (usable.length === 0) {
    return { ok: false, why: "the search address answered 200 and returned no results, which is what an empty credential looks like", results: 0 };
  }
  return { ok: true, results: usable.length, first: String(usable[0]?.title ?? usable[0]?.url ?? "").slice(0, 80) };
}

/**
 * Whether a real in-box turn actually reached for the web, and said something.
 *
 * TWO HALVES, and one of them is not optional. A reply alone proves nothing: a model happily answers
 * a lookup question out of its own memory and the sentence looks identical either way. So the
 * conversation outline is read for a WebSearch or WebFetch tool row, which is the only place outside
 * the box that says which tools a turn really called (docs/GAP-ANALYSIS.md, conversation outline
 * receipts), and both halves have to be there.
 */
export function judgeInBoxProof({ reply, toolNames }) {
  const said = String(reply ?? "").trim();
  const tools = (toolNames ?? []).map((name) => String(name ?? "").toLowerCase());
  const reached = tools.some((name) => name.includes("websearch") || name.includes("webfetch"));
  if (said.length === 0) return { ok: false, why: "the turn ended without saying anything" };
  if (!reached) {
    return { ok: false, why: "the turn answered without calling a web tool, so the answer came from the model and not from the web", said };
  }
  // The host's own sentence for a box with nothing set up. A reply carrying it is the exact failure
  // this whole wave exists to end, and it is worth naming rather than letting it read as an answer.
  if (/no web search service is set up/i.test(said)) {
    return { ok: false, why: "the box still says no web search service is set up on this machine", said };
  }
  return { ok: true, said };
}

/**
 * The whole command, with its I/O injected.
 *
 * `boxCall(slug, command, args)` answers {ok, body} | {ok:false, why}; `proxy` is a cp/proxy.mjs
 * client; `keyOf(slug)` answers this workspace's virtual key or null; `out(line)` prints.
 */
export function createWebSearchProvisioner({
  tenants,
  boxCall,
  proxy,
  keyOf,
  proxyUrl,
  out = () => {},
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  turnTimeoutMs = 180_000,
} = {}) {
  const endpoints = webSearchEndpointsFor(proxyUrl);
  const pad = (value, width) => String(value ?? "").padEnd(width);

  /** One workspace's route as its own box reports it, or null with the reason said out loud. */
  async function routeOf(slug) {
    const answer = await boxCall(slug, "getWebSearchRoute", {});
    if (!answer.ok) { out(`  ${slug}'s box could not be asked: ${answer.why}`); return null; }
    const body = answer.body ?? {};
    return {
      route: String(body.route ?? "none"),
      answers: body.answers === true,
      metered: body.metered === true,
      fetchEndpoint: String(body.fetchEndpoint ?? ""),
      searchEndpoint: String(body.searchEndpoint ?? ""),
      keyLength: Number(body.keyLength ?? 0) || 0,
      keySha256: String(body.keySha256 ?? ""),
    };
  }

  /**
   * The door proof: the same request the box's host makes, from here, on that box's own key. It
   * proves the credential opens the route and that the route returns results, which is everything
   * between the box and the answer. What it does not prove is the box's own tool, which is what
   * --prove is for.
   */
  async function proveDoor(slug, key, query) {
    if (endpoints == null) return { ok: false, why: "no proxy address" };
    const url = `${endpoints.searchEndpoint}?query=${encodeURIComponent(query)}`;
    let response;
    const started = now();
    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      return { ok: false, why: `the search address did not answer (${String(error?.message ?? error).split("\n")[0]})` };
    }
    const body = await response.text().catch(() => "");
    return { ...judgeSearchAnswer({ status: response.status, body }), ms: now() - started };
  }

  /** Which bot to ask. The workspace's lead, or the first one that is not a group. */
  async function leadAgent(slug) {
    const roster = await boxCall(slug, "listAgents", {});
    if (!roster.ok) return { ok: false, why: roster.why };
    const rows = Array.isArray(roster.body) ? roster.body : (Array.isArray(roster.body?.agents) ? roster.body.agents : []);
    const people = rows.filter((row) => row?.isGroup !== true && String(row?.id ?? "").length > 0);
    if (people.length === 0) return { ok: false, why: `${slug} has no bot to ask` };
    const titan = people.find((row) => String(row?.name ?? "").trim().toLowerCase() === "titan");
    const picked = titan ?? people[0];
    return { ok: true, agentId: String(picked.id), agentName: String(picked.name ?? picked.id) };
  }

  /**
   * The in-box proof: a real turn, the box's own WebSearch, the customer's own conversation.
   *
   * IT IS OPT-IN AND THE HELP SAYS WHY. This writes a visible message into somebody's workspace and
   * spends their allowance on a model turn. The door proof above costs neither and covers the route;
   * this covers the one thing the door proof cannot, which is the box's own tool.
   */
  async function proveInBox(slug, question) {
    const lead = await leadAgent(slug);
    if (!lead.ok) return { ok: false, why: lead.why };
    const sent = await boxCall(slug, "sendPrompt", { agentId: lead.agentId, prompt: question });
    if (!sent.ok) return { ok: false, why: `the question could not be sent: ${sent.why}` };
    const deadline = now() + turnTimeoutMs;
    let running = true;
    while (now() < deadline) {
      await sleep(3_000);
      const roster = await boxCall(slug, "listAgents", {});
      if (!roster.ok) continue;
      const rows = Array.isArray(roster.body) ? roster.body : (Array.isArray(roster.body?.agents) ? roster.body.agents : []);
      running = rows.find((row) => String(row?.id ?? "") === lead.agentId)?.isRunning === true;
      if (!running) break;
    }
    if (running) return { ok: false, why: `${lead.agentName} was still working after ${Math.round(turnTimeoutMs / 1000)} s, so nothing was judged` };
    const transcript = await boxCall(slug, "getAgentTranscript", { id: lead.agentId });
    const entries = Array.isArray(transcript.body) ? transcript.body : [];
    const said = entries.filter((entry) => (entry?.kind === "send-message" && String(entry.message?.content ?? "").trim().length > 0)
      || (entry?.kind === "message" && entry?.role === "assistant" && String(entry.content ?? "").trim().length > 0));
    const last = said.at(-1);
    const reply = last == null ? "" : String(last.kind === "send-message" ? last.message?.content : last.content);
    const outlineAnswer = await boxCall(slug, "getConversationOutline", { id: lead.agentId });
    const items = Array.isArray(outlineAnswer.body) ? outlineAnswer.body : [];
    const toolNames = items.filter((item) => item?.kind === "tool-call").map((item) => String(item?.name ?? ""));
    return { ...judgeInBoxProof({ reply, toolNames }), agentName: lead.agentName };
  }

  return {
    endpoints,

    /** Every workspace's route, so the fleet can be measured before and after. No writes. */
    async list() {
      out(`${pad("SLUG", 20)}${pad("ANSWERS", 9)}${pad("ROUTE", 11)}${pad("METERED", 9)}${pad("KEY", 22)}WHERE IT DIALS`);
      const rows = [];
      for (const tenant of tenants) {
        const route = await routeOf(tenant.slug);
        if (route == null) {
          // A ROW EITHER WAY. A box that could not be asked is not a box with no search, and a
          // table that silently drops it counts it in the denominator while showing nine rows out
          // of ten. On the R750 2026-09-15 every live box would land here, because that host
          // predates the command this reads.
          rows.push({ slug: tenant.slug, answers: false, route: "unknown" });
          out(`${pad(tenant.slug, 20)}${pad("unknown", 9)}${pad("unknown", 11)}${pad("unknown", 9)}${pad("could not be asked", 22)}`);
          continue;
        }
        rows.push({ slug: tenant.slug, ...route });
        out(`${pad(tenant.slug, 20)}${pad(route.answers ? "yes" : "no", 9)}${pad(route.route, 11)}`
          + `${pad(route.metered ? "yes" : "no", 9)}`
          + `${pad(route.keyLength === 0 ? "none" : `${route.keyLength} chars ${route.keySha256}`, 22)}`
          + `${route.searchEndpoint}`);
      }
      const answering = rows.filter((row) => row.answers === true).length;
      out("");
      out(`${answering} of ${rows.length} workspace(s) can answer a question about the web today.`);
      return rows;
    },

    /**
     * Point workspaces at the proxy's search, one at a time.
     *
     * The proxy is asked ONCE, before the loop, because its answer is the same for every workspace
     * and asking it per tenant would turn one refusal into ten identical ones.
     */
    async set({ slugs, dryRun = false, prove = false, query = "hot dip galvanized hex bolt", question = "" } = {}) {
      if (endpoints == null) {
        out("this control plane has no proxy address (CP_PROXY_URL is not set), so there is nowhere to point a box");
        return { ok: false, written: 0 };
      }
      const state = proxyTinyFishState(await proxy.listPassThrough());
      if (!state.ok) {
        out(`${dryRun ? "a real run would STOP here" : "STOPPED"} before touching any workspace: ${state.why}`);
        if (state.fix) out(`  ${state.fix}`);
        // A DRY RUN CARRIES ON, and a real one does not. Measured on the R750 2026-09-15, the doors
        // ARE empty, so a dry run that stopped here would be able to say nothing at all about a
        // fleet on the one night somebody wanted to look at it. Carrying on writes nothing and
        // shows exactly what a working proxy would get; the refusal above still stands, and the
        // answer is still not ok, so nothing reads this as a run that went through.
        if (!dryRun) {
          out("  nothing was written");
          return { ok: false, written: 0, why: state.why };
        }
        out("  the plan below is what a run would do once that is fixed, and nothing here writes anything");
        out("");
      } else {
        out(`the proxy carries a credential on ${state.paths.join(" and ")}`);
      }
      out(`boxes will be pointed at ${endpoints.searchEndpoint} and ${endpoints.fetchEndpoint}`);
      out("");
      let written = 0;
      const results = [];
      for (const slug of slugs) {
        out(`${slug}`);
        const key = keyOf(slug);
        const plan = webSearchPlan({ slug, route: await routeOf(slug), key, endpoints });
        if (plan.action === "stop") { out(`  stopped: ${plan.why}`); results.push({ slug, action: "stop", why: plan.why }); continue; }
        if (plan.action === "skip" || plan.action === "already") {
          out(`  nothing to do: ${plan.why}`);
          results.push({ slug, action: plan.action, why: plan.why });
          continue;
        }
        for (const change of plan.changes) out(`  ${change}`);
        if (dryRun) {
          out(`  would write ${WEB_SEARCH_SERVER}'s three fields with this workspace's key (sha256 ${plan.keySha256})`);
          out("  nothing was written");
          results.push({ slug, action: "would-write", keySha256: plan.keySha256 });
          continue;
        }
        const wrote = await boxCall(slug, "setWebSearchRoute", {
          apiKey: key, fetchEndpoint: endpoints.fetchEndpoint, searchEndpoint: endpoints.searchEndpoint,
        });
        if (!wrote.ok) { out(`  NOT written: ${wrote.why}`); results.push({ slug, action: "failed", why: wrote.why }); continue; }
        written += 1;
        out(`  written: ${wrote.body?.keyLength ?? 0} characters, sha256 ${wrote.body?.keySha256 ?? ""}, ${wrote.body?.changed === true ? "changed" : "unchanged"}`);
        // The door, every time, because it costs nothing and it is the half that is usually broken.
        const door = await proveDoor(slug, key, query);
        out(door.ok
          ? `  proved: this workspace's own key opened the search address and got ${door.results} result(s) in ${door.ms} ms`
          : `  NOT proved: ${door.why}`);
        const row = { slug, action: "written", keySha256: plan.keySha256, door };
        if (prove) {
          const asked = question.length > 0 ? question : "In one line, what is the current version number of Node.js? Look it up rather than answering from memory.";
          out(`  asking ${slug}'s own bot a real question, which puts a message in their conversation`);
          const inBox = await proveInBox(slug, asked);
          out(inBox.ok
            ? `  ${inBox.agentName} answered through its own web tool: ${String(inBox.said).replace(/\s+/g, " ").slice(0, 160)}`
            : `  the in-box proof did not pass: ${inBox.why}`);
          row.inBox = inBox;
        }
        results.push(row);
      }
      out("");
      out(dryRun ? "dry run: nothing was written into any box" : `${written} workspace(s) written`);
      return { ok: state.ok, written, results, ...(state.ok ? {} : { why: state.why }) };
    },
  };
}
