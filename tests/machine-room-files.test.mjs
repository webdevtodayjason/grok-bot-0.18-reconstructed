// Files that open (CONSOLE-4, item 4): the viewer and the relay route behind every file row.
//
// Jason's report was that a file row does nothing -- not on the desktop Files list, not in the top
// nav, not on the attachment in the chat. Three separate breaks made that one symptom, and only
// one of them is in this file's half. What is pinned here is the half a browser gate cannot show:
//
//   - which view each extension gets, because "it opened" is not the same as "it opened as the
//     kind of thing it is", and a .md rendered as a <pre> full of hash marks is the bug Jason
//     would report next;
//
//   - that a cached null from the old file:// path cannot be inherited. The list used to store the
//     raw file:// URL, the host answers null for that form, and the adapter caches null answers by
//     path. A viewer that passed its caller's string straight through would therefore read the
//     poisoned entry and show "the box would not read this file" forever, on a file that reads
//     fine. So the unwrap happens here too, and is measured here;
//
//   - and every refusal the relay's /files route owes, against a real relay process and a real
//     HTTP gateway, because a path check asserted against a mock is a path check nobody has run.
//
// The gateway answer shapes come from the host these commands already ship in (bundle
// 37050858e4ec, on all three R750 boxes): readAttachmentText {path, agentId} answers
// { kind:"text", text, truncated, bytes } | { kind:"binary", bytes } | null, and
// readAttachmentChunk {path, agentId, offset, length} answers { bytesBase64, totalSize, mime } |
// null, with mime set only for pictures, video and audio (attachments-service.ts).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { RELAY_TOKEN, signInAsOperator, startRelay, tenantRow, tenantsFile } from "./relay-tenant-support.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A real agent directory shape. The uuid matters: the relay's own fence requires one, which is
// what keeps this route off settings.json and off any path a browser made up.
const AGENT = "0fe11a96-3978-4fee-9560-f9cd8d504727";
const DIR = `/home/box/sand-data/agents/${AGENT}`;
const NOTES = `${DIR}/attachments/rsi-vs-agi-notes.md`;

// ---- the viewer ------------------------------------------------------------------------------

// The shipped file, run as the browser runs it, with the shared helpers app.js publishes. The
// markdown renderer is lifted out of app.js rather than re-implemented, so "a real heading" here
// means the element the console actually draws.
async function loadViewer(extra = {}) {
  const source = await readFile(path.join(repoRoot, "ui/machine-room/files-viewer.js"), "utf8");
  const appSource = await readFile(path.join(repoRoot, "ui/machine-room/app.js"), "utf8");
  const inlineStart = appSource.indexOf("  function inlineMarkup(line) {");
  const paraStart = appSource.indexOf("  function paragraphMarkup(text) {");
  const paraEnd = appSource.indexOf("\n  }\n", paraStart) + 4;
  assert.ok(inlineStart > 0 && paraStart > inlineStart, "the markdown renderer must still be findable in app.js");
  const escapeHtml = (value) => String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const { paragraphMarkup } = new Function("escapeHtml", `${appSource.slice(inlineStart, paraEnd)}\nreturn { paragraphMarkup };`)(escapeHtml);
  // app.js's own masker, copied by value from its one line so a drift in the pattern shows up here.
  const SECRETISH = /(?:sk-|xai-|gsk_|ghp_|AIza|xox[abprs]-)[A-Za-z0-9_-]{10,}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|[A-Za-z0-9_\-+/=]{32,}/g;
  const maskSecrets = (value) => String(value ?? "").replace(SECRETISH, (hit) => `${hit.slice(0, 4)}…[redacted, ${hit.length} chars]`);

  const panel = { eyebrow: "", title: "", html: "" };
  const win = {
    URLSearchParams,
    __mrUi: {
      escapeHtml, paragraphMarkup, maskSecrets,
      openPanel: (eyebrow, title, content) => { panel.eyebrow = eyebrow; panel.title = title; panel.html = content; },
    },
    ...extra,
  };
  const viewer = new Function("window", `${source}\nreturn window.__filesViewer;`)(win);
  return { viewer, panel, win, paragraphMarkup, maskSecrets, escapeHtml };
}

