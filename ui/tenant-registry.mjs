// ui/tenant-registry.mjs -- which tenants this console serves, and how to reach each one's box.
//
// TENANT-5. There is one relay, one console and one login page. A tenant is one box container plus
// one data directory, and this file is the relay's answer to "which box, which token, which files"
// for the tenant a request belongs to.
//
// The shape of an entry, and where each field comes from:
//
//   slug        the tenant name on the control plane. "titanium" is the operator's own.
//   name        what a person calls it. Only ever used in a log line.
//   box         the box container's name, for `docker exec`. Coolify names it titanbot-box-<uuid>.
//   gateway     http://<box>:1340 on the shared docker network.
//   token       that box's SAND_GATEWAY_TOKEN. It never reaches a browser.
//   sessionKey  tenantSessionSecret(master, slug), so the relay can verify that tenant's sign-in
//               token without ever holding the control plane's master key. SIGNIN-2: the operator's
//               own entry has no way to derive this, so it is the second field a control plane row
//               for that slug is allowed to merge on, and an empty one means account sign-in is not
//               available for that workspace yet (the instance password still is).
//   stateDir    /data/titanbot/<slug>/state -- endpoints.json, mail.json, mail-inbox.jsonl.
//   profileDir  /data/titanbot/<slug>/profile -- the job bus token file.
//   included    PROXY-1. The models this tenant's plan already pays for, and the virtual key that
//               reaches them: {baseUrl, key, keyId, models: [{id, model, name, contextWindow,
//               servedBy, modelLabel}], enforced}. Minted per tenant by the control plane and
//               handed to this relay on the same route as the rest of the row. NULL IS A REAL
//               ANSWER meaning the feature is off here, which is what keeps a developer Mac and a
//               single-box install byte-identical to today: no included section on the console, no
//               plan rows in the model menu, and every path below behaves exactly as it did before.
//
// Three rules shape everything below.
//
// 1. THE OPERATOR IS SEEDED FROM THE ENVIRONMENT, NOT FROM THE CONTROL PLANE. The relay builds its
//    own entry at boot out of the variables it already had (SAND_BOX_CONTAINER,
//    SAND_HOST_GATEWAY_URL, SAND_HOST_GATEWAY_TOKEN, SAND_UI_STATE_DIR, SAND_PROFILE_DIRS). That is
//    the whole compatibility story: with no control plane configured the registry holds exactly one
//    entry, every seam in the relay resolves to it, and a developer Mac or a single-box install
//    behaves precisely as it did before this file existed. It is also why a control plane outage
//    cannot take Jason's own console down, which is rule 3 of ui/tenant-login.mjs restated.
//
//    TWO FIELDS ARE THE EXCEPTION, and both for the same reason: nothing in this relay's own
//    environment can produce them. `included` is minted at the proxy (PROXY-1) and `sessionKey` is
//    derived from a master that never leaves the control plane (SIGNIN-2). A row for the operator's
//    slug has those two merged onto the env-seeded entry and every other field of it ignored.
//
// 2. A BOX NAME IS VERIFIED, NEVER GUESSED. The old relay fell back to `docker ps --filter
//    label=com.titanbot.role=box` and took the first match. On a server with one box that was
//    convenient; on a server with N tenants it resolves to an arbitrary customer's container, and
//    every `docker exec` the console makes would land in somebody else's box. That fallback is
//    deleted. Instead one `docker ps` per refresh (one call for the whole fleet, not one per
//    tenant) builds the set of names that actually exist, and an entry whose box is not in it is
//    marked unreachable and answers "That workspace is not available right now." The operator's own
//    entry is exempt from being marked unreachable: Jason's console is the door he fixes a stopped
//    box from, so it says so in the log rather than locking him out of it.
//
// 3. A REFRESH THAT FAILS KEEPS THE LAST GOOD ANSWER. The control plane is one service on one
//    machine. If it stops answering, the tenants read a minute ago keep working and one line goes
//    in the log; nobody is signed out over it.
//
// Nothing here imports anything outside node builtins and ui/auth.mjs, because the relay image has
// no node_modules at all.
import path from "node:path";
import { readFileSync } from "node:fs";
import { safeEqual } from "./auth.mjs";

// The operator's own tenant name. Jason's instance password and the gateway bearer both mean this.
export const OPERATOR_SLUG = "titanium";

// The sentence a person sees when their session names a workspace this console cannot serve right
// now: still provisioning, its box stopped, or a control plane that has not answered yet.
export const NOT_AVAILABLE_SENTENCE = "That workspace is not available right now.";

