// SIGNIN-1. The gates say their own name at the door, and this file is what keeps them saying it.
//
// Jason, 2026-09-09, reading the Sign-in attempts panel: his own address marked "Attack", 101 tries,
// 23 different passwords. Every burst was this repository's own deploy gate spending the relay's
// lockout on purpose. The panel could not tell that from a stranger because the rows carried nothing
// about the caller but a user agent reading "node".
//
// The fix is one header, and the reason it needs a test rather than a diff is that all three ways it
// can be silently lost are invisible on the page and invisible in a review:
//
//   1. A gate that never imports scripts/gate-agent.mjs sends nothing, and nothing about the gate
//      run looks different. The whole point of deriving the name from the filename is that a gate
//      written next year gets it by importing rather than by remembering, and this file is the part
//      that notices when one does not.
//   2. verify-deploy's own fetch helper spreads the caller's `init` LAST so a caller can override
//      the redirect or the timeout. A `headers` default written before that spread is REPLACED
//      wholesale by every call that passes headers of its own, which is four of the login legs. The
//      helper still works, the header is just gone. That is measured here by building the helper's
//      own object literal out of the file and looking at what comes back.
//   3. One leg of verify-deploy is node's raw https rather than fetch, and node adds no user agent
//      to a raw request. Measured on this Mac: `fetch` with no headers sends `user-agent: node`,
//      `http.request` with no headers sends none at all. That leg runs three times a run and is
//      where the blank-agent rows in the live ledger come from, so it carries the header by hand
//      and that has to stay true.
//
// Nothing in this file is a claim that the header PROVES anything. A user agent is a string a
// stranger writes. The panel's rule is narrower than the prefix on purpose, and docs/ADMIN.md,
// "Telling a gate from an attacker", is where that rule lives.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { GATE_AGENT_PREFIX, gateUserAgent } from "../scripts/gate-agent.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOf = (name) => readFileSync(path.join(repo, "scripts", name), "utf8");

// The gates that actually knock at a login door on a live box. The others are deliberately
// untouched and the reasons are worth keeping next to the list: verify-browser-tools serves its own
// fixture login page from its own fixture server, verify-console-polish and verify-job-bus and
// verify-mail carry bearer tokens, verify-admin drives a control plane and a relay it starts
// itself, and the rest never reach a login door at all. Changing the user agent of a context that
// measures rendering would change what the page under test reads, for nothing.
const GATES = [
  "verify-deploy.mjs",
  "verify-one-console.mjs",
  "verify-one-console-browser.mjs",
  "verify-control-plane.mjs",
  // ONBOARD-2. It signs a THROWAWAY super admin in at a live api.titanium.bot/v1/sessions to run one
  // real onboarding, so the attempt it writes is a real row on the operator's own panel.
  "verify-onboard-r750.mjs",
  // VOICE-1: it posts a password at a relay's own /login to get the console cookie the voice door
  // takes, and drives real Chrome through the same door. The relay is one it starts itself, but the
  // door is real and the header costs one import, so it is held to the same rule.
  "verify-voice.mjs",
  // DOOR-1 and STORE-1. The front door IS what this gate measures, and /auth/token is the same door
  // wearing a different shape: it posts a real password at it and records an attempt in the ledger
  // exactly as the page does. So it says its own name, at both, including from inside the browser -- the
  // phone user agent it drives Chrome with carries the name on the end, so the ledger row a minted
  // bearer writes is labelled too.
  "verify-door.mjs",
];

test("the name is built from the calling file, not typed into it", () => {
  assert.equal(gateUserAgent("file:///repo/scripts/verify-deploy.mjs"), "titanbot-gate/verify-deploy");
  assert.equal(gateUserAgent("/repo/scripts/verify-one-console-browser.mjs"), "titanbot-gate/verify-one-console-browser");
  assert.equal(gateUserAgent("verify-control-plane.js"), "titanbot-gate/verify-control-plane");
  // A header value with a control character in it is a request-splitting shape. A filename is not
  // somewhere to start trusting bytes just because we wrote it.
  assert.equal(gateUserAgent("/repo/scripts/odd name;v=1.mjs"), "titanbot-gate/odd-name-v-1");
  // Never a header that ends in a slash: an empty name reads on the panel as a field that failed
  // rather than as a caller that did not say.
  assert.equal(gateUserAgent(""), `${GATE_AGENT_PREFIX}unknown`);
  assert.equal(gateUserAgent(), `${GATE_AGENT_PREFIX}unknown`);
  // Every real name fits the ledger's 120 character clip with room to spare, so no gate's row is
  // ever truncated in the middle of its own name.
  for (const gate of GATES) assert.equal(gateUserAgent(gate).length < 60, true, gate);
});