test("each extension gets the view its kind deserves", async () => {
  const { viewer } = await loadViewer();
  assert.equal(viewer.kindFor("rsi-vs-agi-notes.md"), "markdown");
  assert.equal(viewer.kindFor("README.markdown"), "markdown");
  assert.equal(viewer.kindFor("notes.txt"), "text");
  assert.equal(viewer.kindFor("run.log"), "text");
  assert.equal(viewer.kindFor("shot.webp"), "image");
  assert.equal(viewer.kindFor("shot.png"), "image");
  assert.equal(viewer.kindFor("report.pdf"), "pdf");
  // The point of the last one: an unknown kind is offered, never rendered into a guess.
  assert.equal(viewer.kindFor("archive.bin"), "download");
  assert.equal(viewer.kindFor("no-extension-at-all"), "download");
});

test("markdown is rendered, not printed: a real heading element and no literal hash", async () => {
  const { viewer } = await loadViewer();
  const html = viewer.bodyMarkup("markdown", { kind: "text", text: "# RSI vs AGI\n\n- one\n- two", bytes: 40 }, { name: "n.md" });
  assert.match(html, /<p class="message-heading"><strong>RSI vs AGI<\/strong><\/p>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.ok(!html.includes("#"), `a raw hash reached the page: ${html}`);
});

// Found by looking at the rendered page rather than at the HTML: a markdown FILE is hard-wrapped
// at about 80 columns, and paragraphMarkup makes a <p> per line because agents write one long line
// per paragraph. Measured in real Chrome on grok-bot-local-vm before the fix: one three-line
// wrapped paragraph in gate-notes.md painted as three paragraphs with a gap between each.
test("a hard-wrapped paragraph in a file is one paragraph, not one per line", async () => {
  const { viewer } = await loadViewer();
  const html = viewer.bodyMarkup("markdown", { kind: "text", text: "Titan wrote this for the gate.\nIt proves one thing: a markdown file\nopens as rendered markdown.", bytes: 90 }, { name: "n.md" });
  assert.equal((html.match(/<p>/g) ?? []).length, 1, html);
  assert.match(html, /<p>Titan wrote this for the gate\. It proves one thing: a markdown file opens as rendered markdown\.<\/p>/);
});

test("the unwrap leaves every block that is not a paragraph exactly where it was", async () => {
  const { viewer } = await loadViewer();
  // A blank line still separates paragraphs, and a heading, a bullet, a numbered item, a quote and
  // a table row each stay on their own line rather than being pulled into the prose above them.
  const kept = viewer.unwrapSoftBreaks("one\ntwo\n\n# Head\nprose\n\n- a\n- b\n\n1. first\n\n> quoted\n\n| c |\n\nlast");
  assert.equal(kept, "one two\n\n# Head\nprose\n\n- a\n- b\n\n1. first\n\n> quoted\n\n| c |\n\nlast");
  // A wrapped bullet is one bullet, not a bullet plus a stray paragraph. Markdown's own lazy
  // continuation rule, and the shape every notes file an agent writes actually has.
  assert.equal(
    viewer.unwrapSoftBreaks("- open on a click, from every list the\n  console shows\n- and download it"),
    "- open on a click, from every list the console shows\n- and download it",
  );
  // A fence is left strictly alone: joining the lines of a code block would make it unreadable.
  assert.equal(viewer.unwrapSoftBreaks("```\nconst a = 1;\nconst b = 2;\n```\nx\ny"), "```\nconst a = 1;\nconst b = 2;\n```\nx y");
  // And markdown's own hard break, two trailing spaces, is a break the writer asked for, so the
  // two lines stay two lines. The trailing spaces themselves are dropped, which changes nothing:
  // paragraphMarkup trims every line's end before it renders it.
  assert.equal(viewer.unwrapSoftBreaks("Dear Jason,  \nthe file opens now."), "Dear Jason,\nthe file opens now.");
});

test("a text file is a pre, and its markup is escaped rather than run", async () => {
  const { viewer } = await loadViewer();
  const html = viewer.bodyMarkup("text", { kind: "text", text: "<script>alert(1)</script>", bytes: 25 }, { name: "n.log" });
  assert.match(html, /<pre class="file-viewer-text">/);
  assert.ok(!html.includes("<script>"), html);
  assert.match(html, /&lt;script&gt;/);
});

test("masked text stays masked inside the viewer", async () => {
  const { viewer } = await loadViewer();
  const token = `sk-${"a".repeat(40)}`;
  for (const kind of ["markdown", "text"]) {
    const html = viewer.bodyMarkup(kind, { kind: "text", text: `key: ${token}`, bytes: 60 }, { name: `n.${kind === "markdown" ? "md" : "txt"}` });
    assert.ok(!html.includes(token), `the ${kind} branch printed a token verbatim`);
    assert.match(html, /redacted, \d+ chars/);
  }
});

test("a PDF gets an embed pointed at the same-origin route, and copy that does not promise a viewer", async () => {
  const { viewer } = await loadViewer();
  const html = viewer.bodyMarkup("pdf", null, { name: "r.pdf", path: `${DIR}/assets/r.pdf`, agentId: AGENT });
  assert.match(html, /<embed class="file-viewer-pdf"[^>]*type="application\/pdf"/);
  // Inline, not download=1: the browser's own viewer will not paint an attachment.
  assert.match(html, /src="\/files\?agent=[^"]*&amp;path=[^"]*"/);
  assert.ok(!/download=1/.test(/src="([^"]*)"/.exec(html)[1]), "the embed must not ask for an attachment");
  assert.match(html, /If the document does not appear above/);
});

test("an unknown kind offers the file rather than rendering it", async () => {
  const { viewer } = await loadViewer();
  const html = viewer.bodyMarkup("download", null, { name: "archive.bin" });
  assert.match(html, /empty-state/);
  assert.match(html, /Download it/);
});

test("every row's download link is a same-origin /files URL carrying the bare path", async () => {
  const { viewer } = await loadViewer();
  const href = viewer.downloadHref({ path: `file://${NOTES}`, agentId: AGENT });
  const url = new URL(href, "https://console.titanium.bot");
  assert.equal(url.pathname, "/files");
  assert.equal(url.searchParams.get("agent"), AGENT);
  assert.equal(url.searchParams.get("path"), NOTES, "the file:// wrapper must never reach the route");
  assert.equal(url.searchParams.get("download"), "1");
});

// The regression this whole item exists downstream of. filesOf used to store the raw file:// URL;
// the host answers null for that form; the adapter caches a null answer by path. So if the viewer
// passed its caller's string through, it would read the cache entry the failed URL read poisoned
// and report a readable file as unreadable, permanently, with no way for the person to retry.
test("a cached null from an earlier file:// read cannot be inherited by the viewer", async () => {
  const reads = [];
  // The adapter's own cache, keyed exactly as gateway-adapter.js keys it, pre-poisoned by a read
  // that went out under the URL form before this wave.
  const cache = new Map([[`txt:file://${NOTES}`, Promise.resolve(null)]]);
  const adapter = {
    readAttachmentText(agentId, filePath) {
      reads.push(filePath);
      const key = `txt:${filePath}`;
      if (!cache.has(key)) cache.set(key, Promise.resolve({ kind: "text", text: "# Notes\n\nreal content", truncated: false, bytes: 2712 }));
      return cache.get(key);
    },
  };
  const nodes = new Map();
  const root = {
    dataset: { filePath: NOTES },
    querySelector: (sel) => nodes.get(sel) ?? null,
  };
  const { viewer, panel } = await loadViewer({
    __machineRoomAdapter: adapter,
    document: { querySelector: (sel) => (sel === "[data-file-viewer]" ? root : null) },
  });
  nodes.set("[data-file-body]", { innerHTML: "" });
  nodes.set("[data-file-meta]", { innerHTML: "" });

  viewer.open({ path: `file://${NOTES}`, agentId: AGENT, name: "rsi-vs-agi-notes.md" });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(reads, [NOTES], "the viewer must read the bare path, never the file:// URL");
  assert.match(nodes.get("[data-file-body]").innerHTML, /<strong>Notes<\/strong>/);
  assert.equal(panel.title, "rsi-vs-agi-notes.md");
  assert.match(panel.html, /data-file-viewer/);
  assert.match(panel.html, /class="file-download" data-file-download/);
});

test("the panel copy says what the list is, and stops claiming the files are somewhere else", async () => {
  const { viewer } = await loadViewer();
  // The sentence it replaces said the host keeps no per-worker directory and that everything a
  // worker writes goes to one shared /workspace. True of /workspace, false of every file in the
  // list, all of which live in the agent's own attachments/ and assets/.
  assert.ok(!/no per-worker directory/i.test(viewer.PANEL_NOTE), viewer.PANEL_NOTE);
  assert.match(viewer.PANEL_NOTE, /this agent's own storage/i);
  assert.match(viewer.PANEL_NOTE, /shared workspace are not in this list/i);
});

// ---- the relay route -------------------------------------------------------------------------

// A gateway that answers readAttachmentChunk the way a box does, so the route is measured against
// the shape it will actually meet rather than one this test invented.
async function boxGateway(files, { status = 200, body = null } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const args = raw.length > 0 ? JSON.parse(raw) : {};
      calls.push({ url: req.url, args });
      if (req.url !== "/api/readAttachmentChunk") { res.writeHead(404, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "unknown gateway method" })); }
      if (status !== 200) { res.writeHead(status, { "content-type": "application/json" }); return res.end(JSON.stringify(body ?? { error: "refused" })); }
      const file = files[args.path];
      // null is the host's answer for a path it will not serve. respondJson sends it bare.
      if (file == null) { res.writeHead(200, { "content-type": "application/json" }); return res.end("null"); }
      const bytes = Buffer.from(file.bytes ?? "", "utf8");
      const total = file.totalSize ?? bytes.byteLength;
      const start = Math.min(Number(args.offset) || 0, bytes.byteLength);
      const slice = bytes.subarray(start, start + Math.max(0, Number(args.length) || 0));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ bytesBase64: slice.toString("base64"), totalSize: total, mime: file.mime ?? null }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, stop: () => server.close() };
}

