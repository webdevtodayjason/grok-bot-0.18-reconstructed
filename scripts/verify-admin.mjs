#!/usr/bin/env node
// verify-admin.mjs -- the ADMIN-1 gate: the super admin console, end to end, against a control
// plane this script starts, a Coolify that is not Coolify, and a relay that is not a relay.
//
// Everything below goes through HTTP the way the console and the CLI reach it, and the page leg
// goes through a real headless Chrome the way Jason reaches it. The one thing this file imports
// from the tree under test is ui/login-ledger.mjs, and only so the relay-ledger leg can drive the
// writer directly: a gate that asked a service whether its own file was safe would be proving
// nothing, so that leg reads the bytes off the disk itself.
//
// The fixture is built in here. The fake relay serves a login-attempts file with three stories in
// it, because those three are what the panel exists to tell apart:
//
//   198.51.100.7    six different passwords in four minutes          -> must be flagged as an attack
//   203.0.113.44    the same password four times                     -> must NOT be flagged
//   192.0.2.10      one refusal and then a successful sign-in        -> an ordinary bad morning
//
// In order:
//   boot        the control plane starts on a free port with a throwaway data dir and answers health
//   promote     an account is added, `account promote` makes it a super admin, demote takes it back,
//               and the last super admin cannot be demoted into a console nobody can open
//   door        every /v1/admin route refuses no bearer, a wrong bearer, a NORMAL account's own
//               valid session, and a token minted under ANOTHER tenant's derived key carrying the
//               super admin's account id; the operator token opens them; a super admin's session
//               opens them
//   ledger      a refused sign-in lands in the control plane's own record with a keyed hash, and
//               the password TEXT is nowhere in the data directory (every file, byte by byte)
//   relay       the relay's own ledger writer: the hash is HMAC-SHA256 under the salt, the salt file
//               is 0600, a success carries no hash, the clear text is not in the file, and the
//               rotation at the cap keeps exactly one previous file
//   attack      six different passwords from one address inside ten minutes raises the flag, four of
//               the same password does not, and the merged list carries both ledgers
//   panels      GET /v1/admin/{overview,sign-ins,clients,boxes,system} answer, and the facts this
//               container cannot read say "not measured" rather than zero
//   contract    GET /v1/admin/providers, when this tree has it, answers the shape the page is
//               written against. When it does not, that is SKIP with the reason, not a fail
//   feedback    FEEDBACK-1: a report posted with the relay token lands and the admin token does
//               not open that door; a slug in the body is ignored in favour of the relay's
//               forwarded one; a report at the console's own maximum lands with nothing shorter
//               than it was sent and one over a limit is refused with the field named rather than
//               truncated; edit, approve and suppress each write a change record row;
//               Create GitHub issue with no token answers the prepared-body sentence and sends
//               nothing; a token the fake GitHub refuses is not stored; one it accepts files it;
//               a suppressed report is refused rather than filed over its own decision, and
//               filing a report nobody approved is recorded as the approval it is
//   ceiling     AGENTS-CAP-2: the clients panel reads the number off the box, 0, 5000, "forty",
//               2.5 and null are each refused in a sentence and never reach the box, a write
//               answers with what the box read back, and a pin reports a pin and not a success
//   page        headless Chrome signs in at /admin and the nine panels are walked one at a time
//               through the rail: each opens from its own hash, is the only one on screen, does not
//               push the document past 900 px at 1440x900, and still carries every control it had
//               (ADMIN-3). The rail is reachable by Tab and by the pointer, and a cold load at a
//               panel's own link opens that panel
//   client      ADMIN-2: the add-client form goes out as a fetch, the row comes back, the temporary
//               password is on the whole document exactly once and is gone after a Refresh, the
//               welcome mail box is present, off and disabled with the reason, and the same address
//               a second time prints the route's own sentence and creates nothing
//   health      PROVIDERS-8: a provider whose most recent requests answered reads as answering with
//               the month's failures beside the chip in amber, its key's last error column reads the
//               same sweep, and Check now is off with the reason on screen when there is no key
//   remove      PROVIDERS-9: Remove is off on a provider that holds a key or serves a plan model,
//               with the reason beside it; on a keyless duplicate it is on, it is what is really
//               under the pointer, an empty confirmation removes nothing, and the typed name takes
//               the duplicate away and leaves the real one
//   providers   the sixth panel, driven through a real browser: a key typed into the masked field
//               reaches no response body and no node of the DOM, a roll takes the pool from two to
//               three to two with no key on screen, a plan model with no screenshot route is
//               refused in a sentence a person reads, a remove with nothing typed is refused, and
//               each of those writes a ledger row with an actor and a time and no key in it
//   leak        no response body in the whole run carries the session secret, the admin token, the
//               relay token, any password, either key planted through the providers panel, or
//               the repository token planted through the Feedback panel; that token is in no row
//               of the change record either, and the store that does hold it is 0600
//
// Exit status: 0 every leg passed, 1 a leg failed, 2 nothing was measured (the control plane could
// not be started, or the browser leg could not resolve playwright).
//
//   node scripts/verify-admin.mjs
//   node scripts/verify-admin.mjs --no-browser     the API legs only
//   CP_GATE_SHOT_DIR=... node scripts/verify-admin.mjs   and a 1440x900 picture of each of the nine
//
// Env: CP_GATE_PORT, CP_GATE_FAKE_PORT, CP_GATE_RELAY_PORT, CP_GATE_GITHUB_PORT to pin ports instead of taking free
//      ones; CP_GATE_TIMEOUT_MS for the boot wait (default 20000); GROK_BOT_PLAYWRIGHT_DIR for the
//      browser leg, defaulting to .cache/playwright, which scripts/setup-gates.sh fills.

import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createLoginLedger, hashTried } from "../ui/login-ledger.mjs";
import { mintSessionToken, tenantSessionSecret } from "../ui/session-token.mjs";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log([
    "verify-admin.mjs -- the ADMIN-1 gate (docs/ADMIN.md).",
    "",
    "  node scripts/verify-admin.mjs",
    "  node scripts/verify-admin.mjs --no-browser",
    "",
    "Starts cp/server.mjs on a free port with a throwaway data dir, a fake Coolify and a fake relay",
    "serving a built-in login-attempts fixture and a fake GitHub, then walks the super admin console:",
    "promote and",
    "demote, the admin door against a normal account, the sign-in ledger and its keyed hash, the",
    "attack rule, the read routes, and the page itself in headless Chrome, including the providers",
    "panel: a key typed into its masked field, a key rolled with no gap, a plan model refused for",
    "having nowhere to send a screenshot, and the ledger rows all three of those wrote. It kills every",
    "server and deletes every temp directory on the way out.",
    "",
    "Exit 0 every leg passed, 1 a leg failed, 2 nothing was measured.",
  ].join("\n"));
  process.exit(0);
}

const WANT_BROWSER = !process.argv.includes("--no-browser");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = process.env.CP_GATE_SERVER ? path.resolve(process.env.CP_GATE_SERVER) : path.join(repoRoot, "cp", "server.mjs");
const BOOT_TIMEOUT_MS = Number(process.env.CP_GATE_TIMEOUT_MS ?? 20000);

// Fake, minted for one process, never printed. The leak leg at the end searches every response body
// this run ever saw for all of them.
const SESSION_SECRET = randomBytes(32).toString("hex");
const ADMIN_TOKEN = randomBytes(24).toString("base64url");
const RELAY_TOKEN = randomBytes(24).toString("base64url");
const COOLIFY_KEY = `fake-${randomBytes(12).toString("hex")}`;
// FEEDBACK-1. The repository token this run plants through the paste door. The leak leg at the end
// hunts for it in every response body, every node of the rendered page, every ledger row and every
// byte of the data directory: this store has never held a secret before, and the whole panel is
// built on it never coming back out.
const GITHUB_TOKEN = `ghp_${randomBytes(20).toString("hex")}`;
const BASE_DOMAIN = "titanium.bot";
const TENANT_SLUG = "titanium";
const SERVICE_UUID = "fakeserviceuuid00001";

const BOSS_EMAIL = `boss+${randomBytes(4).toString("hex")}@example.com`;
const BOSS_PASSWORD = randomBytes(18).toString("base64url");
const USER_EMAIL = `user+${randomBytes(4).toString("hex")}@example.com`;
const USER_PASSWORD = randomBytes(18).toString("base64url");
// The password the ledger legs try and then hunt for on disk. Distinctive on purpose: a random
// base64 string could in principle collide with sqlite's own bytes, and this one cannot.
const TRIED_PASSWORD = `NeverOnDisk-${randomBytes(8).toString("hex")}-Zz`;
// The customer's password as it stands right now. The reset-password leg replaces it, and the
// page leg has to sign in as that person afterwards to be refused for the RIGHT reason: "this
// console is not yours", not "that password is wrong".
let userPasswordNow = USER_PASSWORD;

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` -- ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const step = (title) => console.log(`\n== ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () => new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// ---- the fixture -------------------------------------------------------------------------------
//
// The relay's salt is its own, so these hashes are made with a salt this script owns. That is the
// truth of the shape: the control plane cannot recompute them and never tries to, it only counts
// how many DISTINCT ones came from one address.

const RELAY_SALT = randomBytes(32).toString("hex");
const fixtureHash = (password) => createHmac("sha256", RELAY_SALT).update(password, "utf8").digest("hex");
const ATTACK_IP = "198.51.100.7";
const SAME_IP = "203.0.113.44";
const ORDINARY_IP = "192.0.2.10";
const FIXTURE_AT = Date.now() - 5 * 60 * 1000;

const fixtureRows = [];
// Six different passwords inside four minutes from one address. This is the attack.
for (let index = 0; index < 6; index += 1) {
  fixtureRows.push({
    at: new Date(FIXTURE_AT + index * 40_000).toISOString(),
    door: "account",
    email: "owner@acme-roofing.example",
    ip: ATTACK_IP,
    userAgent: "curl/8.4.0",
    triedHash: fixtureHash(`guess-number-${index}`),
    outcome: "refused",
    tenant: "",
  });
}
// The same password four times from another address. Somebody's phone, and it must not be flagged.
for (let index = 0; index < 4; index += 1) {
  fixtureRows.push({
    at: new Date(FIXTURE_AT + 10_000 + index * 30_000).toISOString(),
    door: "account",
    email: USER_EMAIL,
    ip: SAME_IP,
    userAgent: "Mozilla/5.0 (iPhone)",
    triedHash: fixtureHash("one-stale-saved-password"),
    outcome: "refused",
    tenant: "",
  });
}
// One password against six accounts, one try each, a different address every time. A spray, and the
// shape of it is the point: no address bucket reaches anything, no account is locked out, and every
// row on its own looks like somebody mistyping. The by-address table cannot see this by
// construction, so it is the by-account table and the password summary that have to.
const SPRAY_EMAILS = [];
for (let index = 0; index < 6; index += 1) SPRAY_EMAILS.push(`sprayed${index}@acme-roofing.example`);
const SPRAY_IPS = SPRAY_EMAILS.map((_, index) => `203.0.113.${60 + index}`);
for (let index = 0; index < SPRAY_EMAILS.length; index += 1) {
  fixtureRows.push({
    at: new Date(FIXTURE_AT + 20_000 + index * 25_000).toISOString(),
    door: "account",
    email: SPRAY_EMAILS[index],
    ip: SPRAY_IPS[index],
    userAgent: "python-requests/2.31",
    triedHash: fixtureHash("one-common-password"),
    outcome: "refused",
    tenant: "",
  });
}

// One refusal and then a lockout and then a success. An ordinary bad morning.
fixtureRows.push({
  at: new Date(FIXTURE_AT + 60_000).toISOString(), door: "instance", email: "", ip: ORDINARY_IP,
  userAgent: "Mozilla/5.0", triedHash: fixtureHash("typo"), outcome: "refused", tenant: "",
});
fixtureRows.push({
  at: new Date(FIXTURE_AT + 90_000).toISOString(), door: "instance", email: "", ip: ORDINARY_IP,
  userAgent: "Mozilla/5.0", triedHash: "", outcome: "locked", tenant: "",
});
fixtureRows.push({
  at: new Date(FIXTURE_AT + 150_000).toISOString(), door: "instance", email: "", ip: ORDINARY_IP,
  userAgent: "Mozilla/5.0", triedHash: "", outcome: "ok", tenant: TENANT_SLUG,
});

const fixtureBoxes = [{
  slug: TENANT_SLUG, name: "Titanium", box: `titanbot-box-${SERVICE_UUID}`, operator: true,
  root: `/data/titanbot/${TENANT_SLUG}`,
  containerState: "running", containerStateWhy: "",
  memoryBytes: 1_476_395_008, memoryWhy: "",
  diskKb: 4_194_304, diskWhy: "",
  lastActivityAt: new Date(FIXTURE_AT).toISOString(), lastActivityWhy: "",
  gatewayAnswering: true, gatewayStatus: 200, gatewayMs: 14, gatewayWhy: "",
  measuredAt: new Date().toISOString(),
}];

// ---- the providers fixture ---------------------------------------------------------------------
//
// PROVIDERS-1. The sixth panel is driven by routes that belong to a different item of this wave, so
// until those land this gate serves them itself, through Playwright's own network layer. The page
// is untouched by that: it makes the same same-origin fetch it makes in production, its CSP still
// says connect-src 'self', and nothing about the browser leg is special-cased. What the fixture
// buys is determinism, which is the whole reason the write legs stay on it even after the real
// routes exist: an add, a roll and a remove against a live proxy are not things a gate on a laptop
// can repeat. The contract leg below checks the real route's SHAPE when this tree has it, so a
// route that drifts from what the page reads is a failure and not a surprise on the R750.
//
// The two key values below are planted on purpose and are registered with the leak sweep at the
// end of the run. They are what makes "no key reaches a response body or a node of the DOM" a
// measurement rather than a claim.

const PLANTED_KEY_ADD = `sk-planted-add-${randomBytes(10).toString("hex")}`;
const PLANTED_KEY_ROLL = `sk-planted-roll-${randomBytes(10).toString("hex")}`;

const nowIso = () => new Date().toISOString();
// The mask a real credential store reports: the shape of the key and its last four characters, and
// nothing else. Never enough to use, and it is what the panel draws.
const maskOf = (value) => `sk-****${String(value).slice(-4)}`;
const shortHash = (value) => createHmac("sha256", "gate").update(String(value)).digest("hex").slice(0, 12);

// THE FIXTURE SPEAKS cp/admin.mjs's OWN WORDS. It was once written in a vocabulary of its own --
// key.name, key.mask, catalog.source, defaults.newWorkspaceModel, ledger -- while the route it
// stands in for answered slot, masked, catalog.live, defaults.planModel and actions. Every check
// below passed and the panel drew an empty card against a route that was answering perfectly. So
// the shape here is copied from cp/PROVIDERS-ROUTES.md, and the route-contract leg above measures
// the real route against the same names.
const providersFixture = {
  configured: true,
  why: "",
  db: { on: true, why: "a deployment at the proxy carries db_model true, so a change made here sticks" },
  measuredAt: nowIso(),
  providers: [
    {
      id: "zai", name: "Z.AI", kind: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4",
      fromPreset: true, bootstrapEnv: ["PROXY_ZAI_KEY_1", "PROXY_ZAI_KEY_2"],
      health: {
        reachable: true, why: "", checkedAt: nowIso(),
        how: "the most recent 5 requests on this provider all answered", requests: 412, failures: 0,
        recent: { count: 5, failures: 0, oldestAt: nowIso(), newestAt: nowIso() },
        month: { requests: 412, failures: 0, lastFailureAt: "", lastFailureWhy: "" },
      },
      catalog: {
        models: ["glm-5.3", "glm-5.3-flash", "glm-5", "glm-4.7", "glm-4.6", "glm-4.6v"],
        live: true,
        readAt: nowIso(),
        why: "",
        note: "This is a list of names. The context window and whether a model takes an image are things you set.",
        ready: true,
        liveNeedsKey: true,
        leftoverDoor: false,
      },
      keys: [
        {
          slot: "zai-1", label: "Z.AI subscription one", order: 1, masked: "sk-****4f2a", parked: false,
          serves: ["plan-zai", "plan-zai-vision"], lastError: null,
          spend: { month: 12.41, requests: 4120, tokens: 8_400_000, priced: true, why: "" },
          quota: {
            unit: "prompts", window: "5 hours", used: 120, total: 400, remaining: 280, pct: 30,
            resetAt: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), warn: false, live: false,
            why: "Our own count of what went through this key, 120 of 400 prompts.",
            byWorkspace: [{ slug: "demo", requests: 90, tokens: 412_000, dollars: 0.41 }],
          },
        },
        {
          slot: "zai-2", label: "Z.AI subscription two", order: 2, masked: "sk-****9c11", parked: false,
          serves: ["plan-zai", "plan-zai-vision"], lastError: null,
          // NOT PRICED. This is the state every Z.AI key on the R750 was really in on 2026-09-08:
          // 654 spend rows all at spend 0.000000, because the deployments carry no cost per token.
          // The page must print "not priced" here and never a dollar sign in front of a zero.
          spend: { month: 0, requests: 3980, tokens: 7_100_000, priced: false, why: "no price is set on this key's deployment(s), so what went through it cannot be turned into money." },
          quota: {
            unit: "prompts", window: "5 hours", used: 340, total: 400, remaining: 60, pct: 85,
            resetAt: new Date(Date.now() + 3 * 3600 * 1000).toISOString(), warn: true, live: false,
            why: "Our own count of what went through this key, 340 of 400 prompts.",
            byWorkspace: [],
          },
        },
      ],
    },
    {
      id: "minimax", name: "MiniMax", kind: "openai", baseUrl: "https://api.minimax.io/v1",
      fromPreset: true, bootstrapEnv: ["PROXY_MINIMAX_KEY"],
      health: {
        reachable: null, why: "nothing has run on MiniMax inside this window and no check has been made, so there is nothing to report",
        checkedAt: "", requests: 0, failures: 0,
        recent: { count: 0, failures: 0, oldestAt: "", newestAt: "" },
        month: { requests: 0, failures: 0, lastFailureAt: "", lastFailureWhy: "" },
      },
      catalog: {
        models: ["MiniMax-M3", "MiniMax-M2"], live: false, readAt: "",
        why: "This is the short list this product has actually run. Refresh reads the vendor's own list once a key is in.",
        note: "This is a list of names. The context window and whether a model takes an image are things you set.",
        ready: false, liveNeedsKey: true, leftoverDoor: false,
      },
      keys: [
        {
          slot: "minimax-1", label: "MiniMax subscription", order: 1, masked: "sk-****77ab", parked: false,
          serves: ["plan-minimax"], lastError: null,
          spend: { month: null, requests: null, tokens: null, priced: true, why: "the proxy reported this key with no numbers on it" },
          quota: {
            unit: "requests", window: "", used: 0, total: null, remaining: null, pct: null, resetAt: "",
            warn: false, live: false,
            why: "Nothing is set for this subscription's plan size yet, so there is no bar to draw.",
            byWorkspace: [],
          },
        },
      ],
    },
    // PROVIDERS-8 AND PROVIDERS-9, AS THE R750 REALLY HAD THEM ON 2026-09-09.
    //
    // The Alibaba token plan was listed TWICE. `qwen` is the preset with the override, one key and
    // 254 requests behind it, three of which failed on the evening of 2026-09-08 before the key
    // moved endpoints; the twelve newest all answered. The old rule went red on any failure inside
    // the month window, so the panel said "not answering" while the same model answered HTTP 200 in
    // 2,357 ms through the proxy. The new rule reads the most recent five and this card is GREEN,
    // with the month's three failures beside the chip in amber where they can be acted on.
    {
      id: "qwen", name: "Alibaba Model Studio", kind: "openai",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      fromPreset: true, bootstrapEnv: ["PROXY_QWEN_KEY"],
      health: {
        reachable: true, why: "", checkedAt: nowIso(),
        how: "the most recent 5 requests on this provider all answered",
        requests: 254, failures: 3,
        recent: { count: 5, failures: 0, oldestAt: nowIso(), newestAt: nowIso() },
        month: {
          requests: 254, failures: 3,
          lastFailureAt: "2026-09-08T22:48:09Z",
          lastFailureWhy: "litellm.APIConnectionError: the address the key was on stopped answering",
        },
      },
      catalog: {
        models: ["qwen3-max", "qwen3-coder-plus"], live: false, readAt: "",
        why: "This is the short list this product has actually run.",
        note: "This is a list of names. The context window and whether a model takes an image are things you set.",
        ready: false, liveNeedsKey: true, leftoverDoor: false,
      },
      keys: [
        {
          slot: "qwen-1", label: "Alibaba token plan", order: 1, masked: "sk-****2b90", parked: false,
          serves: ["plan-qwen"],
          // Read off the request log the same sweep the health rule reads, rather than out of the
          // proxy's /health/latest, which answers an empty list on this build and always did.
          lastError: { at: "2026-09-08T22:48:09Z", why: "litellm.APIConnectionError: the address the key was on stopped answering" },
          spend: { month: 4.02, requests: 254, tokens: 2_100_000, priced: true, why: "" },
          quota: {
            unit: "tokens", window: "7 days", used: 2_100_000, total: 10_000_000, remaining: 7_900_000, pct: 21,
            resetAt: new Date(Date.now() + 4 * 86400 * 1000).toISOString(), warn: false, live: false,
            why: "Our own count of what went through this key.",
            byWorkspace: [],
          },
        },
      ],
    },
    // The leftover of the 2026-09-08 recovery: the same name, the same address, no key, and nothing
    // ever run through it. Two identical cards is two chances to point a plan model at the dead one,
    // which is what PROVIDERS-9's Remove control exists to end.
    {
      id: "qwen-plan", name: "Alibaba Model Studio", kind: "openai",
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      fromPreset: false, bootstrapEnv: [],
      health: {
        reachable: null, why: "nothing has ever run on this provider and no check has been made",
        checkedAt: "", requests: 0, failures: 0,
        recent: { count: 0, failures: 0, oldestAt: "", newestAt: "" },
        month: { requests: 0, failures: 0, lastFailureAt: "", lastFailureWhy: "" },
      },
      catalog: {
        models: [], live: false, readAt: "", why: "nobody has read this provider's model list yet",
        note: "This is a list of names. The context window and whether a model takes an image are things you set.",
        ready: false, liveNeedsKey: true, leftoverDoor: false,
      },
      keys: [],
    },
  ],
  planModels: [
    {
      alias: "plan-zai", provider: "zai", vendorModel: "openai/glm-5.3",
      customerName: "Z.AI GLM (included with your plan)", customerLabel: "GLM-5.3", servedBy: "Z.AI GLM",
      contextWindow: 200_000, supportsVision: false, visionFallback: "plan-zai-vision",
      vision: { ok: false, at: nowIso(), why: "messages.content.type is invalid" },
      plans: ["included"], customerVisible: true, shownToCustomers: true,
      deployments: [
        { id: "tb-plan-zai-zai-1", keySlot: "zai-1", fromDb: true, healthy: true, why: "" },
        { id: "tb-plan-zai-zai-2", keySlot: "zai-2", fromDb: true, healthy: true, why: "" },
      ],
      workspaces: 3, workspaceSlugs: ["demo", "richard-avery", "titanium"], workspacesWhy: "",
      inputCostPerToken: null, outputCostPerToken: null, priced: false,
      pricedWhy: "Every dollar figure for this model is zero until a cost per token is set on it, and a zero reads as 'they have not spent anything'.",
      // WHAT THE R750 REALLY LOOKED LIKE. demo was pushed the label; richard-avery and titanium were
      // not, so their Titans answered with the routing alias while their consoles said GLM-5.3.
      runningHere: ["demo", "richard-avery", "titanium"],
      labelBehind: 2, labelBehindSlugs: ["richard-avery", "titanium"],
      labelBehindWhy: "richard-avery, titanium are pointed at plan-zai and say something else. Push the label to fix what their Titan calls itself.",
    },
    {
      // The model everything else falls back TO. It has no fallback of its own and never will, and
      // it must never reach a customer's card, which is what shownToCustomers false says here.
      alias: "plan-zai-vision", provider: "zai", vendorModel: "openai/glm-5.3-flash",
      customerName: "", customerLabel: "", servedBy: "",
      contextWindow: 128_000, supportsVision: true, visionFallback: "",
      vision: { ok: true, at: nowIso(), why: "" },
      plans: ["included"], customerVisible: false, shownToCustomers: false,
      deployments: [
        { id: "tb-plan-zai-vision-zai-1", keySlot: "zai-1", fromDb: true, healthy: true, why: "" },
        { id: "tb-plan-zai-vision-zai-2", keySlot: "zai-2", fromDb: true, healthy: true, why: "" },
      ],
      workspaces: 3, workspaceSlugs: ["demo", "richard-avery", "titanium"], workspacesWhy: "",
      inputCostPerToken: null, outputCostPerToken: null, priced: false, pricedWhy: "",
      runningHere: [], labelBehind: 0, labelBehindSlugs: [], labelBehindWhy: "",
    },
    {
      alias: "plan-qwen", provider: "qwen", vendorModel: "openai/qwen3-max",
      customerName: "Qwen3 Max", customerLabel: "Qwen3-Max", servedBy: "Alibaba Model Studio",
      contextWindow: 256_000, supportsVision: false, visionFallback: "plan-zai-vision",
      vision: { ok: false, at: nowIso(), why: "messages.content.type is invalid" },
      plans: ["included"], customerVisible: true, shownToCustomers: true,
      deployments: [{ id: "tb-plan-qwen-qwen-1", keySlot: "qwen-1", fromDb: true, healthy: true, why: "" }],
      workspaces: 0, workspaceSlugs: [], workspacesWhy: "",
      inputCostPerToken: 0.0000004, outputCostPerToken: 0.0000016, priced: true, pricedWhy: "",
      runningHere: [], labelBehind: 0, labelBehindSlugs: [], labelBehindWhy: "",
    },
    {
      alias: "plan-minimax", provider: "minimax", vendorModel: "openai/MiniMax-M3",
      customerName: "MiniMax-M3", customerLabel: "MiniMax-M3", servedBy: "MiniMax",
      contextWindow: 200_000, supportsVision: false, visionFallback: "plan-zai-vision",
      vision: { ok: false, at: "", why: "this model has never been asked whether it takes an image" },
      plans: ["included"], customerVisible: true, shownToCustomers: true,
      deployments: [{ id: "tb-plan-minimax-minimax-1", keySlot: "minimax-1", fromDb: true, healthy: null, why: "" }],
      workspaces: 0, workspaceSlugs: [], workspacesWhy: "",
      inputCostPerToken: 0.0000012, outputCostPerToken: 0.0000048, priced: true, pricedWhy: "",
      runningHere: [], labelBehind: 0, labelBehindSlugs: [], labelBehindWhy: "",
    },
  ],
  defaults: { planModel: "plan-zai", why: "" },
  pricing: { unpriced: ["plan-zai", "plan-zai-vision"], why: "Some plan models carry no cost per token. Every dollar figure that touches them is zero." },
  actions: [],
};