const str = (value) => (typeof value === "string" ? value.trim() : "");

// PROXY-1. The included set, normalised or null. Null covers every "off" there is: the control
// plane has no proxy configured, the row predates the wave, the mint failed, or somebody sent a
// shape this does not recognise. Nothing downstream ever has to ask which.
//
// id EQUALS model, on purpose and pinned by the design: one string rather than two that can drift,
// and the plan- prefix on it is what POST /endpoints drops and POST /endpoints/use resolves, so a
// customer's own row can never be mistaken for one of these or the other way round.
//
// modelLabel is carried, and this line is the whole of PROVIDERS-1's first fix. The control plane
// has sent it since 611fc9c -- it is what the customer's own Titan says it runs, "GLM-5.3" rather
// than the routing alias "plan-zai" -- and this function used to normalise it away. Measured on
// this Mac 2026-09-08 at af8c1ff: a row arriving with modelLabel "GLM-5.3" left here as five
// fields with the label gone, ui/server.mjs's includedRows read `row.modelLabel` and got undefined,
// and both R750 boxes therefore carried no SAND_OPENAI_COMPATIBLE_MODEL_LABEL and told their
// customers they run plan-zai. A panel that lets an operator NAME a model is worth nothing if the
// name never arrives, so the name arrives here.
//
// Empty is a real answer and means "no label": ui/server.mjs deletes the box variable for it and
// the console falls back to the model, which is what every row did before the field existed.
function includedOf(value) {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return null;
  const baseUrl = str(value.baseUrl).replace(/\/+$/, "");
  const key = str(value.key);
  // A set with no way to reach it, or no credential, is not a degraded set: it is no set.
  if (baseUrl.length === 0 || key.length === 0) return null;
  const models = (Array.isArray(value.models) ? value.models : []).map((row) => {
    const model = str(row?.model) || str(row?.id);
    if (model.length === 0) return null;
    const context = Number(row?.contextWindow);
    return {
      id: model,
      model,
      name: str(row?.name) || model,
      contextWindow: Number.isFinite(context) && context > 0 ? Math.trunc(context) : null,
      // What the box tells a person it answers through, so Titan never names a container.
      servedBy: str(row?.servedBy),
      // What the box tells a person it IS. See the note above this function.
      modelLabel: str(row?.modelLabel),
    };
  }).filter((row) => row != null);
  if (models.length === 0) return null;
  return { baseUrl, key, keyId: str(value.keyId), models, enforced: value.enforced === true };
}

// One entry, from whatever the control plane (or the test override file) sent. Everything is
// normalised here so no caller downstream has to ask whether a field might be a number or a null.
function normalize(row, { operator = false } = {}) {
  const slug = str(row?.slug);
  if (slug.length === 0) return null;
  const box = str(row?.box);
  const gateway = str(row?.gateway).replace(/\/+$/, "");
  return {
    slug,
    name: str(row?.name) || slug,
    box,
    gateway: gateway.length > 0 ? gateway : (box.length > 0 ? `http://${box}:1340` : ""),
    token: str(row?.token),
    sessionKey: str(row?.sessionKey),
    stateDir: str(row?.stateDir),
    profileDir: str(row?.profileDir),
    status: str(row?.status) || "running",
    included: includedOf(row?.included),
    operator,
    // Set by the docker sweep below. Until one has run, every entry is taken at its word: refusing
    // a tenant because the first `docker ps` has not come back yet would make a cold start look
    // like an outage.
    reachable: true,
  };
}

// Two entries are the same entry when every field a caller can act on is the same. The registry
// reuses the old object in that case, which keeps the per-tenant caches in server.mjs (the mail
// edge, the request context) from being rebuilt every sixty seconds for no reason.
const signature = (entry) => JSON.stringify([
  entry.slug, entry.name, entry.box, entry.gateway, entry.token, entry.sessionKey,
  entry.stateDir, entry.profileDir, entry.status, entry.operator, entry.reachable,
  // PROXY-1: a re-minted or revoked virtual key has to rebuild the entry, or the console keeps
  // handing out the old one until something unrelated about the tenant happens to move.
  entry.included,
]);

