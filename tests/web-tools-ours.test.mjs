// CURSOR-1 / TOOLS-FETCH-1. WebFetch and WebSearch as ours: the fallback order, the words a
// failure ends in, and the two TinyFish routes, driven against a fake TinyFish.
//
// Measured on the R750 2026-09-07: both tools were Connect-RPC calls to api2.cursor.sh and both
// answered "Error: Tool failed; this may be temporary. Try again." on every call. Richard's first
// session made 11 fetches and 8 searches and every one failed. Two claims are worth pinning where
// they can be checked in a second: the direct read is tried first and the backup only when the site
// refuses, and no failure text ever says "may be temporary" or names a tool.
//
// Nothing here touches the network or reads a real credential. The key is invented, the fake
// TinyFish is a function in this file, and the only endpoints asserted are the strings the code
// would dial.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { transform } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Both modules under test are import-free at runtime (tinyfish-route.ts imports web-tools.ts for
// types only), so a single-file transform reaches them without the host graph.
async function loadSource(relativePath) {
  const source = await readFile(path.join(repoRoot, relativePath), "utf8");
  const { code } = await transform(source, { format: "esm", loader: "ts", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const webTools = await loadSource("source/host/extensions/inference/web-tools.ts");
const route = await loadSource("source/host/extensions/inference/tinyfish-route.ts");

function reply({ status = 200, contentType = "text/html; charset=utf-8", body = "", contentLength } = {}) {
  const headers = new Map();
  if (contentType != null) headers.set("content-type", contentType);
  if (contentLength != null) headers.set("content-length", String(contentLength));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body,
  };
}

/** A fake TinyFish that records what it was asked and answers what the test told it to. */
function fakeTinyFish({ page, results = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    fallback: {
      route: "connector",
      async fetchPage(url) {
        calls.push({ kind: "fetch", url });
        if (fail) throw new Error("tinyfish said no");
        return page ?? "";
      },
      async search(query) {
        calls.push({ kind: "search", query });
        if (fail) throw new Error("tinyfish said no");
        return results;
      },
    },
  };
}

// TOOLS-FETCH-4. Every read resolves the hostname before it connects, so the cases below say what
// the name lands on rather than asking this machine's resolver. Nothing here touches the network.
const PUBLIC = async () => ["93.184.216.34"];
const LOOPBACK = async () => ["127.0.0.1"];

const PLAIN_PAGE = "<html><head><title>Example Domain</title></head><body><h1>Example</h1><p>Hello there.</p></body></html>";

test("a page this machine can read is read here, and the backup is never asked", async () => {
  const tinyfish = fakeTinyFish({ page: "should not be used" });
  const requests = [];
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => tinyfish.fallback,
    fetchImpl: async (url, init) => { requests.push({ url, init }); return reply({ body: PLAIN_PAGE }); },
  });
  const result = await fetchPage(null, "https://example.com/");
  assert.equal(result.error, undefined);
  // The page's own h1 already opens the text, so the <title> is not repeated on top of it.
  assert.equal(result.content, "# Example\n\nHello there.");
  assert.equal(tinyfish.calls.length, 0, "the backup must not be touched when the direct read worked");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.redirect, "manual", "redirects are followed here, one hop at a time, so each hop is checked");
  assert.equal(requests[0].init.headers["user-agent"], webTools.BROWSER_USER_AGENT);
  assert.match(requests[0].init.headers["user-agent"], /Mozilla\/5\.0/, "a browser-like User-Agent, not node's");
});

test("a 403 falls through to the backup, and the backup's page is what comes back", async () => {
  const tinyfish = fakeTinyFish({ page: "# Members only\n\nThe real text." });
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => tinyfish.fallback,
    fetchImpl: async () => reply({ status: 403, body: "Forbidden" }),
  });
  const result = await fetchPage(null, "https://blocked.example/article");
  assert.equal(result.content, "# Members only\n\nThe real text.");
  assert.deepEqual(tinyfish.calls, [{ kind: "fetch", url: "https://blocked.example/article" }]);
});

test("a 429 and a 5xx fall through the same way", async () => {
  for (const status of [401, 429, 503]) {
    const tinyfish = fakeTinyFish({ page: `read anyway after ${status}` });
    const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
      resolveFallback: () => tinyfish.fallback,
      fetchImpl: async () => reply({ status, body: "no" }),
    });
    const result = await fetchPage(null, "https://slow.example/");
    assert.equal(result.content, `read anyway after ${status}`, `status ${status}`);
  }
});

