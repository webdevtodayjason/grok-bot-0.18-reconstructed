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
//   page        headless Chrome signs in at /admin and all six panels render from the fixture
//   providers   the sixth panel, driven through a real browser: a key typed into the masked field
//               reaches no response body and no node of the DOM, a roll takes the pool from two to
//               three to two with no key on screen, a plan model with no screenshot route is
//               refused in a sentence a person reads, a remove with nothing typed is refused, and
//               each of those writes a ledger row with an actor and a time and no key in it
//   leak        no response body in the whole run carries the session secret, the admin token, the
//               relay token, any password, or either key planted through the providers panel
//
// Exit status: 0 every leg passed, 1 a leg failed, 2 nothing was measured (the control plane could
// not be started, or the browser leg could not resolve playwright).
//
//   node scripts/verify-admin.mjs
//   node scripts/verify-admin.mjs --no-browser     the API legs only
//
// Env: CP_GATE_PORT, CP_GATE_FAKE_PORT, CP_GATE_RELAY_PORT to pin ports instead of taking free
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
    "serving a built-in login-attempts fixture, then walks the super admin console: promote and",
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

const providersFixture = {
  configured: true,
  why: "",
  storeModelInDb: true,
  storeModelInDbWhy: "",
  measuredAt: nowIso(),
  providers: [
    {
      id: "zai", name: "Z.AI", kind: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4",
      reachable: true, reachableWhy: "", checkedAt: nowIso(),
      catalog: {
        source: "provider",
        models: ["glm-5.3", "glm-5.3-flash", "glm-5", "glm-4.7", "glm-4.6", "glm-4.6v"],
        readAt: nowIso(),
        why: "",
      },
      keys: [
        { name: "zai-1", label: "Z.AI subscription one", order: 1, mask: "sk-****4f2a", parked: false, usedBy: ["plan-zai", "plan-zai-vision"], spend: { month: 12.41, monthWhy: "", today: 0.62, todayWhy: "" }, lastError: "", lastErrorAt: null },
        { name: "zai-2", label: "Z.AI subscription two", order: 2, mask: "sk-****9c11", parked: false, usedBy: ["plan-zai", "plan-zai-vision"], spend: { month: 11.08, monthWhy: "", today: 0.55, todayWhy: "" }, lastError: "", lastErrorAt: null },
      ],
    },
    {
      id: "minimax", name: "MiniMax", kind: "openai", baseUrl: "https://api.minimax.io/v1",
      reachable: null, reachableWhy: "this provider has not been asked since the last restart", checkedAt: null,
      catalog: { source: "curated", models: ["MiniMax-M3", "MiniMax-M2"], readAt: nowIso(), why: "MiniMax does not publish a model list, so this is our own" },
      keys: [
        { name: "minimax-1", label: "MiniMax subscription", order: 1, mask: "sk-****77ab", parked: false, usedBy: ["plan-minimax"], spend: { month: null, monthWhy: "the proxy reported this key with no numbers on it", today: null, todayWhy: "the proxy reported this key with no numbers on it" }, lastError: "", lastErrorAt: null },
      ],
    },
  ],
  planModels: [
    {
      id: "pm-zai", alias: "plan-zai", provider: "zai", vendorModel: "openai/glm-5.3", keyName: "zai-1",
      customerName: "GLM-5.3", customerLabel: "GLM-5.3", customerVisible: true,
      visionFallback: "plan-zai-vision", contextWindow: 200_000, supportsVision: false,
      plans: ["included"], workspaces: 3, workspacesWhy: "", parked: false,
    },
    {
      id: "pm-zai-vision", alias: "plan-zai-vision", provider: "zai", vendorModel: "openai/glm-5.3-flash", keyName: "zai-1",
      customerName: "", customerLabel: "", customerVisible: false,
      visionFallback: "", contextWindow: 128_000, supportsVision: true,
      plans: ["included"], workspaces: 3, workspacesWhy: "", parked: false,
    },
    {
      id: "pm-minimax", alias: "plan-minimax", provider: "minimax", vendorModel: "openai/MiniMax-M3", keyName: "minimax-1",
      customerName: "MiniMax-M3", customerLabel: "MiniMax-M3", customerVisible: true,
      visionFallback: "plan-zai-vision", contextWindow: 200_000, supportsVision: false,
      plans: ["included"], workspaces: 0, workspacesWhy: "", parked: false,
    },
  ],
  defaults: { newWorkspaceModel: "plan-zai", why: "" },
  ledger: [],
};