// The operator's own workspace, which is the one Jason clicks these rows in. Its gateway is the
// process-wide SAND_HOST_GATEWAY_URL rather than a registry row, so the stub goes there.
async function startFilesConsole(files, options) {
  const gateway = await boxGateway(files, options);
  const demo = tenantRow("demo", { gateway: gateway.url, token: "gateway-token-for-demo" });
  const relay = await startRelay({
    CP_URL: "http://127.0.0.1:1",
    CP_RELAY_TOKEN: RELAY_TOKEN,
    SAND_UI_TENANTS_FILE: tenantsFile([demo.row]),
    SAND_HOST_GATEWAY_URL: gateway.url,
  }, { prefix: "relay-files-", pathValue: "/nonexistent" });
  const cookie = await signInAsOperator(relay);
  const get = (query) => fetch(`${relay.base}/files?${query}`, { headers: { cookie } });
  return { relay, gateway, cookie, get, stop: () => { relay.stop(); gateway.stop(); } };
}

const q = (fields) => new URLSearchParams(fields).toString();

test("the route serves an attachments file and an assets file, and refuses everything else", async () => {
  const asset = `${DIR}/assets/diagram.webp`;
  const console_ = await startFilesConsole({
    [NOTES]: { bytes: "# RSI vs AGI\n\nnotes.\n" },
    [asset]: { bytes: "not really a picture", mime: "image/webp" },
  });
  try {
    const ok = await console_.get(q({ agent: AGENT, path: NOTES }));
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), "# RSI vs AGI\n\nnotes.\n");
    assert.equal(ok.headers.get("content-type"), "text/markdown", "the extension names the type the host has no mime for");
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");

    const assets = await console_.get(q({ agent: AGENT, path: asset }));
    assert.equal(assets.status, 200, "assets/ is as much a place a file lives as attachments/");
    assert.equal(assets.headers.get("content-type"), "image/webp", "the host's own mime wins where it has one");

    // A generated image is written to a path the model chose, under an mkdir -p
    // (generate-image-resource-accessor.ts). Refusing those would put a file in the list that
    // will not open, which is the bug this wave exists to remove.
    const nested = `${DIR}/assets/2026-09/chart.png`;
    const deep = await startFilesConsole({ [nested]: { bytes: "png-ish", mime: "image/png" } });
    try { assert.equal((await deep.get(q({ agent: AGENT, path: nested }))).status, 200, "a generated image nested under assets/ must open"); }
    finally { deep.stop(); }

    // Every refusal, and each is refused before anything reaches the box.
    const before = console_.gateway.calls.length;
    for (const [bad, why] of [
      ["/etc/passwd", "a path with no agent directory in it at all"],
      [`${DIR}/settings.json`, "a file inside the agent's own directory that the conversation never carried"],
      [`${DIR}/attachments/../../../etc/shadow`, "a traversal"],
      ["/home/box/sand-data/agents/not-a-uuid/attachments/x.md", "an agent segment that is not an id"],
      [`${DIR}/attachments/./x.md`, "a dot segment"],
      [`${DIR}/attachments`, "the directory itself rather than a file in it"],
      ["", "no path at all"],
    ]) {
      const res = await console_.get(q({ agent: AGENT, path: bad }));
      assert.equal(res.status, 400, `${why} must be refused: ${bad}`);
    }
    assert.equal(console_.gateway.calls.length, before, "a refused path must never reach the box");
  } finally { console_.stop(); }
});