test("a JavaScript-only page reads as empty and falls through", async () => {
  const tinyfish = fakeTinyFish({ page: "rendered by the backup" });
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => tinyfish.fallback,
    fetchImpl: async () => reply({ body: "<html><head></head><body><div id=\"root\"></div><script>boot()</script></body></html>" }),
  });
  const result = await fetchPage(null, "https://spa.example/");
  assert.equal(result.content, "rendered by the backup");
  assert.equal(tinyfish.calls[0].kind, "fetch");
});

test("a JavaScript shell that leaves only its title behind goes to the backup, and the title is kept only if the backup cannot beat it", async () => {
  // Measured 2026-09-07 from this Mac: https://www.instagram.com/titaniumcomputing/ answers 200
  // with a 620,447 byte body that reduces to "# Instagram" and none of the wall phrases. Richard's
  // Titan read that as the page and told him Instagram was empty.
  const SHELL = `<html><head><title>Instagram</title></head><body><div id="mount"></div><script>${"x".repeat(200_000)}</script></body></html>`;
  const good = fakeTinyFish({ page: "the profile, rendered by the backup" });
  const viaBackup = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => good.fallback,
    fetchImpl: async () => reply({ body: SHELL }),
  });
  assert.equal((await viaBackup(null, "https://www.instagram.com/titaniumcomputing/")).content, "the profile, rendered by the backup");
  assert.equal(good.calls[0].kind, "fetch");

  const broken = fakeTinyFish({ fail: true });
  const kept = await webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => broken.fallback,
    fetchImpl: async () => reply({ body: SHELL }),
  })(null, "https://www.instagram.com/titaniumcomputing/");
  assert.equal(kept.error, undefined);
  assert.match(kept.content, /Instagram/);

  // A short real page is not a shell: example.com is 559 bytes that reduce to 131 characters.
  assert.equal(webTools.looksLikeShell("# Example Domain\n\nThis domain is for use in documentation examples without needing permission. Coordinate this with somebody.", 559), false);
  assert.equal(webTools.looksLikeShell("# Instagram\n\n", 620_447), true);
  assert.equal(webTools.looksLikeShell("# A big page\n\nwith three lines of words", 300_000), true);
});

test("a page whose whole content is its own title goes to the backup, however small the page is", async () => {
  // TOOLS-FETCH-3. htmlToText puts the title on top of whatever the body left behind, so a shell
  // with a <title> -- nearly every real page -- never reduced to the empty string and the empty
  // branch could not be reached for one. Measured 2026-09-07: reddit.com/r/smallbusiness came back
  // as "# Reddit" and nothing else, and the person was told the page was empty.
  const SHELL = "<html><head><title>Reddit - Dive into anything</title></head><body><div id=\"root\"></div><script>boot()</script></body></html>";
  const good = fakeTinyFish({ page: "THE REAL ARTICLE TEXT FROM THE BACKUP" });
  const viaBackup = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => good.fallback,
    fetchImpl: async () => reply({ body: SHELL }),
  });
  assert.equal((await viaBackup(null, "https://www.reddit.com/r/smallbusiness/")).content, "THE REAL ARTICLE TEXT FROM THE BACKUP");
  assert.equal(good.calls[0].kind, "fetch", "the backup is asked, which is what never happened before");

  // The title is still better than an error when the backup cannot beat it.
  const broken = fakeTinyFish({ fail: true });
  const kept = await webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => broken.fallback,
    fetchImpl: async () => reply({ body: SHELL }),
  })(null, "https://www.reddit.com/r/smallbusiness/");
  assert.equal(kept.error, undefined);
  assert.match(kept.content, /Reddit/);

  assert.equal(webTools.looksLikeTitleOnly("# Instagram"), true);
  assert.equal(webTools.looksLikeTitleOnly("# Example\n\nHello there."), false);
  assert.equal(webTools.looksLikeTitleOnly(""), false);
});

/* ---------------------------------------------------------------- *
 * Where a fetch may go.
 * ---------------------------------------------------------------- */

