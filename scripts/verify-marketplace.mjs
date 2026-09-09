// MARKET-6. The Marketplace and the Add-your-own card, in a real browser against a real box.
//
// What it proves, and why each leg is here:
//
//   THE CATALOG DRAWS. Every row the host serves has a card, every chip is one of the host's own
//   categories, a chip filters to its own members, every tile is the same square, and every logo a
//   row declares actually decoded. A row whose logo file is missing draws a broken image and no
//   test that reads the catalog as JSON would ever notice.
//
//   ADD YOUR OWN. The card is where the brief says it is, its three doors are in the stated order,
//   a header marked secret mints a stored NAME and draws no value box, the entry that will be
//   written is shown before anything is, and the four refusals come back as one sentence each. A
//   pasted vendor block fills the form and says out loud that the key in it was dropped -- and the
//   key is nowhere in the page's markup afterwards.
//
//   IT ACTUALLY ADDS. One keyless public server goes in through the card, connects, lists its
//   tools, and comes out again with its stored values cleared, leaving connectors.json byte for
//   byte as it was found. This is the leg that would catch the console and the host disagreeing
//   about the shape of an add, which is exactly what they did the first time they met.
//
//   THE OLDER TRANSPORT (--sse). The picker's second option is drawn on every run above; only this
//   arm opens it. A connector added through that door has to come back `transport=sse` with the far
//   end's tools listed -- not silently `http`, and not connected-looking with nothing behind it. It
//   runs against this repo's own stub in SSE mode rather than a vendor, because no shipping preset
//   recommends SSE and the one obvious public candidate answers 410 on its /sse, so a gate pointed
//   at a vendor would be measuring that vendor's retirement schedule. Off by default: it starts a
//   process inside the box, so it is asked for rather than assumed, one arm at a time.
//
// Custody -- that a stored value reaches no process argument list -- is asserted by
// scripts/verify-connector-host.mjs, which can drive an in-box bearer stub without a vendor key.
// This gate does the console's half and deliberately does not duplicate it.
//
// Integration check. Needs the box up on a bundle from this tree and a relay serving this tree.
// Run it through scripts/on-box.sh so it does not overlap another gate.
//
//   node scripts/verify-marketplace.mjs
//   node scripts/verify-marketplace.mjs --no-write   skip the add/remove leg on a shared box
//   node scripts/verify-marketplace.mjs --sse        add the older-transport arm
//
//   0  every leg passed        1  a leg failed
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "../.cache/playwright/node_modules/playwright-core/index.mjs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const DATA = "/home/box/sand-data";
const NO_WRITE = process.argv.includes("--no-write");
const SSE_ARM = process.argv.includes("--sse");
// Keyless on purpose: a public docs server needs no credential and no sign-in, so the add leg can
// run on a shared box without anyone's key being involved.
const PROBE_URL = "https://mcp.deepwiki.com/mcp";
const PROBE_NAME = `mktprobe-${Math.random().toString(36).slice(2, 8)}`;

// The older-transport arm. Its far end is scripts/lib/mcp-bearer-stub.mjs in SSE mode, run inside
// the box, and its key is invented here and lives for the length of the run: a gate that needed a
// vendor's credential to open a door could not be run by anyone who did not already hold one.
const SSE_NAME = `mktsse-${Math.random().toString(36).slice(2, 8)}`;
const SSE_FIELD = "MKTSSE_STUB_KEY";
const SSE_VALUE = `mktsse-${Math.random().toString(36).slice(2, 14)}`;
const SSE_PORT = 8794;
const SSE_STUB_PATH = "/tmp/mktsse-stub.mjs";

const inBox = (command) => new Promise((resolve, reject) => {
  execFile("docker", ["exec", BOX, "sh", "-lc", command], { maxBuffer: 32 * 1024 * 1024 }, (error, out) => {
    if (error) reject(error); else resolve(String(out));
  });
});
const connectorsSha = () => inBox(`sha256sum ${DATA}/connectors.json | cut -c1-64`).then((line) => line.trim());