// Every mutation appends the pool size AFTER it, per provider. A roll that never leaves a gap reads
// 2, 3, 2 in that order: the new key was in before the old one came out. A delete-then-add would
// read 2, 1, 2, and there is no way to tell those apart from the answer alone.
const poolHistory = { zai: [], minimax: [], qwen: [], "qwen-plan": [] };
const pushBodies = [];
const recordPool = (id) => {
  const provider = providersFixture.providers.find((one) => one.id === id);
  if (provider) (poolHistory[id] ??= []).push(provider.keys.length);
};

const fixtureLedger = (action, target, detail, outcome = "ok") => {
  providersFixture.actions.unshift({
    at: nowIso(), actor: BOSS_EMAIL, via: "console", ip: "127.0.0.1", action, target, detail, outcome,
  });
};

// The bodies the fixture served, so the leak sweep covers them the same way it covers the control
// plane's. A fixture that leaked a key would otherwise be invisible to the leg that exists to
// notice exactly that.
const fixtureBodiesSeen = [];

// ADMIN-2. The workspaces the add-client leg creates, merged into the real control plane's own
// /v1/admin/clients answer so the panel draws them the way it would draw a real one. Provisioning a
// container is not a thing a gate on a laptop can do twice, and the whole point of the check is the
// half that CAN be repeated: the form goes out, the row comes back, the password is on screen once,
// and the same address a second time is refused and creates nothing.
const addedClients = [];
const takenEmails = new Set();
const mintedPasswords = [];

/**
 * The whole fixture as one Playwright route handler. Returns [status, body] for a request, or null
 * when this is not a route the fixture owns.
 */
function providersFixtureAnswer(method, pathname, body) {
  const parts = pathname.split("/").filter((one) => one.length > 0); // v1 admin ...
  const at = parts.slice(2);
  const find = (id) => providersFixture.providers.find((one) => one.id === id);

  if (method === "GET" && pathname === "/v1/admin/providers") {
    providersFixture.measuredAt = nowIso();
    return [200, providersFixture];
  }
  if (method === "POST" && pathname === "/v1/admin/providers") {
    // The id is TYPED, not derived: it is what every key slot on this provider is named after.
    const id = String(body?.id ?? "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) return [400, { message: "A provider needs a short name in lower case letters, numbers and dashes." }];
    providersFixture.providers.push({
      id, name: String(body?.name ?? ""), kind: String(body?.kind ?? "openai"), baseUrl: String(body?.baseUrl ?? ""),
      fromPreset: false, bootstrapEnv: [],
      health: { reachable: null, why: "no key here yet, so there is nothing to reach", checkedAt: "" },
      catalog: {
        models: [], live: false, readAt: "", why: "nobody has read this provider's model list yet",
        note: "This is a list of names. The context window and whether a model takes an image are things you set.",
        ready: String(body?.catalogPath ?? "").length > 0, liveNeedsKey: true, leftoverDoor: false,
      },
      keys: [],
    });
    fixtureLedger("added a provider", id, `${body?.kind ?? "openai"} at ${body?.baseUrl ?? ""}`);
    return [200, { ok: true, message: `${body?.name} was added. Add a key to it before pointing a plan model at it.` }];
  }
  // PROVIDERS-9. Removing a provider. Before the branch below, because that one takes every
  // /v1/admin/providers/:id request and would swallow this one into a fall-through.
  if (method === "DELETE" && at[0] === "providers" && at.length === 2) {
    const id = decodeURIComponent(at[1]);
    const provider = find(id);
    if (provider == null) return [404, { error: "not_found", message: `There is no provider called ${id}.` }];
    if (String(body?.confirm ?? "") !== id) {
      fixtureLedger("tried to remove a provider", id, "the confirmation did not match", "refused");
      return [409, { error: "confirm_mismatch", message: `Type ${id} to confirm. Nothing was removed.` }];
    }
    if ((provider.keys ?? []).length > 0) {
      return [409, { error: "has_keys", message: `${provider.name} still holds ${provider.keys.length} key(s). Remove them first: taking a provider away under a live key stops every workspace on it.` }];
    }
    const serving = providersFixture.planModels.filter((one) => one.provider === id);
    if (serving.length > 0) {
      return [409, { error: "has_deployments", message: `${serving.map((one) => one.alias).join(", ")} still runs on ${provider.name}. Point it somewhere else first.` }];
    }
    if (provider.fromPreset === true && body?.andOverride !== true) {
      return [409, { error: "preset_override", message: `${provider.name} is one of the built-in providers and this one carries an override. Removing it takes the override off and puts the built-in back, which is a different thing, so say so.` }];
    }
    providersFixture.providers = providersFixture.providers.filter((one) => one.id !== id);
    fixtureLedger("removed a provider", id, provider.fromPreset === true
      ? "the override came off and the built-in came back"
      : "it held no key and served nothing");
    return [200, {
      removed: id,
      wasPreset: provider.fromPreset === true,
      catalogSwept: true,
      left: providersFixture.providers.length,
      message: `${provider.name} is gone. ${providersFixture.providers.length} providers are left.`,
    }];
  }

  // ADMIN-2. Adding a client. Before the /v1/admin/clients/:slug/model branch further down, which
  // only matches a longer path, and before anything else claims the bare collection.
  if (method === "POST" && pathname === "/v1/admin/clients") {
    const email = String(body?.email ?? "").trim().toLowerCase();
    const company = String(body?.company ?? "").trim();
    if (email.length === 0 || !email.includes("@")) {
      return [400, { error: "bad_request", message: "That is not an email address." }];
    }
    if (!/[a-z0-9]/i.test(company)) {
      return [400, { error: "bad_company", message: "That company name has no letters or numbers in it, so there is nothing to name the workspace after. Send a different one." }];
    }
    // The control plane's own words, verbatim, from cp/server.mjs's signup handler. The panel prints
    // whatever the route says without rewording it, so this is what the check below reads.
    if (takenEmails.has(email)) {
      return [409, { error: "duplicate_email", message: "That email address already has an account. Sign in instead." }];
    }
    takenEmails.add(email);
    const slug = company.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
    const temporaryPassword = `tmp-${randomBytes(9).toString("base64url")}`;
    mintedPasswords.push(temporaryPassword);
    addedClients.push({
      slug, name: company, status: "provisioning", lastError: "",
      coolify: { reachable: false, status: "" },
      users: [{
        id: `acct-${slug}`, email, name: String(body?.name ?? ""),
        createdAt: nowIso(), lastSignInAt: null, superAdmin: false, disabled: false,
      }],
      model: null,
      ceiling: { read: false, why: "this workspace's box is still being built, so it has not reported a ceiling yet" },
      spend: null,
    });
    fixtureLedger("added a client", slug, `${email}, ceiling ${body?.ceiling ?? "the default"}`);
    return [201, {
      tenant: { slug, name: company },
      account: { email, name: String(body?.name ?? "") },
      temporaryPassword,
      signIn: `https://console.titanium.bot/${slug}`,
      state: "building",
      planModel: { applied: String(body?.planModel ?? ""), why: "the workspace starts on it at its first turn" },
      ceiling: { applied: Number(body?.ceiling ?? 40), why: "written into the box's own environment" },
      welcomeMail: { sent: false, why: "this control plane sends no mail yet" },
      message: `${company} was added. The workspace is still coming up.`,
    }];
  }

  // /v1/admin/providers/:id/...
  if (at[0] === "providers" && at.length >= 2) {
    const provider = find(at[1]);
    if (provider == null) return [404, { message: "no provider by that name" }];
    if (method === "POST" && at[2] === "catalog" && at[3] === "refresh") {
      provider.catalog.readAt = nowIso();
      provider.catalog.live = true;
      fixtureLedger("read a provider's model list", provider.id, `${provider.catalog.models.length} names, and names are all a model list carries`);
      return [200, { ok: true, message: `${provider.name} lists ${provider.catalog.models.length} models. That is names and nothing else: the context window and whether it takes a screenshot are yours to set.` }];
    }
    if (method === "POST" && at[2] === "keys" && at.length === 3) {
      const value = String(body?.apiKey ?? "");
      if (value.length === 0) return [400, { message: "a key was not sent" }];
      recordPool(provider.id); // the size before, so the history reads as a sequence and not a result
      provider.keys.push({
        slot: `${provider.id}-${provider.keys.length + 1}`,
        label: String(body?.label ?? "") || `${provider.name} key ${provider.keys.length + 1}`,
        order: provider.keys.length + 1,
        masked: maskOf(value),
        parked: false, backsCatalog: false, serves: [], lastError: null,
        spend: { month: 0, requests: 0, why: "" },
        quota: { unit: "requests", window: "", used: 0, total: null, remaining: null, pct: null, resetAt: "", warn: false, live: false, why: "Nothing is set for this subscription's plan size yet.", byWorkspace: [] },
      });
      recordPool(provider.id);
      fixtureLedger("added a key", `${provider.id}/${provider.keys[provider.keys.length - 1].slot}`, `${value.length} characters, ${shortHash(value)}`);
      return [200, { ok: true, message: `A key was added to ${provider.name} as ${provider.keys[provider.keys.length - 1].slot} (${shortHash(value)}). The proxy uses it on the next request.` }];
    }
    if (method === "POST" && at[2] === "keys" && at.length >= 5) {
      const key = provider.keys.find((one) => one.slot === decodeURIComponent(at[3]));
      if (key == null) return [404, { message: "no key by that name" }];
      if (at[4] === "roll") {
        const value = String(body?.apiKey ?? "");
        if (value.length === 0) return [400, { message: "a key was not sent" }];
        // IN FIRST, THEN OUT. The pool history is what proves there was never a moment with fewer
        // keys than it started with: it reads two, three, two. A delete-then-add would read two,
        // one, two, and from the answer alone the two are indistinguishable.
        recordPool(provider.id);
        const replacement = { ...key, slot: `${key.slot}-new`, masked: maskOf(value), order: provider.keys.length + 1 };
        provider.keys.push(replacement);
        recordPool(provider.id);
        provider.keys = provider.keys.filter((one) => one.slot !== key.slot);
        replacement.slot = key.slot;
        replacement.order = key.order;
        provider.keys.sort((a, b) => a.order - b.order);
        recordPool(provider.id);
        fixtureLedger("rolled a key", `${provider.id}/${key.slot}`, `${value.length} characters, ${shortHash(value)}, the old one came out after the new one answered`);
        return [200, { ok: true, message: `${key.label} was replaced (${shortHash(value)}). The new key went in beside the old one and the old one came out after it answered, so nothing failed in between.` }];
      }
      if (at[4] === "park") {
        key.parked = body?.parked === true;
        fixtureLedger(key.parked ? "parked a key" : "put a key back in use", `${provider.id}/${key.slot}`, "");
        return [200, { ok: true, message: key.parked ? `${key.label} is parked and takes no more requests.` : `${key.label} is back in use from the next request.` }];
      }
      if (at[4] === "quota") {
        key.quota = {
          ...key.quota,
          unit: String(body?.unit ?? key.quota?.unit ?? "requests"),
          window: String(body?.window ?? ""),
          total: Number(body?.total) > 0 ? Number(body.total) : null,
          resetAt: String(body?.resetAt ?? ""),
        };
        key.quota.remaining = key.quota.total == null ? null : Math.max(0, key.quota.total - key.quota.used);
        key.quota.pct = key.quota.total == null ? null : Math.round((key.quota.used / key.quota.total) * 100);
        key.quota.warn = key.quota.pct != null && key.quota.pct >= 80;
        fixtureLedger("recorded a plan window", `${provider.id}/${key.slot}`, `${key.quota.total ?? "none"} ${key.quota.unit}`);
        return [200, { ok: true, message: `The plan window for ${key.label} is recorded. What is counted against it is our own count of what went through this key.` }];
      }
      if (at[4] === "remove") {
        // The SLOT, which is what cp/admin.mjs checks. A confirmation the service would refuse is a
        // confirmation that teaches the operator the wrong word.
        if (String(body?.confirm ?? "") !== key.slot) {
          fixtureLedger("tried to remove a key", `${provider.id}/${key.slot}`, "the confirmation did not match", "refused");
          return [400, { message: `Type ${key.slot} to confirm. Nothing was removed.` }];
        }
        provider.keys = provider.keys.filter((one) => one.slot !== key.slot);
        recordPool(provider.id);
        fixtureLedger("removed a key", `${provider.id}/${key.slot}`, "the value is gone and cannot be read back");
        return [200, { ok: true, message: `${key.label} is gone. The proxy stops using it on the next request.` }];
      }
    }
  }
  const planModelRow = (alias, body, existing) => ({
    alias,
    provider: String(body?.provider ?? existing?.provider ?? ""),
    vendorModel: String(body?.vendorModel ?? existing?.vendorModel ?? ""),
    customerName: String(body?.customerName ?? existing?.customerName ?? ""),
    customerLabel: String(body?.customerLabel ?? existing?.customerLabel ?? ""),
    servedBy: String(body?.servedBy ?? existing?.servedBy ?? ""),
    customerVisible: body?.customerVisible !== undefined ? body.customerVisible !== false : (existing?.customerVisible !== false),
    visionFallback: String(body?.visionFallback ?? existing?.visionFallback ?? ""),
    contextWindow: body?.contextWindow ?? existing?.contextWindow ?? null,
    supportsVision: body?.supportsVision !== undefined ? body.supportsVision === true : existing?.supportsVision === true,
    vision: existing?.vision ?? { ok: false, at: "", why: "this model has never been asked whether it takes an image" },
    plans: Array.isArray(body?.plans) ? body.plans : (existing?.plans ?? []),
    deployments: existing?.deployments ?? (Array.isArray(body?.keySlots) ? body.keySlots.map((slot) => ({ id: `tb-${alias}-${slot}`, keySlot: String(slot), fromDb: true, healthy: true, why: "" })) : []),
    workspaces: existing?.workspaces ?? 0,
    workspaceSlugs: existing?.workspaceSlugs ?? [],
    workspacesWhy: "",
    inputCostPerToken: body?.inputCostPerToken !== undefined ? Number(body.inputCostPerToken) : (existing?.inputCostPerToken ?? null),
    outputCostPerToken: body?.outputCostPerToken !== undefined ? Number(body.outputCostPerToken) : (existing?.outputCostPerToken ?? null),
    priced: (body?.inputCostPerToken !== undefined || body?.outputCostPerToken !== undefined) ? true : (existing?.priced === true),
    pricedWhy: "",
    runningHere: existing?.runningHere ?? [],
    labelBehind: existing?.labelBehind ?? 0,
    labelBehindSlugs: existing?.labelBehindSlugs ?? [],
    labelBehindWhy: existing?.labelBehindWhy ?? "",
  });
  const withShown = (row) => ({
    ...row,
    // The one rule that keeps a routing target off a customer's card, computed here the way
    // cp/admin.mjs computes it, so the panel is drawn against the same answer.
    shownToCustomers: row.customerVisible === true && String(row.customerLabel ?? "").length > 0 && String(row.customerName ?? "").length > 0,
  });
  if (method === "POST" && pathname === "/v1/admin/plan-models") {
    const alias = String(body?.alias ?? "");
    if (alias.length === 0) return [400, { message: "a plan model needs a routing name" }];
    if (providersFixture.planModels.some((one) => one.alias === alias)) {
      return [409, { message: `${alias} already exists. Change it instead: the name is what every box already points at.` }];
    }
    if (String(body?.visionFallback ?? "").length === 0 && body?.supportsVision !== true) {
      return [400, { message: "a plan model needs somewhere for a screenshot to go" }];
    }
    const row = withShown(planModelRow(alias, body, null));
    providersFixture.planModels.push(row);
    fixtureLedger("added a plan model", alias, `${row.vendorModel} across ${row.deployments.length} key(s)`);
    return [200, { ok: true, message: `${row.customerName || alias} is saved. The proxy uses it on the next request and a workspace picks it up on its next turn.` }];
  }
  if (method === "POST" && at[0] === "plan-models" && at[2] === "update") {
    const alias = decodeURIComponent(at[1]);
    const existing = providersFixture.planModels.find((one) => one.alias === alias);
    if (existing == null) return [404, { message: `The proxy serves nothing called ${alias}.` }];
    if (String(body?.visionFallback ?? existing.visionFallback ?? "").length === 0 && !(body?.supportsVision ?? existing.supportsVision)) {
      return [400, { message: "a plan model needs somewhere for a screenshot to go" }];
    }
    Object.assign(existing, withShown(planModelRow(alias, body, existing)));
    fixtureLedger("changed a plan model", alias, existing.vendorModel);
    return [200, { ok: true, message: `${existing.customerName || alias} is saved. The proxy uses it on the next request and a workspace picks it up on its next turn.` }];
  }
  // The pool a plan model runs on: one deployment per key. Add first, then remove, so it is never
  // short a key, and never empty.
  if (method === "POST" && at[0] === "plan-models" && at[2] === "keys") {
    const alias = decodeURIComponent(at[1]);
    const row = providersFixture.planModels.find((one) => one.alias === alias);
    if (row == null) return [404, { message: `The proxy serves nothing called ${alias}.` }];
    const wanted = Array.isArray(body?.keySlots) ? [...new Set(body.keySlots.map(String))] : [];
    if (wanted.length === 0) return [400, { message: "Name the keys this model should run on. A plan model with no key behind it serves nothing." }];
    row.deployments = wanted.map((slot) => (row.deployments ?? []).find((one) => one.keySlot === slot)
      ?? { id: `tb-${alias}-${slot}`, keySlot: slot, fromDb: true, healthy: true, why: "" });
    fixtureLedger("changed the keys a plan model runs on", alias, wanted.join(", "));
    return [200, { alias, keySlots: wanted, message: `${alias} runs on ${wanted.length === 1 ? "one key" : `${wanted.length} keys`} from the next request: ${wanted.join(", ")}.` }];
  }
  if (method === "POST" && at[0] === "plan-models" && at[2] === "vision-check") {
    const alias = decodeURIComponent(at[1]);
    const row = providersFixture.planModels.find((one) => one.alias === alias);
    if (row == null) return [404, { message: `The proxy serves nothing called ${alias}.` }];
    row.vision = { ok: row.supportsVision === true, at: nowIso(), why: row.supportsVision ? "" : "messages.content.type is invalid" };
    fixtureLedger("asked a model whether it takes an image", alias, row.vision.ok ? "it took the image" : "it refused the image");
    return [200, { ok: true, message: row.vision.ok ? `${alias} took an image part.` : `${alias} refused an image part. It needs a vision fallback.` }];
  }
  if (method === "POST" && at[0] === "plan-models" && at[2] === "apply") {
    const alias = decodeURIComponent(at[1]);
    fixtureLedger("gave every workspace access to a model", alias, "");
    return [200, { ok: true, message: `Every workspace can reach ${alias} now. It shows up in their own list within a minute.` }];
  }
  if (method === "POST" && at[0] === "plan-models" && at[2] === "push-label") {
    const alias = decodeURIComponent(at[1]);
    const row = providersFixture.planModels.find((one) => one.alias === alias);
    // Every push body the page sent, so the leg below can prove what it sent and not only what came
    // back. The defect this catches is a page that answers the route's refusal by resending
    // { all: true }, which is the safety being defeated by the client rather than a bug in either.
    pushBodies.push(body ?? {});
    // The route refuses a push that names nobody, because it writes inside a box AND sets the
    // model. The fixture refuses it too, or the page could ship sending an empty body forever.
    const named = Array.isArray(body?.slugs) ? body.slugs.map(String) : [];
    const targets = named.length > 0 ? named : (body?.all === true ? (row?.workspaceSlugs ?? []) : []);
    if (targets.length === 0) {
      return [409, {
        error: "name_them",
        candidates: row?.workspaceSlugs ?? [],
        message: `Say which workspaces. This writes inside a box and it sets the model as well as the label, so it is never done to a workspace nobody named.`,
      }];
    }
    fixtureLedger("pushed a model label to the workspaces running it", alias, String(row?.customerLabel ?? ""));
    return [200, { ok: true, message: `${targets.length} workspace(s) will call it ${row?.customerLabel ?? ""} from their next turn.` }];
  }
  if (method === "POST" && pathname === "/v1/admin/defaults") {
    providersFixture.defaults.planModel = String(body?.planModel ?? "");
    fixtureLedger("changed what a new workspace starts on", providersFixture.defaults.planModel, "");
    return [200, { ok: true, message: `A workspace made from now on starts on ${providersFixture.defaults.planModel}.` }];
  }
  if (method === "POST" && at[0] === "clients" && at[2] === "model") {
    const slug = decodeURIComponent(at[1]);
    const alias = String(body?.planModel ?? "");
    // The banner a person reads names the model the way a person names it. The alias belongs in the
    // ledger row, where the operator is looking at plumbing on purpose, and nowhere else.
    const named = providersFixture.planModels.find((one) => one.alias === alias);
    fixtureLedger("changed one workspace's model", slug, alias);
    return [200, { ok: true, message: `${slug} runs on ${named?.customerName || alias} from its next turn.` }];
  }
  return null;
}

// ---- the fake Coolify --------------------------------------------------------------------------
const coolifyCalls = [];
function fakeCoolifyHandler(req, res) {
  const url = new URL(req.url, "http://fake");
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const authorized = (req.headers.authorization ?? "").startsWith("Bearer ");
    // Whether a key was sent, never the key. A recorder that prints bearers is a recorder that
    // leaks them.
    coolifyCalls.push({ method: req.method, path: url.pathname, authorized, bytes: body.length });
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    };
    if (!authorized) return send(401, { message: "Unauthenticated." });
    const p = url.pathname.replace(/^\/api\/v1/, "");
    if (req.method === "GET" && /^\/projects\/?$/.test(p)) return send(200, [{ id: 1, uuid: "fakeprojectuuid00001", name: "Titanium Computing" }]);
    if (req.method === "GET" && /^\/servers\/?$/.test(p)) return send(200, [{ id: 1, uuid: "fakeserveruuid000001", name: "r750" }]);
    if (req.method === "POST" && /^\/services\/[^/]+\/(start|stop|restart)\/?$/.test(p)) return send(200, { message: "Service request queued." });
    if (req.method === "GET" && /^\/services\/[^/]+\/applications\/?$/.test(p)) {
      return send(200, [{ uuid: "app-box", name: "titanbot-box", status: "running", fqdn: null }]);
    }
    if (req.method === "GET" && /^\/services\/[^/]+\/?$/.test(p)) {
      return send(200, { id: 1, uuid: SERVICE_UUID, name: `titanbot-${TENANT_SLUG}`, status: "running:unknown", applications: [{ uuid: "app-box", name: "titanbot-box", status: "running", fqdn: null }] });
    }
    return send(404, { message: "Not found." });
  });
}