test("a public name that resolves to loopback is refused, and the backup is not asked either", async () => {
  // Measured on this Mac 2026-09-08 against the production module: http://127.0.0.1:<port>/internal
  // was refused by the tool's own precheck and http://localtest.me:<port>/internal was not, because
  // that precheck is a hostname string test. localtest.me is a public name that resolves to
  // loopback, and the tool returned the box's own internal page.
  const tinyfish = fakeTinyFish({ page: "the backup must not be asked to read this either" });
  let dialled = 0;
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: LOOPBACK,
    resolveFallback: () => tinyfish.fallback,
    fetchImpl: async () => { dialled += 1; return reply({ body: "<html><body><p>SECRET-INTERNAL-PAGE</p></body></html>" }); },
  });
  const result = await fetchPage(null, "http://localtest.me:7777/internal");
  assert.equal(result.content, undefined);
  assert.match(result.error, /is on this machine or on the private network/);
  assert.match(result.error, /localtest\.me:7777/);
  assert.equal(dialled, 0, "the address is refused before anything is dialled");
  assert.equal(tinyfish.calls.length, 0);
});

test("a redirect into the box is refused, which fetch's own follow could never see", async () => {
  // The 302 hop is the half a hostname test cannot cover: readPageDirectly used redirect:"follow",
  // so a public name answering 302 to http://127.0.0.1/ handed back the box's own page.
  const seen = [];
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: async (host) => (host === "127.0.0.1" ? ["127.0.0.1"] : ["93.184.216.34"]),
    resolveFallback: () => null,
    fetchImpl: async (url) => {
      seen.push(url);
      if (url === "https://redirector.example/go") {
        return { ok: false, status: 302, headers: { get: (name) => (name.toLowerCase() === "location" ? "http://127.0.0.1:7777/internal" : null) }, text: async () => "" };
      }
      return reply({ body: "<html><body><p>SECRET-INTERNAL-PAGE</p></body></html>" });
    },
  });
  const result = await fetchPage(null, "https://redirector.example/go");
  assert.match(result.error, /is on this machine or on the private network/);
  assert.deepEqual(seen, ["https://redirector.example/go"], "the second hop is never dialled");
});

test("a redirect to another public page is still followed, and the page that answers is the one read", async () => {
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => null,
    fetchImpl: async (url) => url === "https://short.example/x"
      ? { ok: false, status: 301, headers: { get: (name) => (name.toLowerCase() === "location" ? "/article" : null) }, text: async () => "" }
      : reply({ body: "<html><body><h1>The article</h1><p>Words.</p></body></html>" }),
  });
  assert.equal((await fetchPage(null, "https://short.example/x")).content, "# The article\n\nWords.");
});

test("the names the box answers to are refused whatever they resolve to", async () => {
  for (const host of ["localhost", "host.docker.internal", "gateway.docker.internal", "box.internal", "app.localhost"]) {
    assert.equal(webTools.isPrivateWebHostName(host), true, host);
  }
  assert.equal(webTools.isPrivateWebHostName("example.com"), false);
  assert.equal(webTools.isPrivateWebHostName("localtest.me"), false, "a public name is only caught by resolving it");
  for (const address of ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1"]) {
    assert.equal(webTools.isPrivateWebAddress(address), true, address);
  }
  assert.equal(webTools.isPrivateWebAddress("93.184.216.34"), false);
  assert.equal(webTools.isPrivateWebAddress("example.com"), false, "a name is not an address");
});

test("a page that redirects forever is given up on rather than followed forever", async () => {
  let hops = 0;
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => null,
    fetchImpl: async () => { hops += 1; return { ok: false, status: 302, headers: { get: (name) => (name.toLowerCase() === "location" ? "https://loop.example/again" : null) }, text: async () => "" }; },
  });
  const result = await fetchPage(null, "https://loop.example/start");
  assert.match(result.error, /Could not read that page/);
  assert.equal(hops, webTools.MAX_WEB_FETCH_REDIRECTS + 1);
});

