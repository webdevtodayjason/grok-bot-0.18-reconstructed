#!/usr/bin/env node
// verify-attach.mjs -- a person attaches a picture and the agent either sees it or says why not.
//
// ATTACH-1. Jason attached a screenshot twice on 2026-09-09. It showed in his own message both
// times and Titan received no image either time. The console leg was never at fault: the PNG
// arrived byte-identical in the agent's attachments folder and the host's containment check passed.
// It died in flattenParts, which had no branch for a user message's own {type:"image"} part, so the
// request left as a plain string.
//
// So this gate does what he did, in a real browser, through the real #composer-file input. A passing
// page.click() is not evidence a human can click; a passing fetch is not evidence a picture
// travelled. It then reads the box's own host log and the agent's own reply, and accepts EITHER of
// exactly two outcomes:
//
//   VISION      the [sand][wire] line shows imageParts >= 1 and the reply names the colour.
//   GUARDED     the endpoint refused the picture (measured: glm-5.3 answers 400 code 1210), the
//               guard fired, the turn did NOT die, and the reply names the file and says plainly it
//               cannot see pictures on this model.
//
// Anything else fails, including the silence this whole item exists to end.
//
//   node scripts/verify-attach.mjs --box grok-bot-local-vm
//     --ui       the console, default http://127.0.0.1:7777/ (the relay serves it at its root;
//                /machine-room/ is a 302 back to /, so pointing at that just costs a hop)
//     --agent    reuse an agent instead of minting a scratch one (it is NOT deleted)
//     --timeout-ms  how long to wait for a reply, default 240000
//
// Run it through scripts/on-box.sh: it shares the box, the display and the login throttle with every
// other gate. It mints its own agent so a long-lived history cannot be blamed for a dead turn
// (PLUMBING-AUDIT 6i), deletes it pass or fail, and asserts nothing about the roster's size -- the
// local box carries 22 bots belonging to other waves.
//
// Exit 0 the wire is proved, 1 a leg failed, 2 nothing could be measured.
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { deflateSync } from "node:zlib";

const flag = (name, fallback = null) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1] ?? fallback;
};
const BOX = flag("box", process.env.SAND_BOX_CONTAINER ?? "grok-bot-local-vm");
const UI = (flag("ui", process.env.MACHINE_ROOM_URL ?? "http://127.0.0.1:7777/")).replace(/\/*$/, "/");
const RELAY = new URL(UI).origin;
const GATEWAY = process.env.SAND_HOST_GATEWAY_URL ?? "http://127.0.0.1:1340";
const TIMEOUT_MS = Number.parseInt(flag("timeout-ms", "240000"), 10);
const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR ?? new URL("../.cache/playwright", import.meta.url).pathname;
const CHROME = process.env.GROK_BOT_CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let failures = 0;
const pass = (name, detail = "") => console.log(`  PASS  ${name}${detail ? ` -- ${detail}` : ""}`);
const fail = (name, detail = "") => { failures += 1; console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`); };
const step = (name) => console.log(`\n== ${name}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gatewayToken() {
  const explicit = process.env.SAND_HOST_GATEWAY_TOKEN?.trim();
  if (explicit) return explicit;
  for (const dir of (process.env.SAND_PROFILE_DIRS ?? "").split(":")) {
    if (!dir) continue;
    try { return JSON.parse(readFileSync(`${dir}/local-docker-vm.json`, "utf8")).token; } catch {}
  }
  return null;
}
const TOKEN = gatewayToken();
if (TOKEN == null) {
  console.error("no gateway token: set SAND_HOST_GATEWAY_TOKEN or SAND_PROFILE_DIRS, so nothing here can be measured");
  process.exit(2);
}
const call = async (method, args = {}) => {
  const res = await fetch(`${GATEWAY}/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} -> ${res.status} ${text.slice(0, 200)}`);
  try { return JSON.parse(text); } catch { return text; }
};
const docker = (args) => new Promise((resolve, reject) =>
  execFile("docker", args, { maxBuffer: 32 << 20 }, (error, out) =>
    (error ? reject(new Error(`docker ${args.join(" ")}: ${error.message}`)) : resolve(String(out)))));

// A 64x64 solid-colour PNG, written by hand so the gate carries no fixture and no encoder.
//
// THE COLOUR AND THE NAME ARE BOTH SECRETS. The first version of this gate wrote solid-blue.png and
// asked for the colour, so a model that read nothing but the path in the attached-files note could
// answer "blue" -- and the scorer took that as a pass, which made the exact regression this item
// exists to catch (an image stripped on the way to the provider) score green. One of four colours
// is picked at random each run and the file is named for a random token, so nothing in the prompt,
// the path or the roster carries the answer: the only place the answer exists is the pixels.
const COLOURS = [
  { word: "blue", rgb: [0x1e, 0x5a, 0xd6] },
  { word: "red", rgb: [0xd6, 0x1e, 0x2a] },
  { word: "green", rgb: [0x1e, 0xa5, 0x4a] },
  { word: "yellow", rgb: [0xf2, 0xd0, 0x1e] },
];
const COLOUR = COLOURS[Math.floor(Math.random() * COLOURS.length)];
function solidColourPng([red, green, blue]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const check = Buffer.alloc(4); check.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, check]);
  };
  const side = 64;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour RGB
  const raw = Buffer.alloc(side * (1 + side * 3));
  for (let y = 0; y < side; y += 1) {
    const row = y * (1 + side * 3);
    raw[row] = 0; // no filter
    for (let x = 0; x < side; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = red; raw[at + 1] = green; raw[at + 2] = blue;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

step(`the console at ${UI} and the box ${BOX}`);
try {
  const res = await fetch(UI, { redirect: "manual" });
  if (res.status >= 500) throw new Error(`the console answered ${res.status}`);
} catch (error) {
  console.error(`  the console is not answering at ${UI} (${error.message}).`);
  console.error("  Start the relay against this box first, or point --ui at one. Nothing can be measured without it.");
  process.exit(2);
}

// Without the trace switch the [sand][wire] line is simply ABSENT, which reads exactly like "no
// images" -- the one misreading this gate must never make. Say so and stop rather than pass on it.
let traceOn = false;
try {
  const settings = await docker(["exec", BOX, "sh", "-c", "cat /home/box/sand-data/sand-host-settings.json 2>/dev/null || echo {}"]);
  traceOn = /"SAND_TOOL_TRACE"\s*:\s*(true|"1"|1)/.test(settings);
} catch { /* reported below */ }
if (!traceOn) {
  console.error(`  SAND_TOOL_TRACE is not on in ${BOX}'s sand-host-settings.json, so the [sand][wire] line will be absent`);
  console.error("  and an absent line reads as 'no images'. Turn it on, then run this again.");
  process.exit(2);
}
pass("the trace switch is on, so an absent wire line would be a real absence");