// ---- the fake relay ----------------------------------------------------------------------------
// One credential, CP_RELAY_TOKEN, and it is the same value the real relay checks. A request without
// it is refused here for the same reason it is refused there: this route is every failed sign-in on
// the fleet.
const relayCalls = [];
// AGENTS-CAP-2. What each "box" holds, so a write and the read after it are the same fact. The one
// workspace this gate builds starts where the R750's three do today, at 100.
const fixtureCeilings = new Map([[TENANT_SLUG, { maxAgents: 100, bots: 6, pinned: false, read: true }]]);
const ceilingWrites = [];
function fakeRelayHandler(req, res) {
  const url = new URL(req.url, "http://fake");
  const header = String(req.headers.authorization ?? "");
  const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  relayCalls.push({ method: req.method, path: url.pathname, authorized: presented === RELAY_TOKEN });
  const send = (status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  if (presented !== RELAY_TOKEN) return send(401, { error: "unauthorized" });
  if (url.pathname === "/admin/login-attempts") {
    const since = Date.parse(url.searchParams.get("since") ?? "");
    const outcome = String(url.searchParams.get("outcome") ?? "");
    const rows = fixtureRows.filter((row) => {
      if (Number.isFinite(since) && Date.parse(row.at) < since) return false;
      if (outcome.length > 0 && row.outcome !== outcome) return false;
      return true;
    });
    return send(200, { source: "relay", measuredAt: new Date().toISOString(), rows });
  }
  if (url.pathname === "/admin/boxes") {
    return send(200, { measuredAt: new Date().toISOString(), boxes: fixtureBoxes });
  }
  // AGENTS-CAP-2. The ceiling, read off "the box" and written into it. The fake keeps the number
  // per workspace so a write really does change what the next read answers: a fake that echoed the
  // request back would pass a control plane that never called it.
  const ceiling = /^\/admin\/tenants\/([^/]+)\/ceiling$/.exec(url.pathname);
  if (ceiling != null) {
    const slug = decodeURIComponent(ceiling[1]);
    const state = fixtureCeilings.get(slug);
    if (state == null) return send(404, { error: "not_found" });
    const answer = () => send(200, {
      slug, measuredAt: new Date().toISOString(),
      read: state.read !== false, maxAgents: state.maxAgents, bots: state.bots,
      pinned: state.pinned === true, pinnedBy: state.pinned === true ? "container env (SAND_MAX_AGENTS)" : null,
      why: state.read === false ? "that box did not answer" : "",
    });
    if (req.method === "GET") return answer();
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let wanted = null;
      try { wanted = Number(JSON.parse(raw || "{}").maxAgents); } catch { wanted = null; }
      ceilingWrites.push({ slug, maxAgents: wanted });
      // A pinned box takes the write into its file and keeps answering through its environment,
      // which is the whole reason the control plane must report a pin rather than a success.
      if (state.pinned !== true && Number.isInteger(wanted)) state.maxAgents = wanted;
      answer();
    });
    return undefined;
  }
  return send(404, { error: "not_found" });
}

// ---- the fake GitHub ---------------------------------------------------------------------------
// FEEDBACK-1. The issue door is proved and fired against this, never against api.github.com: a gate
// that filed a real issue every time somebody ran it would be a gate nobody runs. The control plane
// is pointed here with CP_GITHUB_API_URL.
//
// It answers the way GitHub does for the three cases the door has to tell apart: a repository this
// token can see with issues on, one whose issues are off, and a token it refuses outright.
const githubCalls = [];
const GOOD_REPO = "titanium/bot";
const NO_ISSUES_REPO = "titanium/archive";
function fakeGithubHandler(req, res) {
  const url = new URL(req.url, "http://fake");
  const header = String(req.headers.authorization ?? "");
  const presented = /^bearer\s+/i.test(header) ? header.replace(/^bearer\s+/i, "").trim() : "";
  githubCalls.push({ method: req.method, path: url.pathname, token: presented });
  const send = (status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
    res.end(text);
  };
  if (presented !== GITHUB_TOKEN) return send(401, { message: "Bad credentials" });
  if (req.method === "GET" && url.pathname === `/repos/${GOOD_REPO}`) return send(200, { full_name: GOOD_REPO, has_issues: true });
  if (req.method === "GET" && url.pathname === `/repos/${NO_ISSUES_REPO}`) return send(200, { full_name: NO_ISSUES_REPO, has_issues: false });
  if (req.method === "POST" && url.pathname === `/repos/${GOOD_REPO}/issues`) {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      let issue = {};
      try { issue = JSON.parse(raw || "{}"); } catch { issue = {}; }
      githubIssues.push(issue);
      send(201, { number: githubIssues.length, html_url: `https://github.com/${GOOD_REPO}/issues/${githubIssues.length}` });
    });
    return undefined;
  }
  return send(404, { message: "Not Found" });
}
const githubIssues = [];

// ---- the run -----------------------------------------------------------------------------------

const bodiesSeen = [];
let child = null;
let fakeCoolify = null;
let fakeRelay = null;
let fakeGithub = null;
let dataDir = null;
let tenantRoot = null;
let ledgerDir = null;
let browser = null;
const childLog = [];

const cleanup = () => {
  if (browser) { try { void browser.close(); } catch { /* already gone */ } }
  if (child && child.exitCode == null) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  for (const server of [fakeCoolify, fakeRelay, fakeGithub]) { if (server) { try { server.close(); } catch { /* already closed */ } } }
  for (const dir of [dataDir, tenantRoot, ledgerDir]) {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ } }
  }
};
const die = (message) => {
  console.log(`\n${message}`);
  console.log("exit 2: nothing was measured");
  cleanup();
  process.exit(2);
};

if (!existsSync(SERVER)) die(`the control plane's entry point is not in this tree (looked at ${SERVER}).`);
if (!existsSync(path.join(repoRoot, "cp", "admin", "index.html"))) {
  die("cp/admin/index.html is not in this tree, so there is no console to measure.");
}

const CP_PORT = Number(process.env.CP_GATE_PORT ?? await freePort());
const FAKE_PORT = Number(process.env.CP_GATE_FAKE_PORT ?? await freePort());
const RELAY_PORT = Number(process.env.CP_GATE_RELAY_PORT ?? await freePort());
const GITHUB_PORT = Number(process.env.CP_GATE_GITHUB_PORT ?? await freePort());
const BASE = `http://127.0.0.1:${CP_PORT}`;

dataDir = mkdtempSync(path.join(tmpdir(), "admin-gate-data-"));
tenantRoot = mkdtempSync(path.join(tmpdir(), "admin-gate-tenants-"));
ledgerDir = mkdtempSync(path.join(tmpdir(), "admin-gate-ledger-"));

fakeCoolify = http.createServer(fakeCoolifyHandler);
await new Promise((resolve, reject) => { fakeCoolify.once("error", reject); fakeCoolify.listen(FAKE_PORT, "127.0.0.1", resolve); });
fakeRelay = http.createServer(fakeRelayHandler);
await new Promise((resolve, reject) => { fakeRelay.once("error", reject); fakeRelay.listen(RELAY_PORT, "127.0.0.1", resolve); });
fakeGithub = http.createServer(fakeGithubHandler);
await new Promise((resolve, reject) => { fakeGithub.once("error", reject); fakeGithub.listen(GITHUB_PORT, "127.0.0.1", resolve); });

const call = async (method, pathname, { body, token, admin, raw } = {}) => {
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (admin) headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  else if (token) headers.authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`${BASE}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (error) {
    return { status: 0, text: "", json: null, error: String(error?.message ?? error) };
  }
  const text = await res.text();
  if (!raw) bodiesSeen.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json, the leg says so */ }
  return { status: res.status, text, json, error: null, headers: res.headers };
};

console.log(`control plane on ${BASE}`);
console.log(`fake Coolify on http://127.0.0.1:${FAKE_PORT}, fake relay on http://127.0.0.1:${RELAY_PORT}`);
console.log(`data dir ${dataDir}`);

child = spawn(process.execPath, [SERVER], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    CP_PORT: String(CP_PORT),
    CP_DATA_DIR: dataDir,
    CP_SESSION_SECRET: SESSION_SECRET,
    CP_ADMIN_TOKEN: ADMIN_TOKEN,
    CP_RELAY_TOKEN: RELAY_TOKEN,
    CP_RELAY_URL: `http://127.0.0.1:${RELAY_PORT}`,
    // FEEDBACK-1. The issue door is pointed at this run's own fake, so no run of this gate ever
    // reaches api.github.com and no run ever files a real issue at a real repository.
    CP_GITHUB_API_URL: `http://127.0.0.1:${GITHUB_PORT}`,
    CP_BASE_DOMAIN: BASE_DOMAIN,
    CP_COOLIFY_URL: `http://127.0.0.1:${FAKE_PORT}`,
    COOLIFY_API_KEY: COOLIFY_KEY,
    COOLIFY_PROJECT_UUID: "fakeprojectuuid00001",
    COOLIFY_SERVER_UUID: "fakeserveruuid000001",
    CP_TENANT_ROOT: tenantRoot,
    CP_RELEASE_ROOT: tenantRoot,
    CP_PUBLIC_URL: BASE,
    // Neither is mounted anywhere on this Mac, which is exactly the state the panel has to render
    // honestly. Left unset on purpose so the "not measured" leg measures the real default.
    CP_BACKUP_MANIFEST_DIR: "",
    CP_ISOLATION_REPORT: "",
  },
});
child.stdout.on("data", (chunk) => childLog.push(String(chunk)));
child.stderr.on("data", (chunk) => childLog.push(String(chunk)));
child.on("exit", (code, signal) => childLog.push(`\n[control plane exited code=${code} signal=${signal}]\n`));

const bootedBy = Date.now() + BOOT_TIMEOUT_MS;
let booted = false;
while (Date.now() < bootedBy) {
  const health = await call("GET", "/v1/health");
  if (health.status === 200) { booted = true; break; }
  if (child.exitCode != null) break;
  await sleep(200);
}
if (!booted) die(`the control plane never answered /v1/health.\n${childLog.join("")}`);

// ---- boot ---------------------------------------------------------------------------------------
step("boot");
{
  const health = await call("GET", "/v1/health");
  check(health.status === 200 && health.json?.ok === true, "the control plane answers /v1/health", `status ${health.status}`);
}

// ---- promote and demote ---------------------------------------------------------------------------
step("promote and demote");
{
  const adopt = await call("POST", `/v1/tenants/${TENANT_SLUG}/adopt`, {
    admin: true,
    body: { coolifyServiceUuid: SERVICE_UUID, host: `console.${BASE_DOMAIN}`, name: "Titanium" },
  });
  check(adopt.status === 200, "a workspace exists to sign in to", `status ${adopt.status}`);

  const boss = await call("POST", "/v1/accounts", { admin: true, body: { email: BOSS_EMAIL, password: BOSS_PASSWORD, tenant: TENANT_SLUG, name: "Jason" } });
  const user = await call("POST", "/v1/accounts", { admin: true, body: { email: USER_EMAIL, password: USER_PASSWORD, tenant: TENANT_SLUG, name: "A customer" } });
  check(boss.status === 201 && user.status === 201, "two accounts were added", `${boss.status} and ${user.status}`);
  check(boss.json?.account?.superAdmin === false, "a new account is not a super admin");

  const promoted = await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/promote`, { admin: true });
  check(promoted.status === 200 && promoted.json?.account?.superAdmin === true, "the operator token promotes an account", `status ${promoted.status}`);

  const listed = await call("GET", "/v1/accounts", { admin: true });
  const seen = (listed.json?.accounts ?? []).find((row) => row.email === BOSS_EMAIL);
  check(seen?.superAdmin === true, "the flag reads back on the account list");

  // Promote a second one so the demote below is not the last one standing.
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { admin: true });
  const demoted = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/demote`, { admin: true });
  check(demoted.status === 200 && demoted.json?.account?.superAdmin === false, "demote takes it back", `status ${demoted.status}`);

  // And now there is one left, which is the one that must not be demotable.
  const last = await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/demote`, { admin: true });
  check(last.status === 409 && last.json?.error === "last_super_admin", "the last super admin cannot be demoted into a console nobody can open", `status ${last.status}`);

  const missing = await call("POST", "/v1/admin/users/nobody@example.com/promote", { admin: true });
  check(missing.status === 404, "promoting somebody who does not exist is a 404", `status ${missing.status}`);
}

// ---- the door -------------------------------------------------------------------------------------
step("the admin door");
const ADMIN_ROUTES = ["/v1/admin/overview", "/v1/admin/sign-ins", "/v1/admin/clients", "/v1/admin/boxes", "/v1/admin/system"];
let bossToken = "";
let userToken = "";
{
  for (const route of ADMIN_ROUTES) {
    const bare = await call("GET", route);
    check(bare.status === 401, `${route} refuses a caller with no bearer`, `status ${bare.status}`);
  }
  const wrong = await call("GET", "/v1/admin/overview", { token: randomBytes(24).toString("base64url") });
  check(wrong.status === 401, "a made-up bearer opens nothing", `status ${wrong.status}`);

  const relayTried = await call("GET", "/v1/admin/overview", { token: RELAY_TOKEN });
  check(relayTried.status === 401, "the relay's own credential does not open the admin console", `status ${relayTried.status}`);

  const userSession = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: USER_PASSWORD } });
  userToken = String(userSession.json?.token ?? "");
  check(userSession.status === 200 && userToken.length > 0, "a normal account signs in to its workspace", `status ${userSession.status}`);
  check(userSession.json?.account?.superAdmin === false, "and the answer says it is not a super admin");

  for (const route of ADMIN_ROUTES) {
    const refused = await call("GET", route, { token: userToken });
    check(refused.status === 401, `${route} refuses a normal account's valid session`, `status ${refused.status}`);
  }
  const escalate = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { token: userToken });
  check(escalate.status === 401, "a normal account cannot promote itself", `status ${escalate.status}`);

  // A token minted under ANOTHER tenant's own key, carrying the super admin's account id.
  //
  // This is the shape of the real attack and not a theoretical one. Every tenant relay is handed
  // its own derived session key, that key sits in that customer's Coolify environment, and anyone
  // who can run code in that customer's relay holds it. A signature made with it proves which key
  // was used and nothing about who the person is, so the account the token NAMES has to be the
  // account the token was issued for. Without that binding this mints a super admin out of one
  // ordinary customer's key.
  const roster = await call("GET", "/v1/accounts", { admin: true });
  const bossId = String((roster.json?.accounts ?? []).find((row) => row.email === BOSS_EMAIL)?.id ?? "");
  check(bossId.length > 0, "the gate knows the super admin's account id, which is what a forgery would carry");
  const forgedAt = Date.now();
  const { token: forged } = mintSessionToken({
    sub: bossId,
    email: BOSS_EMAIL,
    tenant: "a-different-customer",
    host: "a-different-customer.titanium.bot",
    iat: forgedAt,
    exp: forgedAt + 60 * 60 * 1000,
    jti: randomBytes(16).toString("hex"),
  }, tenantSessionSecret(SESSION_SECRET, "a-different-customer"), forgedAt);
  for (const route of ADMIN_ROUTES) {
    const refused = await call("GET", route, { token: forged });
    check(refused.status === 401, `${route} refuses a token signed with another customer's key`, `status ${refused.status}`);
  }
  const forgedPromote = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { token: forged });
  check(forgedPromote.status === 401, "and it cannot promote anybody, which is the escalation that would outlive the token", `status ${forgedPromote.status}`);

  const bossSession = await call("POST", "/v1/sessions", { body: { email: BOSS_EMAIL, password: BOSS_PASSWORD } });
  bossToken = String(bossSession.json?.token ?? "");
  check(bossSession.status === 200 && bossSession.json?.account?.superAdmin === true, "the super admin signs in and the answer says so", `status ${bossSession.status}`);

  const opened = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(opened.status === 200, "and that session opens the console", `status ${opened.status}`);

  // Demoted while the tab is open. The flag is read from the store on every request, so the very
  // next call must fail: this is the leg that proves it is not a claim inside the token.
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/promote`, { admin: true });
  await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/demote`, { admin: true });
  const afterDemote = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(afterDemote.status === 401, "a demotion takes effect on the next request, not when the token expires", `status ${afterDemote.status}`);
  await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/promote`, { admin: true });
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/demote`, { admin: true });
  const backIn = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(backIn.status === 200, "and promoting again lets the same session back in", `status ${backIn.status}`);
}