test("a 200 that is really a sign-in wall goes to the backup, and the wall is kept if the backup cannot beat it", async () => {
  // Measured 2026-09-07 from this Mac: https://www.linkedin.com/feed/ answers 200 with 792
  // characters that are entirely a sign-in form. A status code alone never catches that.
  const WALL = "<html><head><title>LinkedIn Login, Sign in</title></head><body><h2>Sign in</h2><p>New to LinkedIn? Join now</p></body></html>";
  const good = fakeTinyFish({ page: "the real feed" });
  const viaBackup = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => good.fallback,
    fetchImpl: async () => reply({ body: WALL }),
  });
  assert.equal((await viaBackup(null, "https://www.linkedin.com/feed/")).content, "the real feed");
  assert.equal(good.calls[0].kind, "fetch");

  const broken = fakeTinyFish({ fail: true });
  const viaWall = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => broken.fallback,
    fetchImpl: async () => reply({ body: WALL }),
  });
  const kept = await viaWall(null, "https://www.linkedin.com/feed/");
  assert.equal(kept.error, undefined, "a wall is worse than an article and better than an error");
  assert.match(kept.content, /Sign in/);
});

test("the wall detector needs both halves, so a long article that mentions signing in is not a wall", async () => {
  assert.equal(webTools.looksLikeWall("Sign in to continue"), true);
  assert.equal(webTools.looksLikeWall("Please enable JavaScript to view this site."), true);
  assert.equal(webTools.looksLikeWall("Checking your browser before accessing the site."), true);
  assert.equal(webTools.looksLikeWall("A long piece about renewals. ".repeat(80) + " You can sign in later."), false);
  assert.equal(webTools.looksLikeWall("# Example Domain\n\nThis domain is for use in documentation examples."), false);
});

test("a page over the 25 MB cap is not read into memory whole", async () => {
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => null,
    fetchImpl: async () => reply({ contentLength: webTools.MAX_WEB_FETCH_BYTES + 1, body: "x" }),
  });
  const result = await fetchPage(null, "https://huge.example/dump");
  assert.equal(result.content, undefined);
  assert.match(result.error, /Could not read that page/);
  assert.equal(webTools.MAX_WEB_FETCH_BYTES, 25 * 1024 * 1024);
});

test("when the site refuses and the backup cannot reach it either, the text says so and names the next step", async () => {
  const tinyfish = fakeTinyFish({ fail: true });
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => tinyfish.fallback,
    fetchImpl: async () => reply({ status: 403, body: "no" }),
  });
  const result = await fetchPage(null, "https://blocked.example/");
  assert.equal(
    result.error,
    "Could not read that page. The site refused a direct fetch and the fallback could not reach it either. Trying again will not help. Open the page in your browser and read it from there.",
  );
});

test("with no backup set up at all, the text says that rather than blaming the site alone", async () => {
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => null,
    fetchImpl: async () => reply({ status: 403, body: "no" }),
  });
  const result = await fetchPage(null, "https://blocked.example/");
  assert.match(result.error, /there is no backup web service set up on this machine/);
  assert.match(result.error, /Open the page in your browser and read it from there\.$/);
});

test("a resolveFallback that throws is the same as having none, never a crash", async () => {
  const fetchPage = webTools.createSandWebFetchService({
    resolveAddresses: PUBLIC,
    resolveFallback: () => { throw new Error("connectors.json is unreadable"); },
    fetchImpl: async () => reply({ status: 403, body: "no" }),
  });
  const result = await fetchPage(null, "https://blocked.example/");
  assert.match(result.error, /no backup web service set up/);
});

test("no web tool failure says \"may be temporary\", and none names a tool", async () => {
  const messages = [
    webTools.webFetchFailureMessage({ why: "refused", fallback: "failed" }),
    webTools.webFetchFailureMessage({ why: "refused", fallback: "missing" }),
    webTools.webFetchFailureMessage({ why: "unreachable", fallback: "failed" }),
    webTools.webFetchFailureMessage({ why: "empty", fallback: "failed" }),
    webTools.webFetchFailureMessage({ why: "not-text", fallback: "missing" }),
    webTools.webSearchFailureMessage("failed"),
    webTools.webSearchFailureMessage("missing"),
  ];
  for (const message of messages) {
    assert.doesNotMatch(message, /may be temporary/i, message);
    assert.doesNotMatch(message, /WebFetch|WebSearch|fetch_content|TinyFish|Cursor|MCP/i, message);
    assert.doesNotMatch(message, /—/, `no em dashes: ${message}`);
    assert.match(message, /browser/, `every failure names what the person can do: ${message}`);
  }
});

test("the web-search tool's own provider error carries the same plain words", async () => {
  // web-search.ts pulls in the whole proto graph, so this reads the file rather than importing it.
  // The claim is narrow and worth pinning: the sentence Richard saw is gone from the tool shell,
  // and what replaced it names what the person can do.
  const text = await readFile(path.join(repoRoot, "source/packages/agent/tools/core/web-search.ts"), "utf8");
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(withoutComments, /this may be temporary/i);
  assert.match(text, /Search for it in your browser instead\./);
});