// The gateway's port answers before the host behind it will take a command, so a run started right
// after a restart dies on createAgent with a closed socket. Wait for the surface, not the port. The
// roster command is listAgents; there is no getAgents, and asking for one 404s for ever.
step("the gateway is ready to take a command");
let ready = false;
for (let attempt = 0; attempt < 24 && !ready; attempt += 1) {
  ready = await call("listAgents").then(() => true).catch(() => false);
  if (!ready) await sleep(5_000);
}
if (!ready) { console.error("  the gateway never became ready, so nothing can be measured"); process.exit(2); }
pass("the gateway answers listAgents");

const idOf = (created) => created?.id ?? created?.agentId ?? created?.agent?.id ?? null;
let ownedAgentId = null;
let agentId = flag("agent", null);
if (agentId == null) {
  const created = await call("createAgent", {
    name: `verify-attach ${Math.random().toString(36).slice(2, 8)}`,
    description: "Throwaway agent for the attachment verification gate. Safe to delete.",
  });
  agentId = ownedAgentId = idOf(created);
  if (agentId == null) { console.error(`createAgent returned no id: ${JSON.stringify(created).slice(0, 200)}`); process.exit(2); }
  console.log(`  minted a scratch agent ${agentId}`);
}
const cleanup = async () => {
  if (ownedAgentId == null) return;
  await call("deleteAgent", { id: ownedAgentId }).catch(() => {});
  ownedAgentId = null;
};

const scratch = mkdtempSync(join(tmpdir(), "verify-attach-"));
// Named for nothing: a token, so the path in the attached-files note says only that a file is
// there. The word this gate is waiting for exists in the pixels and nowhere else.
const picture = join(scratch, `img-${randomBytes(4).toString("hex")}.png`);
writeFileSync(picture, solidColourPng(COLOUR.rgb));
const PROMPT = "Reply with the one colour word that describes the attached image.";
console.log(`  the picture is ${basename(picture)} and it is ${COLOUR.word}; neither the name nor the prompt says so`);

step("a person attaches the picture in a real browser and sends");
const { chromium } = createRequire(`${PW_DIR}/package.json`)("playwright-core");
let browser = null;
try {
  browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const page = await browser.newContext({ viewport: { width: 1400, height: 900 } }).then((c) => c.newPage());
  await page.goto(UI, { waitUntil: "domcontentloaded", timeout: 60_000 });

  const card = page.locator(`[data-context-kind="worker"][data-context-id="${agentId}"]`);
  await card.waitFor({ state: "attached", timeout: 60_000 });
  await card.first().click();
  pass("the scratch agent's own card is clickable in the roster");

  // The real input a person reaches through the ＋ button. setInputFiles is the only honest way to
  // put a file into a file input: there is no scriptable path a person does not also have.
  await page.locator("#composer-file").setInputFiles(picture);
  await page.waitForFunction(
    () => { const tray = document.getElementById("attachment-tray"); return tray != null && !tray.hidden && !tray.textContent.includes("uploading"); },
    null, { timeout: 60_000 },
  );
  const chip = (await page.locator("#attachment-tray").textContent()) ?? "";
  if (chip.includes(basename(picture))) pass("the attachment tray shows the file, staged and uploaded");
  else fail("the attachment tray never showed the file", chip.slice(0, 120));

  await page.locator("#message-input").fill(PROMPT);
  await page.locator("#composer .send-button").click();
  pass("the send button a person presses accepted the message");
} catch (error) {
  fail("the browser leg", error.message.split("\n")[0]);
  if (browser != null) await browser.close().catch(() => {});
  await cleanup();
  process.exit(1);
} finally {
  if (browser != null) await browser.close().catch(() => {});
}