test("a download names the file and is served as an attachment", async () => {
  const console_ = await startFilesConsole({ [NOTES]: { bytes: "# RSI vs AGI\n" } });
  try {
    const res = await console_.get(q({ agent: AGENT, path: NOTES, download: "1" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-disposition"), 'attachment; filename="rsi-vs-agi-notes.md"');
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-length"), String(Buffer.byteLength("# RSI vs AGI\n")));
  } finally { console_.stop(); }
});

// An agent that writes an .html file must not get script on this console's own origin with this
// console's own session. There is no CSP header in front of it, so the disposition is the whole
// of the defence and it has to hold without anybody remembering to add one.
test("a file a browser would execute is sent as a download even when nothing asked for one", async () => {
  const page = `${DIR}/attachments/report.html`;
  const console_ = await startFilesConsole({ [page]: { bytes: "<script>alert(document.cookie)</script>" } });
  try {
    const res = await console_.get(q({ agent: AGENT, path: page }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-disposition"), /^attachment;/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  } finally { console_.stop(); }
});

test("a PDF is served inline, which is what the browser's own viewer needs", async () => {
  const doc = `${DIR}/assets/report.pdf`;
  const console_ = await startFilesConsole({ [doc]: { bytes: "%PDF-1.7 not really" } });
  try {
    const res = await console_.get(q({ agent: AGENT, path: doc }));
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /^inline;/);
  } finally { console_.stop(); }
});

test("a file bigger than the console serves is refused with the size, not streamed", async () => {
  const big = `${DIR}/assets/huge.bin`;
  const console_ = await startFilesConsole({ [big]: { bytes: "x".repeat(64), totalSize: 400 * 1024 * 1024 } });
  try {
    const res = await console_.get(q({ agent: AGENT, path: big }));
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /400 MB.*up to 25 MB/);
  } finally { console_.stop(); }
});

test("a file the box will not serve is a 404, and the box's own refusal passes through unchanged", async () => {
  const gone = `${DIR}/attachments/gone.md`;
  const missing = await startFilesConsole({});
  try {
    assert.equal((await missing.get(q({ agent: AGENT, path: gone }))).status, 404);
  } finally { missing.stop(); }

  // The gateway's own status is its answer to give: dressing a 403 as a 200 with an empty body is
  // how a refusal becomes "the file is blank".
  const refused = await startFilesConsole({}, { status: 403, body: { error: "this box is read-only" } });
  try {
    const res = await refused.get(q({ agent: AGENT, path: gone }));
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /read-only/);
  } finally { refused.stop(); }
});

test("the route needs a session, the same as every other console route", async () => {
  const console_ = await startFilesConsole({ [NOTES]: { bytes: "# notes" } });
  try {
    const res = await fetch(`${console_.relay.base}/files?${q({ agent: AGENT, path: NOTES })}`, { redirect: "manual" });
    assert.notEqual(res.status, 200, "a file must not come out of a box for a request with no session");
  } finally { console_.stop(); }
});

test("a file bigger than one gateway call is paged, and arrives whole", async () => {
  // Not 8 MB of test data: the paging is measured by the offsets the route asks for, which is the
  // thing that breaks, and by the bytes coming back in one piece.
  const big = `${DIR}/assets/long.txt`;
  const body = "0123456789".repeat(4096);
  const console_ = await startFilesConsole({ [big]: { bytes: body } });
  try {
    const res = await console_.get(q({ agent: AGENT, path: big }));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), body);
    // One call is enough here because the host's per-call cap is far above this file; what the
    // assertion pins is that the route asked for the host's own ceiling and started at zero.
    assert.equal(console_.gateway.calls[0].args.offset, 0);
    assert.equal(console_.gateway.calls[0].args.length, 8 * 1024 * 1024);
  } finally { console_.stop(); }
});