test("the web-fetch tool shell no longer claims to run from somebody else's server", async () => {
  const text = await readFile(path.join(repoRoot, "source/packages/agent/tools/core/web-fetch.ts"), "utf8");
  const withoutComments = text.replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(withoutComments, /isolated server/);
  assert.doesNotMatch(withoutComments, /may return previously cached content/);
  // The localhost and private-IP refusals stay, and matter more now that the fetch runs here.
  assert.match(text, /Cannot fetch from localhost/);
  assert.match(text, /Cannot fetch from private IP/);
  // TOOLS-FETCH-4. The cheap precheck also knows the names the box itself answers to. b66aa1f
  // measured host.docker.internal:7777 as the operator console, readable from inside the box.
  assert.match(withoutComments, /host\.docker\.internal/);
  assert.match(withoutComments, /\.internal/);
});

test("web search maps the backup's results into the tool's document shape", async () => {
  const tinyfish = fakeTinyFish({
    results: [
      { title: "First", url: "https://one.example/", text: "one snippet" },
      { title: "Second", url: "https://two.example/", text: "two snippet" },
    ],
  });
  const search = webTools.createSandWebSearchService({ resolveFallback: () => tinyfish.fallback });
  const result = await search(null, { searchTerm: "how do I renew a domain" });
  assert.deepEqual(tinyfish.calls, [{ kind: "search", query: "how do I renew a domain" }]);
  assert.equal(result.documents.length, 2);
  assert.equal(result.documents[0].url, "https://one.example/");
});

test("web search with nothing set up throws the plain-words message, not a bare provider error", async () => {
  const search = webTools.createSandWebSearchService({ resolveFallback: () => null });
  await assert.rejects(
    () => search(null, { searchTerm: "anything" }),
    (error) => {
      assert.match(error.message, /No web search service is set up on this machine/);
      assert.doesNotMatch(error.message, /may be temporary/i);
      assert.equal(error.clientVisibleErrorMessage, error.modelVisibleErrorMessage);
      return true;
    },
  );
});

test("web search uses the error class the host hands it, so the tool layer can show it", async () => {
  class FakeToolCallError extends Error {
    constructor(fields) { super(fields.error); this.clientVisibleErrorMessage = fields.clientVisibleErrorMessage; }
  }
  const search = webTools.createSandWebSearchService({
    resolveFallback: () => null,
    createError: (fields) => new FakeToolCallError(fields),
  });
  await assert.rejects(() => search(null, { searchTerm: "x" }), FakeToolCallError);
});

/* ---------------------------------------------------------------- *
 * Which route the backup takes.
 * ---------------------------------------------------------------- */

test("the connector wins when it is installed, and the stored key is never touched", async () => {
  let keyReads = 0;
  const resolved = route.resolveWebFallback({
    listConnectors: () => ["localfiles", "tinyfish"],
    readApiKey: () => { keyReads += 1; return "tf-invented-key"; },
    connectorTools: () => ({ callTool: async () => "{}" }),
  });
  assert.equal(resolved.route, "connector");
  assert.equal(keyReads, 0, "the connector route must not read the secret store at all");
});

test("without the connector the stored key takes over, and without either there is no backup", async () => {
  const withKey = route.resolveWebFallback({
    listConnectors: () => ["localfiles"],
    readApiKey: () => "tf-invented-key",
    connectorTools: () => ({ callTool: async () => "{}" }),
    fetchImpl: async () => reply({ contentType: "application/json", body: "{}" }),
  });
  assert.equal(withKey.route, "api");

  const nothing = route.resolveWebFallback({
    listConnectors: () => ["localfiles"],
    readApiKey: () => null,
    connectorTools: () => null,
  });
  assert.equal(nothing, null);

  // A connector entry with the box still down is not a route: fall through to the key.
  const boxDown = route.resolveWebFallback({
    listConnectors: () => ["tinyfish"],
    readApiKey: () => "tf-invented-key",
    connectorTools: () => null,
  });
  assert.equal(boxDown.route, "api");
});

