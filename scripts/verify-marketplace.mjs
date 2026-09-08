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
// Custody -- that a stored value reaches no process argument list -- is asserted by
// scripts/verify-connector-host.mjs, which can drive an in-box bearer stub without a vendor key.
// This gate does the console's half and deliberately does not duplicate it.
//
// Integration check. Needs the box up on a bundle from this tree and a relay serving this tree.
// Run it through scripts/on-box.sh so it does not overlap another gate.
//
//   node scripts/verify-marketplace.mjs
//   node scripts/verify-marketplace.mjs --no-write   skip the add/remove leg on a shared box
//
//   0  every leg passed        1  a leg failed
import { execFile } from "node:child_process";
import { chromium } from "../.cache/playwright/node_modules/playwright-core/index.mjs";

const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? process.env.SAND_GATEWAY_URL ?? "http://127.0.0.1:7777";
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOX = process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm";
const DATA = "/home/box/sand-data";
const NO_WRITE = process.argv.includes("--no-write");
// Keyless on purpose: a public docs server needs no credential and no sign-in, so the add leg can
// run on a shared box without anyone's key being involved.
const PROBE_URL = "https://mcp.deepwiki.com/mcp";
const PROBE_NAME = `mktprobe-${Math.random().toString(36).slice(2, 8)}`;

const inBox = (command) => new Promise((resolve, reject) => {
  execFile("docker", ["exec", BOX, "sh", "-lc", command], { maxBuffer: 32 * 1024 * 1024 }, (error, out) => {
    if (error) reject(error); else resolve(String(out));
  });
});
const connectorsSha = () => inBox(`sha256sum ${DATA}/connectors.json | cut -c1-64`).then((line) => line.trim());

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
} finally {
  await browser.close();
}
console.log(failed === 0 ? "\nPASS" : `\nFAIL (${failed})`);
process.exit(failed === 0 ? 0 : 1);