test("every gate that knocks at a login door imports the name rather than spelling it", () => {
  for (const gate of GATES) {
    const source = sourceOf(gate);
    assert.match(source, /import \{ gateUserAgent \} from "\.\/gate-agent\.mjs";/,
      `${gate} does not import scripts/gate-agent.mjs, so it sends whatever node sends and its rows read as a stranger's`);
    assert.match(source, /const GATE_AGENT = gateUserAgent\(import\.meta\.url\);/,
      `${gate} does not derive its name from its own filename, so a rename would leave the header lying`);
    // Spelled out anywhere else and the derivation is decoration. The prefix constant lives in one
    // file so the panel and the documents quote the same string.
    const literals = source.split("\n").filter((line) => line.includes(GATE_AGENT_PREFIX) && !line.trim().startsWith("//"));
    assert.deepEqual(literals, [], `${gate} spells the prefix out in code instead of importing it: ${literals.join(" | ")}`);
  }
});

/**
 * The other 42, checked rather than asserted.
 *
 * SIGNIN-1, from the review of 2026-09-09: the list above is only worth its comment for as long as
 * nothing else grows a login leg. MEASURED ON THE R750 that day, the residual noise behind the
 * Attack pill on the operator's own address was 79 unlabelled rows, every one of them written by
 * this same deploy gate BEFORE the header shipped -- not by an unlabelled script. That is the shape
 * of the risk here: a script that reaches a real login door without the header writes rows nobody
 * can tell from a stranger's, and nothing would notice for weeks.
 *
 * So every verify script that mentions a login path at all has to be either one of the four that
 * send the header or named here with the reason it cannot reach a live door. A new one is a failing
 * test rather than a surprise on the panel.
 */
const NO_LIVE_LOGIN_DOOR = new Map([
  ["verify-browser-tools.mjs", "serves its own login page from its own fixture server on 127.0.0.1 and posts to that"],
  ["verify-console-polish.mjs", "reads with a bearer; the word login is in a message about being bounced to one"],
  ["verify-job-bus.mjs", "checks that an unauthenticated call is bounced to /login and never posts a password"],
  ["verify-admin.mjs", "drives a control plane and a relay it starts itself, on a throwaway data directory"],
  ["verify-welcome-mail.mjs", "renders the welcome mail into a browser page with setContent; the login path is a fixture inside that page and no request leaves the process"],
  ["verify-onboard.mjs", "the sign-in link it reads out of a captured welcome is exercised against a fake relay it starts on 127.0.0.1; nothing it touches is a live door"],
]);