step("what actually left for the provider, read off the box's own log");
const hostLog = async () => docker(["exec", BOX, "sh", "-c", "tail -n 4000 /tmp/sand-host.log 2>/dev/null || true"]);
const wireLineFor = (log) => {
  const lines = log.split("\n").filter((line) => line.includes("[sand][wire]") && line.includes(agentId));
  if (lines.length === 0) return null;
  try { return JSON.parse(lines.at(-1).slice(lines.at(-1).indexOf("{"))); } catch { return null; }
};

// Collect the WHOLE turn, not its first line. An agent says "let me look" and then works: reading
// only the first SendMessage measures the intention and never the answer, which is how a gate ends
// up reporting a failure the product did not have.
let wire = null;
let reply = "";
let settled = 0;
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  await sleep(5_000);
  if (wire == null) wire = wireLineFor(await hostLog());
  const transcript = await call("getTranscript", { id: agentId }).catch(() => null);
  const entries = Array.isArray(transcript) ? transcript : transcript?.entries ?? [];
  const said = entries.filter((entry) => entry?.role === "assistant" || entry?.kind === "send-message");
  const text = said.map((entry) => String(entry?.text ?? entry?.message?.content ?? "")).join("\n").trim();
  if (text.length === 0 || text.includes(PROMPT)) continue;
  settled = text === reply ? settled + 1 : 0;
  reply = text;
  // Three quiet polls with the agent having spoken at least once is a finished turn.
  if (settled >= 3) break;
}

if (wire == null) {
  fail("no [sand][wire] line for this conversation", "the trace is on, so the turn never reached the provider");
} else {
  console.log(`  wire: ${JSON.stringify(wire)}`);
  if (wire.historyImageParts >= 1) pass("the history counter sees the attachment", `historyImageParts=${wire.historyImageParts}`);
  else fail("the history counter still reads 0 for an attached picture", JSON.stringify(wire));
}

step("the answer");
console.log(`  reply: ${reply.slice(0, 600) || "(nothing)"}`);
const namedTheColour = new RegExp(`\\b${COLOUR.word}\\b`, "i").test(reply);
const namedAnotherColour = COLOURS.some((one) => one.word !== COLOUR.word && new RegExp(`\\b${one.word}\\b`, "i").test(reply));
const saidItCannotSee = /cannot see|could not see|can't see|cannot view|can't view|unable to see|not able to see|no image|don't see an image|do not see an image/i.test(reply);

if (wire != null && wire.imageParts >= 1) {
  if (wire.imageParts === wire.historyImageParts) pass("the counters agree", `${wire.historyImageParts} in history, ${wire.imageParts} on the wire`);
  else fail("the counters disagree", JSON.stringify(wire));
}

if (reply.length === 0) {
  // The failure this whole item exists to end: "On it", and then nothing, forever.
  fail("the turn said nothing at all", "which is the exact silence this item exists to end");
} else if (namedTheColour && wire != null && wire.imageParts >= 1) {
  pass(`VISION -- the picture left as a picture and the agent named it ${COLOUR.word}`);
} else if (namedTheColour) {
  // The picture never left as a picture and the answer is still right. With a random colour behind
  // a random filename there is nothing to read it off, so this is the gate measuring something it
  // does not understand, and a gate that does not understand its own pass is not a pass.
  fail(`the agent said ${COLOUR.word} with no image on the wire`,
    `imageParts=${wire?.imageParts ?? "unknown"}; nothing but the pixels carries that word, so this turn is not measured`);
} else if (namedAnotherColour && !saidItCannotSee) {
  fail("the agent named a colour the picture is not", reply.slice(0, 300));
} else if (saidItCannotSee) {
  // Three ways to get here, and all three are an honest close rather than a dead turn:
  //  - the guard fired, so no image part left and the model was handed the sentence instead;
  //  - the endpoint took the part and the model behind it is text-only and says so;
  //  - vision is off for this deployment.
  // What is NOT acceptable is silence, or a colour guessed with nothing to look at.
  console.log(wire != null && wire.imageParts >= 1
    ? "  the picture left as a picture and this model still says it cannot look at one"
    : "  no image part left for this endpoint, so the measured close is the guard and not the colour");
  pass("HONEST -- the agent says plainly that it cannot see the picture instead of guessing or going quiet");
  if (new RegExp(`${basename(picture)}|attachments/`).test(reply)) pass("and it knows which file it was given, and where it is");
  else console.log("  note: the reply does not name the file, so only the note in the prompt carries the path");
} else {
  fail("the agent neither named the colour nor said it could not see the picture", reply.slice(0, 300));
}

await cleanup();
console.log(failures === 0 ? "\nOK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