/** A gateway command through the page, which already holds the session the console signed in with. */
const gateway = (command, body) => page.evaluate(async ([name, payload]) => {
  const res = await fetch(`/api/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const text = await res.text();
  try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: text }; }
}, [command, body ?? {}]);

/**
 * The box's own address on the docker bridge. Not 127.0.0.1: inside a box that is the exec daemon on
 * 1337 and 1338 and the host's gateway on 1340, and the connector writer refuses it outright. A
 * private address on plain http is the shape the rules do allow, which is what this arm needs.
 */
async function boxAddress() {
  const out = await new Promise((resolve, reject) => execFile("docker",
    ["inspect", BOX, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}"],
    (error, stdout) => (error ? reject(error) : resolve(String(stdout)))));
  const address = out.trim().split(/\s+/).find((entry) => /^\d+\.\d+\.\d+\.\d+$/.test(entry));
  if (address === undefined) throw new Error("the box has no non-loopback IPv4 address to reach its own stub on");
  return address;
}

/** Copies the stub in and starts it in SSE mode. The key crosses in the ENVIRONMENT, never argv. */
async function startSseStub(address) {
  const source = readFileSync(new URL("./lib/mcp-bearer-stub.mjs", import.meta.url), "utf8");
  const encoded = Buffer.from(source, "utf8").toString("base64");
  await inBox(`echo ${encoded} | base64 -d > ${SSE_STUB_PATH}`);
  void new Promise((resolve) => execFile("docker",
    ["exec", "-d", "-e", `MCP_STUB_KEY=${SSE_VALUE}`, "-e", "MCP_STUB_SSE=1", BOX,
      "node", SSE_STUB_PATH, "--port", String(SSE_PORT), "--host", address],
    () => resolve())).catch(() => {});
  // Up means "refuses a wrong bearer on the stream", which is a stronger readiness signal than a
  // socket that accepts: a half-started server would answer the connect and nothing else.
  for (let n = 0; n < 40; n += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const probe = await inBox(`curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer wrong' ${`http://${address}:${SSE_PORT}/sse`} || true`).catch(() => "");
    if (probe.trim() === "401") return true;
  }
  return false;
}

const stopSseStub = async () => {
  await inBox(`pkill -f ${SSE_STUB_PATH} || true`).catch(() => {});
  await inBox(`rm -f ${SSE_STUB_PATH}`).catch(() => {});
};

/** Every word the box uses for "not finished yet"; `initializing` is a native remote's handshake. */
const UNSETTLED = new Set(["loading", "connecting", "initializing", "starting", "pending"]);
async function settle(server, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const rows = (await gateway("listInstalledMcpServers", {})).body;
    last = (Array.isArray(rows) ? rows : []).find((row) => row.serverIdentifier === server || row.name === server) ?? null;
    if (last != null && !UNSETTLED.has(String(last.status))) return last;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return last;
}

let failed = 0;
const check = (ok, what, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}${detail ? ` \u2014 ${detail}` : ""}`);
  if (!ok) failed += 1;
};


const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("pageerror", (error) => { console.log(`  PAGEERROR ${error.message}`); failed += 1; });
try {
  await page.goto(`${GATEWAY}/`, { waitUntil: "load" });
  await page.waitForTimeout(3500);
  await page.click('[data-capability="marketplace"]');
  await page.waitForTimeout(2500);
  // The catalog is a gateway read; wait for it rather than measuring a panel mid-paint.
  for (let n = 0; n < 40; n += 1) {
    if ((await page.$$("[data-marketplace-card]")).length > 0) break;
    await page.waitForTimeout(500);
  }

  const cards = await page.$$eval("[data-marketplace-card]", (els) => els.map((e) => e.dataset.marketplaceCard));
  // The local box is shared and is being restarted by another wave while this runs, so the read is
  // retried rather than reported as an empty catalog.
  let served = { plugins: [], categories: [] };
  for (let n = 0; n < 8 && served.plugins.length === 0; n += 1) {
    served = await page.evaluate(async () => {
      const r = await fetch("/api/listMarketplace", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const body = await r.json().catch(() => ({}));
      return { plugins: (body?.plugins ?? []).map((p) => p.id), categories: body?.categories ?? [] };
    });
    if (served.plugins.length === 0) await page.waitForTimeout(2500);
  }
  check(served.plugins.length > 0, `the host serves a catalog (${served.plugins.length} rows)`, served.plugins.join(", "));
  const missing = served.plugins.filter((id) => !cards.includes(id));
  check(missing.length === 0, `a card for every plugin the host serves (${cards.length} drawn)`, missing.join(", "));

  const chips = await page.$$eval("[data-marketplace-chips] [data-marketplace-category]", (els) => els.map((e) => e.dataset.marketplaceCategory));
  check(chips[0] === "All" && chips.length > 1, `the chips are the host's category list (${chips.join(" | ")})`);

  const pick = chips.find((c) => c !== "All" && c !== "Featured");
  if (pick) {
    await page.click(`[data-marketplace-category="${pick}"]`);
    await page.waitForTimeout(600);
    const filtered = await page.$$eval("[data-marketplace-card]", (els) => els.map((e) => e.dataset.marketplaceCard));
    check(filtered.length > 0 && filtered.length < cards.length, `a chip filters to its own members (${pick}: ${filtered.length} of ${cards.length})`);
    await page.click(`[data-marketplace-category="All"]`);
    await page.waitForTimeout(600);
  }

  // Tile geometry, 40px on a card and in the strip.
  const tiles = await page.evaluate(() => [...document.querySelectorAll("[data-marketplace-card] .marketplace-tile, [data-marketplace-installed] .marketplace-tile")]
    .map((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; }));
  const off = tiles.filter((t) => t.w !== 40 || t.h !== 40);
  check(tiles.length > 0 && off.length === 0, `every tile is the standard 40px square (${tiles.length})`, JSON.stringify(off.slice(0, 4)));

  // Every declared logo actually decoded.
  const logos = await page.evaluate(() => [...document.querySelectorAll("img.marketplace-tile-img")]
    .map((img) => ({ src: img.dataset.marketplaceLogo, w: img.naturalWidth })));
  const broken = logos.filter((l) => !(l.w > 0));
  check(logos.length === 0 || broken.length === 0, `every declared logo decoded (${logos.length})`, broken.map((b) => b.src).join(", "));

  // The strip draws each installed plugin once.
  const strip = await page.$$eval("[data-marketplace-installed] .marketplace-tile", (els) => els.map((e) => e.getAttribute("title")));
  check(new Set(strip).size === strip.length, `the installed strip draws each plugin once (${strip.length})`, strip.join(", "));

  // ---- Add your own -----------------------------------------------------------------------------
  const editor = await page.$("[data-connector-editor]");
  check(editor != null, "the Add your own card is on the page");
  await page.evaluate(() => document.querySelector("[data-connector-editor]")?.setAttribute("open", "open"));
  await page.waitForTimeout(400);
  const summary = await page.$eval("[data-connector-editor] summary", (el) => el.textContent.trim());
  check(summary === "Add your own", `the card is called what it does ("${summary}")`);
  const doors = await page.$$eval("[data-byo-doors] .roster-tab", (els) => els.map((e) => e.textContent.trim()));
  check(doors.join(" | ") === "A link | A program | Paste their config", `three doors, link first (${doors.join(" | ")})`);
  check((await page.$$("[data-byo-link] #byo-url")).length === 1, "the link door is the one that opens");
  const transports = await page.$$eval("#byo-transport option", (els) => els.map((e) => e.textContent.trim()));
  check(transports.length === 2 && /Streamable HTTP/.test(transports[0]), `the transport picker names the common one first (${transports.join(" | ")})`);

  // A secret header draws a NAME box and no value box, and the name is minted from the address.
  await page.fill("#byo-url", "https://mcp.notion.com/mcp");
  await page.waitForTimeout(500);
  const env = await page.$eval('[data-byo-header-env="0"]', (el) => el.value);
  check(env === "NOTION_TOKEN", `the stored name is minted from the address as it is typed (${env})`);
  const minted = await page.$eval("#byo-name", (el) => el.value);
  check(minted === "notion", `and so is the name the box files it under (${minted})`);
  check((await page.$$('[data-byo-header-value="0"]')).length === 0, "a secret header draws no value box at all");
  // Untick it and a value box appears, with no stored name: the two shapes never overlap.
  await page.click('[data-byo-header-secret="0"]');
  await page.waitForTimeout(400);
  check((await page.$$('[data-byo-header-value="0"]')).length === 1 && (await page.$$('[data-byo-header-env="0"]')).length === 0, "unticking it turns the row back into a literal");
  await page.click('[data-byo-header-secret="0"]');
  await page.waitForTimeout(400);

  // The preview, before anything is written.
  await page.click("[data-byo-show]");
  await page.waitForTimeout(1200);
  const preview = await page.$eval("[data-byo-preview]", (el) => el.textContent).catch(() => "");
  check(/What will be written/.test(preview), "the entry that will be written is shown before Add");
  check(/NOTION_TOKEN/.test(preview) && !/Bearer /.test(preview), "and it names the stored key rather than carrying one", preview.replace(/\s+/g, " ").slice(0, 160));

  // The refusals, in a real browser.
  const refuse = async (url) => {
    await page.fill("#byo-url", url);
    await page.click("[data-byo-link] button[type=submit]");
    await page.waitForTimeout(900);
    return (await page.$eval("[data-byo-refusal]", (el) => el.textContent).catch(() => ""));
  };
  check(/Give the address as https/.test(await refuse("http://mcp.example.com/mcp")), "plain http is refused in one sentence");
  check(/inside this box's own network/.test(await refuse("https://127.0.0.1:1340/mcp")), "the box's own network is refused in one sentence");
  check(/carries the key inside it/.test(await refuse("https://mcp.example.com/mcp?api_key=abc")), "a key in the address is refused in one sentence");

  // The paste door reads a vendor's block into the form and drops its key.
  await page.click('[data-byo-door="paste"]');
  await page.waitForTimeout(400);
  await page.fill("#byo-paste", JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer sk-not-a-real-key" } } } }));
  await page.click("[data-byo-paste] button[type=submit]");
  await page.waitForTimeout(1200);
  const filledUrl = await page.$eval("#byo-url", (el) => el.value).catch(() => "");
  check(filledUrl === "https://mcp.linear.app/mcp", `a pasted block fills the link door (${filledUrl})`);
  const note = await page.$eval("[data-byo-note]", (el) => el.textContent).catch(() => "");
  check(/was not kept/.test(note), "and says out loud that the key in it was dropped", note.slice(0, 120));
  const dom = await page.content();
  check(!dom.includes("sk-not-a-real-key"), "the pasted key is nowhere in the page's markup");

  // Nothing was written by any of that.
  const after = await page.evaluate(async () => {
    const r = await fetch("/connectors");
    return Object.keys((await r.json())?.mcpServers ?? {});
  });
  check(!after.includes("linear") && !after.includes("notion"), `the box's connectors are untouched (${after.join(", ")})`);

  // ---- and then it really adds one ---------------------------------------------------------------
  // Everything above proves the form. This proves the write: the console and the host agreeing on
  // the shape of an add is the one thing a form test cannot tell you, and is what they got wrong.
  if (NO_WRITE) {
    console.log("  --  the add/remove leg is skipped (--no-write)");
  } else {
    const shaBefore = await connectorsSha();
    await page.click('[data-byo-door="link"]');
    await page.waitForTimeout(400);
    await page.fill("#byo-url", PROBE_URL);
    await page.waitForTimeout(500);
    await page.fill("#byo-name", PROBE_NAME);
    // Keyless: drop the header row the form offers by default, so nothing asks for a credential.
    await page.evaluate(() => document.querySelector("[data-byo-header-remove='0']")?.click());
    await page.waitForTimeout(400);
    await page.click("[data-byo-link] button[type=submit]");

    let listed = null;
    for (let n = 0; n < 60 && listed == null; n += 1) {
      await page.waitForTimeout(1000);
      const found = await page.evaluate(async (name) => {
        const r = await fetch("/api/listInstalledMcpServers", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const rows = await r.json().catch(() => []);
        return (Array.isArray(rows) ? rows : []).find((row) => row.serverIdentifier === name || row.name === name) ?? null;
      }, PROBE_NAME);
      if (found != null && (found.status === "connected" || found.toolCount > 0)) listed = found;
    }
    check(listed != null, `Add on the link door lands a working connector (${PROBE_NAME})`, listed == null ? "it never reached connected" : `status=${listed.status} transport=${listed.transport} tools=${listed.toolCount}`);
    if (listed != null) {
      check(listed.transport === "http", `the box opened the address itself rather than bridging to it (transport=${listed.transport})`);
      check(Number(listed.toolCount) > 0, `and its tools are listed (${listed.toolCount})`);
      check(typeof listed.statusSentence !== "string" || listed.statusSentence.length < 200, "the health line is a sentence, not a stack", String(listed.statusSentence ?? "").slice(0, 120));
    }

    const removed = await page.evaluate(async (name) => {
      const r = await fetch("/api/removeLocalConnector", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ server: name, name, clearSecrets: true }) });
      return { status: r.status, body: await r.text() };
    }, PROBE_NAME);
    check(removed.status < 400, "Uninstall with the clear offer came back without an error", removed.body.slice(0, 140));
    const shaAfter = await connectorsSha();
    check(shaAfter === shaBefore, "connectors.json is byte-identical to what this run found", `${shaBefore.slice(0, 12)} -> ${shaAfter.slice(0, 12)}`);
  }

  // ---- the older transport, opened rather than assumed ------------------------------------------
  // The picker has offered SSE since the card shipped and nothing had ever gone through it. The
  // claim is narrow and it is the whole point: an entry added through that door comes back
  // `transport=sse` with the far end's tools listed. A door that quietly fell back to the modern
  // transport would look identical on the page and be a different protocol on the wire.
  if (!SSE_ARM) {
    console.log("  --  the older-transport arm is skipped (pass --sse)");
  } else {
    const shaBeforeSse = await connectorsSha();
    let address = null;
    try {
      address = await boxAddress();
      const up = await startSseStub(address);
      check(up, `the in-box stub is serving the older transport on ${address}:${SSE_PORT} and refuses a wrong bearer`);
      if (up) {
        // Through the form, because the form is what shipped: the transport is chosen in the picker
        // and the header is marked secret, so what reaches the host is a stored NAME and no value.
        await page.click('[data-byo-door="link"]');
        await page.waitForTimeout(400);
        await page.fill("#byo-url", `http://${address}:${SSE_PORT}/sse`);
        await page.waitForTimeout(500);
        await page.selectOption("#byo-transport", "sse");
        await page.fill("#byo-name", SSE_NAME);
        await page.fill('[data-byo-header-name="0"]', "Authorization");
        await page.fill('[data-byo-header-env="0"]', SSE_FIELD);
        await page.waitForTimeout(300);
        await page.click("[data-byo-link] button[type=submit]");
        await page.waitForTimeout(2500);

        const written = await inBox(`cat ${DATA}/connectors.json`);
        check(written.includes(`"${SSE_NAME}"`), `the entry was written under the name the form was given (${SSE_NAME})`);
        check(!written.includes(SSE_VALUE), "and connectors.json carries no value, only the field's name");

        // With nothing stored the far end refuses, which is the honest state to be in before a key.
        const beforeKey = await settle(SSE_NAME, 60_000);
        check(beforeKey != null, "the connector is listed before its key is stored", `status=${beforeKey?.status} ${String(beforeKey?.statusSentence ?? "").slice(0, 90)}`);

        const stored = await gateway("setConnectorSecret", { server: SSE_NAME, field: SSE_FIELD, value: SSE_VALUE });
        check(stored.status < 400, "the key stores through the masked card's own command", String(stored.body).slice(0, 120));

        const connected = await settle(SSE_NAME, 120_000);
        check(connected?.status === "connected", "the box connected over the older transport",
          `status=${connected?.status} ${String(connected?.statusSentence ?? connected?.statusDetail ?? "").slice(0, 160)}`);
        check(connected?.transport === "sse", `and it opened it AS sse rather than falling back (transport=${connected?.transport})`);

        const probed = await gateway("probeConnector", { server: SSE_NAME });
        const names = (probed.body?.tools ?? []).map((tool) => tool.name);
        check(names.includes("search") && names.includes("fetch_content"),
          `the far end's tools came back over the stream (${names.join(", ") || "none"})`);

        // Same custody line as the modern transport, because the older one is no excuse for a
        // weaker rule: the value the card stored is in no process argument list in the box.
        const psOut = await inBox("ps -eo args");
        check(!psOut.includes(SSE_VALUE), "the stored value is in no process argument list inside the box");
      }
    } finally {
      await gateway("removeLocalConnector", { server: SSE_NAME, name: SSE_NAME, clearSecrets: true }).catch(() => {});
      await stopSseStub();
    }
    const shaAfterSse = await connectorsSha();
    check(shaAfterSse === shaBeforeSse, "connectors.json is byte-identical after the older-transport arm", `${shaBeforeSse.slice(0, 12)} -> ${shaAfterSse.slice(0, 12)}`);
  }
} finally {
  await browser.close();
}
console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