/**
 * The registry.
 *
 * operator     the env-seeded entry, always present and never replaced by a refresh.
 * cpUrl        the control plane's public URL, or "" for a console with no control plane.
 * relayToken   CP_RELAY_TOKEN, the credential that opens GET /v1/relay/tenants and nothing else.
 * tenantsFile  SAND_UI_TENANTS_FILE: a JSON file read INSTEAD of the control plane. It is what
 *              makes the whole of this testable with no network and no control plane, the same
 *              kind of documented override SAND_UI_AUTH_FILE already is.
 * dockerNames  async () => Set<string> | null. null means "docker could not be asked", which skips
 *              the verification rather than marking the fleet unreachable.
 * boxPeers     the ui/auth.mjs createBoxPeers set, refreshed on this same cycle with every box
 *              container name in the fleet. A box is never a trusted forwarder, so the relay has
 *              to know which addresses are boxes.
 */
export function createTenantRegistry({
  operator,
  cpUrl = "",
  relayToken = "",
  tenantsFile = "",
  fetchImpl = fetch,
  dockerNames = null,
  boxPeers = null,
  refreshMs = 60_000,
  timeoutMs = 10_000,
  missRefreshMs = 10_000,
  now = () => Date.now(),
  log = (line) => console.log(line),
} = {}) {
  const seed = normalize({ ...operator, name: operator?.name ?? "Titanium" }, { operator: true });
  if (seed == null) throw new Error("the tenant registry needs an operator entry with a slug");

  let entries = new Map([[seed.slug, seed]]);
  let order = [seed];
  let lastGoodAt = 0;
  let failures = 0;
  let lastMissRefresh = 0;
  let timer = null;

  const rebuild = (next) => {
    // Reuse the object when nothing about it changed, so identity is a usable cache key.
    const kept = new Map();
    for (const [slug, entry] of next) {
      const before = entries.get(slug);
      kept.set(slug, before != null && signature(before) === signature(entry) ? before : entry);
    }
    entries = kept;
    order = [...kept.values()];
  };

  // Which container names exist on this host right now. One call for the whole fleet.
  async function verifyBoxes(next) {
    // An entry with no box name at all needs no docker to judge, so it is judged first and it is
    // judged whatever docker answers or fails to answer. SIGNIN-2 widened the control plane's
    // registry answer to include an ADOPTED row that carries a slug and a derived key and nothing
    // else, which is how the operator's own key arrives. A second adopted workspace arrives the
    // same way, and if the docker sweep below is the only thing that marks it unreachable then a
    // relay whose `docker ps` failed leaves it reachable WITH a real key: that person gets a
    // session and a console with no box behind it instead of the sentence. Two conditions at once,
    // and both of them happen. The operator's own entry is exempt for the reason in rule 2 above:
    // this console is the door a stopped box gets fixed from.
    for (const entry of next.values()) {
      if (entry.operator || entry.box.length > 0) continue;
      log(`reg  ${entry.slug}: no container named (unset), so that workspace answers "not available"`);
      entry.reachable = false;
    }
    if (typeof dockerNames !== "function") return;
    let names = null;
    try { names = await dockerNames(); } catch { names = null; }
    // No answer is not evidence of absence. A relay with no docker (or a docker that hiccuped)
    // must not turn every tenant into "not available"; it simply learns nothing this round.
    if (names == null) return;
    for (const entry of next.values()) {
      const known = entry.box.length > 0 && names.has(entry.box);
      if (known) { entry.reachable = true; continue; }
      if (entry.operator) {
        // Said out loud, never acted on. See rule 2 at the top.
        entry.reachable = true;
        log(`reg  no container named ${entry.box || "(unset)"} on this host, so the model picker, `
          + `the connectors editor and the desktop view have nothing to reach. `
          + `Set SAND_BOX_CONTAINER on this relay to the box's container name.`);
        continue;
      }
      if (entry.reachable !== false) {
        log(`reg  ${entry.slug}: no container named ${entry.box || "(unset)"}, so that workspace answers "not available"`);
      }
      entry.reachable = false;
    }
  }

  // The rows, from the override file or from the control plane. A {failed} object means "could not
  // be read", which is different from an empty fleet.
  async function readRows() {
    if (tenantsFile.length > 0) {
      try {
        const parsed = JSON.parse(readFileSync(tenantsFile, "utf8"));
        return Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.tenants) ? parsed.tenants : []);
      } catch (error) {
        return { failed: `could not read ${tenantsFile} (${error?.message ?? error})` };
      }
    }
    if (cpUrl.length === 0 || relayToken.length === 0) return [];
    let response;
    try {
      response = await fetchImpl(`${cpUrl}/v1/relay/tenants`, {
        headers: { authorization: `Bearer ${relayToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { failed: error?.name === "TimeoutError" ? "timed out" : "no answer" };
    }
    if (response.status !== 200) return { failed: `HTTP ${response.status}` };
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!Array.isArray(body?.tenants)) return { failed: "the answer carried no tenant list" };
    // The control plane names the rows it left out and why; a customer missing from the console is
    // worth a line in the log rather than a bare 404 for whoever tries to sign in.
    //
    // Except the operator's own row, which this relay builds from its own environment and never
    // from the control plane. The control plane has no token or directories for an adopted
    // instance, so it correctly leaves that row out and correctly says why, and printing it here
    // read as a fault every sixty seconds for a console that was working perfectly. A line that
    // says something is wrong when nothing is is worse than no line at all.
    for (const row of Array.isArray(body.skipped) ? body.skipped : []) {
      const slug = str(row?.slug);
      if (slug === OPERATOR_SLUG) continue;
      if (slug.length > 0) log(`reg  ${slug} is not on this console: ${str(row?.why) || "the control plane did not say"}`);
    }
    return body.tenants;
  }

  async function refresh() {
    const rows = await readRows();
    if (!Array.isArray(rows)) {
      failures += 1;
      // Once per failure streak, not once a minute forever.
      if (failures === 1) {
        const when = lastGoodAt > 0 ? new Date(lastGoodAt).toISOString() : "boot";
        log(`reg  could not reach the control plane (${rows.failed}); serving the ${order.length} tenant(s) last read at ${when}`);
      }
      return { ok: false, detail: rows.failed };
    }
    if (failures > 0) log("reg  the control plane is answering again");
    failures = 0;

    const next = new Map();
    for (const row of rows) {
      const entry = normalize(row);
      if (entry == null) continue;
      if (entry.slug === seed.slug) {
        // The operator's box, token and directories come from this relay's own environment and
        // from nowhere else. A row for it is dropped rather than merged, because a control plane
        // that got one field wrong would otherwise point Jason's console at somebody else's box.
        //
        // TWO EXCEPTIONS, and each one is a value this relay's own environment cannot produce.
        //
        // PROXY-1, the included set. Jason's workspace is a tenant of the proxy like everybody
        // else -- the control plane mints it a virtual key the same way, and that key arrives on
        // this row and on no other route -- so treating his console as the one place the plan
        // cannot reach would mean his own box keeps a copied operator key, which is the exact
        // thing that wave ended.
        //
        // SIGNIN-2, the derived session key. It is tenantSessionSecret(master, slug), and the
        // master that derives it never leaves the control plane, so there is nothing here to
        // derive it from: the seed starts with none. Without it an account on the operator's own
        // workspace could not sign in at all. MEASURED on the R750 2026-09-10: a correct password
        // on an account on this slug read 503 "That workspace is not available right now." while
        // the byte-identical account on demo was signed in at once, because sessionKeyOf answered
        // "" and the verdict path in ui/tenant-login.mjs turns a missing key into `unknown`.
        //
        // Both are MERGED onto the env-seeded entry: box, token, gateway, stateDir and profileDir
        // are not read from this row at all, so the reason the row is dropped is untouched -- a
        // control plane with one of those fields wrong still cannot point Jason's console at
        // somebody else's box. Both are assigned unconditionally, so the control plane turning one
        // off turns it off here too rather than leaving this console serving a dead value. A
        // control plane that is merely DOWN is a different case and a safe one: no row arrives at
        // all, the seed keeps its last good key, and nobody is signed out over it.
        //
        // In place rather than by replacement, because `seed` is what operator() and the boot
        // path hold: every reader reaches the entry through the registry or through the request
        // context's own `entry`, so one object staying one object is what keeps them agreeing.
        seed.included = entry.included;
        seed.sessionKey = entry.sessionKey;
        // Said only when there is nothing on the row worth merging at all, which is exactly the
        // case the line was written for. A row carrying a virtual key or a derived key is this
        // relay doing its job, and a line that reads as a fault every sixty seconds on a console
        // that is working perfectly is worse than no line at all.
        if (entry.included == null && entry.sessionKey.length === 0) {
          log(`reg  the control plane returned a row for ${seed.slug}; this relay uses its own environment for that one`);
        }
        continue;
      }
      next.set(entry.slug, entry);
    }
    next.set(seed.slug, seed);
    await verifyBoxes(next);
    // On the same cycle and from the same list: which addresses belong to a box. See
    // createBoxPeers in ui/auth.mjs for why a box must never be read as a proxy.
    if (boxPeers != null && typeof boxPeers.refresh === "function") {
      await boxPeers.refresh([...next.values()].map((entry) => entry.box)).catch(() => {});
    }
    rebuild(next);
    lastGoodAt = now();
    return { ok: true, count: next.size };
  }

  const registry = {
    get(slug) {
      return entries.get(String(slug ?? "")) ?? null;
    },
    all() { return order; },
    operator() { return entries.get(seed.slug) ?? seed; },
    refresh,
    // A session naming a tenant we have never heard of is the one thing worth a refresh outside
    // the schedule: a customer who signed up thirty seconds ago should not wait a minute. Rate
    // limited so a stranger with a made-up slug in a signed cookie cannot pump the control plane.
    miss(slug) {
      const at = now();
      if (entries.has(String(slug ?? ""))) return false;
      if (at - lastMissRefresh < missRefreshMs) return false;
      lastMissRefresh = at;
      void refresh().catch(() => {});
      return true;
    },
    // Which tenant holds this gateway token. Every entry is compared, with no early break, so the
    // time this takes says nothing about which tenant matched or how many there are.
    matchToken(presented) { return registry.matchBy(presented, (entry) => entry.token); },
    // The same scan over a value read per entry, which is how the job bus finds the tenant whose
    // bearer was presented without the token ever being in the registry.
    matchBy(presented, valueOf) {
      const asked = String(presented ?? "");
      if (asked.length === 0) return null;
      let found = null;
      for (const entry of order) {
        let value = "";
        try { value = String(valueOf(entry) ?? ""); } catch { value = ""; }
        if (value.length > 0 && safeEqual(asked, value)) found ??= entry;
      }
      return found;
    },
    sessionKeyOf(slug) { return entries.get(String(slug ?? ""))?.sessionKey ?? ""; },
    // Starts the schedule. unref'd, so it never holds the process open on its own.
    start() {
      if (timer != null) return timer;
      timer = setInterval(() => { void refresh().catch(() => {}); }, refreshMs);
      timer.unref?.();
      return timer;
    },
    stop() { if (timer != null) { clearInterval(timer); timer = null; } },
    // For the boot log and the tests.
    stats() { return { count: order.length, failures, lastGoodAt }; },
  };
  return registry;
}

// The relay's own entry, built out of the environment it already had. Kept here rather than in
// server.mjs so the shape of an entry is defined in exactly one file.
export function operatorEntry({
  env = process.env, gateway, token, stateDir = "", profileDir = "", boxDefault = "grok-bot-local-vm",
} = {}) {
  return {
    slug: OPERATOR_SLUG,
    name: "Titanium",
    box: str(env?.SAND_BOX_CONTAINER) || boxDefault,
    gateway: String(gateway ?? "").replace(/\/+$/, ""),
    token: String(token ?? ""),
    // SIGNIN-2. Empty as a SEED, not as an answer. Nothing in this relay's own environment can
    // derive this key -- it is tenantSessionSecret(master, slug) and the master never leaves the
    // control plane -- so the seed starts with none and a refresh merges the control plane's one
    // on, exactly as it does for `included`. Until one has been merged, the instance password is
    // the only door to this workspace, which is what a console with no control plane has always
    // had and is what rule 3 of ui/tenant-login.mjs keeps working when the control plane is down.
    sessionKey: "",
    stateDir: String(stateDir ?? ""),
    profileDir: String(profileDir ?? ""),
    status: "running",
    // PROXY-1. Nothing in this relay's own environment can mint a virtual key, so the seed starts
    // with none and a refresh merges one on if the control plane has one for this slug.
    included: null,
  };
}

// The names of the containers running on this host, or null when docker could not be asked.
export function dockerNameReader(execFile) {
  return () => new Promise((resolve) => {
    try {
      execFile("docker", ["ps", "--format", "{{.Names}}"], { timeout: 8000, maxBuffer: 4 << 20 }, (error, stdout) => {
        if (error != null && !stdout) return resolve(null);
        const names = String(stdout ?? "").split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
        resolve(new Set(names));
      });
    } catch { resolve(null); }
  });
}

// Where a tenant's file goes. The operator's files keep every override they ever had (the per-file
// env vars, then SAND_UI_STATE_DIR, then beside the code); a tenant's come out of its own state
// directory and nowhere else.
export function tenantFile(entry, name, { here = "", stateFile = null } = {}) {
  if (entry?.operator === true && typeof stateFile === "function") return stateFile(name, here);
  const dir = String(entry?.stateDir ?? "");
  return dir.length > 0 ? path.resolve(dir, name) : path.join(here, name);
}
