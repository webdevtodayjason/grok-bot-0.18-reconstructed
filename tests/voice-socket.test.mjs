/**
 * VOICE-1 item A5: the four lines in ui/server.mjs, proved against the REAL relay.
 *
 * Everything else in this wave is tested against the edge in isolation. This file boots
 * ui/server.mjs itself on a temp port, because the things that can only break in that file are
 * exactly the things isolation cannot see: whether the upgrade branch sits BEFORE the
 * socket.destroy() it has to pre-empt, whether the route line is inside the session, whether the
 * two buildContext fields resolve to a path the relay can actually write, and whether the VNC
 * branch still works next to it.
 *
 * THE SILENT-SOCKET RULE IS THE HEADLINE. Measured on this relay before a line of this wave was
 * written: a cookie-less upgrade answers a READABLE `HTTP/1.1 401` and an unknown upgrade path
 * answers ZERO BYTES with no status line at all -- and real Chrome reports the second as `onerror`
 * at 16 ms with no close code, indistinguishable from the relay being down. That void answer is a
 * failure this console has already been burned by, so the voice branch accepts the upgrade and says
 * one plain sentence instead, and this file asserts both halves of that difference.
 *
 * The boot pattern (temp port, temp auth file, temp profile dir, SIGTERM and SIGINT handlers) is
 * scripts/verify-job-bus.mjs:236-254 and :283-284, because this test runs under `timeout`, which
 * sends exactly SIGTERM, and a child relay that outlived it would hold the port.
 */
import { strict as assert } from "node:assert";
import net from "node:net";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, newAuthRecord, serializeCookie } from "../ui/auth.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
/** Every HTTP leg of every gate in this tree says who it is. */
const AGENT = "titanbot-gate/voice-socket.test.mjs";
const PLANTED_KEY = "xai-4Qw8ZrMtLn2VxK7sBpE5cD9fJ1yU6aH3";

const sleep = (ms) => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref(); });

let relay = null;
let dir = null;
let relayLog = "";

const stopRelay = () => {
  if (relay != null) { try { relay.kill("SIGKILL"); } catch { /* already gone */ } relay = null; }
};
const dropDir = () => {
  if (dir != null) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } dir = null; }
};
// SIGTERM never reaches a finally (node's default handler ends the process) and this file runs under
// `timeout`, which sends exactly that.
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => { stopRelay(); dropDir(); process.exit(143); });
}

/** One raw upgrade, and whatever bytes come back, including none. */
function rawUpgrade(port, pathname, { cookie = null, origin = null, forwardedHost = null, key = "dGhlIHNhbXBsZSBub25jZQ==" } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        `User-Agent: ${AGENT}`,
        ...(cookie == null ? [] : [`Cookie: ${cookie}`]),
        ...(origin == null ? [] : [`Origin: ${origin}`]),
        ...(forwardedHost == null ? [] : [`X-Forwarded-Host: ${forwardedHost}`]),
        "", "",
      ].join("\r\n"));
    });
    let bytes = Buffer.alloc(0);
    const done = () => resolve({ text: bytes.toString("utf8"), bytes });
    const timer = setTimeout(() => { socket.destroy(); done(); }, 4000);
    timer.unref();
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      // Enough to have the status line and, for an accepted voice socket, its first frames.
      if (bytes.length > 0 && (bytes.includes("\r\n\r\n") ? bytes.length > 200 || !bytes.toString().startsWith("HTTP/1.1 101") : false)) {
        clearTimeout(timer);
        setTimeout(() => { socket.destroy(); done(); }, 250).unref();
      }
    });
    socket.on("error", () => { clearTimeout(timer); done(); });
    socket.on("close", () => { clearTimeout(timer); done(); });
  });
}

/** The text frames a freshly accepted voice socket sent, read straight out of the raw bytes. */
function framesIn(bytes) {
  const head = bytes.indexOf("\r\n\r\n");
  if (head < 0) return [];
  let off = head + 4;
  const out = [];
  while (off + 2 <= bytes.length) {
    const opcode = bytes[off] & 0x0f;
    let len = bytes[off + 1] & 0x7f;
    let p = off + 2;
    if (len === 126) { if (p + 2 > bytes.length) break; len = bytes.readUInt16BE(p); p += 2; }
    else if (len === 127) { if (p + 8 > bytes.length) break; len = Number(bytes.readBigUInt64BE(p)); p += 8; }
    if (p + len > bytes.length) break;
    const payload = bytes.subarray(p, p + len);
    if (opcode === 0x1) { try { out.push(JSON.parse(payload.toString("utf8"))); } catch { /* not JSON */ } }
    if (opcode === 0x8) out.push({ t: "close", code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString("utf8") });
    off = p + len;
  }
  return out;
}