// Every mutation appends the pool size AFTER it, per provider. A roll that never leaves a gap reads
// 2, 3, 2 in that order: the new key was in before the old one came out. A delete-then-add would
// read 2, 1, 2, and there is no way to tell those apart from the answer alone.
const poolHistory = { zai: [], minimax: [] };
const recordPool = (id) => {
  const provider = providersFixture.providers.find((one) => one.id === id);
  if (provider) (poolHistory[id] ??= []).push(provider.keys.length);
};

const fixtureLedger = (action, target, detail, outcome = "ok") => {
  providersFixture.ledger.unshift({
    at: nowIso(), actor: BOSS_EMAIL, via: "console", ip: "127.0.0.1", action, target, detail, outcome,
  });
};

// The bodies the fixture served, so the leak sweep covers them the same way it covers the control
// plane's. A fixture that leaked a key would otherwise be invisible to the leg that exists to
// notice exactly that.
const fixtureBodiesSeen = [];

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
    const id = String(body?.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    providersFixture.providers.push({
      id, name: String(body?.name ?? ""), kind: String(body?.kind ?? "openai"), baseUrl: String(body?.baseUrl ?? ""),
      reachable: null, reachableWhy: "this provider has not been asked yet", checkedAt: null,
      catalog: { source: "none", models: [], readAt: null, why: "nobody has read this provider's model list yet" },
      keys: [],
    });
    fixtureLedger("added a provider", id, `${body?.kind ?? "openai"} at ${body?.baseUrl ?? ""}`);
    return [200, { ok: true, message: `${body?.name} was added. Add a key to it before pointing a plan model at it.` }];
  }
  // /v1/admin/providers/:id/...
  if (at[0] === "providers" && at.length >= 2) {
    const provider = find(at[1]);
    if (provider == null) return [404, { message: "no provider by that name" }];
    if (method === "POST" && at[2] === "catalog" && at[3] === "refresh") {
      provider.catalog.readAt = nowIso();
      fixtureLedger("read a provider's model list", provider.id, `${provider.catalog.models.length} names, and names are all a model list carries`);
      return [200, { ok: true, message: `${provider.name} lists ${provider.catalog.models.length} models. That is names and nothing else: the context window and whether it takes a screenshot are yours to set.` }];
    }
    if (method === "POST" && at[2] === "keys" && at.length === 3) {
      const value = String(body?.key ?? "");
      if (value.length === 0) return [400, { message: "a key was not sent" }];
      recordPool(provider.id); // the size before, so the history reads as a sequence and not a result
      provider.keys.push({
        name: `${provider.id}-${provider.keys.length + 1}`,
        label: String(body?.label ?? "") || `${provider.name} key ${provider.keys.length + 1}`,
        order: provider.keys.length + 1,
        mask: maskOf(value),
        parked: false, usedBy: [], lastError: "", lastErrorAt: null,
        spend: { month: 0, monthWhy: "", today: 0, todayWhy: "" },
      });
      recordPool(provider.id);
      fixtureLedger("added a key", `${provider.id}/${provider.keys[provider.keys.length - 1].name}`, `${value.length} characters, ${shortHash(value)}`);
      return [200, { ok: true, message: `A key was added to ${provider.name} as ${provider.keys[provider.keys.length - 1].name} (${shortHash(value)}). The proxy uses it on the next request.` }];
    }
    if (method === "POST" && at[2] === "keys" && at.length >= 5) {
      const key = provider.keys.find((one) => one.name === decodeURIComponent(at[3]));
      if (key == null) return [404, { message: "no key by that name" }];
      if (at[4] === "roll") {
        const value = String(body?.key ?? "");
        if (value.length === 0) return [400, { message: "a key was not sent" }];
        // IN FIRST, THEN OUT. The pool history is what proves there was never a moment with fewer
        // keys than it started with: it reads two, three, two. A delete-then-add would read two,
        // one, two, and from the answer alone the two are indistinguishable.
        recordPool(provider.id);
        const replacement = { ...key, name: `${key.name}-new`, mask: maskOf(value), order: provider.keys.length + 1 };
        provider.keys.push(replacement);
        recordPool(provider.id);
        provider.keys = provider.keys.filter((one) => one.name !== key.name);
        replacement.name = key.name;
        replacement.order = key.order;
        provider.keys.sort((a, b) => a.order - b.order);
        recordPool(provider.id);
        fixtureLedger("rolled a key", `${provider.id}/${key.name}`, `${value.length} characters, ${shortHash(value)}, the old one came out after the new one answered`);
        return [200, { ok: true, message: `${key.label} was replaced (${shortHash(value)}). The new key went in beside the old one and the old one came out after it answered, so nothing failed in between.` }];
      }
      if (at[4] === "park") {
        key.parked = body?.parked === true;
        fixtureLedger(key.parked ? "parked a key" : "put a key back in use", `${provider.id}/${key.name}`, "");
        return [200, { ok: true, message: key.parked ? `${key.label} is parked and takes no more requests.` : `${key.label} is back in use from the next request.` }];
      }
      if (at[4] === "remove") {
        if (String(body?.confirm ?? "") !== provider.name) {
          fixtureLedger("tried to remove a key", `${provider.id}/${key.name}`, "the confirmation did not match", "refused");
          return [400, { message: `Type ${provider.name} to confirm. Nothing was removed.` }];
        }
        provider.keys = provider.keys.filter((one) => one.name !== key.name);
        recordPool(provider.id);
        fixtureLedger("removed a key", `${provider.id}/${key.name}`, "the value is gone and cannot be read back");
        return [200, { ok: true, message: `${key.label} is gone. The proxy stops using it on the next request.` }];
      }
    }
  }
  if (method === "POST" && pathname === "/v1/admin/plan-models") {
    const alias = String(body?.alias ?? "");
    if (alias.length === 0) return [400, { message: "a plan model needs a routing name" }];
    if (String(body?.visionFallback ?? "").length === 0 && body?.supportsVision !== true) {
      return [400, { message: "a plan model needs somewhere for a screenshot to go" }];
    }
    const existing = providersFixture.planModels.find((one) => one.alias === alias);
    const row = {
      id: existing?.id ?? `pm-${alias}`,
      alias,
      provider: String(body?.provider ?? ""),
      vendorModel: String(body?.vendorModel ?? ""),
      keyName: String(body?.keyName ?? ""),
      customerName: String(body?.customerName ?? ""),
      customerLabel: String(body?.customerLabel ?? ""),
      customerVisible: body?.customerVisible !== false,
      visionFallback: String(body?.visionFallback ?? ""),
      contextWindow: body?.contextWindow ?? null,
      supportsVision: body?.supportsVision === true,
      plans: Array.isArray(body?.plans) ? body.plans : [],
      workspaces: existing?.workspaces ?? 0,
      workspacesWhy: "",
      parked: false,
    };
    if (existing) Object.assign(existing, row);
    else providersFixture.planModels.push(row);
    fixtureLedger(existing ? "changed a plan model" : "added a plan model", alias, `${row.vendorModel} on ${row.keyName}`);
    return [200, { ok: true, message: `${row.customerName || alias} is saved. The proxy uses it on the next request and a workspace picks it up on its next turn.` }];
  }
  if (method === "POST" && at[0] === "plan-models" && at[2] === "grant-all") {
    const alias = decodeURIComponent(at[1]);
    fixtureLedger("gave every workspace access to a model", alias, "");
    return [200, { ok: true, message: `Every workspace can reach ${alias} now. It shows up in their own list within a minute.` }];
  }
  if (method === "POST" && at[0] === "plan-models" && at[2] === "push-label") {
    const alias = decodeURIComponent(at[1]);
    const row = providersFixture.planModels.find((one) => one.alias === alias);
    fixtureLedger("pushed a model label to the workspaces running it", alias, String(row?.customerLabel ?? ""));
    return [200, { ok: true, message: `${row?.workspaces ?? 0} workspaces will call it ${row?.customerLabel ?? ""} from their next turn.` }];
  }
  if (method === "POST" && pathname === "/v1/admin/defaults") {
    providersFixture.defaults.newWorkspaceModel = String(body?.newWorkspaceModel ?? "");
    fixtureLedger("changed what a new workspace starts on", providersFixture.defaults.newWorkspaceModel, "");
    return [200, { ok: true, message: `A workspace made from now on starts on ${providersFixture.defaults.newWorkspaceModel}.` }];
  }
  if (method === "POST" && at[0] === "clients" && at[2] === "model") {
    const slug = decodeURIComponent(at[1]);
    const alias = String(body?.model ?? "");
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
  return send(404, { error: "not_found" });
}