// ---- the control plane's own ledger, and the password that is not on disk -------------------------
step("the sign-in ledger");
{
  const before = await call("GET", "/v1/admin/sign-ins?hours=24&limit=500", { token: bossToken });
  const countBefore = (before.json?.rows ?? []).filter((row) => row.source === "control plane").length;

  const refused = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: TRIED_PASSWORD } });
  check(refused.status === 401, "a wrong password is refused", `status ${refused.status}`);

  const after = await call("GET", "/v1/admin/sign-ins?hours=24&limit=500", { token: bossToken });
  const ours = (after.json?.rows ?? []).filter((row) => row.source === "control plane");
  check(ours.length > countBefore, "the refusal is in the merged ledger", `${countBefore} then ${ours.length}`);

  const row = ours.find((entry) => entry.email === USER_EMAIL && entry.outcome === "refused");
  check(row != null, "with the email that was typed");
  check(/^[0-9a-f]{64}$/.test(String(row?.triedHash ?? "")), "and a 64 character keyed hash of the password", String(row?.triedHash ?? "").slice(0, 12));
  check(String(row?.triedHash ?? "") !== TRIED_PASSWORD, "which is not the password");
  check(row?.tenant === TENANT_SLUG, "and the workspace the email maps to, filled in by the control plane", String(row?.tenant));

  const ok = ours.find((entry) => entry.outcome === "ok");
  check(ok != null && String(ok.triedHash ?? "").length === 0, "a successful sign-in is recorded with no hash at all");

  // Every file in the data directory, byte by byte. The sqlite store, its two WAL sidecars and the
  // salt. If the password text is anywhere in any of them, this leg is the one that says so.
  const searched = [];
  let found = "";
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      searched.push(path.relative(dataDir, full));
      const bytes = readFileSync(full);
      if (bytes.includes(Buffer.from(TRIED_PASSWORD, "utf8"))) found = path.relative(dataDir, full);
    }
  };
  walk(dataDir);
  check(searched.length > 0, "the data directory has files to search", searched.join(", "));
  check(found === "", "the password that was tried is in no file in the data directory", found ? `found in ${found}` : "");
}

// ---- the relay's own ledger writer ----------------------------------------------------------------
step("the relay's ledger");
{
  const ledger = createLoginLedger({ dir: ledgerDir, maxBytes: 4096 });
  await ledger.record({ door: "account", email: "Owner@Acme.Example", ip: ORDINARY_IP, userAgent: "x".repeat(400), outcome: "refused", password: TRIED_PASSWORD });
  await ledger.record({ door: "instance", ip: ORDINARY_IP, outcome: "ok", password: TRIED_PASSWORD, tenant: TENANT_SLUG });
  await ledger.record({ door: "instance", ip: ORDINARY_IP, outcome: "locked" });

  const rows = await ledger.rows();
  check(rows.length === 3, "three rows were written", String(rows.length));
  check(rows[0].email === "owner@acme.example", "the email is lowercased as typed", rows[0].email);
  check(rows[0].userAgent.length === 120, "the user agent is clipped to 120 characters", String(rows[0].userAgent.length));
  check(rows[0].triedHash === hashTried(TRIED_PASSWORD, readFileSync(path.join(ledgerDir, "login-attempt-salt"), "utf8").trim()),
    "the hash is HMAC-SHA256 of the password under the salt file, recomputed here");
  check(rows[1].triedHash === "", "a successful sign-in carries no hash");
  check(rows[2].triedHash === "", "a lockout carries no hash either");

  const mode = statSync(path.join(ledgerDir, "login-attempt-salt")).mode & 0o777;
  check(mode === 0o600, "the salt file is 0600", `0${mode.toString(8)}`);
  const ledgerMode = statSync(path.join(ledgerDir, "login-attempts.jsonl")).mode & 0o777;
  check(ledgerMode === 0o600, "and so is the ledger", `0${ledgerMode.toString(8)}`);

  const raw = readFileSync(path.join(ledgerDir, "login-attempts.jsonl"), "utf8");
  check(!raw.includes(TRIED_PASSWORD), "the password text is not in the ledger file");
  check(raw.includes(rows[0].triedHash), "the keyed hash is");

  // Rotation, counted rather than guessed at: rows are written one at a time until the rename
  // actually happens, then three more into the fresh file. A fixed number of rows would depend on
  // how wide a row happens to be, which is how a gate starts passing for the wrong reason.
  const live = path.join(ledgerDir, "login-attempts.jsonl");
  const kept = `${live}.1`;
  let written = 3;
  let rotatedAfter = 0;
  for (let index = 0; index < 500 && rotatedAfter === 0; index += 1) {
    await ledger.record({ door: "account", email: `filler${index}@example.com`, ip: ATTACK_IP, outcome: "refused", password: `filler-${index}` });
    written += 1;
    if (existsSync(kept)) rotatedAfter = written;
  }
  check(rotatedAfter > 0, "past the cap the file rotates", `after ${rotatedAfter} rows`);
  for (let index = 0; index < 3; index += 1) {
    await ledger.record({ door: "account", email: `after${index}@example.com`, ip: ATTACK_IP, outcome: "refused", password: `after-${index}` });
    written += 1;
  }
  check(statSync(live).size < 4096, "and the live file starts again under the cap", `${statSync(live).size} bytes`);
  const files = readdirSync(ledgerDir).filter((name) => name.startsWith("login-attempts.jsonl"));
  check(files.length === 2, "exactly one previous file is kept", files.join(", "));
  const all = await ledger.rows();
  check(all.length === written, "and both files are read back together, oldest first", `${all.length} of ${written}`);
  check(all[0].email === "owner@acme.example", "with the oldest row first");
  check(!readFileSync(kept, "utf8").includes(TRIED_PASSWORD), "the rotated file has no password text either");
}

// ---- the attack rule --------------------------------------------------------------------------------
step("the attack rule");
{
  const answer = await call("GET", "/v1/admin/sign-ins?hours=24&limit=1000", { token: bossToken });
  check(answer.status === 200, "the merged ledger answers", `status ${answer.status}`);
  const addresses = answer.json?.addresses ?? [];
  const attack = addresses.find((row) => row.ip === ATTACK_IP);
  const same = addresses.find((row) => row.ip === SAME_IP);
  const ordinary = addresses.find((row) => row.ip === ORDINARY_IP);

  check(attack != null, "the attacking address is in the summary");
  check(attack?.distinctPasswords === 6, "six different passwords were counted", String(attack?.distinctPasswords));
  check(attack?.attack === true, "and the address is flagged as an attack");
  check(attack?.passwordStory === "6 different passwords", "and the panel's sentence says so in plain words", String(attack?.passwordStory));

  check(same != null && same.attack === false, "the address that tried one password four times is NOT flagged");
  check(same?.passwordStory === "the same password 4 times", "and its sentence says the same password", String(same?.passwordStory));
  check(same?.distinctPasswords === 1, "one distinct password", String(same?.distinctPasswords));

  check(ordinary != null && ordinary.attack === false, "and one refusal then a lockout then a sign-in is not an attack");
  check(ordinary?.ok === 1 && ordinary?.locked === 1 && ordinary?.refused === 1, "with all three outcomes counted",
    `${ordinary?.refused}/${ordinary?.locked}/${ordinary?.ok}`);

  const bySource = new Set((answer.json?.rows ?? []).map((row) => row.source));
  check(bySource.has("relay") && bySource.has("control plane"), "and both ledgers are in the one list", [...bySource].join(", "));
  check(relayCalls.some((row) => row.path === "/admin/login-attempts" && row.authorized), "the control plane read the relay's ledger with the relay token");

  // The spray, which every other brake in the product misses.
  const sprayAddresses = new Set(SPRAY_IPS);
  const sprayBuckets = addresses.filter((row) => sprayAddresses.has(row.ip));
  check(sprayBuckets.length === SPRAY_IPS.length, "the spray's addresses are all in the by-address table", String(sprayBuckets.length));
  check(sprayBuckets.every((row) => row.attack === false), "and not one of them is flagged, which is exactly why the address table cannot catch this");

  const accounts = answer.json?.accounts ?? [];
  const sprayed = accounts.filter((row) => row.sprayed);
  check(sprayed.length === SPRAY_EMAILS.length, "the by-account table flags every account the one password was tried on", `${sprayed.length} of ${SPRAY_EMAILS.length}`);
  check(sprayed.every((row) => row.addresses.length === 1), "each of those accounts saw one address and one attempt");
  check(accounts.some((row) => row.email === USER_EMAIL && row.sprayed === false), "and an ordinary account in the same window is not flagged");

  const password = (answer.json?.passwords ?? []).find((row) => row.spray);
  check(password?.accountsInWindow === SPRAY_EMAILS.length, "one password reached six accounts inside the window", String(password?.accountsInWindow));
  check((password?.addresses ?? []).length === SPRAY_IPS.length, "from six different addresses", String((password?.addresses ?? []).length));
  check(String(answer.json?.sprayRule ?? "").includes("spray"), "and the panel carries the rule in plain words", String(answer.json?.sprayRule ?? "").slice(0, 60));

  const refusedOnly = await call("GET", "/v1/admin/sign-ins?hours=24&outcome=refused&limit=1000", { token: bossToken });
  check((refusedOnly.json?.rows ?? []).every((row) => row.outcome === "refused"), "the outcome filter filters");
  const oneHour = await call("GET", "/v1/admin/sign-ins?hours=1&limit=1000", { token: bossToken });
  check((oneHour.json?.rows ?? []).length > 0, "and the hours filter still finds this run's own rows");
}

// ---- the five read routes -----------------------------------------------------------------------------
step("the five panels' data");
{
  const overview = await call("GET", "/v1/admin/overview", { token: bossToken });
  check(overview.status === 200 && overview.json?.counts?.clients === 1, "overview counts the workspaces", JSON.stringify(overview.json?.counts));
  check(overview.json?.signIns?.attackAddresses?.includes(ATTACK_IP), "and names the attacking address");
  check((overview.json?.signIns?.sprayedAccounts ?? []).length === SPRAY_EMAILS.length,
    "and names the accounts one password was sprayed across", String((overview.json?.signIns?.sprayedAccounts ?? []).length));

  const clients = await call("GET", "/v1/admin/clients", { token: bossToken });
  const client = (clients.json?.clients ?? [])[0];
  check(clients.status === 200 && client != null, "clients answers", `status ${clients.status}`);
  check(client?.slug === TENANT_SLUG, "with the workspace", String(client?.slug));
  check((client?.users ?? []).length === 2, "and the people who can sign in to it", String((client?.users ?? []).length));
  // PROXY-1 replaced the `plan: "none"` placeholder with the real allowance object, and this leg
  // was still asserting the placeholder, so the no-browser run was red on a correct tree. What it
  // asks now is the thing that actually matters on this card: the allowance is a named object and
  // never a blank, and with no proxy configured in this fixture every number in it reads as the
  // reason it could not be measured rather than as a zero.
  check(client?.spend != null, "and an allowance object on the row rather than a blank");
  check(client?.spend?.minted === false, "which says this workspace has no plan key at the proxy", String(client?.spend?.minted));
  check(String(client?.spend?.why ?? "").length > 0, "and says why in plain words", String(client?.spend?.why ?? "").slice(0, 60));
  check(client?.spend?.thisMonth?.dollars === null && client?.spend?.today?.dollars === null,
    "with no dollar figure invented for a proxy that was never asked");
  check(clients.json?.proxy?.configured === false && String(clients.json?.proxy?.why ?? "").length > 0,
    "and the panel carries the reason the proxy is not configured", String(clients.json?.proxy?.why ?? "").slice(0, 60));
  check((client?.users ?? []).some((row) => row.lastSignInAt != null), "and a last sign-in for somebody who has signed in");
  check(client?.coolify?.reachable === true && client?.coolify?.status === "running", "and what Coolify says right now", String(client?.coolify?.status));

  const boxes = await call("GET", "/v1/admin/boxes", { token: bossToken });
  const box = (boxes.json?.boxes ?? [])[0];
  check(boxes.status === 200 && box != null, "boxes answers", `status ${boxes.status}`);
  check(box?.containerState === "running", "the container state came from the relay", String(box?.containerState));
  check(box?.gatewayAnswering === true, "the gateway answering came from the relay");
  check(box?.diskKb === 4_194_304 && box?.memoryBytes === 1_476_395_008, "and so did disk and memory");
  check(box?.lastBackupStamp === null && String(box?.lastBackupWhy).includes("not mounted"),
    "the backup stamp is not measured, and says why", String(box?.lastBackupWhy).slice(0, 60));

  const system = await call("GET", "/v1/admin/system", { token: bossToken });
  check(system.status === 200, "system answers", `status ${system.status}`);
  check(system.json?.coolify?.reachable === true, "Coolify is reachable");
  check(system.json?.relay?.reachable === true, "the relay is reachable");
  check(system.json?.backup?.measured === false && String(system.json?.backup?.why).length > 0, "the nightly backup is not measured, and says why");
  check(system.json?.isolation?.measured === false && String(system.json?.isolation?.why).includes("box-isolation.sh"),
    "the box isolation check is not measured, and names the script that would write one");
  check(system.json?.mailWebhook?.measured === false, "the mail webhook is not measured from this container");
  check(Array.isArray(system.json?.disks) && system.json.disks.length === 2, "two disks are reported, one of them the archives mount that is not there");
  check(system.json?.disks?.[1]?.freeBytes === null, "and the one that is not mounted reads null rather than zero");
  check(Array.isArray(system.json?.stuckProvisioning), "stuck builds are a list");
  // The one card that says whether the sign-in panel's numbers mean anything. Without it, a data
  // directory this service cannot write reads as a quiet day rather than as a broken ledger.
  check(system.json?.signInRecord?.signing === true, "the sign-in record says it is being written", String(system.json?.signInRecord?.why ?? "").slice(0, 60));
  check(system.json?.counts?.superAdmins === 1, "and there is one super admin", String(system.json?.counts?.superAdmins));

  // The named actions. Coolify is the fake one, so this measures that the route reaches it with the
  // service uuid and writes the ledger, not that a container moved.
  const restart = await call("POST", `/v1/admin/clients/${TENANT_SLUG}/restart`, { token: bossToken, body: {} });
  check(restart.status === 200, "a super admin can restart a customer's workspace", `status ${restart.status}`);
  check(coolifyCalls.some((row) => /\/services\/[^/]+\/restart$/.test(row.path)), "and Coolify was actually asked");

  // The adopted guard is shared with /v1/tenants, and this is the leg that proves the admin console
  // did not get its own copy without it. Tenant "titanium" is Jason's live console.
  const rebuild = await call("POST", `/v1/admin/clients/${TENANT_SLUG}/provision`, { token: bossToken, body: {} });
  check(rebuild.status === 409 && rebuild.json?.error === "adopted",
    "and cannot rebuild an adopted instance into a second copy of the live console", `status ${rebuild.status}`);

  const disabled = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/disable`, { token: bossToken, body: {} });
  check(disabled.status === 200 && disabled.json?.account?.disabled === true, "a person's sign-in can be turned off", `status ${disabled.status}`);
  const shut = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: USER_PASSWORD } });
  check(shut.status === 403 && shut.json?.error === "disabled", "and that person can no longer sign in", `status ${shut.status}`);
  const self = await call("POST", `/v1/admin/users/${encodeURIComponent(BOSS_EMAIL)}/disable`, { token: bossToken, body: {} });
  check(self.status === 409, "a super admin cannot disable their own sign-in from the console", `status ${self.status}`);
  await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/enable`, { token: bossToken, body: {} });

  const reset = await call("POST", `/v1/admin/users/${encodeURIComponent(USER_EMAIL)}/reset-password`, { token: bossToken, body: {}, raw: true });
  const temporary = String(reset.json?.temporaryPassword ?? "");
  check(reset.status === 200 && temporary.length >= 8, "a password reset hands back one temporary password", `status ${reset.status}`);
  const withTemporary = await call("POST", "/v1/sessions", { body: { email: USER_EMAIL, password: temporary } });
  check(withTemporary.status === 200, "which works", `status ${withTemporary.status}`);
  userPasswordNow = temporary;
  const again = await call("GET", "/v1/admin/clients", { token: bossToken });
  check(!again.text.includes(temporary), "and is not readable anywhere afterwards");
}

// ---- the route contract ------------------------------------------------------------------------
//
// PROVIDERS-1. The panel is written against one GET, and the route behind it belongs to a different
// item of this wave. Two things have to be true and they are measured separately: the page must
// render whatever the route answers, which is the fixture leg below, and the route must answer the
// shape the page reads, which is this one. Until the route exists this is a SKIP carrying the
// reason, because a gate that went red on a route its own item does not own would be red all day
// for something nobody reading it could act on. The moment cp/admin.mjs serves it this turns into
// real checks with no edit here, and a route that drifts from the contract is then a failure on
// this Mac rather than a surprise on the R750.
step("the providers route contract");
{
  const answer = await call("GET", "/v1/admin/providers", { token: bossToken });
  if (answer.status === 404) {
    console.log("  SKIP  this tree does not serve GET /v1/admin/providers yet, so the shape was not measured");
    console.log("        the page leg below drives the panel against the gate's own fixture instead");
  } else {
    check(answer.status === 200, "GET /v1/admin/providers answers the super admin", `status ${answer.status}`);
    const body = answer.json ?? {};
    check(Array.isArray(body.providers), "it carries a list of providers");
    check(Array.isArray(body.planModels), "and a list of plan models");
    check(Array.isArray(body.actions), "and the ledger the panel draws under What changed");
    check(body.defaults != null && typeof body.defaults === "object", "and the defaults block");
    const provider = (body.providers ?? [])[0];
    if (provider != null) {
      for (const field of ["id", "name", "kind", "baseUrl", "keys", "catalog"]) {
        check(field in provider, `a provider carries ${field}`);
      }
      const key = (provider.keys ?? [])[0];
      if (key != null) {
        for (const field of ["name", "label", "order", "mask", "spend"]) {
          check(field in key, `a key carries ${field}`);
        }
        // The one field that must NOT be there. A route that answered with a key value would put it
        // on the screen, into a browser's memory and into this run's leak sweep, and nothing
        // downstream would notice, because the page renders whatever it is handed.
        check(!/"(key|apiKey|value|secret)"\s*:\s*"[^"]{12,}"/.test(JSON.stringify(key)),
          "and no key value, which is the whole reason the panel can only ever draw a mask");
      }
    }
    const model = (body.planModels ?? [])[0];
    if (model != null) {
      for (const field of ["alias", "provider", "vendorModel", "customerName", "customerLabel", "customerVisible", "visionFallback", "contextWindow"]) {
        check(field in model, `a plan model carries ${field}`);
      }
    }
  }
}

