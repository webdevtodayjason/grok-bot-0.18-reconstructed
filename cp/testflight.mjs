// cp/testflight.mjs -- TestFlight feedback brought into the control plane.
//
// Apple is polled once an hour. Its submission ids are the database keys, so reading the same page
// twice stores and announces nothing twice. The private key is a 0600 file rather than a setting:
// listSettings is an operator-facing API, while the key must never be in any API answer.

import { sign as signBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { TESTFLIGHT_FEEDBACK_STATES } from "./store.mjs";
import { boxContainerFor, readGatewayTokenFor } from "./provision.mjs";

export const TESTFLIGHT_KEY_ID_SETTING = "testflight.keyId";
export const TESTFLIGHT_ISSUER_ID_SETTING = "testflight.issuerId";
export const FEEDBACK_NOTIFY_SETTING = "feedback.notify";
export const TESTFLIGHT_BUNDLE_ID = "bot.titanium.app";
export const TESTFLIGHT_POLL_INTERVAL_MS = 60 * 60 * 1000;
export const APPLE_BASE_URL = "https://api.appstoreconnect.apple.com";

const b64url = (input) => Buffer.from(input).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Mint an ES256 App Store Connect JWT using Node's raw IEEE-P1363 signature. */
export function mintToken({ keyId, issuerId, privateKeyPem, lifetimeSeconds = 600, now = Date.now() }) {
  const at = Math.floor(Number(now) / 1000);
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    iss: issuerId,
    iat: at,
    exp: at + Math.min(Number(lifetimeSeconds) || 600, 20 * 60),
    aud: "appstoreconnect-v1",
  }));
  const signature = signBytes("sha256", Buffer.from(`${header}.${payload}`), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${payload}.${b64url(signature)}`;
}

export const testflightKeyFile = (config = {}) => path.join(String(config.dataDir ?? "."), "testflight.p8");

/** Read the operator-placed key only when no group or other permission bit is present. */
export function readPrivateKey(file) {
  const mode = statSync(file).mode & 0o777;
  if (mode !== 0o600) throw new Error(`${file} must be mode 0600 and is ${mode.toString(8)}`);
  const pem = readFileSync(file, "utf8");
  if (!pem.includes("BEGIN PRIVATE KEY")) throw new Error(`${file} does not look like an App Store Connect .p8 key`);
  return pem;
}

const appleReason = (answer) => {
  const first = answer?.body?.errors?.[0];
  if (first == null) return `HTTP ${answer?.status}`;
  const detail = String(first.detail ?? "").trim();
  return `${String(first.title ?? "Apple refused the request")}${detail ? `: ${detail}` : ""}${first.code ? ` (${first.code})` : ""}`;
};

const testerName = (row) => {
  if (row == null) return "unknown tester";
  const name = `${String(row.firstName ?? "")} ${String(row.lastName ?? "")}`.trim();
  return name || String(row.email ?? "unknown tester");
};

export function rowsFromApple(answer, kind) {
  const included = new Map((answer?.included ?? []).map((row) => [`${row.type}:${row.id}`, row]));
  return (answer?.data ?? []).map((row) => {
    const attributes = row?.attributes ?? {};
    const buildId = row?.relationships?.build?.data?.id;
    const testerId = row?.relationships?.tester?.data?.id;
    return {
      id: String(row?.id ?? ""),
      receivedAt: Date.parse(String(attributes.createdDate ?? "")) || Date.now(),
      build: String(included.get(`builds:${buildId}`)?.attributes?.version ?? ""),
      device: String(attributes.deviceModel ?? ""),
      os: String(attributes.osVersion ?? ""),
      tester: testerName(included.get(`betaTesters:${testerId}`)?.attributes),
      comment: String(attributes.comment ?? ""),
      kind,
      state: "new",
    };
  }).filter((row) => row.id.length > 0);
}

const boxTimeoutMs = 10_000;

/** The shared announcement path for both in-app and TestFlight feedback. */
export function createFeedbackNotifier({ store, config = {}, probeImpl = globalThis.fetch } = {}) {
  const boxBase = (container) => {
    const override = String(config?.boxUrlOverride ?? "").trim().replace(/\/+$/, "");
    return override || `http://${container}:1340`;
  };
  const callBox = async (slug, command, args) => {
    const tenant = store.getTenant(slug);
    if (tenant == null) return { ok: false, why: `there is no workspace called ${slug}` };
    const container = boxContainerFor(tenant);
    if (!container) return { ok: false, why: `${slug} has no box container` };
    const token = readGatewayTokenFor(store, slug, config) ?? "";
    if (!token) return { ok: false, why: `${slug}'s gateway token could not be read` };
    try {
      const response = await probeImpl(`${boxBase(container)}/api/${command}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(args ?? {}),
        signal: AbortSignal.timeout(boxTimeoutMs),
      });
      const text = await response.text();
      if (response.status !== 200) return { ok: false, why: `${command} answered HTTP ${response.status}` };
      try { return { ok: true, body: text ? JSON.parse(text) : {} }; }
      catch { return { ok: false, why: `${command} answered something that is not json` }; }
    } catch (error) {
      return { ok: false, why: `${command} did not answer (${String(error?.message ?? error)})` };
    }
  };

  return async function notifyFeedback({ source = "in-app", id = "", tenant = "", title = "", tester = "", comment = "", kind = "feedback" } = {}) {
    if (String(store.getSetting(FEEDBACK_NOTIFY_SETTING, "1")) === "0") {
      return { ok: false, why: `${FEEDBACK_NOTIFY_SETTING} is off, so nothing was announced` };
    }
    const admin = (store.listAccounts() ?? []).find((row) => row.superAdmin === true
      && row.disabled !== true && String(row.tenant ?? "") && store.getTenant(String(row.tenant)) != null);
    if (admin == null) return { ok: false, why: "no enabled super admin has a workspace, so there is nobody to tell" };
    const slug = String(admin.tenant);
    const roster = await callBox(slug, "listAgents", {});
    if (!roster.ok) return roster;
    const rows = Array.isArray(roster.body) ? roster.body : (Array.isArray(roster.body?.agents) ? roster.body.agents : []);
    const people = rows.filter((row) => row?.isGroup !== true && String(row?.id ?? ""));
    const titan = people.find((row) => String(row?.name ?? "").trim().toLowerCase() === "titan");
    if (titan == null) return { ok: false, why: `${slug} has no bot called Titan to tell` };
    const summary = source === "testflight"
      ? `New TestFlight ${kind} feedback from ${tester || "an unknown tester"}: ${String(comment || "no comment").replace(/[\r\n\t]+/g, " ").slice(0, 300)}`
      : `New in-app feedback from ${tenant || "an unknown workspace"}: ${String(title || "no title").replace(/[\r\n\t]+/g, " ").slice(0, 300)}`;
    const sent = await callBox(slug, "sendPrompt", {
      agentId: String(titan.id),
      prompt: summary,
      clientNonce: `feedback:${source}:${id}`,
    });
    return sent.ok ? { ok: true, why: "", detail: `Titan in ${slug} was told` } : sent;
  };
}

export function createTestFlight({
  store,
  config = {},
  now = () => Date.now(),
  fetchImpl = globalThis.fetch,
  baseUrl = process.env.ASC_BASE_URL ?? APPLE_BASE_URL,
  keyFile = null,
  notify = null,
  log = () => {},
} = {}) {
  const file = keyFile ?? testflightKeyFile(config);
  const announce = notify ?? createFeedbackNotifier({ store, config, probeImpl: fetchImpl });
  const credentials = () => ({
    keyId: String(store.getSetting(TESTFLIGHT_KEY_ID_SETTING, "") ?? "").trim(),
    issuerId: String(store.getSetting(TESTFLIGHT_ISSUER_ID_SETTING, "") ?? "").trim(),
  });

  const configured = () => {
    const held = credentials();
    if (!held.keyId) return { ok: false, why: `no ${TESTFLIGHT_KEY_ID_SETTING} is set`, keyFile: file };
    if (!held.issuerId) return { ok: false, why: `no ${TESTFLIGHT_ISSUER_ID_SETTING} is set`, keyFile: file };
    try { readPrivateKey(file); }
    catch (error) { return { ok: false, why: String(error?.message ?? error), keyFile: file }; }
    return { ok: true, why: "", keyFile: file };
  };

  const call = async (token, pathname) => {
    try {
      const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, "")}${pathname}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, body };
    } catch (error) {
      return { status: 0, body: null, why: String(error?.message ?? error) };
    }
  };

  async function poll() {
    const door = configured();
    if (!door.ok) return { ok: false, why: door.why, stored: 0, notified: 0 };
    const held = credentials();
    let token;
    try { token = mintToken({ ...held, privateKeyPem: readPrivateKey(file), now: now() }); }
    catch (error) { return { ok: false, why: String(error?.message ?? error), stored: 0, notified: 0 }; }
    const apps = await call(token, `/v1/apps?filter[bundleId]=${encodeURIComponent(TESTFLIGHT_BUNDLE_ID)}`);
    if (apps.status !== 200) return { ok: false, why: `apps: ${apps.why ?? appleReason(apps)}`, stored: 0, notified: 0 };
    const appId = String(apps.body?.data?.[0]?.id ?? "");
    if (!appId) return { ok: false, why: `no app with bundle id ${TESTFLIGHT_BUNDLE_ID} is on this team`, stored: 0, notified: 0 };

    let stored = 0;
    let notified = 0;
    const errors = [];
    for (const [endpoint, kind] of [["betaFeedbackScreenshotSubmissions", "screenshot"], ["betaFeedbackCrashSubmissions", "crash"]]) {
      const answer = await call(token, `/v1/apps/${encodeURIComponent(appId)}/${endpoint}?limit=200&include=build,tester&sort=-createdDate`);
      if (answer.status !== 200) { errors.push(`${endpoint}: ${answer.why ?? appleReason(answer)}`); continue; }
      for (const row of rowsFromApple(answer.body, kind)) {
        const result = store.recordTestflightFeedback(row);
        if (!result.stored) continue;
        stored += 1;
        const told = await announce({ source: "testflight", ...result.row });
        if (told.ok) notified += 1;
        else log(`testflight feedback ${row.id} was stored; nobody was told: ${told.why}`);
      }
    }
    return { ok: errors.length === 0, why: errors.join("; "), stored, notified };
  }

  const panel = ({ state = "", sinceMs = 0, limit = 200 } = {}) => ({
    rows: store.listTestflightFeedback({ state, sinceMs, limit }).map((row) => ({ ...row, receivedAt: new Date(row.receivedAt).toISOString() })),
    total: store.countTestflightFeedback(),
    counts: { new: store.countNewTestflightFeedback(), seen: store.countTestflightFeedback() - store.countNewTestflightFeedback() },
    states: TESTFLIGHT_FEEDBACK_STATES,
    configured: configured(),
    bundleId: TESTFLIGHT_BUNDLE_ID,
    measuredAt: new Date(now()).toISOString(),
  });

  return {
    poll,
    panel,
    configured,
    markSeen(id) { return store.setTestflightFeedbackState(id, "seen"); },
  };
}

/** Run once now and every hour after that. The timer never keeps shutdown open. */
export function startTestFlightTimer({ testflight, intervalMs = TESTFLIGHT_POLL_INTERVAL_MS, log = () => {} } = {}) {
  const run = async (cause) => {
    try {
      const answer = await testflight.poll();
      log(answer.ok
        ? `testflight feedback: ${answer.stored} new row(s), ${answer.notified} announced (${cause})`
        : `testflight feedback: not checked, ${answer.why} (${cause})`);
      return answer;
    } catch (error) {
      const answer = { ok: false, why: String(error?.message ?? error), stored: 0, notified: 0 };
      log(`testflight feedback: not checked, ${answer.why} (${cause})`);
      return answer;
    }
  };
  void run("boot");
  const timer = setInterval(() => { void run("timer"); }, intervalMs);
  timer.unref?.();
  return { timer, run };
}