test("the connector route asks for fetch_content with the arguments that tool requires", async () => {
  const seen = [];
  const resolved = route.resolveWebFallback({
    listConnectors: () => ["tinyfish"],
    readApiKey: () => null,
    connectorTools: () => ({
      callTool: async (request) => {
        seen.push(request);
        return request.tool === "search"
          ? JSON.stringify({ results: [{ title: "Only", url: "https://only.example/", snippet: "snip" }] })
          : JSON.stringify({ results: [{ url: "https://x.example/", title: "X", text: "the page text" }], errors: [] });
      },
    }),
  });
  assert.equal(await resolved.fetchPage("https://x.example/"), "# X\n\nthe page text");
  assert.equal(seen[0].server, "tinyfish");
  assert.equal(seen[0].tool, "fetch_content");
  assert.deepEqual(seen[0].args.urls, ["https://x.example/"]);
  assert.equal(seen[0].args.format, "markdown");

  assert.deepEqual(await resolved.search("titanium"), [{ title: "Only", url: "https://only.example/", text: "snip" }]);
  assert.equal(seen[1].tool, "search");
  assert.equal(seen[1].args.query, "titanium");
});

test("the key route dials the documented endpoints with X-API-Key and nothing else", async () => {
  const KEY = `tf-invented-${Math.random().toString(36).slice(2, 10)}`;
  const requests = [];
  const resolved = route.resolveWebFallback({
    listConnectors: () => [],
    readApiKey: () => KEY,
    connectorTools: () => null,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return reply({
        contentType: "application/json",
        body: url.startsWith(route.TINYFISH_SEARCH_ENDPOINT)
          ? JSON.stringify({ results: [{ title: "R", url: "https://r.example/", snippet: "snip" }] })
          : JSON.stringify({ results: [{ url: "https://p.example/", title: "P", text: "body" }] }),
      });
    },
  });
  await resolved.fetchPage("https://p.example/");
  await resolved.search("bank holidays");
  assert.equal(requests[0].url, "https://api.fetch.tinyfish.ai");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["x-api-key"], KEY);
  assert.equal(JSON.parse(requests[0].init.body).urls[0], "https://p.example/");
  assert.equal(requests[1].url, "https://api.search.tinyfish.ai?query=bank%20holidays");
  assert.equal(requests[1].init.headers["x-api-key"], KEY);
  assert.equal(requests[1].init.headers.authorization, undefined, "the REST APIs take the key header, not a bearer");
});

test("a backup that answers with an error payload throws rather than returning an empty page", async () => {
  const resolved = route.resolveWebFallback({
    listConnectors: () => ["tinyfish"],
    readApiKey: () => null,
    connectorTools: () => ({ callTool: async () => JSON.stringify({ results: [], errors: [{ url: "https://x.example/", error: "blocked" }] }) }),
  });
  await assert.rejects(() => resolved.fetchPage("https://x.example/"), /blocked/);
});

/* ---------------------------------------------------------------- *
 * The reduction that makes a page readable.
 * ---------------------------------------------------------------- */

test("script, style and markup come out; headings, lists and entities stay", async () => {
  const html = [
    "<html><head><title>Renewals &amp; billing</title><style>.a{color:red}</style></head>",
    "<body><script>window.x=1</script><h2>How it works</h2><ul><li>First</li><li>Second</li></ul>",
    "<p>Costs &pound;10 &mdash; per year.</p></body></html>",
  ].join("");
  const text = webTools.htmlToText(html);
  assert.doesNotMatch(text, /window\.x/);
  assert.doesNotMatch(text, /color:red/);
  assert.doesNotMatch(text, /</);
  assert.match(text, /^# Renewals & billing/);
  assert.match(text, /## How it works/);
  assert.match(text, /- First/);
  assert.match(text, /- Second/);
  assert.match(text, /Costs £10/);
});

test("a page that is only chrome and script reduces to nothing, which is what triggers the fallback", async () => {
  assert.equal(webTools.htmlToText("<html><head></head><body><script>go()</script></body></html>"), "");
});

test("binary content is not read as text", async () => {
  assert.equal(webTools.isTextualContentType("image/png"), false);
  assert.equal(webTools.isTextualContentType("application/pdf"), false);
  assert.equal(webTools.isTextualContentType("text/html; charset=utf-8"), true);
  assert.equal(webTools.isTextualContentType("application/json"), true);
  assert.equal(webTools.isTextualContentType(""), true);
});
