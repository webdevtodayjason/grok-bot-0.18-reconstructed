// ui/relay-hooks.mjs -- the seam three builders land through without three of them editing one file.
//
// THE PROBLEM THIS SOLVES, written down so nobody discovers it. ui/server.mjs is 3,693 lines and is
// the single file the whole apps wave naturally collides in: the data diet needs a hook inside
// relayCommand and relayAvatar, the asset policy needs one in the static branch, and push needs
// routes and a sweep beside the mail sweep. Three builders adding route lines and call sites to one
// file is three rebases and a merge nobody can verify. So the call sites are wired ONCE, here and in
// server.mjs, against signatures fixed in the design, and the three optional modules are loaded by
// name at boot. The cost is one indirection layer. The benefit is that the file lists are genuinely
// disjoint and the merge order is mechanical rather than hoped for.
//
// EVERY HOOK HAS AN IDENTITY FALLBACK AND THE ABSENT CASE IS A TEST, NOT A COMMENT. With no
// api-diet.mjs the relay answers bodies unchanged; with no asset-cache.mjs assets keep `no-store`;
// with no push-edge.mjs the /push routes 404 and no sweep runs. tests/relay-hooks-absent.test.mjs
// proves all three against a real relay with the files deleted. That is the lesson CONSOLE-4 already
// paid for: backgrounds.js destructured a global that was not there and took the picker down, and a
// comment saying "optional" would have read exactly the same as this does.
//
// A FAILURE TO LOAD IS LOGGED ONCE AND FALLS BACK, NEVER THROWN. A syntax error in an optional module
// must not stop the console coming up: a customer meeting a dead port because a cache policy module
// would not parse is a worse failure than a customer meeting `no-store`.

const NO_STORE = { "cache-control": "no-store" };

// Load one optional sibling. `null` for absent, which is the case every fallback below is written
// for; a module that throws on import is also null, with one line in the log saying which and why.
async function optional(specifier, log) {
  try {
    return await import(specifier);
  } catch (error) {
    // ERR_MODULE_NOT_FOUND is the ordinary case -- the module is simply not part of this ship -- and
    // is not worth a line. Anything else is a broken file and is.
    const code = String(error?.code ?? "");
    if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
      log(`hook  ${specifier} would not load, so the relay runs without it: ${error?.message ?? error}`);
    }
    return null;
  }
}

/**
 * Loads whichever of the three optional modules are present and answers the hook table server.mjs
 * calls. Called once, awaited into boot, before the first request: a hook that was sometimes there
 * and sometimes not would be the worst of both halves.
 *
 * `deps` is what the optional modules need from the relay and cannot reach themselves: the log, and
 * a `tenantFile(t, name)` so a module can keep per-tenant state in the same state directory
 * everything else does without importing the context builder.
 */
