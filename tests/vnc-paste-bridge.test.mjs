// The relay's rewrite of the box's vnc.html.
//
// The desktop pane is an iframe onto noVNC as the BOX serves it, proxied through the relay. This
// change appends a clipboard bridge and a style to that one page on the way through, and the whole
// risk of the approach is in the word "one": a rewrite that reached the client's JavaScript, or
// that ran twice on a page, would break the desktop for every agent on the box. So this asserts
// the boundary, not the contents -- what gets touched, once, and what does not get touched at all.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VNC_BRIDGE_MARKER, rewriteVncAsset } from "../ui/vnc-bridge.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

// Shaped like the head noVNC actually serves: a module boot script that imports ./app/ui.js, and a
// </head> to append in front of. Nothing here depends on the rest of that page.
const VNC_HTML = [
  "<!DOCTYPE html>",
  "<html>",
  "<head>",
  '<link rel="stylesheet" href="app/styles/base.css">',
  '<script type="module">import UI from "./app/ui.js"; UI.start({});</scr' + "ipt>",
  "</head>",
  '<body><div id="noVNC_control_bar_anchor" class="noVNC_vcenter"></div></body>',
  "</html>",
].join("\n");

test("vnc.html comes back with the bridge appended to its head, exactly once", () => {
  const out = rewriteVncAsset("vnc.html", VNC_HTML);
  assert.equal(countOf(out, VNC_BRIDGE_MARKER), 1, "the bridge is in the page once");
  assert.equal(countOf(out, "</head>"), 1, "and the head is still closed once");
  assert.ok(out.indexOf(VNC_BRIDGE_MARKER) < out.indexOf("</head>"), "the bridge goes inside the head");
  assert.ok(out.startsWith("<!DOCTYPE html>"), "nothing before the doctype");
  // The page the box served is still all there: the rewrite only adds.
  for (const line of VNC_HTML.split("\n")) assert.ok(out.includes(line), `the box's own line survives: ${line}`);
  // What the console needs on the other end of the frame.
  assert.ok(out.includes("titanbot-vnc-paste"), "the page listens for the console's paste message");
  assert.ok(out.includes("clipboardPasteFrom"), "and hands the text to the RFB clipboard call");
  assert.ok(out.includes("titanbot-vnc-clipboard"), "and sends what the box copies back the other way");
  assert.ok(out.includes('import UI from "./app/ui.js"'), "reaching UI the only way vnc.html exposes it, as a module");
  // The bar is the fallback, so what the style hides is part of the contract. noVNC's own drag
  // handle lives inside #noVNC_control_bar_anchor and goes with it; #noVNC_hint_anchor is the drag
  // hint on the opposite edge, reveals nothing, and is left to the client.
  assert.ok(/#noVNC_control_bar_anchor \{ display: none/.test(out), "the control bar anchor is the one thing hidden");
  assert.ok(!out.includes("#noVNC_hint_anchor {"), "noVNC's own hint anchor is left alone");
  assert.ok(out.includes('html.titanbot-vnc-bar #noVNC_control_bar_anchor { display: flex'), "and the restore puts back the anchor's own resting display");
});

test("a page that already carries the bridge is left alone", () => {
  const once = rewriteVncAsset("vnc.html", VNC_HTML);
  const twice = rewriteVncAsset("vnc.html", once);
  assert.equal(twice, once, "a second pass changes nothing");
  assert.equal(countOf(twice, VNC_BRIDGE_MARKER), 1, "and does not inject a second copy");
});

test("nothing but vnc.html is rewritten", () => {
  // The client's own code, its stylesheet, its config, and the lite page beside it. Every one of
  // these is served through the same /vnc/<display>/ route.
  const untouched = {
    "app/ui.js": 'import RFB from "../core/rfb.js";\nexport default { rfb: null };\n',
    "core/rfb.js": "export default class RFB { clipboardPasteFrom(text) { return text; } }\n",
    "app/styles/base.css": ".noVNC_vcenter { display: flex !important; }\n",
    "defaults.json": '{"resize":"scale"}\n',
    "vnc_lite.html": VNC_HTML,
    "app/vnc.html": VNC_HTML,
  };
  for (const [rest, body] of Object.entries(untouched)) {
    const out = rewriteVncAsset(rest, body);
    assert.equal(out, body, `${rest} is passed through unchanged`);
    assert.ok(!out.includes(VNC_BRIDGE_MARKER), `${rest} carries no bridge`);
  }
});

test("a buffer stays a buffer, and a page with no head is not guessed at", () => {
  const asset = Buffer.from("console.log('ui');", "utf8");
  assert.equal(rewriteVncAsset("app/ui.js", asset), asset, "an asset buffer comes back as the same object");
  const page = rewriteVncAsset("vnc.html", Buffer.from(VNC_HTML, "utf8"));
  assert.ok(Buffer.isBuffer(page), "a rewritten page is still a buffer");
  assert.equal(countOf(page.toString("utf8"), VNC_BRIDGE_MARKER), 1, "with the bridge in it once");
  const headless = "<html><body>no head at all</body></html>";
  assert.equal(rewriteVncAsset("vnc.html", headless), headless, "a page with nowhere to inject is served as it came");
});

test("the relay rewrites on the vnc route and nowhere else", () => {
  const server = readFileSync(path.join(repoRoot, "ui", "server.mjs"), "utf8");
  assert.equal(countOf(server, "rewriteVncAsset("), 1, "one call site in the relay");
  const call = server.slice(server.indexOf("rewriteVncAsset("));
  assert.ok(call.startsWith("rewriteVncAsset(rest, Buffer.from(await upstream.arrayBuffer()))"),
    "it wraps the proxied body, so the file name decides and the relay does not");
  // The bridge is a sibling module of the relay, and two tests spawn a copy of the relay out of a
  // temp directory. A copy list that forgot it would fail to boot the server at all. Those two
  // tests now copy every .mjs in ui/ instead of naming modules one at a time, which is the same
  // guarantee and does not need editing again the next time the relay grows a sibling; accept
  // either shape, and keep failing on a fixed list that has dropped the bridge.
  const copiesEveryRelayModule = /readdirSync\(path\.join\(repoRoot, "ui"\)\)[\s\S]{0,120}endsWith\("\.mjs"\)/;
  for (const name of ["relay-login-guards.test.mjs", "relay-trusted-proxies.test.mjs"]) {
    const source = readFileSync(path.join(repoRoot, "tests", name), "utf8");
    assert.ok(source.includes('"vnc-bridge.mjs"') || copiesEveryRelayModule.test(source),
      `${name} copies the bridge module beside the relay`);
  }
});

test("the console half is wired to the same message names", () => {
  const app = readFileSync(path.join(repoRoot, "ui", "machine-room", "app.js"), "utf8");
  assert.ok(app.includes("wireDesktopPaste()"), "the paste bridge is wired at startup");
  assert.ok(app.includes('{ type: "titanbot-vnc-paste", text }'), "a paste is posted at the frame");
  assert.ok(app.includes('data.type === "titanbot-vnc-pasted"'), "and the frame's answer is what the panel reports");
  assert.ok(/Pasted \$\{chars\} character/.test(app), "reported as a count of characters");
  assert.ok(app.includes('{ type: "titanbot-vnc-bar" }'), "the control-bar message is forwarded to the frame");
  assert.ok(app.includes('document.getElementById("desktop-vnc-bar")?.addEventListener("click", handleVncBarButton)'),
    "and the pane's button sends it too, so the fallback is not a keyboard chord alone");
  const html = readFileSync(path.join(repoRoot, "ui", "machine-room", "index.html"), "utf8");
  assert.ok(/id="desktop-paste-note"/.test(html), "the desktop panel carries the note element");
  assert.ok(/Shift \+ B/.test(html), "which names the way back to noVNC's own clipboard bar");
  assert.ok(/while this pane has the keyboard/.test(html), "and scopes the paste claim to when the browser still delivers one");
  assert.ok(/id="desktop-vnc-bar"/.test(html), "the pane carries the button that shows that bar");
});

test("the bridge never reads UI at module top level, because WebKit hands it over uninitialised (beta-36-2, 2026-09-12)", () => {
  const out = String(rewriteVncAsset("vnc.html", "<html><head></head><body></body></html>"));
  const bridge = out.slice(out.indexOf("<script type=\"module\">"), out.indexOf("</script>"));
  assert.ok(!/\narmClipboard\(\);/.test(bridge), "the first arm is on the load event, not a synchronous top-level call");
  assert.ok(bridge.includes("window.addEventListener(\"load\", armClipboard)"));
  assert.ok(bridge.includes("const uiNow = () => { try { return UI; }"), "every read of UI goes through the guard");
  assert.ok(!/[^.\w]UI\.rfb/.test(bridge), "no bare UI.rfb read is left in the bridge");
});