test("no other gate reaches a login door without saying its own name at it", () => {
  const names = readdirSync(path.join(repo, "scripts")).filter((name) => /^verify-.*\.mjs$/.test(name)).sort();
  assert.equal(names.length >= 40, true, `expected the whole verify family, found ${names.length}`);
  for (const name of names) {
    if (GATES.includes(name)) continue;
    const source = sourceOf(name);
    if (!/["'`][^"'`]*\/(login|auth\/login)\b/.test(source)) continue;
    assert.equal(NO_LIVE_LOGIN_DOOR.has(name), true,
      `${name} names a login path but neither imports scripts/gate-agent.mjs nor is listed as unable to reach a live one. `
      + "Either give it the header (one import and one const) or add it here with the reason.");
  }
});

test("verify-deploy's fetch helper merges the caller's headers over the name, never under it", () => {
  const source = sourceOf("verify-deploy.mjs");
  // The helper's own object literal, lifted out of the file and built here. This is a behavioural
  // check and not a regex on a comment: what is asserted below is what that expression actually
  // returns, so the bug this guards against -- a headers default placed BEFORE `...init` and
  // therefore replaced by every caller that sends headers -- fails here rather than in the field.
  const literal = /const hit = \(path, init = \{\}\) => fetch\(`\$\{URL_BASE\}\$\{path\}`, (\{[\s\S]*?\n\})\);/.exec(source)?.[1];
  assert.notEqual(literal, undefined, "the hit helper is not in the shape this test knows how to read; update the test with the helper");
  const build = new Function("GATE_AGENT", "init", `return ${literal};`);

  // A caller that sends nothing gets the name.
  const bare = build("titanbot-gate/verify-deploy", {});
  assert.equal(bare.headers["user-agent"], "titanbot-gate/verify-deploy");
  assert.equal(bare.redirect, "manual", "and the helper's own defaults are still there");

  // A caller that sends its own headers keeps every one of them AND still gets the name. These are
  // the four legs that pass headers: the oversize body, the lockout, and both forged
  // X-Forwarded-For legs. Before this wave each of them replaced the whole headers object.
  const forged = build("titanbot-gate/verify-deploy", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html", "x-forwarded-for": "203.0.113.7" },
  });
  assert.equal(forged.headers["user-agent"], "titanbot-gate/verify-deploy",
    "the caller's headers replaced the gate's name instead of merging with it");
  assert.equal(forged.headers["x-forwarded-for"], "203.0.113.7",
    "the gate's name replaced the caller's headers, which is the same bug pointing the other way");
  assert.equal(forged.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(forged.method, "POST", "and the rest of the caller's init still arrives");

  // A caller that wants a different agent is allowed to have one. The default is a default.
  const overridden = build("titanbot-gate/verify-deploy", { headers: { "user-agent": "curl/8" } });
  assert.equal(overridden.headers["user-agent"], "curl/8");
});

test("verify-deploy's raw https leg carries the header by hand, because node adds none", () => {
  const source = sourceOf("verify-deploy.mjs");
  const leg = /const req = https\.request\(\{[\s\S]*?\n    \}, \(res\)/.exec(source)?.[0];
  assert.notEqual(leg, undefined, "the origin-bypass leg is not in the shape this test knows how to read");
  assert.match(leg, /"user-agent": GATE_AGENT,/,
    "the origin-bypass leg sends no user agent, and it runs three times a run: these are the blank-agent rows in the live ledger");
  assert.match(leg, /"cf-connecting-ip": forgedIp,/, "and it is still the leg this test thinks it is");
});

test("the other three gates put the name where their own requests are made", () => {
  const oneConsole = sourceOf("verify-one-console.mjs");
  // get, postForm and apiCall each build a headers object of their own, so the name goes in the
  // literal rather than through a spread, and the caller's cookie and bearer are still added after.
  assert.match(oneConsole, /const headers = \{ "user-agent": GATE_AGENT, accept \};/, "get");
  assert.match(oneConsole, /const headers = \{ "user-agent": GATE_AGENT, "content-type": "application\/x-www-form-urlencoded", accept: "text\/html" \};/, "postForm");
  assert.match(oneConsole, /headers: \{ "user-agent": GATE_AGENT, "content-type": "application\/json", cookie \}/, "apiCall");
  assert.match(oneConsole, /const SELF = \{ "x-gate-self": "1", "user-agent": GATE_AGENT \};/, "the control plane legs");

  // The browser gate has no fetch at all: every request it makes is Chrome's, so the name goes on
  // the context and rides on the page loads and the form posts alike. Both contexts, because the
  // second one is the wrong-password leg, which is precisely the leg that writes a refused row.
  const browser = sourceOf("verify-one-console-browser.mjs");
  const contexts = browser.match(/browser\.newContext\(\{[^}]*\}[^)]*\)/g) ?? [];
  assert.equal(contexts.length >= 2, true, `expected both browser contexts, found ${contexts.length}`);
  for (const context of contexts) {
    assert.match(context, /userAgent: GATE_AGENT/, `a browser context signs in without naming the gate: ${context}`);
  }

  // The control plane gate knocks at a door whose table cannot hold the field yet (SIGNIN-1b). The
  // header is sent anyway: it costs nothing and it is right the day the column lands.
  assert.match(sourceOf("verify-control-plane.mjs"), /const headers = \{ "user-agent": GATE_AGENT \};/);
});