test("the relay comes up, and the voice door answers on it", async (t) => {
  dir = mkdtempSync(path.join(tmpdir(), "voice-socket-gate-"));
  const authFile = path.join(dir, "auth.json");
  const profileDir = path.join(dir, "profile");
  const stateDir = path.join(dir, "state");
  writeFileSync(authFile, `${JSON.stringify(newAuthRecord(randomBytes(18).toString("hex")), null, 2)}\n`, { mode: 0o600 });
  const cookieSecret = JSON.parse(readFileSync(authFile, "utf8")).cookieSecret;
  const cookie = serializeCookie("gb_session", createSession(cookieSecret, { tenant: "" })).split(";")[0];
  rmSync(profileDir, { recursive: true, force: true });
  writeFileSync(authFile, readFileSync(authFile));

  const port = 19000 + Math.floor(Math.random() * 900);
  // A gateway that does not exist. Nothing in this file needs one: every voice refusal below is
  // decided before the roster is read, or reads an empty roster and says so.
  relay = spawn(process.execPath, [path.join(REPO, "ui", "server.mjs")], {
    cwd: REPO,
    env: {
      ...process.env,
      SAND_UI_PORT: String(port),
      SAND_UI_BIND_HOST: "127.0.0.1",
      SAND_PROFILE_DIRS: profileDir,
      SAND_UI_AUTH_FILE: authFile,
      SAND_UI_STATE_DIR: stateDir,
      SAND_HOST_GATEWAY_URL: "http://127.0.0.1:1",
      // Never ui/auth.json, never the real state dir, never a real box.
      CP_URL: "",
      CP_RELAY_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  relay.stdout.on("data", (chunk) => { relayLog += String(chunk); });
  relay.stderr.on("data", (chunk) => { relayLog += String(chunk); });
  relay.on("exit", (code) => { relayLog += `\n(the relay exited with ${code})`; });

  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 60 && relay.exitCode == null; i += 1) {
    const probe = await fetch(`${base}/v1/health`, { headers: { "user-agent": AGENT }, signal: AbortSignal.timeout(3000) }).catch(() => null);
    if (probe != null) { up = true; break; }
    await sleep(250);
  }
  assert.ok(up, `the relay never answered on ${base}: ${relayLog.slice(-500)}`);

  try {
    await t.test("a cookie-less voice upgrade answers a READABLE 401, and not zero bytes", async () => {
      const answer = await rawUpgrade(port, "/voice/socket");
      assert.ok(answer.bytes.length > 0, "zero bytes is the void answer this branch exists to avoid");
      assert.match(answer.text, /^HTTP\/1\.1 401 Unauthorized/, answer.text.slice(0, 120));
    });

    await t.test("an unknown upgrade path still answers zero bytes, which is the contrast", async () => {
      // Unchanged behaviour, asserted so the difference is a measured fact rather than a claim in a
      // comment: this is what /voice/socket would have done had the branch gone after the destroy.
      const answer = await rawUpgrade(port, "/nothing/here", { cookie });
      assert.equal(answer.bytes.length, 0, `an unknown path answered: ${answer.text.slice(0, 120)}`);
    });

    await t.test("a signed-in upgrade with an empty voice.json is ACCEPTED, says one sentence, then says goodbye", async () => {
      const answer = await rawUpgrade(port, "/voice/socket", { cookie });
      assert.match(answer.text, /^HTTP\/1\.1 101 Switching Protocols/, answer.text.slice(0, 200));
      assert.match(answer.text, /sec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i, "the accept the RFC's own key computes");
      assert.ok(!/sec-websocket-extensions/i.test(answer.text), "permessage-deflate is declined");
      const frames = framesIn(answer.bytes);
      const note = frames.find((frame) => frame.t === "note");
      assert.ok(note != null, `no sentence came back: ${JSON.stringify(frames)}`);
      // The person reads plain words. No vendor name, no tool name, and it says where to fix it.
      assert.match(note.text, /no realtime voice key yet/);
      assert.match(note.text, /Voice card in Settings/);
      for (const vendor of ["xAI", "x.ai", "OpenAI", "Grok", "grok", "realtime provider"]) {
        assert.ok(!note.text.includes(vendor), `the sentence names ${vendor}`);
      }
      assert.ok(frames.some((frame) => frame.t === "state" && frame.value === "off"), "the orb is told to go back to off");
      const bye = frames.find((frame) => frame.t === "bye");
      assert.ok(bye != null, "and it says goodbye rather than just stopping");
      const close = frames.find((frame) => frame.t === "close");
      assert.equal(close?.code, 1000, "a clean close");
      assert.ok(String(close?.reason ?? "").length > 0, "carrying a reason the page reads off event.reason");

      // THE SEAM BETWEEN THE RELAY AND THE PAGE, and the one integration defect this wave had.
      // ui/machine-room/voice.js reads `reason` off the note frame and off the bye frame as its OWN
      // condition vocabulary, and "no-key" is the single condition that draws the control opening the
      // Voice card. Without it the page painted the relay's sentence, then painted "the line dropped"
      // over the top of it on the close -- so the very first press on a workspace with nothing set up
      // led a person nowhere. The prose stays on `detail` and on the close frame; the condition is
      // what the page needs, and it must be a word that file knows.
      assert.equal(note.reason, "no-key", "the note names the condition the page draws a control for");
      assert.equal(bye.reason, "no-key", "and the bye names it too, so a trailing close cannot retitle it away");
      assert.match(String(bye.detail ?? ""), /realtime key/, "with the operator's prose kept on detail");
      const vocabulary = new Set(["", "no-microphone", "no-key", "day-cap", "session-cap", "box-not-running", "line-dropped"]);
      assert.ok(vocabulary.has(note.reason), "and it is a condition ui/machine-room/voice.js can render");
    });

    await t.test("a foreign Origin is refused in words on an accepted socket", async () => {
      const answer = await rawUpgrade(port, "/voice/socket", { cookie, origin: "https://evil.example" });
      // An upgrade carries cookies and is exempt from CORS, and the request handler checks no Origin
      // at all, so this branch is the only thing between a stranger's page and a live microphone.
      assert.match(answer.text, /^HTTP\/1\.1 101/, "still a sentence rather than a reset");
      const frames = framesIn(answer.bytes);
      const note = frames.find((frame) => frame.t === "note");
      assert.ok(note != null, `no sentence came back: ${JSON.stringify(frames)}`);
      assert.match(note.text, /page this console does not serve/);
      assert.match(note.text, /did not open the microphone/);
    });

    await t.test("the console's own Origin is accepted, through X-Forwarded-Host as well", async () => {
      // On the R750 the relay sits behind Traefik and Cloudflare, so its own Host header is the
      // container's. Getting this wrong would refuse every real customer on the public name.
      const sameHost = await rawUpgrade(port, "/voice/socket", { cookie, origin: `http://127.0.0.1:${port}` });
      const note = framesIn(sameHost.bytes).find((frame) => frame.t === "note");
      assert.match(note?.text ?? "", /no realtime voice key yet/, "it got past the origin check to the real refusal");
      const forwarded = await rawUpgrade(port, "/voice/socket", {
        cookie, origin: "https://console.titanium.bot", forwardedHost: "console.titanium.bot",
      });
      const forwardedNote = framesIn(forwarded.bytes).find((frame) => frame.t === "note");
      assert.match(forwardedNote?.text ?? "", /no realtime voice key yet/, "and the forwarded host is what is compared");
    });

    await t.test("a key written through the door never comes back out of it", async () => {
      const headers = { "content-type": "application/json", cookie, "user-agent": AGENT };
      const before = await fetch(`${base}/voice/settings`, { headers }).then((r) => r.json());
      assert.equal(before.apiKeySet, false);
      assert.equal(before.apiKey, undefined);
      // Saved the way the Voice card saves it, through the ordinary console session.
      const saved = await fetch(`${base}/voice/settings`, {
        method: "POST", headers,
        body: JSON.stringify({ enabled: true, vendor: "xai", apiKey: PLANTED_KEY, agentId: "" }),
      }).then((r) => r.json());
      assert.equal(saved.apiKeySet, true, "the relay took it");
      assert.equal(saved.enabled, true);
      assert.equal(saved.vendor, "xai");
      // THE SWEEP. Not one byte of it, and not a prefix of it, in the answer to either verb.
      for (const body of [saved, await fetch(`${base}/voice/settings`, { headers }).then((r) => r.json())]) {
        const text = JSON.stringify(body);
        assert.ok(!text.includes(PLANTED_KEY), "the key came back out of /voice/settings");
        assert.ok(!text.includes(PLANTED_KEY.slice(0, 12)), "a prefix of the key came back out");
      }
      // And the rest of the form saves without the key being re-sent, which is what lets the card
      // change the vendor without ever holding a secret.
      const vendorOnly = await fetch(`${base}/voice/settings`, {
        method: "POST", headers, body: JSON.stringify({ vendor: "openai" }),
      }).then((r) => r.json());
      assert.equal(vendorOnly.vendor, "openai");
      assert.equal(vendorOnly.apiKeySet, true, "the key was KEPT, not silently cleared");
      // Explicit null clears it, which is how a person takes it off again.
      const cleared = await fetch(`${base}/voice/settings`, {
        method: "POST", headers, body: JSON.stringify({ apiKey: null }),
      }).then((r) => r.json());
      assert.equal(cleared.apiKeySet, false);
      // It really is on this relay's disk, in the operator's own state directory, and nowhere else.
      const onDisk = readFileSync(path.join(stateDir, "voice.json"), "utf8");
      assert.ok(!onDisk.includes(PLANTED_KEY), "cleared means cleared on disk too");
      // The caps the page is told about come from the relay's constants, because there is no cp here.
      assert.equal(cleared.sessionCapSeconds, 1800);
      assert.equal(cleared.dayCapSeconds, 7200);
    });

    await t.test("the settings door is behind the session, like every other console route", async () => {
      const answer = await fetch(`${base}/voice/settings`, { headers: { "user-agent": AGENT, accept: "application/json" } });
      assert.equal(answer.status, 401);
      assert.equal(answer.headers.get("x-relay-auth"), "required", "so the page knows to bounce to the login");
    });

    await t.test("a body that is not JSON, and a verb that is not GET or POST, are both refused in words", async () => {
      const headers = { "content-type": "application/json", cookie, "user-agent": AGENT };
      const bad = await fetch(`${base}/voice/settings`, { method: "POST", headers, body: "not json" });
      assert.equal(bad.status, 400);
      assert.match((await bad.json()).error, /must be JSON/);
      const wrong = await fetch(`${base}/voice/settings`, { method: "DELETE", headers });
      assert.equal(wrong.status, 405);
      assert.equal(wrong.headers.get("allow"), "GET, POST");
    });

    await t.test("the VNC upgrade still reaches its own handler, unchanged, next to the new branch", async () => {
      // What this wave could break about VNC is ROUTING and nothing else: the new branch sits above
      // VNC's in the one upgrade handler, so a branch written wrongly would swallow the VNC path or
      // be swallowed by it. Every assertion here is therefore about reaching relayVncSocket, and
      // every one of them is decided inside this process -- no box, no port this test does not own.
      //
      // The real 101 being piped back is NOT asserted here on purpose. vncTarget hardcodes port 6080
      // on the box's own host, so a 101 needs either the local box's websockify (which made this leg
      // flake: two runs in ten came back with nothing when the box was busy) or a listener on a
      // loopback alias this machine does not have (127.0.0.2 is EADDRNOTAVAIL without a sudo alias,
      // and a bracketed IPv6 host is ENOTFOUND through net.connect). That leg belongs to the gate
      // that runs against a real box, and it is scripts/verify-voice.mjs --leg relay.
      const noCookie = await rawUpgrade(port, "/vnc/1/websockify");
      assert.match(noCookie.text, /^HTTP\/1\.1 401 Unauthorized/, "VNC still checks the same cookie it always did");

      // Past the cookie, into relayVncSocket's own key guard: a malformed Sec-WebSocket-Key is
      // destroyed there and nowhere else, so zero bytes here proves control reached that function.
      const badKey = await rawUpgrade(port, "/vnc/1/websockify", { cookie, key: "not-a-websocket-key" });
      assert.equal(badKey.bytes.length, 0, "a bad key is destroyed inside relayVncSocket, as it always was");

      // And with a good key it dials the box and the dial fails here (the gateway URL points at a
      // closed port), which relayVncSocket answers by destroying the socket. Zero bytes again, and
      // critically NOT a voice frame: the two branches do not overlap.
      const good = await rawUpgrade(port, "/vnc/1/websockify", { cookie });
      assert.ok(!good.text.includes("\"t\":\"note\""), "the voice branch did not answer a VNC upgrade");
      assert.ok(!good.text.includes("\"t\":\"ready\""), "and it did not open a voice session on the VNC path");

      // The contrast that makes the ordering a measured fact: the same relay, the same cookie, one
      // path answering words and the other answering the way it always has.
      const voice = await rawUpgrade(port, "/voice/socket", { cookie });
      assert.match(voice.text, /^HTTP\/1\.1 101/, "voice accepts and speaks");
      assert.ok(badKey.bytes.length === 0 && voice.bytes.length > 0, "and VNC's own refusals are untouched");
    });

    await t.test("the relay logged nothing that looks like a secret", () => {
      assert.ok(!relayLog.includes(PLANTED_KEY), "the planted key is in the relay's own stdout");
      assert.ok(!relayLog.includes(PLANTED_KEY.slice(0, 12)));
      assert.ok(!/refusing to bind/.test(relayLog), relayLog.slice(-300));
    });
  } finally {
    stopRelay();
    dropDir();
  }
});