// ---- the routes the page was written against, in their own words -------------------------------
//
// THIS IS THE LEG THE FIXTURE CANNOT BE. The page leg below drives the panel against this gate's own
// fixture, which is the only way to repeat a write; but a fixture is written by the same hand as the
// page, so the two can agree perfectly while the real route answers something else. That is not a
// hypothetical: this file once served key.name, key.mask and defaults.newWorkspaceModel while the
// route answered slot, masked and defaults.planModel, every check passed, and the panel drew an
// empty card against a route that was working.
//
// So each of the three answers this wave added is asked for the FIELD NAMES the page reads, and the
// refusals are asked for the SENTENCES the page prints without rewording. A route that has not
// landed in this tree yet is a SKIP with the reason, never a pass.
step("the routes the page reads");
{
  // SIGNIN-1. The gate marker, and the three things a summary needs to say what it set aside.
  const signIns = await call("GET", "/v1/admin/sign-ins?hours=24", { token: bossToken });
  check(signIns.status === 200, "GET /v1/admin/sign-ins answers", `status ${signIns.status}`);
  const gates = signIns.json?.gates;
  if (gates == null) {
    console.log("  SKIP  this tree's sign-ins route carries no gates block yet, so the panel's grey rows are measured against the fixture only");
  } else {
    check(typeof gates.rows === "number", "the sign-ins answer says how many rows were set aside as our own gates", String(gates.rows));
    check(Array.isArray(gates.scripts), "and which scripts they were");
    check(typeof gates.setAsideNote === "string" && gates.setAsideNote.length > 0,
      "and carries the sentence the panel prints", String(gates.setAsideNote).slice(0, 70));
    const address = (signIns.json?.addresses ?? [])[0];
    if (address != null) {
      check("gateRows" in address, "an address summary says how many of its rows were set aside");
      check("yourAddress" in address, "and whether it is one of ours");
    }
  }

  // PROVIDERS-8. The two windows the chip and the amber line are drawn from.
  const providers = await call("GET", "/v1/admin/providers", { token: bossToken });
  const health = (providers.json?.providers ?? [])[0]?.health;
  if (health == null) {
    console.log("  SKIP  no proxy is configured on this control plane, so provider health carries nothing to measure");
  } else {
    check(health.recent != null && typeof health.recent === "object",
      "provider health carries the recent window the chip is decided on");
    check(health.month != null && typeof health.month === "object",
      "and the month window the amber count is drawn from");
    for (const field of ["requests", "failures", "lastFailureAt"]) {
      check(health.month != null && field in health.month, `and the month window carries ${field}`);
    }
  }

  // PROVIDERS-9. The route exists and it refuses rather than 404s, which is the difference between
  // a control that is off and a control that is wired to nothing.
  const removed = await call("DELETE", "/v1/admin/providers/not-a-provider", { token: bossToken, body: { confirm: "not-a-provider" } });
  if (removed.status === 404 && String(removed.json?.error ?? "") !== "not_found") {
    console.log("  SKIP  this tree does not serve DELETE /v1/admin/providers/<id> yet");
  } else {
    check(removed.status === 404 || removed.status === 409 || removed.status === 400,
      "DELETE /v1/admin/providers refuses a provider that is not there rather than doing something",
      `status ${removed.status}`);
    check(String(removed.json?.message ?? "").length > 0, "in a sentence, which is what the panel puts on the screen",
      String(removed.json?.message ?? "").slice(0, 70));
  }

  // ADMIN-2. The two refusals the form can produce without provisioning anything, in the words the
  // panel prints unchanged. The happy path writes a container and is measured on the R750.
  const dup = await call("POST", "/v1/admin/clients", { token: bossToken, body: { email: BOSS_EMAIL, company: "Anything At All" } });
  if (dup.status === 404) {
    console.log("  SKIP  this tree does not serve POST /v1/admin/clients yet, so the add-client form is measured against the fixture only");
  } else {
    check(dup.status === 409, "an address that already has an account is refused", `status ${dup.status}`);
    check(String(dup.json?.error ?? "") === "duplicate_email", "by name", String(dup.json?.error));
    // The exact string the page leg below reads off the banner. If these two ever drift the operator
    // meets one sentence from the CLI and another from the console for the same refusal.
    check(String(dup.json?.message ?? "") === "That email address already has an account. Sign in instead.",
      "in the sentence the console prints unchanged", String(dup.json?.message ?? "").slice(0, 80));
    const noName = await call("POST", "/v1/admin/clients", { token: bossToken, body: { email: `fresh+${randomBytes(4).toString("hex")}@example.com`, company: "!!!" } });
    check(noName.status === 400 && String(noName.json?.error ?? "") === "bad_company",
      "a company name with nothing in it to name a workspace after is refused", `status ${noName.status} ${noName.json?.error}`);
    check(String(noName.json?.message ?? "").length > 0, "with the reason in words", String(noName.json?.message ?? "").slice(0, 80));
    check((await call("POST", "/v1/admin/clients", { body: { email: "x@example.com", company: "X" } })).status === 401,
      "and the whole door refuses a caller with no session");
  }
}

// ---- the feedback channel (FEEDBACK-1) --------------------------------------------------------
//
// The intake, the panel, the two decisions and the issue door, over HTTP the way the relay and the
// console reach them. The page leg below drives the same rows through a real browser.
step("the feedback channel");
let plantedReportId = 0;
{
  const report = {
    version: 1,
    tier: "critical",
    category: "tools",
    title: "The browser tool answered 500 four times in a row",
    description: "Every attempt to open a page failed and I could not finish the task.",
    steps: ["Ask Titan to read a page", "Watch it fail"],
    tools: [{ name: "openPage", status: "failed", error: "500 from the box" }],
    evidence: {
      agent: "agent-7", agentName: "Titan", conversation: "conv-3",
      hostVersion: "0.18.4", consoleVersion: "gate",
      calls: [{ name: "openPage", status: "500", summary: "the box refused", output: "Internal error" }],
      messages: [{ role: "assistant", text: "I could not open that page." }],
    },
  };
  const postReport = (body, { token, tenant } = {}) => {
    const headers = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    if (tenant !== undefined) headers["x-titanbot-tenant"] = tenant;
    return fetch(`${BASE}/v1/feedback`, { method: "POST", headers, body: JSON.stringify(body) })
      .then(async (res) => {
        const text = await res.text();
        bodiesSeen.push(text);
        let json = null;
        try { json = JSON.parse(text); } catch { /* the leg says so */ }
        return { status: res.status, json, text };
      })
      .catch((error) => ({ status: 0, json: null, text: String(error?.message ?? error) }));
  };

  // The credential. CP_RELAY_TOKEN and nothing else: the admin token adds accounts and deletes
  // services, and neither door may ever do the other's job.
  check((await postReport(report, { tenant: TENANT_SLUG })).status === 401, "a report with no bearer is refused");
  check((await postReport(report, { token: ADMIN_TOKEN, tenant: TENANT_SLUG })).status === 401,
    "and the operator token does not open the intake either");
  const landed = await postReport(report, { token: RELAY_TOKEN, tenant: TENANT_SLUG });
  check(landed.status === 201, "a report posted with the relay token lands", `status ${landed.status}`);
  plantedReportId = Number(landed.json?.id ?? 0);
  check(plantedReportId > 0, "and comes back with its number", String(plantedReportId));

  // A slug in the body is IGNORED, not trusted. This is the leg that says a box cannot file as its
  // neighbour: the relay stamps the workspace out of its own registry and nothing reads the body.
  const lying = await postReport({ ...report, title: "filed by a liar", workspace: "victim", slug: "victim", tenant: "victim" },
    { token: RELAY_TOKEN, tenant: TENANT_SLUG });
  check(lying.status === 201, "a report naming somebody else's workspace still lands");
  const listedAfterLie = await call("GET", "/v1/admin/feedback?limit=50", { token: bossToken });
  const liar = (listedAfterLie.json?.rows ?? []).find((row) => row.title === "filed by a liar");
  check(liar?.tenant === TENANT_SLUG, "under the relay's workspace and not the body's", String(liar?.tenant));
  check(!JSON.stringify(liar ?? {}).includes("victim"), "and the body's own name is nowhere in the record");

  // THE CONSOLE'S OWN MAXIMUM SHAPE, through the real intake. It used to answer 201 and store 8,000
  // characters of a 15,296-character description, drop two of the twelve calls and cut each call's
  // output from 1,200 to 800, with nothing on any screen saying so.
  const bigCalls = Array.from({ length: 12 }, (_, i) => ({
    name: "Shell", status: "failed", summary: `run ${i} `.padEnd(400, "."), output: `output ${i} `.padEnd(1200, "."),
  }));
  const bigDescription = ["The shell has failed every time for the last hour.", "", "What ran just before:",
    ...bigCalls.map((call) => `- ${call.summary}\n  ${call.output}`)].join("\n");
  const big = await postReport({
    ...report, title: "the console's own maximum", description: bigDescription,
    evidence: { ...report.evidence, calls: bigCalls },
  }, { token: RELAY_TOKEN, tenant: TENANT_SLUG });
  check(big.status === 201, "a report at the console's own maximum lands whole", `status ${big.status}, ${bigDescription.length} characters sent`);
  const bigRow = ((await call("GET", "/v1/admin/feedback?limit=50", { token: bossToken })).json?.rows ?? [])
    .find((row) => row.title === "the console's own maximum");
  check(bigRow?.payload?.description?.length === bigDescription.length, "with nothing shorter than it was sent",
    `${bigRow?.payload?.description?.length ?? 0} of ${bigDescription.length}`);
  check((bigRow?.payload?.evidence?.calls ?? []).length === 12, "and no call dropped", String((bigRow?.payload?.evidence?.calls ?? []).length));
  check((bigRow?.payload?.evidence?.calls ?? []).every((call) => call.output.length === 1200), "and no output cut");
  // Over a limit is a refusal with the field named, never a 201 that stored half of it.
  const tooBig = await postReport({ ...report, description: "d".repeat(40_000) }, { token: RELAY_TOKEN, tenant: TENANT_SLUG });
  check(tooBig.status === 400, "a report over a limit is refused rather than truncated", `status ${tooBig.status}`);
  check(/the description is \d+ characters/.test(String(tooBig.json?.message ?? "")), "in a sentence naming the field",
    String(tooBig.json?.message ?? "").slice(0, 80));

  // The panel.
  const listed = await call("GET", "/v1/admin/feedback?limit=50", { token: bossToken });
  check(listed.status === 200, "the Feedback panel answers the super admin", `status ${listed.status}`);
  check((listed.json?.rows ?? []).length >= 2, "and lists what arrived", String((listed.json?.rows ?? []).length));
  check(listed.json?.counts?.criticalNew >= 2, "with the critical count over everything rather than over the filter",
    String(listed.json?.counts?.criticalNew));
  check(listed.json?.github?.stored === false, "and says no repository token is stored yet");
  check((await call("GET", "/v1/admin/feedback", {})).status === 401, "and it refuses a caller with no session");
  const filtered = await call("GET", "/v1/admin/feedback?tier=observation", { token: bossToken });
  check((filtered.json?.rows ?? []).length === 0, "a tier nothing was filed under lists nothing");
  check(filtered.json?.counts?.criticalNew >= 2, "and the counts still count everything");

  // Every decision writes a row in the change record, with an actor and a time.
  const actionsBefore = (await call("GET", "/v1/admin/actions", { token: bossToken })).json?.rows ?? [];
  const edited = await call("POST", `/v1/admin/feedback/${plantedReportId}/edit`, { token: bossToken, body: { title: "The browser tool keeps failing", body: "Edited by the super admin." } });
  check(edited.status === 200 && edited.json?.report?.title === "The browser tool keeps failing", "an edit takes", `status ${edited.status}`);
  const stillSent = await call("GET", `/v1/admin/feedback?limit=50`, { token: bossToken });
  const editedRow = (stillSent.json?.rows ?? []).find((row) => row.id === plantedReportId);
  check(editedRow?.payload?.description === report.description, "and what the agent sent is kept underneath it, unchanged");
  const approved = await call("POST", `/v1/admin/feedback/${plantedReportId}/approve`, { token: bossToken, body: {} });
  check(approved.status === 200 && approved.json?.report?.state === "approved", "approve moves the state", `status ${approved.status}`);
  const suppressed = await call("POST", `/v1/admin/feedback/${liar?.id}/suppress`, { token: bossToken, body: {} });
  check(suppressed.status === 200 && suppressed.json?.report?.state === "suppressed", "suppress moves the state");
  check(String(suppressed.json?.message ?? "").includes("stays on the record"), "and says the row is kept with the decision on it");
  const actionsAfter = (await call("GET", "/v1/admin/actions", { token: bossToken })).json?.rows ?? [];
  const wrote = actionsAfter.length - actionsBefore.length;
  check(wrote === 3, "each of those three wrote a row in the change record", String(wrote));
  const ours = actionsAfter.filter((row) => String(row.action).startsWith("feedback."));
  check(ours.every((row) => String(row.actor).length > 0 && String(row.at).length > 0), "each with an actor and a time");

  // The issue, with no token stored: the body is PREPARED and the answer says so in those words.
  const prepared = await call("POST", `/v1/admin/feedback/${plantedReportId}/issue`, { token: bossToken, body: {} });
  check(prepared.status === 200 && prepared.json?.filed === false, "with no token, Create GitHub issue prepares rather than files");
  check(String(prepared.json?.message ?? "") === "the issue body is ready; paste a repo token in the Feedback panel and press this again",
    "and says exactly that", String(prepared.json?.message ?? "").slice(0, 60));
  check(String(prepared.json?.body ?? "").includes("openPage"), "and the prepared body carries the evidence");
  check(githubCalls.length === 0, "and nothing was sent anywhere", String(githubCalls.length));

  // The token. Proved before it is stored, and a token GitHub refuses is not kept.
  const wrongRepo = await call("POST", "/v1/admin/feedback/github-token", { token: bossToken, body: { repo: NO_ISSUES_REPO, token: GITHUB_TOKEN } });
  check(wrongRepo.status === 409 && String(wrongRepo.json?.message ?? "").includes("issues turned off"),
    "a repository with its issues off is refused, and nothing is stored", `status ${wrongRepo.status}`);
  const wrongToken = await call("POST", "/v1/admin/feedback/github-token", { token: bossToken, body: { repo: GOOD_REPO, token: "ghp_not_the_one" } });
  check(wrongToken.status === 409 && String(wrongToken.json?.message ?? "").includes("nothing was stored"),
    "a token GitHub refuses is not stored", `status ${wrongToken.status}`);
  const stored = await call("POST", "/v1/admin/feedback/github-token", { token: bossToken, body: { repo: GOOD_REPO, token: GITHUB_TOKEN } });
  check(stored.status === 200, "a token GitHub accepts is stored", `status ${stored.status}`);
  check(/^\d+ characters, sha256 [0-9a-f]{8}$/.test(String(stored.json?.evidence ?? "")),
    "and what comes back is a length and a hash", String(stored.json?.evidence ?? ""));

  // And now it files.
  const filedIt = await call("POST", `/v1/admin/feedback/${plantedReportId}/issue`, { token: bossToken, body: {} });
  check(filedIt.status === 200 && filedIt.json?.filed === true, "Create GitHub issue files it", `status ${filedIt.status}`);
  check(String(filedIt.json?.issueUrl ?? "").startsWith(`https://github.com/${GOOD_REPO}/issues/`), "and records where it went", String(filedIt.json?.issueUrl ?? ""));
  check(githubIssues.length === 1 && String(githubIssues[0].title ?? "").startsWith("[critical]"), "one issue, titled with its tier", String(githubIssues[0]?.title ?? "").slice(0, 40));
  const afterFiling = await call("GET", "/v1/admin/feedback?state=filed", { token: bossToken });
  check((afterFiling.json?.rows ?? []).length === 1, "and the row reads as filed");

  // THE SECOND GATE IS A CHECK. A suppressed report used to file anyway, and filing overwrote the
  // state, the name and the time on the row -- so the decision survived only in the change record
  // and was gone from the panel, while docs/ADMIN.md promised it was kept.
  const refusedFiling = await call("POST", `/v1/admin/feedback/${liar?.id}/issue`, { token: bossToken, body: {} });
  check(refusedFiling.status === 409 && refusedFiling.json?.filed === false,
    "a suppressed report is refused rather than filed", `status ${refusedFiling.status}`);
  check(/was suppressed on/.test(String(refusedFiling.json?.message ?? "")),
    "in a sentence naming the decision it would have overwritten", String(refusedFiling.json?.message ?? "").slice(0, 70));
  check(githubIssues.length === 1, "and nothing reached GitHub", String(githubIssues.length));
  const stillSuppressed = (await call("GET", "/v1/admin/feedback?state=suppressed", { token: bossToken })).json?.rows ?? [];
  check(stillSuppressed.some((row) => row.id === liar?.id), "the suppression is still on the row the panel draws");

  // A report nobody pressed Approve on. Filing IS the approval -- pressing Create GitHub issue is a
  // deliberate act by the same person the Approve button belongs to -- but it is written down as
  // one rather than left implied.
  const fresh = await postReport({ ...report, title: "never approved, filed anyway" }, { token: RELAY_TOKEN, tenant: TENANT_SLUG });
  const freshId = Number(fresh.json?.id ?? 0);
  check(freshId > 0 && fresh.json?.state === "new", "a third report arrives in state new", String(fresh.json?.state));
  const filedNew = await call("POST", `/v1/admin/feedback/${freshId}/issue`, { token: bossToken, body: {} });
  check(filedNew.status === 200 && filedNew.json?.filed === true, "filing a report that was never approved is allowed", `status ${filedNew.status}`);
  check(/filing it counted as the approval/.test(String(filedNew.json?.message ?? "")),
    "and says so, rather than quietly calling it approved", String(filedNew.json?.message ?? "").slice(-70));
  const implied = ((await call("GET", "/v1/admin/actions", { token: bossToken })).json?.rows ?? [])
    .filter((row) => String(row.action) === "feedback.issue");
  check(implied.some((row) => /filing is the approval/.test(String(row.detail))),
    "and the change record carries the implied approval with it");
}

// ---- the ceiling on a client row (AGENTS-CAP-2) -----------------------------------------------
step("the ceiling");
{
  const read = await call("GET", "/v1/admin/clients", { token: bossToken });
  const row = (read.json?.clients ?? []).find((one) => one.slug === TENANT_SLUG);
  check(row?.ceiling?.read === true, "the clients panel reads a ceiling off the box");
  check(row?.ceiling?.maxAgents === 100, "and it is the box's own number, not a stored one", String(row?.ceiling?.maxAgents));

  // The range is checked in the control plane, because the host fails OPEN: a value it cannot use
  // drops the workspace to the default with nothing on any screen saying why.
  const writesBefore = ceilingWrites.length;
  for (const bad of [0, 5000, "forty", 2.5, null]) {
    const answer = await call("POST", `/v1/admin/clients/${TENANT_SLUG}/ceiling`, { token: bossToken, body: { maxAgents: bad } });
    check(answer.status === 400, `a ceiling of ${JSON.stringify(bad)} is refused`, `status ${answer.status}`);
    check(String(answer.json?.message ?? "").includes("whole number from 1 to 1000"), "in a sentence a person reads");
  }
  check(ceilingWrites.length === writesBefore, "and none of those reached the box", String(ceilingWrites.length - writesBefore));

  const set = await call("POST", `/v1/admin/clients/${TENANT_SLUG}/ceiling`, { token: bossToken, body: { maxAgents: 40 } });
  check(set.status === 200, "a ceiling of 40 is written", `status ${set.status}`);
  check(set.json?.maxAgents === 40, "and the answer is what the box read back", String(set.json?.maxAgents));
  check(set.json?.pinned === false, "with pinned false");
  check(ceilingWrites.at(-1)?.maxAgents === 40, "and the relay was asked to write exactly that", JSON.stringify(ceilingWrites.at(-1) ?? {}));

  // PINNED IS NOT A SUCCESS. The relay writes the file either way; a box whose container pins
  // SAND_MAX_AGENTS keeps answering through that, and reporting a success would be a claim the box
  // does not honour.
  fixtureCeilings.get(TENANT_SLUG).pinned = true;
  const pinned = await call("POST", `/v1/admin/clients/${TENANT_SLUG}/ceiling`, { token: bossToken, body: { maxAgents: 60 } });
  check(pinned.status === 200 && pinned.json?.pinned === true, "a pinned box reports a pin", `status ${pinned.status}`);
  check(pinned.json?.maxAgents === 40, "and reports the number the box still answers with, not the one that was sent", String(pinned.json?.maxAgents));
  check(String(pinned.json?.message ?? "").includes("takes effect there until that is gone"), "and says so in the operator's own words");
  fixtureCeilings.get(TENANT_SLUG).pinned = false;

  // A box that cannot be asked reads as not measured and never as a default.
  fixtureCeilings.get(TENANT_SLUG).read = false;
  const blind = await call("GET", "/v1/admin/clients", { token: bossToken });
  const blindRow = (blind.json?.clients ?? []).find((one) => one.slug === TENANT_SLUG);
  check(blindRow?.ceiling?.read === false, "a box that did not answer reads as not measured");
  check(blindRow?.ceiling?.maxAgents === null, "with no number at all, rather than the default", String(blindRow?.ceiling?.maxAgents));
  fixtureCeilings.get(TENANT_SLUG).read = true;
  // Put it back where the panel leg below expects it.
  await call("POST", `/v1/admin/clients/${TENANT_SLUG}/ceiling`, { token: bossToken, body: { maxAgents: 40 } });
}