// ---- the run -----------------------------------------------------------------------------------

const bodiesSeen = [];
let child = null;
let fakeCoolify = null;
let fakeRelay = null;
let dataDir = null;
let tenantRoot = null;
let ledgerDir = null;
let browser = null;
const childLog = [];

const cleanup = () => {
  if (browser) { try { void browser.close(); } catch { /* already gone */ } }
  if (child && child.exitCode == null) { try { child.kill("SIGTERM"); } catch { /* already gone */ } }
  for (const server of [fakeCoolify, fakeRelay]) { if (server) { try { server.close(); } catch { /* already closed */ } } }
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
const BASE = `http://127.0.0.1:${CP_PORT}`;

dataDir = mkdtempSync(path.join(tmpdir(), "admin-gate-data-"));
tenantRoot = mkdtempSync(path.join(tmpdir(), "admin-gate-tenants-"));
ledgerDir = mkdtempSync(path.join(tmpdir(), "admin-gate-ledger-"));

fakeCoolify = http.createServer(fakeCoolifyHandler);
await new Promise((resolve, reject) => { fakeCoolify.once("error", reject); fakeCoolify.listen(FAKE_PORT, "127.0.0.1", resolve); });
fakeRelay = http.createServer(fakeRelayHandler);
await new Promise((resolve, reject) => { fakeRelay.once("error", reject); fakeRelay.listen(RELAY_PORT, "127.0.0.1", resolve); });

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
    check(Array.isArray(body.ledger), "and the ledger the panel draws under What changed");
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

  browser = await playwright.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });

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
    if (request.method() === "GET" && pathname === "/v1/admin/clients" && clientModelInjection != null) {
      const real = await route.fetch();
      const answer = await real.json().catch(() => null);
      if (answer?.clients?.[0]) answer.clients[0].model = clientModelInjection;
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

  const panels = ["panel-signins", "panel-clients", "panel-boxes", "panel-system", "panel-spend", "panel-providers"];
  for (const id of panels) {
    check(await page.locator(`#${id}`).isVisible(), `the ${id.replace("panel-", "")} panel renders`);
  }
  check((await page.locator(".panel").count()) === 6, "six panels and no more", String(await page.locator(".panel").count()));
  check(live?.panels === 6, "and the readiness flag says six", String(live?.panels));

  const attackChips = await page.locator("#addresses .chip.attack").count();
  check(attackChips === 1, "one Attack chip, on the address that earned it", String(attackChips));
  const attackRow = await page.locator("#addresses tbody tr", { hasText: ATTACK_IP }).first().textContent();
  check(String(attackRow).includes("6 different passwords"), "and its row says six different passwords", String(attackRow).replace(/\s+/g, " ").slice(0, 90));
  const sameRow = await page.locator("#addresses tbody tr", { hasText: SAME_IP }).first().textContent();
  check(String(sameRow).includes("the same password 4 times"), "the other address's row says the same password four times", String(sameRow).replace(/\s+/g, " ").slice(0, 90));

  const sprayChips = await page.locator("#accounts .chip.attack").count();
  check(sprayChips === SPRAY_EMAILS.length, "a Spray chip on every account the one password was tried on", String(sprayChips));
  const sprayRow = await page.locator("#accounts tbody tr", { hasText: SPRAY_EMAILS[0] }).first().textContent();
  check(String(sprayRow).includes("the same password 1 time"), "and that row says one password, once, which is why nothing else caught it",
    String(sprayRow).replace(/\s+/g, " ").slice(0, 90));

  const clientCards = await page.locator(".client").count();
  check(clientCards === 1, "the clients panel drew the workspace", String(clientCards));
  const boxRows = await page.locator("#boxes tbody tr").count();
  check(boxRows === 1, "the box health panel drew a row", String(boxRows));
  const cards = await page.locator("#system .card").count();
  check(cards >= 8, "the system panel drew its cards", String(cards));

  const systemText = await page.locator("#system").textContent();
  check(String(systemText).includes("not measured"), "and says 'not measured' for what it cannot read, rather than a zero");
  // The panel was renamed panel-payments -> panel-spend by PROXY-1 and its placeholder was
  // rewritten, and this leg still waited on the old id, so it threw an uncaught TimeoutError that
  // killed the process here: everything below this line, the leak sweep and the em dash check
  // included, had not run since. The wait is bounded now as well as correct, so a future rename is
  // a FAIL with the reason on it rather than a dead gate.
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
  const providerCards = await page.locator("#providers .provider").count();
  check(providerCards === 2, "the providers panel drew both providers", String(providerCards));
  const modelCards = await page.locator("#planModels .planModel").count();
  check(modelCards === 3, "and every plan model", String(modelCards));

  // THE ALIAS IS NOT THE NAME. A plan model that has a customer name shows that name at the top and
  // the routing alias only on its own captioned line underneath. This is the check that stops the
  // panel doing to the operator what the Settings card was doing to the customer.
  const named = await page.locator('#planModels .planModel[data-alias="plan-zai"] .head').textContent();
  check(!String(named).includes("plan-zai"), "a plan model with a label leads with the label and not the routing name",
    String(named).replace(/\s+/g, " ").slice(0, 70));
  const aliasLines = await page.locator("#planModels .aliasLine").count();
  check(aliasLines === 3, "and each one says what the routing calls it, captioned as that", String(aliasLines));
  const aliasLine = await page.locator('#planModels .planModel[data-alias="plan-zai"] .aliasLine').textContent();
  check(String(aliasLine).includes("what the routing calls it") && String(aliasLine).includes("plan-zai"),
    "on a line an operator can read without guessing what it is", String(aliasLine).replace(/\s+/g, " ").slice(0, 60));

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
  check(await page.locator('.provider[data-provider="zai"] tr[data-key="zai-1"] + tr .keyForm:not(.danger)').isVisible(),
    "and Roll opens the one under that key");
  await page.locator('.provider[data-provider="zai"] tr[data-key="zai-1"] .rollKey').click();
  check(!(await page.locator('.provider[data-provider="zai"] tr[data-key="zai-1"] + tr .keyForm:not(.danger)').isVisible()),
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
  await zai.locator('tr[data-key="zai-1"] + tr .keyForm:not(.danger) .keyValue').fill(PLANTED_KEY_ROLL);
  await zai.locator('tr[data-key="zai-1"] + tr .keyForm:not(.danger) button[type=submit]').click();
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("was replaced") === true, null, { timeout: 15_000 })
    .catch(() => {});
  const rollBanner = await page.locator("#banner").textContent();
  check(String(rollBanner).includes("was replaced"), "a key rolls from the panel", String(rollBanner).replace(/\s+/g, " ").slice(0, 80));
  check(!String(rollBanner).includes(PLANTED_KEY_ROLL), "and that banner carries no fragment of the new key either");
  check(JSON.stringify(poolHistory.zai) === "[2,3,2]", "the pool went two, three, two, so the new key was in before the old one came out",
    JSON.stringify(poolHistory.zai));
  const zaiKeys = await page.locator('.provider[data-provider="zai"] tbody tr[data-key]').count();
  check(zaiKeys === 2, "and the pool is the size it started at", String(zaiKeys));

  // A PLAN MODEL WITH NOWHERE FOR A SCREENSHOT TO GO IS REFUSED, in a sentence a person reads.
  // This is PROXY-10 as a form rule: every conversation on this product carries screenshots.
  await page.locator('#planModels .planModel[data-alias="plan-minimax"] .actions button', { hasText: "Edit" }).first().click();
  await page.selectOption("#pmVision", "");
  await page.uncheck("#pmSelfVision");
  const modelWritesBefore = providersFixture.ledger.filter((row) => String(row.action).includes("plan model")).length;
  await page.click("#planModelSave");
  await page.waitForFunction(() => document.getElementById("banner")?.textContent?.includes("screenshot") === true, null, { timeout: 10_000 })
    .catch(() => {});
  const visionBanner = await page.locator("#banner").textContent();
  check(String(visionBanner).startsWith("Pick where a screenshot falls back to"),
    "a plan model with no screenshot route is refused in words a person reads", String(visionBanner).replace(/\s+/g, " ").slice(0, 90));
  check(providersFixture.ledger.filter((row) => String(row.action).includes("plan model")).length === modelWritesBefore,
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
  check(providersFixture.ledger.some((row) => row.action === "changed one workspace's model" && row.detail === "plan-minimax"),
    "with a row under What changed naming the workspace and the model");
  clientModelInjection = null;

  // The name of the thing under all this appears once, for the operator, and nowhere else.
  const wholePage = await page.evaluate(() => document.body.innerText);
  check((wholePage.match(/LiteLLM/g) ?? []).length <= 1, "the proxy's own name appears at most once on this page, in a footnote",
    String((wholePage.match(/LiteLLM/g) ?? []).length));

  // A picture of the panel, when somebody asked for one. A gate that says a page renders and a
  // person looking at that page are not the same evidence, and the second one is what a report
  // carries. Off unless CP_GATE_SHOT_DIR is set, so the default run writes nothing anywhere.
  if (process.env.CP_GATE_SHOT_DIR) {
    const shot = path.join(process.env.CP_GATE_SHOT_DIR, "providers-panel.png");
    await page.locator("#panel-providers").screenshot({ path: shot }).catch(() => {});
    const whole = path.join(process.env.CP_GATE_SHOT_DIR, "admin-console.png");
    await page.screenshot({ path: whole, fullPage: true }).catch(() => {});
    console.log(`  shot   ${shot}`);
    console.log(`  shot   ${whole}`);
  }

  // No em dashes anywhere on the screen. Jason's rule, and the panel is copy a business owner reads.
  const visible = await page.evaluate(() => document.body.innerText);
  check(!visible.includes("—"), "no em dash on the whole screen");

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
}

// ---- out ------------------------------------------------------------------------------------------
console.log("");
if (failures === 0) {
  console.log("PASS  the super admin console holds: the flag, the door, the ledger, the attack rule, the six panels, and a provider key that goes in through the screen and comes back out nowhere.");
} else {
  console.log(`FAIL  ${failures} check${failures === 1 ? "" : "s"} did not hold.`);
  if (childLog.length > 0) {
    console.log("\n--- the control plane said ---");
    console.log(childLog.join("").slice(-4000));
  }
}
cleanup();
process.exit(failures === 0 ? 0 : 1);