export async function loadRelayHooks({ log = (line) => console.log(line), deps = {} } = {}) {
  const diet = await optional("./api-diet.mjs", log);
  const assets = await optional("./asset-cache.mjs", log);
  const push = await optional("./push-edge.mjs", log);

  const names = [diet != null ? "api-diet" : null, assets != null ? "asset-cache" : null, push != null ? "push-edge" : null]
    .filter((one) => one != null);
  log(`hook ${names.length === 0 ? "none: bodies unchanged, assets no-store, no push" : names.join(", ")}`);

  // Each optional module may export `create(deps)` and is then handed what it needs; a module with
  // no create is used as-is, which keeps a one-function module from needing a factory.
  const built = async (module) => {
    if (module == null) return null;
    if (typeof module.create !== "function") return module;
    // `log` FIRST, so `deps` can still override it, and so the comment above this function that says
    // deps carries the log is TRUE. It was not: push-edge's credential reader takes a log and was
    // getting the no-op default, which would have made a control plane that stopped handing over the
    // Apple key a silent degrade to the stub rather than a line saying so.
    try { return await module.create({ log, ...deps }); }
    catch (error) { log(`hook  a module would not start, so the relay runs without it: ${error?.message ?? error}`); return null; }
  };
  const D = await built(diet);
  const A = await built(assets);
  const P = await built(push);

  return {
    present: { diet: D != null, assets: A != null, push: P != null },

    /**
     * COST-1's seam. One gateway answer on its way to a browser, with the chance to send less of it.
     *
     * `shapeApiAnswer(method, args, headers, bytes)`: `args` is the parsed object the console sent,
     * `headers` the request's own (so a module can read `x-titan-if-digest`), `bytes` the upstream body
     * as a string. The answer is `{bytes, headers}`: the body to send and any headers to add. With no
     * api-diet.mjs it is the body unchanged and no headers, which is byte for byte what the relay did
     * before this existed.
     *
     * It must never throw and never be the reason a command fails: a projection that breaks answers
     * the whole body, because a console with too much data works and a console with an exception does
     * not.
     */
    shapeApiAnswer(method, rawArgs, headers, bytes) {
      if (D == null || typeof D.shapeApiAnswer !== "function") return { bytes, headers: {} };
      try {
        // The arguments the console SENT, parsed, because that is what a projection decides on -- which
        // agent, which page. Parsed HERE rather than in server.mjs so the JSON.parse costs nothing on a
        // ship with no api-diet.mjs, which is the case the early return above covers. A body that is not
        // an object is {} rather than a throw: a projection must never be the reason a command fails.
        let args = {};
        try { const parsed = JSON.parse(String(rawArgs ?? "").trim().length > 0 ? rawArgs : "{}"); if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed; }
        catch { args = {}; }
        const out = D.shapeApiAnswer(method, args, headers, bytes);
        if (out == null || typeof out.bytes !== "string") return { bytes, headers: {} };
        return { bytes: out.bytes, headers: out.headers ?? {} };
      } catch (error) {
        log(`hook  the projection for ${method} failed, so the whole answer went out: ${error?.message ?? error}`);
        return { bytes, headers: {} };
      }
    },

    /**
     * COST-1's other seam. The cache headers for one static file, and an ETag when the module makes
     * one. `{headers, status}`: a 304 is the module's to decide, because only it knows the validator
     * it wrote.
     *
     * With no asset-cache.mjs this is `no-store`, which is what every asset answers today. THAT IS
     * THE SAFE FALLBACK AND NOT AN OVERSIGHT: assets answer 401 unauthenticated (denyUnauthenticated
     * runs above the static branch) and the relay writes no `vary`, so a PUBLICLY cacheable answer
     * would let an edge serve a signed-in 200, or a 401, to everybody.
     */
    assetPolicy(file, url, req) {
      if (A == null || typeof A.assetPolicy !== "function") return { headers: { ...NO_STORE }, status: 200 };
      try {
        // THE REQUEST'S HEADERS, not the request. Measured during the merge: passing the whole
        // IncomingMessage here reads `if-none-match` as undefined, so every cache decision came out
        // right and every 304 silently became a 200 -- a second boot re-downloading the whole bundle
        // while the headers claimed it was cached. Normalised in the seam because the seam is the one
        // place that knows both shapes, and a module author should not have to guess which arrived.
        const out = A.assetPolicy(file, url, req?.headers ?? req ?? {});
        if (out == null || typeof out.headers !== "object") return { headers: { ...NO_STORE }, status: 200 };
        return { headers: out.headers, status: Number.isFinite(out.status) ? out.status : 200 };
      } catch (error) {
        log(`hook  the asset policy failed, so ${url?.pathname ?? "an asset"} went out no-store: ${error?.message ?? error}`);
        return { headers: { ...NO_STORE }, status: 200 };
      }
    },

    /**
     * index.html on its way out, with the chance to stamp its asset references so the stamped URLs can
     * be cached for a year. A relay-side rewrite, the way sameOriginDesktop already rewrites that same
     * HTML, so index.html on disk is never edited for this.
     */
    stampHtml(html, url) {
      if (A == null || typeof A.stampHtml !== "function") return html;
      try {
        const out = A.stampHtml(html, url);
        return typeof out === "string" && out.length > 0 ? out : html;
      } catch (error) {
        log(`hook  the asset stamping failed, so the page went out unstamped: ${error?.message ?? error}`);
        return html;
      }
    },

    /**
     * PUSH-1's routes. `null` means there are none and /push answers 404 like any other unknown path,
     * which is exactly what a shell needs to see on a relay that has no push: a refusal it can read,
     * not a hang.
     *
     * The handler is given the tenant context, the request, the response and the URL, and answers
     * true when it took the request. False falls through to the 404.
     */
    pushRoutes() {
      if (P == null || typeof P.handle !== "function") return null;
      return P;
    },

    /** The sweep that turns a pending card into one push. A no-op with no push-edge.mjs. */
    pushSweepStart() {
      if (P == null || typeof P.sweepStart !== "function") return;
      try { P.sweepStart(); }
      catch (error) { log(`hook  the push sweep would not start: ${error?.message ?? error}`); }
    },
  };
}