// ---- the page --------------------------------------------------------------------------------------
step("the page");
if (!WANT_BROWSER) {
  console.log("  SKIP  --no-browser was passed, so the page was not measured");
} else {
  const PW_DIR = process.env.GROK_BOT_PLAYWRIGHT_DIR
    ?? process.env.PLAYWRIGHT_DIR
    ?? path.join(repoRoot, ".cache", "playwright");
  const tried = [];
  let playwright = null;
  try { playwright = createRequire(path.join(PW_DIR, "package.json"))("playwright-core"); }
  catch (error) { tried.push(`playwright-core in ${PW_DIR}: ${String(error.message).split("\n")[0]}`); }
  if (playwright == null) {
    try { const mod = await import(`${PW_DIR}/playwright/index.js`); playwright = mod.chromium ? mod : (mod.default ?? mod); }
    catch (error) { tried.push(`playwright in ${PW_DIR}/playwright: ${String(error.message).split("\n")[0]}`); }
  }
  if (playwright == null) {
    try { const mod = await import("playwright"); playwright = mod.chromium ? mod : (mod.default ?? mod); }
    catch (error) { tried.push(`playwright from this repo: ${String(error.message).split("\n")[0]}`); }
  }
  if (playwright == null) {
    console.log("playwright is not resolvable, so the page leg measured nothing.");
    for (const line of tried) console.log(`  ${line}`);
    console.log("Run scripts/setup-gates.sh, or set GROK_BOT_PLAYWRIGHT_DIR, or pass --no-browser.");
    die("the page could not be opened");
  }

  // What the clients route says this workspace runs on. null leaves the real answer alone, which is
  // the state this tree is in and the state the panel has to say "not measured" about.
  let clientModelInjection = null;
  // SIGNIN-1. Off until the leg that needs it, so every check before that one reads the ledger the
  // fixture actually wrote.
  let signInGateInjection = false;

  browser = await playwright.chromium.launch();
  // 1440x900 is the size ADMIN-3 is measured at: a laptop, which is where this console is read. The
  // page must not scroll at it on any panel, which is the whole of what the row asked for.
  const VIEW = { width: 1440, height: 900 };
  const page = await browser.newPage({ viewport: VIEW });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // A DELIBERATE REFUSAL IS NOT A PAGE ERROR. Chrome logs every non-2xx fetch to the console, and
    // this panel now ASKS before it writes inside a customer's box: the push-label button sends an
    // empty body on purpose and renders the 409's candidate list. Counting that as a thrown error
    // would make the guard itself fail this gate, and the fix somebody would reach for is removing
    // the guard. Every other status, and every real exception, still counts.
    const text = message.text();
    const where = String(message.location?.()?.url ?? "");
    if (/status of 409/.test(text) && /push-label/.test(where)) return;
    // ADMIN-2's duplicate address is the same shape: the form asks, the route refuses in a sentence,
    // and the panel prints it. Chrome logs the 409 anyway.
    if (/status of 409/.test(text) && /\/v1\/admin\/clients$/.test(where)) return;
    pageErrors.push(text);
  });

  // THE PROVIDERS FIXTURE, SERVED INTO THE BROWSER. The routes the sixth panel reads and writes
  // belong to another item of this wave, so this gate answers them itself. Nothing about the page
  // is special-cased for it: the page makes the same same-origin fetch it makes in production, its
  // CSP still says connect-src 'self', and every request this handler does not own is passed
  // straight through to the control plane that is actually running. What the fixture buys is a
  // write path a gate on a laptop can repeat: an add, a roll and a remove against a live proxy are
  // not things that can be run twice, and the checks below are exactly the ones that have to be.
  //
  // One route is not answered but ADDED TO: GET /v1/admin/clients is the real control plane's, and
  // `clientModelInjection` merges a model block into the workspace it answers with. That block has
  // three states the panel draws differently and only one of them is the control plane's today, so
  // this is the only way to see the other two before the route that carries them exists. Set to
  // null it changes nothing and the real answer goes through untouched.
  await page.route("**/v1/admin/**", async (route) => {
    const request = route.request();
    let body = null;
    const posted = request.postData();
    if (posted) { try { body = JSON.parse(posted); } catch { body = null; } }
    const pathname = new URL(request.url()).pathname;
    // SIGNIN-1. The gate fields on the sign-ins answer belong to the route, which is another item of
    // this wave, so this run puts them on the real answer the way the model block below is put on
    // the clients answer. What is measured here is what THIS page does with them: a row the route
    // recognised as one of our own verification gates is greyed and named, it is left out of the
    // Attack pill, and every summary says how many were set aside. Off by default, so every check
    // before this one still sees the ledger exactly as it is.
    if (request.method() === "GET" && pathname === "/v1/admin/sign-ins" && signInGateInjection) {
      const real = await route.fetch();
      const answer = await real.json().catch(() => null);
      if (answer != null) {
        let set = 0;
        for (const row of answer.rows ?? []) {
          if (row.ip !== ATTACK_IP) continue;
          row.gate = true;
          row.gateScript = "verify-deploy";
          set += 1;
        }
        for (const row of answer.addresses ?? []) {
          if (row.ip !== ATTACK_IP) continue;
          row.attack = false;
          row.gateRows = set;
          row.yourAddress = true;
        }
        answer.gates = {
          rows: set,
          scripts: ["verify-deploy"],
          setAsideNote: `${set} attempts were this product's own verification gates and are not counted above`,
        };
      }
      await route.fulfill({ status: real.status(), contentType: "application/json", body: JSON.stringify(answer) });
      return;
    }
    if (request.method() === "GET" && pathname === "/v1/admin/clients" && (clientModelInjection != null || addedClients.length > 0)) {
      const real = await route.fetch();
      const answer = await real.json().catch(() => null);
      if (answer?.clients?.[0] && clientModelInjection != null) answer.clients[0].model = clientModelInjection;
      // ADMIN-2. The workspaces this run added through the form, appended to the real answer so the
      // panel draws them beside the real one. They are pushed at the END, so every check written
      // against `.first()` still reads the workspace the control plane actually holds.
      if (Array.isArray(answer?.clients)) answer.clients.push(...addedClients);
      await route.fulfill({ status: real.status(), contentType: "application/json", body: JSON.stringify(answer) });
      return;
    }
    const answer = providersFixtureAnswer(request.method(), pathname, body);
    if (answer == null) { await route.continue(); return; }
    const [status, payload] = answer;
    const text = JSON.stringify(payload);
    // Into the same list the control plane's own bodies go into, so the leak sweep at the end of
    // this run covers what the fixture said as well. A fixture that leaked a key would otherwise be
    // invisible to the one leg that exists to notice exactly that.
    fixtureBodiesSeen.push(text);
    await route.fulfill({ status, contentType: "application/json", body: text });
  });

  // THE PAGE LEG CANNOT KILL THE RUN. A locator that never resolves throws a TimeoutError, and
  // until now that threw straight out of the top level: the process died mid leg and the two legs
  // after this one, the leak sweep and the em dash check, had not run since PROXY-1 renamed a
  // panel. A gate whose last checks can be skipped by an unrelated failure is not measuring them.
  // So the whole page leg is one try now: a throw is a FAIL with the message on it, and the run
  // carries on to the legs that have to happen whatever the browser did.
  try {
  await page.goto(`${BASE}/admin`, { waitUntil: "domcontentloaded" });
  check(await page.locator("#door").isVisible(), "the console opens on a sign-in form and nothing else");
  check(!(await page.locator("#console").isVisible()), "and the panels are not on screen before anyone signs in");

  // A normal account, first. The page must refuse it in plain words, with no panel behind it.
  await page.fill("#email", USER_EMAIL);
  await page.fill("#password", userPasswordNow);
  await page.click("#signinButton");
  await page.waitForFunction(() => document.getElementById("doorMessage").textContent.length > 0, null, { timeout: 15_000 }).catch(() => {});
  const refusedText = await page.locator("#doorMessage").textContent();
  check(String(refusedText).includes("not a super admin"), "a normal account is told the console is not theirs", String(refusedText).slice(0, 70));
  check(!(await page.locator("#console").isVisible()), "and still sees no panel");

  await page.fill("#email", BOSS_EMAIL);
  await page.fill("#password", BOSS_PASSWORD);
  await page.click("#signinButton");
  await page.waitForFunction(() => document.body.getAttribute("data-admin-loaded") === "true", null, { timeout: 30_000 })
    .catch(() => {});
  const live = await page.evaluate(() => window.__adminLive ?? null);
  check(live != null, "the super admin gets in and the page finishes loading", live ? `${live.panels} panels at ${live.at}` : "no readiness flag");

  // ---- ADMIN-3: nine panels, one on screen, and a page that never scrolls -----------------------
  //
  // Nine since the Overview landed, and eight loaders, which are deliberately different numbers: the
  // Overview fetches nothing and is drawn from what the eight registered. The readiness flag counts
  // LOADERS, because that is the thing a gate has to wait for.
  //
  // The old form of this leg asserted isVisible on all eight ids at once, which was right when they
  // were stacked and is seven guaranteed failures now. Each panel is opened by its own hash instead,
  // which is also the check that a pasted link opens a panel.
  const panels = [
    "panel-overview", "panel-signins", "panel-clients", "panel-boxes", "panel-system",
    "panel-spend", "panel-providers", "panel-feedback", "panel-marketplace",
  ];

  // What each panel had before this wave and must still have. Presence, not visibility: several of
  // these are forms that open on a button, and a form that is on screen before it is asked for is
  // the defect the providers panel already has a rule about.
  const PANEL_CONTROLS = {
    "panel-overview": ["#overview"],
    "panel-signins": ["#hours", "#outcome", "#signInsNote", "#addresses", "#accounts", "#attempts"],
    "panel-clients": ["#clients", "#addClientShow", "#addClientForm", "#acEmail", "#acCompany", "#acCeiling", "#acWelcome"],
    "panel-boxes": ["#boxes"],
    "panel-system": ["#system"],
    "panel-spend": ["#spend", "#spendNote", "#panel-spend .placeholder"],
    "panel-providers": [
      "#providersNote", "#providers", "#addProviderShow", "#addProviderForm", "#planModels",
      "#addPlanModelShow", "#planModelForm", "#providerDefaults", "#adminLedger",
    ],
    "panel-feedback": ["#feedbackGates", "#feedbackTier", "#feedbackState", "#feedbackNote", "#feedbackRows", "#feedbackTokenNote", "#githubTokenForm", "#githubRepo", "#githubToken"],
    "panel-marketplace": ["#marketplaceNote", "#marketplaceRows", "#marketplaceChanges", "#marketplaceLedger", "#marketplaceLedgerNote", "#marketplaceDelivery"],
  };

  /** Open a panel the way a person does, by its hash, and wait for it to actually be the open one. */
  const openPanel = async (id) => {
    await page.evaluate((want) => { window.location.hash = want; }, `#${id}`);
    await page.waitForFunction((want) => document.getElementById(want)?.hidden === false, id, { timeout: 10_000 })
      .catch(() => {});
  };

  /**
   * Is this thing actually clickable by a person?
   *
   * The memory note verify-ui-in-a-real-browser: a passing page.click() is not evidence a human can
   * click, because Playwright will scroll to and dispatch at an element another element is sitting
   * on top of. So the centre of the box is asked what is really there.
   */
  const hittable = (selector) => page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (node == null) return "there is no such element";
    const box = node.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return "it has no size";
    if (box.bottom < 0 || box.top > window.innerHeight) return "it is off the screen";
    const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    if (at == null) return "nothing is at its centre";
    if (node === at || node.contains(at) || at.contains(node)) return "";
    return `${at.tagName.toLowerCase()}${at.id ? `#${at.id}` : ""} is on top of it`;
  }, selector);

  for (const id of panels) {
    await openPanel(id);
    const open = await page.locator(`#${id}`).isVisible();
    check(open, `the ${id.replace("panel-", "")} panel opens from its own hash`);
    const others = await page.evaluate((ids) => ids.filter((one) => document.getElementById(one)?.hidden !== true),
      panels.filter((one) => one !== id));
    check(others.length === 0, "and it is the only panel on screen", others.join(", "));

    // THE HEADLINE PROOF. The body must not scroll on any panel at a laptop's size: the rail scrolls
    // and the panel scrolls, and nothing pushes the document taller than the window.
    const tall = await page.evaluate(() => document.documentElement.scrollHeight);
    check(tall <= VIEW.height, `and the page itself does not scroll at ${VIEW.width}x${VIEW.height}`, `${tall} px`);

    // AND IT DOES NOT SCROLL SIDEWAYS. `overflow-y: auto` makes the other axis auto as well, so a
    // panel that is one pixel too wide becomes a horizontal scroller, and anything that scrolls it
    // takes the left edge of every heading and every table off the screen with no sign of why. It
    // is what a screenshot of the providers panel showed on this Mac while every check above passed.
    // Everything genuinely wide on this page already has its own scrolling box, so the honest state
    // of a panel is that it never needs one.
    const wide = await page.evaluate((want) => {
      const node = document.getElementById(want);
      if (node == null) return { over: 0, who: "" };
      const over = node.scrollWidth - node.clientWidth;
      if (over <= 0) return { over: 0, who: "" };
      const inner = node.clientWidth;
      const who = Array.from(node.querySelectorAll("*"))
        .filter((one) => one.offsetWidth > inner)
        .slice(0, 4)
        .map((one) => `${one.tagName.toLowerCase()}${one.id ? `#${one.id}` : String(one.className) ? `.${String(one.className).split(" ")[0]}` : ""} ${one.offsetWidth}`)
        .join(", ");
      return { over, who };
    }, id);
    check(wide.over <= 0, `and the ${id.replace("panel-", "")} panel does not scroll sideways`,
      `${wide.over} px over ${wide.who}`);

    for (const selector of PANEL_CONTROLS[id]) {
      const found = await page.locator(selector).count();
      check(found >= 1, `  ${id.replace("panel-", "")} still has ${selector}`, String(found));
    }
  }
  check((await page.locator(".panel").count()) === panels.length, `${panels.length} panels and no more`, String(await page.locator(".panel").count()));
  check(live?.panels === 8, "and the readiness flag says eight loaders ran, which is a different number on purpose", String(live?.panels));

  // ---- the rail, as a person uses it ------------------------------------------------------------
  for (const id of panels) {
    const why = await hittable(`.rail a[href="#${id}"]`);
    check(why === "", `the rail entry for ${id.replace("panel-", "")} is what is under the pointer at its own centre`, why);
  }
  await openPanel("panel-overview");
  await page.click('.rail a[href="#panel-boxes"]');
  // Waiting on the PANEL and not on the hash. `location.hash` is updated the moment the anchor is
  // followed and the hashchange event that acts on it fires after that, so a wait on the hash can
  // resolve a tick before the panel has moved: this leg failed once and passed once on identical
  // code before the wait was moved to the thing it is actually asserting.
  await page.waitForFunction(() => document.getElementById("panel-boxes")?.hidden === false, null, { timeout: 5_000 }).catch(() => {});
  check(await page.locator("#panel-boxes").isVisible() && await page.evaluate(() => window.location.hash) === "#panel-boxes",
    "clicking a rail entry opens its panel and puts it in the address bar",
    String(await page.evaluate(() => window.location.hash)));
  check(await page.locator('.rail a[href="#panel-boxes"]').getAttribute("aria-current") === "page",
    "and the rail says which one you are on, in a way a screen reader can read too");

  // Reachable by keyboard, which for nine plain anchors means Tab and nothing of our own.
  await page.evaluate(() => document.getElementById("signout").focus());
  const tabbed = [];
  for (let i = 0; i < 14 && tabbed.length < panels.length; i += 1) {
    await page.keyboard.press("Tab");
    const href = await page.evaluate(() => {
      const node = document.activeElement;
      return node && node.tagName === "A" && node.closest(".rail") ? node.getAttribute("href") : "";
    });
    if (href) tabbed.push(href);
  }
  check(tabbed.length === panels.length, "Tab reaches every rail entry", `${tabbed.length} of ${panels.length}`);

  // ON A PHONE the rail is a strip across the top rather than a quarter of the screen, and the page
  // still does not scroll: the strip scrolls sideways and the panel scrolls inside itself. One leg,
  // because the single media block this page has is the whole of what makes that true.
  await page.setViewportSize({ width: 390, height: 844 });
  await openPanel("panel-signins");
  const stacked = await page.evaluate(() => {
    const rail = document.querySelector(".rail").getBoundingClientRect();
    const panels = document.querySelector(".panels").getBoundingClientRect();
    return { above: rail.bottom <= panels.top + 1, tall: document.documentElement.scrollHeight };
  });
  check(stacked.above, "on a narrow screen the rail is a strip above the panel and not a column beside it");
  check(stacked.tall <= 844, "and the page still does not scroll", `${stacked.tall} px`);
  check(await page.locator('.rail a[href="#panel-marketplace"]').isVisible(), "with every entry still reachable");
  await page.setViewportSize(VIEW);

  // A LINK STRAIGHT TO A PANEL. Not the same check as the hash walk above: this is a cold load, so
  // it also proves the panel the hash names is the one that is open when the page first paints.
  await page.goto(`${BASE}/admin#panel-marketplace`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.getAttribute("data-admin-loaded") === "true", null, { timeout: 30_000 })
    .catch(() => {});
  check(await page.locator("#panel-marketplace").isVisible(), "a fresh load at a panel's own link opens that panel");
  check(!(await page.locator("#panel-overview").isVisible()), "and not the Overview with it");

  // ---- the Overview -----------------------------------------------------------------------------
  await openPanel("panel-overview");
  const overviewChips = await page.locator("#overview .stat").count();
  check(overviewChips === 6, "the Overview draws its six figures", String(overviewChips));
  const overviewLinks = await page.locator("#overview a.stat[href^='#panel-']").count();
  check(overviewLinks === 6, "and every one of them is a link into the panel it came from", String(overviewLinks));
  await page.click("#overview a.stat[href='#panel-clients']");
  await page.waitForFunction(() => document.getElementById("panel-clients")?.hidden === false, null, { timeout: 5_000 }).catch(() => {});

  check(await page.locator("#panel-clients").isVisible(), "and clicking one opens that panel");
  const strips = await page.locator(".panel .strip .stat").count();
  check(strips >= 20, "every panel that loaded carries its own strip of figures", String(strips));

  await openPanel("panel-signins");
  const attackChips = await page.locator("#addresses .chip.attack").count();
  check(attackChips === 1, "one Attack chip, on the address that earned it", String(attackChips));
  const attackRow = await page.locator("#addresses tbody tr", { hasText: ATTACK_IP }).first().textContent();
  check(String(attackRow).includes("6 different passwords"), "and its row says six different passwords", String(attackRow).replace(/\s+/g, " ").slice(0, 90));
  const sameRow = await page.locator("#addresses tbody tr", { hasText: SAME_IP }).first().textContent();
  check(String(sameRow).includes("the same password 4 times"), "the other address's row says the same password four times", String(sameRow).replace(/\s+/g, " ").slice(0, 90));

  // SIGNIN-1, ON THE SCREEN. Jason, 2026-09-09 11:43, holding two screenshots of this panel with his
  // own address marked "Attack": every one of those bursts was our own deploy gate spending the
  // relay's lockout on purpose. The route decides what is one of ours; this is what the page does
  // with the answer.
  signInGateInjection = true;
  await page.selectOption("#hours", "24");
  await page.waitForFunction(() => document.querySelectorAll("#attempts tr.gateRow").length > 0, null, { timeout: 15_000 })
    .catch(() => {});
  const gateRows = await page.locator("#attempts tr.gateRow").count();
  check(gateRows === 6, "a gate's attempts are drawn as gate rows", String(gateRows));
  const gateRowText = String(await page.locator("#attempts tr.gateRow").first().textContent());
  check(gateRowText.includes("your own verification gate (verify-deploy)"),
    "each one saying whose gate it was and which script", gateRowText.replace(/\s+/g, " ").slice(0, 90));
  check((await page.locator("#addresses .chip.attack").count()) === 0,
    "and the address they came from carries no Attack pill any more",
    String(await page.locator("#addresses .chip.attack").count()));
  const gateAddress = String(await page.locator("#addresses tbody tr", { hasText: ATTACK_IP }).first().textContent());
  check(gateAddress.includes("your address"), "the address is marked as one of ours", gateAddress.replace(/\s+/g, " ").slice(0, 80));
  check(gateAddress.includes("6 of our own gate rows set aside"),
    "with how many were set aside, so nothing is quietly uncounted", gateAddress.replace(/\s+/g, " ").slice(0, 100));
  const gateStrip = String(await page.locator("#panel-signins .strip").textContent());
  check(gateStrip.includes("YOUR OWN GATES") || gateStrip.includes("Your own gates"),
    "and the panel's own summary carries the same count", gateStrip.replace(/\s+/g, " ").slice(0, 110));
  await openPanel("panel-overview");
  const attackChip = String(await page.locator("#overview a.stat[href='#panel-signins']").textContent());
  check(attackChip.includes("gate rows set aside"), "the Overview says the same thing about the same window",
    attackChip.replace(/\s+/g, " ").slice(0, 90));
  signInGateInjection = false;
  await openPanel("panel-signins");
  await page.selectOption("#hours", "24");
  await page.waitForFunction(() => document.querySelectorAll("#attempts tr.gateRow").length === 0, null, { timeout: 15_000 })
    .catch(() => {});
  check((await page.locator("#addresses .chip.attack").count()) === 1,
    "and with the marker gone the same address is an attack again, so the rule is the marker and not the address",
    String(await page.locator("#addresses .chip.attack").count()));

  const sprayChips = await page.locator("#accounts .chip.attack").count();
  check(sprayChips === SPRAY_EMAILS.length, "a Spray chip on every account the one password was tried on", String(sprayChips));
  const sprayRow = await page.locator("#accounts tbody tr", { hasText: SPRAY_EMAILS[0] }).first().textContent();
  check(String(sprayRow).includes("the same password 1 time"), "and that row says one password, once, which is why nothing else caught it",
    String(sprayRow).replace(/\s+/g, " ").slice(0, 90));

  await openPanel("panel-clients");
  const clientCards = await page.locator(".client").count();
  check(clientCards === 1, "the clients panel drew the workspace", String(clientCards));
  await openPanel("panel-boxes");
  const boxRows = await page.locator("#boxes tbody tr").count();
  check(boxRows === 1, "the box health panel drew a row", String(boxRows));
  await openPanel("panel-system");
  const cards = await page.locator("#system .card").count();
  check(cards >= 8, "the system panel drew its cards", String(cards));

  const systemText = await page.locator("#system").textContent();
  check(String(systemText).includes("not measured"), "and says 'not measured' for what it cannot read, rather than a zero");
  // The panel was renamed panel-payments -> panel-spend by PROXY-1 and its placeholder was
  // rewritten, and this leg still waited on the old id, so it threw an uncaught TimeoutError that
  // killed the process here: everything below this line, the leak sweep and the em dash check
  // included, had not run since. The wait is bounded now as well as correct, so a future rename is
  // a FAIL with the reason on it rather than a dead gate.
  await openPanel("panel-spend");
  const spendPlaceholder = await page.locator("#panel-spend .placeholder").textContent({ timeout: 10_000 })
    .catch((error) => `NOT FOUND: ${String(error?.message ?? error).split("\n")[0]}`);
  check(String(spendPlaceholder).replace(/\s+/g, " ").trim()
    === "Taking the money is not connected yet. Plan pricing and invoices appear here when Stripe is wired in.",
  "the spend panel says exactly what it was asked to say", String(spendPlaceholder).replace(/\s+/g, " ").trim().slice(0, 70));

  // ---- the sixth panel, driven -----------------------------------------------------------------
  //
  // PROVIDERS-1. Everything below is done the way Jason does it: a value typed into a field on the
  // screen and a button clicked. The two key values are planted, they are registered with the leak
  // sweep at the end of this run, and between them they turn "the panel never renders a key" from
  // a claim into a measurement.
  await openPanel("panel-providers");
  const providerCards = await page.locator("#providers .provider").count();
  check(providerCards === 4, "the providers panel drew every provider", String(providerCards));
  const modelCards = await page.locator("#planModels .planModel").count();
  check(modelCards === 4, "and every plan model", String(modelCards));

  // THE ALIAS IS NOT THE NAME. A plan model that has a customer name shows that name at the top and
  // the routing alias only on its own captioned line underneath. This is the check that stops the
  // panel doing to the operator what the Settings card was doing to the customer.
  const named = await page.locator('#planModels .planModel[data-alias="plan-zai"] .head').textContent();
  check(!String(named).includes("plan-zai"), "a plan model with a label leads with the label and not the routing name",
    String(named).replace(/\s+/g, " ").slice(0, 70));
  const aliasLines = await page.locator("#planModels .aliasLine").count();
  check(aliasLines === 4, "and each one says what the routing calls it, captioned as that", String(aliasLines));
  const aliasLine = await page.locator('#planModels .planModel[data-alias="plan-zai"] .aliasLine').textContent();
  check(String(aliasLine).includes("what the routing calls it") && String(aliasLine).includes("plan-zai"),
    "on a line an operator can read without guessing what it is", String(aliasLine).replace(/\s+/g, " ").slice(0, 60));

  // THE WARNING HAS TO BE TRUE OR IT IS FURNITURE. plan-zai-vision is the model every other one
  // falls back TO: it has no fallback of its own and never will. The form already knew that and let
  // it save; the card did not, and shouted "no screenshot route ... fails on its next turn" at it on
  // every single load. An operator who learns that this panel cries wolf about the vision model is
  // an operator who scrolls past the day it is a real text-only model saying the same thing. The
  // other half of the rule, that a model with nowhere to fall back to is refused, is measured on the
  // form below rather than on a card, because this API will not save such a model in the first place.
  const visionSelf = await page.locator('#planModels .planModel[data-alias="plan-zai-vision"]').textContent();
  check(!String(visionSelf).includes("no screenshot route"),
    "the model everything falls back to is not warned that it has nowhere to fall back to",
    String(visionSelf).replace(/\s+/g, " ").slice(0, 80));
  check(String(visionSelf).includes("takes screenshots itself"),
    "it says why instead", String(visionSelf).replace(/\s+/g, " ").slice(0, 80));
  const visionFlagship = await page.locator('#planModels .planModel[data-alias="plan-zai"]').textContent();
  check(String(visionFlagship).includes("a screenshot falls back to"),
    "and a model that does fall back somewhere names where");

  // NOTHING DANGEROUS IS OPEN BEFORE IT IS ASKED FOR. This is here because the first build of this
  // panel drew a roll form and a remove form under every key on load: the code set hidden, and a
  // class setting `display: flex` beat the browser's own rule for it. Every check in this leg still
  // passed, because a field that is on screen by mistake is a field Playwright can type into. Only
  // a person looking at the page caught it, so the fix is a CSS rule and these three checks.
  const drawnAnyway = await page.locator("#panel-providers [hidden]:visible").count();
  check(drawnAnyway === 0, "nothing this panel marked hidden is drawn anyway", `${drawnAnyway} were`);
  check(!(await page.locator("#addProviderForm").isVisible()) && !(await page.locator("#planModelForm").isVisible()),
    "the add forms are closed until somebody asks for them");
  await page.locator('.provider[data-provider="zai"] tr[data-key="zai-1"] .rollKey').click();
  check(await page.locator('.provider[data-provider="zai"] tr[data-key="zai-1"] + tr .keyForm.rollForm').isVisible(),
    "and Roll opens the one under that key");
  await page.locator('.provider[data-provider="zai"] tr[data-key="zai-1"] .rollKey').click();
  check(!(await page.locator('.provider[data-provider="zai"] tr[data-key="zai-1"] + tr .keyForm.rollForm').isVisible()),
    "and closes it again");

  // ADD A KEY, through the masked field, with a real value.
  const minimax = page.locator('.provider[data-provider="minimax"]');
  check(await minimax.locator(".addKeyForm .keyValue").getAttribute("type") === "password",
    "the field a key is typed into is a password field");
  await minimax.locator(".addKeyForm .keyLabel").fill("MiniMax subscription two");
  await minimax.locator(".addKeyForm .keyValue").fill(PLANTED_KEY_ADD);
  await minimax.locator(".addKeyForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("was added") === true, null, { timeout: 15_000 })
    .catch(() => {});
  const addBanner = await page.locator("#banner").textContent();
  check(String(addBanner).includes("A key was added"), "a second key on the same provider goes in from the panel",
    String(addBanner).replace(/\s+/g, " ").slice(0, 80));
  check(!String(addBanner).includes(PLANTED_KEY_ADD), "and the banner names the slot and a hash, never the value");
  const minimaxKeys = await page.locator('.provider[data-provider="minimax"] tbody tr[data-key]').count();
  check(minimaxKeys === 2, "the pool is two keys deep now", String(minimaxKeys));
  check(JSON.stringify(poolHistory.minimax) === "[1,2]", "and it went one to two", JSON.stringify(poolHistory.minimax));
  const addFieldAfter = await page.locator('.provider[data-provider="minimax"] .addKeyForm .keyValue').inputValue();
  check(addFieldAfter === "", "the field it was typed into is empty afterwards and is never written back into");

  // ROLL A KEY. The one that has to leave no gap, and the pool history is how that is measured
  // rather than believed: two, then three while both are in, then two again.
  const zai = page.locator('.provider[data-provider="zai"]');
  await zai.locator('tr[data-key="zai-1"] .rollKey').click();
  await zai.locator('tr[data-key="zai-1"] + tr .keyForm.rollForm .keyValue').fill(PLANTED_KEY_ROLL);
  await zai.locator('tr[data-key="zai-1"] + tr .keyForm.rollForm button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("was replaced") === true, null, { timeout: 15_000 })
    .catch(() => {});
  const rollBanner = await page.locator("#banner").textContent();
  check(String(rollBanner).includes("was replaced"), "a key rolls from the panel", String(rollBanner).replace(/\s+/g, " ").slice(0, 80));
  check(!String(rollBanner).includes(PLANTED_KEY_ROLL), "and that banner carries no fragment of the new key either");
  check(JSON.stringify(poolHistory.zai) === "[2,3,2]", "the pool went two, three, two, so the new key was in before the old one came out",
    JSON.stringify(poolHistory.zai));
  const zaiKeys = await page.locator('.provider[data-provider="zai"] tbody tr[data-key]').count();
  check(zaiKeys === 2, "and the pool is the size it started at", String(zaiKeys));

  // MONEY THAT IS NOT MONEY. A deployment with no cost per token bills every request at zero, so
  // $0.00 in a spend column means either "spent nothing" or "nobody set a price" and the two are
  // indistinguishable on a screen. On the R750 2026-09-08 every Z.AI row was the second while the
  // page drew the first, for a customer at 665,915 tokens.
  const unpricedRow = await zai.locator('tr[data-key="zai-2"]').textContent();
  check(String(unpricedRow).includes("not priced"), "a key whose model carries no price says not priced",
    String(unpricedRow).replace(/\s+/g, " ").slice(0, 90));
  check(!/\$0\.00/.test(String(unpricedRow)), "and never draws a dollar sign in front of a zero");
  const pricedRow = await zai.locator('tr[data-key="zai-1"]').textContent();
  check(/\$/.test(String(pricedRow)), "while a priced one still shows the money", String(pricedRow).replace(/\s+/g, " ").slice(0, 60));

  // AND HEALTH THAT CANNOT GO RED IS NOT HEALTH. Nothing on this install checks in the background,
  // so a provider nothing has run on says so instead of drawing a green light with a fresh
  // timestamp on it, which is what it used to do for a provider whose catalog had never been read.
  const minimaxHead = await minimax.locator(".head").first().textContent();
  check(String(minimaxHead).includes("not checked"), "a provider nothing has checked says not checked",
    String(minimaxHead).replace(/\s+/g, " ").slice(0, 80));
  check(await minimax.locator(".actions button", { hasText: "Check now" }).count() === 1,
    "and there is a button to check it, because a real check costs the vendor a request");

  // PUSHING A LABEL ASKS WHICH WORKSPACES, ALWAYS.
  //
  // The relay door this drives writes the base url, the key, the model, the endpoint name, the
  // served-by line, the context window and the label in one call, so a push does not merely correct
  // a name: it MOVES that workspace onto this plan model. The route was rewritten to refuse a body
  // that names nobody for exactly that reason, and the page answered that refusal by resending
  // { all: true } on one click, with no list, no ticking and no confirm.
  const behindChip = await page.locator('#planModels .planModel[data-alias="plan-zai"] .head').textContent();
  check(String(behindChip).includes("behind on the name"),
    "a model whose boxes are behind on their label says how many", String(behindChip).replace(/\s+/g, " ").slice(0, 90));
  const pushesBefore = pushBodies.length;
  await page.locator('#planModels .planModel[data-alias="plan-zai"] .actions button', { hasText: "Fix what" }).first().click();
  await page.waitForSelector('#planModels .planModel[data-alias="plan-zai"] .pushPicker', { timeout: 15_000 }).catch(() => {});
  const picker = page.locator('#planModels .planModel[data-alias="plan-zai"] .pushPicker');
  check(await picker.count() === 1, "the first click asks which workspaces instead of pushing");
  check(pushBodies.length === pushesBefore + 1 && Object.keys(pushBodies[pushBodies.length - 1]).length === 0,
    "and what it sent was an EMPTY body, so the route's own refusal is what produced the list",
    JSON.stringify(pushBodies[pushBodies.length - 1] ?? null));
  const boxes = await picker.locator("input[type=checkbox]").count();
  check(boxes === 3, "every candidate the route named is on screen as its own tick box", String(boxes));
  const pickerText = await picker.textContent();
  check(String(pickerText).includes("richard-avery (behind)"),
    "the ones actually behind are marked", String(pickerText).replace(/\s+/g, " ").slice(0, 90));
  check(await picker.locator('input[value="demo"]').isChecked() === false,
    "a workspace already saying the right thing is left unticked, because pushing at it writes in a customer's box for no change");
  await picker.locator("button", { hasText: "Update the ticked" }).click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("will call it") === true, null, { timeout: 15_000 })
    .catch(() => {});
  const sent = pushBodies[pushBodies.length - 1];
  check(Array.isArray(sent?.slugs) && sent.slugs.length === 2 && !sent.slugs.includes("demo"),
    "and only the ticked workspaces are sent, by name", JSON.stringify(sent?.slugs ?? sent));
  check(sent?.all !== true, "the page never sends { all: true }, which is what defeated the guard");

  // A PLAN MODEL WITH NOWHERE FOR A SCREENSHOT TO GO IS REFUSED, in a sentence a person reads.
  // This is PROXY-10 as a form rule: every conversation on this product carries screenshots.
  await page.locator('#planModels .planModel[data-alias="plan-minimax"] .actions button', { hasText: "Edit" }).first().click();
  await page.selectOption("#pmVision", "");
  await page.uncheck("#pmSelfVision");
  const modelWritesBefore = providersFixture.actions.filter((row) => String(row.action).includes("plan model")).length;
  await page.click("#planModelSave");
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("screenshot") === true, null, { timeout: 10_000 })
    .catch(() => {});
  const visionBanner = await page.locator("#banner").textContent();
  check(String(visionBanner).startsWith("Pick where a screenshot falls back to"),
    "a plan model with no screenshot route is refused in words a person reads", String(visionBanner).replace(/\s+/g, " ").slice(0, 90));
  check(providersFixture.actions.filter((row) => String(row.action).includes("plan model")).length === modelWritesBefore,
    "and nothing was written, so the refusal is a refusal and not a warning");
  check(!(await page.locator("#planModelForm").isHidden()), "the form stays open on what was typed");
  // Put the route back and save it properly, so the panel's happy path is measured too.
  await page.selectOption("#pmVision", "plan-zai-vision");
  await page.click("#planModelSave");
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("is saved") === true, null, { timeout: 15_000 })
    .catch(() => {});
  check(String(await page.locator("#banner").textContent()).includes("is saved"),
    "with a screenshot route it saves", String(await page.locator("#banner").textContent()).replace(/\s+/g, " ").slice(0, 80));

  // REMOVE, WITHOUT TYPING THE CONFIRMATION. The one destructive control on this page.
  await zai.locator('tr[data-key="zai-2"] .removeKey').click();
  await zai.locator('tr[data-key="zai-2"] + tr .keyForm.danger button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("Nothing was removed") === true, null, { timeout: 10_000 })
    .catch(() => {});
  const removeBanner = await page.locator("#banner").textContent();
  check(String(removeBanner).includes("Nothing was removed"), "a remove with nothing typed in the box is refused",
    String(removeBanner).replace(/\s+/g, " ").slice(0, 80));
  check((await page.locator('.provider[data-provider="zai"] tbody tr[data-key]').count()) === 2,
    "and the pool is untouched");

  // THE MODEL LIST SAYS WHAT IT IS. Names, and nothing else, because that is all a vendor's own
  // list carries and an operator picking one needs to know the rest is theirs to set.
  await zai.locator(".actions button", { hasText: "Refresh the model list" }).click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("lists") === true, null, { timeout: 15_000 })
    .catch(() => {});
  const catalogBanner = await page.locator("#banner").textContent();
  check(String(catalogBanner).includes("names and nothing else"), "a catalog refresh says it returned names and nothing else",
    String(catalogBanner).replace(/\s+/g, " ").slice(0, 90));

  // ---- PROVIDERS-8: a colour that can go back to green -------------------------------------------
  //
  // Measured on the R750 2026-09-09 12:02: plan-qwen answered HTTP 200 in 2,357 ms through the proxy
  // while this panel said "not answering", because the rule went red on ANY failure inside the month
  // window and three of that key's 254 requests had failed the previous evening, before the key moved
  // endpoints. The fixture is that provider, to the number: 254 requests, 3 failures, the newest five
  // all fine.
  const qwen = page.locator('.provider[data-provider="qwen"]');
  const qwenHead = String(await qwen.locator(".head").first().textContent());
  check(qwenHead.includes("answering") && !qwenHead.includes("not answering"),
    "a provider whose most recent requests all answered reads as answering, whatever failed a week ago",
    qwenHead.replace(/\s+/g, " ").slice(0, 80));
  check(qwenHead.includes("3 of 254 failed this month"),
    "and the month's failures are beside the green chip, not instead of it",
    qwenHead.replace(/\s+/g, " ").slice(0, 110));
  check(qwenHead.includes("last 2026-09-08 22:48 UTC"),
    "with the clock time of the last one, which is what an operator matches against a log",
    qwenHead.replace(/\s+/g, " ").slice(0, 110));
  const qwenChipTitle = await qwen.locator(".head .chip.ok").first().getAttribute("title");
  check(String(qwenChipTitle).includes("most recent"), "and the green says what it stands on", String(qwenChipTitle).slice(0, 70));
  // The key row's own column, which read "none" on the R750 for a key that had failed three times,
  // because it was reading the proxy's /health/latest and that answers an empty list on this build.
  const qwenKeyRow = String(await qwen.locator('tr[data-key="qwen-1"]').textContent());
  check(qwenKeyRow.includes("an error"), "the key's last error column reads the same sweep the chip does",
    qwenKeyRow.replace(/\s+/g, " ").slice(0, 90));
  const zaiHead = String(await zai.locator(".head").first().textContent());
  check(!/failed this month/.test(zaiHead), "a provider with no failure this month says nothing about failures",
    zaiHead.replace(/\s+/g, " ").slice(0, 80));

  // A CHECK NEEDS SOMETHING TO CHECK WITH. It sends one real request per model this provider serves,
  // and there is nothing to send it with until a key is in. Said on the screen, not in a tooltip on a
  // control that cannot be hovered.
  const leftover = page.locator('.provider[data-provider="qwen-plan"]');
  const leftoverCheck = leftover.locator(".actions button", { hasText: "Check now" });
  check(await leftoverCheck.isDisabled(), "Check now is off on a provider with no key");
  check(String(await leftover.locator(".head").first().textContent()).includes("add a key first, then this can check it"),
    "and says why on the screen", String(await leftover.locator(".head").first().textContent()).replace(/\s+/g, " ").slice(0, 110));
  check(await zai.locator(".actions button", { hasText: "Check now" }).isDisabled() === false,
    "while a provider that has a key can still be checked, so the working path was not made harder");

  // ---- PROVIDERS-9: removing the duplicate -------------------------------------------------------
  //
  // On the R750 the Alibaba token plan was listed twice: `qwen`, the preset with the key and the
  // requests, and `qwen-plan`, a leftover of the 2026-09-08 recovery with the same name, the same
  // address, no key and nothing ever run through it.
  check(await qwen.locator(".removeProvider").isDisabled(),
    "Remove is off on a provider that still holds a key");
  check(String(await qwen.locator(".head").first().textContent()).includes("Remove the keys first"),
    "and the reason is on the screen beside it");
  check(await page.locator('.provider[data-provider="minimax"] .removeProvider').isDisabled(),
    "and off on one a plan model still runs on");
  check(String(await page.locator('.provider[data-provider="minimax"] .head').first().textContent()).includes("plan-minimax still runs on it"),
    "naming the plan model that would stop as well as the key that is in it",
    String(await page.locator('.provider[data-provider="minimax"] .head').first().textContent()).replace(/\s+/g, " ").slice(0, 130));
  // A built-in is never really removed: the override comes off and the built-in comes back, and the
  // confirmation has to say that or it is a sentence that turns out to be false on the next load.
  check(String(await zai.locator(".providerRemoveForm").textContent()).includes("removing it only takes the override off and puts the built-in back"),
    "a built-in card's confirmation says what removing one actually does");

  const leftoverRemove = leftover.locator(".removeProvider");
  check(await leftoverRemove.isDisabled() === false, "Remove is on for a provider with no key and nothing running on it");
  await leftoverRemove.scrollIntoViewIfNeeded();
  const removeReach = await hittable('.provider[data-provider="qwen-plan"] .removeProvider');
  check(removeReach === "", "and it is what is under the pointer at its own centre, so a person can press it", removeReach);
  await leftoverRemove.click();
  check(await leftover.locator(".providerRemoveForm").isVisible(), "pressing it asks for the name to be typed");
  // Nothing typed, so nothing goes.
  await leftover.locator(".providerRemoveForm button[type=submit]").click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("Nothing was removed") === true, null, { timeout: 10_000 })
    .catch(() => {});
  check(String(await page.locator("#banner").textContent()).includes("Nothing was removed"),
    "an empty confirmation removes nothing", String(await page.locator("#banner").textContent()).replace(/\s+/g, " ").slice(0, 80));
  check((await page.locator("#providers .provider").count()) === 4, "and every card is still there",
    String(await page.locator("#providers .provider").count()));

  await leftover.locator(".providerRemoveForm .confirmProvider").fill("qwen-plan");
  await leftover.locator(".providerRemoveForm button[type=submit]").click();
  await page.waitForFunction(() => document.querySelectorAll("#providers .provider").length === 3, null, { timeout: 15_000 })
    .catch(() => {});
  check((await page.locator("#providers .provider").count()) === 3, "typing the name takes the duplicate away",
    String(await page.locator("#providers .provider").count()));
  check((await page.locator('.provider[data-provider="qwen-plan"]').count()) === 0, "and it is the leftover that went");
  check((await page.locator('.provider[data-provider="qwen"]').count()) === 1, "while the one with the key and the requests stayed");

  // WHAT CHANGED. One row per change, with who and when on it, and no key value in any of them.
  const ledgerRows = await page.locator("#adminLedger tbody tr").count();
  check(ledgerRows >= 4, "every change wrote a row under What changed", String(ledgerRows));
  const ledgerText = await page.locator("#adminLedger").textContent();
  check(String(ledgerText).includes(BOSS_EMAIL), "each carrying who made it");
  check(String(ledgerText).includes("added a key") && String(ledgerText).includes("rolled a key"),
    "and what they did, in the words the operator used");
  check(!String(ledgerText).includes(PLANTED_KEY_ADD) && !String(ledgerText).includes(PLANTED_KEY_ROLL),
    "and no key value in any row");
  const firstRow = await page.locator("#adminLedger tbody tr").first().textContent();
  check(/ago|just now/.test(String(firstRow)), "with a time on it", String(firstRow).replace(/\s+/g, " ").slice(0, 60));

  // THE WHOLE DOCUMENT, not just what is painted: attributes, hidden nodes, input values and all.
  // This is the check that would have caught a key written back into a field by a reload.
  const html = await page.content();
  check(!html.includes(PLANTED_KEY_ADD), "the key that was added is in no node of the page");
  check(!html.includes(PLANTED_KEY_ROLL), "and neither is the one it was rolled to");
  const fieldValues = await page.evaluate(() => Array.from(document.querySelectorAll("input")).map((one) => one.value).join(" "));
  check(!fieldValues.includes(PLANTED_KEY_ADD) && !fieldValues.includes(PLANTED_KEY_ROLL),
    "and no field on the page is still holding one");

  // ONE WORKSPACE'S OWN MODEL, on its own row under the customer, in all three of its states. The
  // control plane in this tree reports none of them yet, so the first is what it actually answers
  // and the other two are injected into that same answer. The middle one is the one that matters:
  // a workspace whose model is pinned in its own environment must SAY so, because a picker that
  // saves a value the box will never read is a control that lies about having worked.
  await openPanel("panel-clients");
  const modelRow = page.locator(".client .modelRow");
  check((await modelRow.count()) === 1, "the customer's row says what that workspace runs on");
  check(String(await modelRow.textContent()).includes("not measured"),
    "and says not measured while nothing reports it, rather than inventing a model",
    String(await modelRow.textContent()).replace(/\s+/g, " ").slice(0, 60));

  clientModelInjection = { current: "plan-zai", label: "GLM-5.3", pinned: true, why: "This workspace's model is fixed in its own environment." };
  await page.click("#refresh");
  await page.waitForFunction(() => document.querySelector(".client .modelRow .chip.locked") != null, null, { timeout: 15_000 }).catch(() => {});
  const pinnedRow = String(await modelRow.textContent());
  check(pinnedRow.includes("GLM-5.3") && pinnedRow.includes("pinned"), "a pinned workspace says pinned and names what it is on",
    pinnedRow.replace(/\s+/g, " ").slice(0, 60));
  check((await modelRow.locator("select").count()) === 0,
    "and offers no picker, because saving one would record a change the workspace never sees");

  clientModelInjection = {
    current: "plan-zai", label: "GLM-5.3", pinned: false,
    choices: [{ alias: "plan-zai", name: "GLM-5.3" }, { alias: "plan-minimax", name: "MiniMax-M3" }],
  };
  await page.click("#refresh");
  await page.waitForFunction(() => document.querySelector(".client .modelRow select") != null, null, { timeout: 15_000 }).catch(() => {});
  const options = await modelRow.locator("select option").allTextContents();
  check(options.join(" ") === "GLM-5.3 MiniMax-M3", "a workspace that can be moved gets a picker of what a customer would see",
    options.join(" "));
  check(!options.join(" ").includes("plan-"), "and the routing names are not in it");
  await modelRow.locator("select").selectOption("plan-minimax");
  await modelRow.locator("button", { hasText: "Save" }).click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("from its next turn") === true, null, { timeout: 15_000 }).catch(() => {});
  const savedBanner = String(await page.locator("#banner").textContent());
  check(savedBanner.includes("from its next turn"), "and saving it says which turn it lands on", savedBanner.replace(/\s+/g, " ").slice(0, 70));
  check(savedBanner.includes("MiniMax-M3") && !savedBanner.includes("plan-"),
    "in the customer's name for the model and not the routing one", savedBanner.replace(/\s+/g, " ").slice(0, 70));
  check(providersFixture.actions.some((row) => row.action === "changed one workspace's model" && row.detail === "plan-minimax"),
    "with a row under What changed naming the workspace and the model");
  // ON THE SCREEN, not just in the answer. This change is made on the clients panel and recorded on
  // the providers one, and reloading only the panel that was clicked left the ledger a row short of
  // the truth until somebody pressed Refresh.
  check(String(await page.locator("#adminLedger").textContent()).includes("changed one workspace's model"),
    "and that row is on the screen without anybody pressing Refresh");
  clientModelInjection = null;

  // ---- the seventh panel, in a browser (FEEDBACK-1) ------------------------------------------
  //
  // The rows the API leg above planted, drawn. What matters on the screen is the pair of facts the
  // panel exists to carry: that both gates are real, and that the stored token is nowhere on it.
  // THE PANEL IS A PANEL AND NOT A WRAPPER. cp/admin/index.html carried eight section opens and
  // seven closes: #panel-feedback never closed, so the browser parsed #panel-marketplace as its
  // CHILD. Nothing on the screen looked wrong and every check below passed, because a child panel
  // renders exactly where a sibling would. It matters the moment one panel is hidden at a time:
  // hiding feedback would take marketplace off the screen with it. Asked of the browser's own tree
  // rather than counted in the source, because counting tags is what missed it for two days.
  const nested = await page.evaluate(() => document.getElementById("panel-feedback")
    ?.contains(document.getElementById("panel-marketplace")) === true);
  check(!nested, "the marketplace panel is a sibling of the feedback panel and not a child of it");
  await openPanel("panel-feedback");
  const feedbackText = await page.locator("#panel-feedback").textContent();
  check(String(feedbackText).includes("shown to the workspace operator"),
    "the Feedback panel says on the page that the operator saw the report first");
  check(!String(feedbackText).includes("Cloud browsing sessions"),
    "and reading that panel reads that panel, not the one that used to be inside it");
  const feedbackCards = await page.locator("#feedbackRows .feedbackCard").count();
  check(feedbackCards >= 2, "and draws the reports the intake took", String(feedbackCards));
  check((await page.locator("#panel-feedback .chip.attack").count()) >= 1,
    "a critical report is drawn loudly, because somebody is stopped right now");
  check(String(await page.locator("#feedbackTokenNote").textContent()).includes("characters, sha256"),
    "the token that was pasted is reported as a length and a hash",
    String(await page.locator("#feedbackTokenNote").textContent()).slice(0, 80));
  // The tier filter is a real filter and not decoration.
  await page.selectOption("#feedbackTier", "observation");
  await page.waitForFunction(() => document.querySelectorAll("#feedbackRows .empty").length > 0, null, { timeout: 10_000 }).catch(() => {});
  check(String(await page.locator("#feedbackRows").textContent()).includes("Nothing reported in this filter"),
    "a tier with nothing in it says so, rather than drawing an empty table");
  await page.selectOption("#feedbackTier", "");
  await page.waitForFunction(() => document.querySelectorAll("#feedbackRows .feedbackCard").length > 0, null, { timeout: 10_000 }).catch(() => {});

  // AGENTS-CAP-2. The ceiling on the client row, in the browser: a number a person can read and a
  // field a person can type in, drawn from what the box reported.
  await openPanel("panel-clients");
  const ceilingField = await page.locator(".client .clientCeiling").first();
  check(await ceilingField.isVisible(), "the client row carries a ceiling field a person can reach");
  check(String(await ceilingField.inputValue()) === "40", "showing the number the box reported", String(await ceilingField.inputValue()));

  // ---- ADMIN-2: adding a client from the screen ---------------------------------------------------
  //
  // Jason, 2026-09-09 11:43: "if I was going to onboard a new client, would that be something I would
  // do from this console or is this console merely reporting?" Provisioning a real container is not a
  // thing a gate on a laptop repeats, so what is measured here is the half that CAN be: the form goes
  // out, the row comes back, the password is on the screen exactly once, and the same address a second
  // time is refused and creates nothing. The other half is measured on the R750.
  await openPanel("panel-clients");
  check(!(await page.locator("#addClientForm").isVisible()), "the add-client form is closed until somebody asks for it");
  const showReach = await hittable("#addClientShow");
  check(showReach === "", "and the button that opens it is what is under the pointer at its own centre", showReach);
  await page.click("#addClientShow");
  check(await page.locator("#addClientForm").isVisible(), "pressing it opens the form");

  // THE MAIL TICK IS NOT A GREEN LIGHT. This control plane sends no mail at all, so the box is
  // present, off, and disabled with the reason beside it.
  check(await page.locator("#acWelcome").isDisabled(), "the welcome mail box is disabled");
  check(await page.locator("#acWelcome").isChecked() === false, "and unchecked, so nothing on the screen suggests mail went out");
  check(String(await page.locator("#acWelcomeWhy").textContent()).includes("does not send mail yet"),
    "with the reason next to it", String(await page.locator("#acWelcomeWhy").textContent()).replace(/\s+/g, " ").slice(0, 70));

  // Three of the four, because plan-zai-vision is the model everything else falls back TO and no
  // customer is ever put on it: it carries no customer name, so offering it here would put a routing
  // alias in a picker and a workspace on a model its own Settings page cannot name.
  const planOptions = await page.locator("#acPlanModel option").allTextContents();
  check(planOptions.length === 3, "the plan model picker is filled from what the providers panel read", planOptions.join(", ").slice(0, 90));
  check(!planOptions.join(" ").includes("plan-"), "in the names a customer would see and not the routing ones", planOptions.join(", ").slice(0, 90));

  const NEW_EMAIL = `newclient+${randomBytes(4).toString("hex")}@example.com`;
  const clientsBefore = await page.locator(".client").count();
  await page.fill("#acEmail", NEW_EMAIL);
  await page.fill("#acCompany", "Northwind Plumbing");
  await page.fill("#acName", "Dale Northwind");
  await page.fill("#acCeiling", "40");
  await page.click("#addClientSave");
  await page.waitForSelector("#addClientResult .newClient", { timeout: 20_000 }).catch(() => {});
  const newCard = String(await page.locator("#addClientResult").textContent());
  check(newCard.includes("still coming up"),
    "the form adds the client and says what state the workspace is in", newCard.replace(/\s+/g, " ").slice(0, 90));
  check(newCard.includes("This password is shown once. Copy it now."),
    "the card says the password will not be shown again");
  check(newCard.includes("northwind-plumbing"), "and names the workspace the company gave its name to",
    newCard.replace(/\s+/g, " ").slice(0, 90));
  check(newCard.includes("No welcome mail was sent"), "and says plainly that no mail went out");
  check((await page.locator("#addClientResult button", { hasText: "Copy the welcome note" }).count()) === 1,
    "with a note to copy instead");
  const clientsAfter = await page.locator(".client").count();
  check(clientsAfter === clientsBefore + 1, "the new workspace has a row on the panel", `${clientsBefore} then ${clientsAfter}`);

  // THE PASSWORD IS ON THE SCREEN ONCE. Not in the banner, not in a second card, not written back
  // into a field: the whole document is searched, attributes and input values included.
  const minted = mintedPasswords[mintedPasswords.length - 1];
  const documentNow = await page.content();
  check(minted != null && documentNow.split(minted).length - 1 === 1,
    "and the temporary password is in exactly one place on the whole document",
    String(minted == null ? "none was minted" : documentNow.split(minted).length - 1));

  // THE SAME ADDRESS AGAIN, in the route's own words and with nothing created.
  await page.click("#addClientShow");
  await page.fill("#acEmail", NEW_EMAIL);
  await page.fill("#acCompany", "Northwind Heating");
  await page.click("#addClientSave");
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("already has an account") === true, null, { timeout: 15_000 })
    .catch(() => {});
  const duplicate = String(await page.locator("#banner").textContent());
  check(duplicate.includes("That email address already has an account. Sign in instead."),
    "a second client on the same address is refused in the route's own sentence, unchanged",
    duplicate.replace(/\s+/g, " ").slice(0, 90));
  check((await page.locator(".client").count()) === clientsAfter, "and nothing was created",
    String(await page.locator(".client").count()));
  check((await page.locator("#addClientResult .newClient").count()) === 0,
    "and no second card, so no password from a client that does not exist is on the screen");

  // Refresh takes the card away, because a temporary password must not sit on a screen an operator
  // walked away from.
  await page.click("#refresh");
  await page.waitForFunction(() => document.body.getAttribute("data-admin-loaded") === "true", null, { timeout: 30_000 }).catch(() => {});
  check((await page.locator("#addClientResult .newClient").count()) === 0, "Refresh takes the new-client card off the screen");
  check(minted != null && !(await page.content()).includes(minted), "and the password with it");

  // ---- the whole console, panel by panel, after every write ---------------------------------------
  //
  // Read off the SCREEN and not out of the DOM. `innerText` is what is painted, and with one panel on
  // screen at a time that means walking all nine: the two rules below are about what a person sees, so
  // a textContent sweep would fail on an em dash inside a node nobody draws and pass on a page that
  // draws one in a panel it did not happen to open.
  const finalText = [];
  for (const id of panels) {
    await openPanel(id);
    const tall = await page.evaluate(() => document.documentElement.scrollHeight);
    check(tall <= VIEW.height, `${id.replace("panel-", "")} still does not scroll the page after every write`, `${tall} px`);
    finalText.push(await page.evaluate(() => document.body.innerText));
    // A picture of each panel, when somebody asked for one. A gate saying a page renders and a person
    // looking at that page are not the same evidence, and the second is what a report carries. Off
    // unless CP_GATE_SHOT_DIR is set, so the default run writes nothing anywhere.
    if (process.env.CP_GATE_SHOT_DIR) {
      const shot = path.join(process.env.CP_GATE_SHOT_DIR, `${id}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      console.log(`  shot   ${shot}  ${tall} px tall in a ${VIEW.width}x${VIEW.height} window`);
      if (id === "panel-providers") {
        const one = path.join(process.env.CP_GATE_SHOT_DIR, "providers-panel.png");
        await page.locator("#panel-providers").screenshot({ path: one }).catch(() => {});
        console.log(`  shot   ${one}`);
      }
    }
  }
  const wholePage = finalText.join("\n");

  // The name of the thing under all this appears once, for the operator, and nowhere else.
  check((wholePage.match(/LiteLLM/g) ?? []).length <= 1, "the proxy's own name appears at most once on this console, in a footnote",
    String((wholePage.match(/LiteLLM/g) ?? []).length));

  // No em dashes anywhere on the screen. Jason's rule, and the panel is copy a business owner reads.
  check(!wholePage.includes("—"), "no em dash on any of the nine panels");

  check(pageErrors.length === 0, "and the page threw nothing", pageErrors.slice(0, 2).join(" | "));
  } catch (error) {
    check(false, "the page leg ran to the end", String(error?.message ?? error).split("\n")[0]);
  } finally {
    if (browser) { try { await browser.close(); } catch { /* already gone */ } browser = null; }
  }
}

// ---- leak -----------------------------------------------------------------------------------------
step("nothing leaked");
{
  const secrets = [
    ["the session secret", SESSION_SECRET],
    ["the admin token", ADMIN_TOKEN],
    ["the relay token", RELAY_TOKEN],
    ["the Coolify key", COOLIFY_KEY],
    ["the super admin's password", BOSS_PASSWORD],
    ["the customer's password", USER_PASSWORD],
    ["the password that was tried", TRIED_PASSWORD],
    ["the relay's ledger salt", RELAY_SALT],
    // PROVIDERS-1. The two values typed into the panel's masked fields in this run. Before this
    // wave nothing had ever put a secret INTO this console and there was nothing here to plant.
    ["the key added through the providers panel", PLANTED_KEY_ADD],
    ["the key rolled to through the providers panel", PLANTED_KEY_ROLL],
    // FEEDBACK-1. The repository token, which is the first secret this store has ever HELD rather
    // than passed along. cp/README.md asks for this sweep by name.
    ["the repository token pasted into the Feedback panel", GITHUB_TOKEN],
  ];
  // The fixture's own answers go into the same haystack. It is the thing that served the writes,
  // so a key coming back out of one of them is exactly the failure this leg exists to catch.
  const haystack = bodiesSeen.concat(fixtureBodiesSeen).join("\n");
  for (const [label, secret] of secrets) {
    check(!haystack.includes(secret), `no response body in this run carried ${label}`);
  }
  const log = childLog.join("");
  for (const [label, secret] of secrets) {
    check(!log.includes(secret), `and the control plane's log did not print ${label}`);
  }

  // FEEDBACK-1. The held token, hunted in the two places the other secrets cannot be: the change
  // record, which keeps its rows forever, and the data directory, which is where this store now
  // writes a secret for the first time. Both are asked for by name in cp/README.md.
  const ledgerRows = (await call("GET", "/v1/admin/actions", { token: bossToken })).json?.rows ?? [];
  check(!JSON.stringify(ledgerRows).includes(GITHUB_TOKEN), "no row in the change record carries the repository token");
  check(ledgerRows.some((row) => String(row.action) === "feedback.github-token" && /characters, sha256/.test(String(row.detail))),
    "and the row that recorded it holds a length and a hash instead");

  // Every byte of the data directory. The token IS in the sqlite store on purpose, so this is not a
  // search for absence: it is a search for the token in a form anything else could read it out of.
  // What must not be true is that it reaches a response, a page or a log, which the checks above
  // cover; what is checked here is that the file it does live in is 0600.
  const modes = [];
  const walkModes = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkModes(full); continue; }
      modes.push([path.relative(dataDir, full), statSync(full).mode & 0o777]);
    }
  };
  walkModes(dataDir);
  const store = modes.filter(([name]) => name.startsWith("control-plane.sqlite"));
  check(store.length > 0, "the store is in the data directory", store.map(([name]) => name).join(", "));
  check(store.every(([, mode]) => mode === 0o600), "and it and its sidecars are 0600, which is what holding a secret costs",
    store.map(([name, mode]) => `${name} ${mode.toString(8)}`).join(", "));
}

// ---- out ------------------------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log("PASS  the super admin console holds: the flag, the door, the ledger, the attack rule, nine panels behind a rail on a page that never scrolls, a client added and a duplicate refused, provider health that can go back to green, a duplicate provider removed, a provider key and a repository token that go in through the screen and come back out nowhere, the two gates on every report, and a ceiling read off the box.");
} else {
  console.log(`FAIL  ${failures} check${failures === 1 ? "" : "s"} did not hold.`);
  if (childLog.length > 0) {
    console.log("\n--- the control plane said ---");
    console.log(childLog.join("").slice(-4000));
  }
}
cleanup();
process.exit(failures === 0 ? 0 : 1);
