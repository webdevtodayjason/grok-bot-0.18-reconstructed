// ui/relay-secrets.mjs -- KEYS-1. The relay's copy of the keys the product uses.
//
// Shaped on ui/push-edge.mjs's createCredentialReader, which has been in production since PUSH-1 and
// is the right shape for exactly this: one in-flight fetch, a hard timeout, an unref'd refresh, and
// a non-200 or a throw that degrades to the LAST GOOD COPY rather than to an exception. A
// control-plane outage must not take voice and mail down with it, and a thrown refresh on a shared
// timer would take its neighbours down in the same process. The two NUMBERS are shorter than the
// push reader's and the reason is on them below: this one is woken by a person holding a button.
//
// THREE RULES THAT ARE NOT PREFERENCES.
//
// 1. MEMORY ONLY. Nothing here is written beside voice.json or mail.json or anywhere else. The
//    control plane is the only durable home for these; a copy on a relay's disk is a second place to
//    rotate, a second place to leak, and a second answer to "which key is live".
//
// 2. {} WITH NO CONTROL PLANE. relayConfig() is called here rather than handed in, so a console with
//    no CP_URL or no CP_RELAY_TOKEN -- which is every single-box install, every gate on this Mac and
//    grok-bot-local-vm -- gets an empty answer immediately and falls straight through to the
//    workspace's own file. That is what keeps all six file-seeded legs of verify-voice green.
//
// 3. A 404 GETS ITS OWN SENTENCE, once per process, separate from the outage line. The product has
//    already been bitten by exactly this class: the relay calls POST /v1/relay/code/e2b-key, the live
//    control plane 404s it while its sibling answers 401, codeE2bKey() swallows the answer, and a
//    cloud coding task is refused as "no key" forever while two gap rows blame an unpasted key. A
//    door that is not there is a DEPLOY fact and reads nothing like a service that is down, so it
//    does not get to hide inside the outage line.
//
// PREFERENCE: the control plane first, the workspace's own file second, nothing third. There is NO
// migration code and there will not be: a relay-to-control-plane push of a file value would be a
// brand new write path for a secret and would undo write-only-from-the-console. Measured on the R750
// 2026-09-10, the operator's own /state/mail.json is the only key-bearing file on the machine, no
// voice.json exists anywhere, and no tenant has a mail.json. So the door starts empty, nobody's
// mail stops, and the operator pasting the sending key once at the admin console IS the migration.

import { relayConfig } from "./tenant-login.mjs";

const str = (value) => String(value ?? "").trim();

/** The names the control plane will answer with. Anything else in the body is ignored. */
export const SECRET_NAMES = Object.freeze(["keys.voice.xai", "keys.voice.openai", "keys.mail.send"]);

/** Which key dials for a workspace's chosen voice service. The twin of cp/secrets.mjs's own. */
export function voiceKeyName(vendorId) {
  const id = str(vendorId).toLowerCase();
  if (id === "xai") return "keys.voice.xai";
  if (id === "openai") return "keys.voice.openai";
  return "";
}

/**
 * The reader.
 *
 * `env` rather than two strings, because relayConfig is the ONE place in this tree that decides
 * whether there is a control plane behind this console, and a second copy of that decision is how
 * the two drift. A test hands it a plain object.
 */
export function createSecretsReader({
  env = process.env,
  fetchImpl = fetch,
  // SIXTY SECONDS AND SIX, and both are shorter than createCredentialReader's five minutes and ten.
  // The push reader is woken by a notification nobody is watching; this one is woken by a person
  // holding a button down. A rotation that takes five minutes to reach the relay is five minutes of
  // a dial refused on a key the operator already replaced, and a ten second timeout on the websocket
  // upgrade path is ten seconds of a lit Talk button with nothing said. Six seconds is longer than
  // the 194 ms relay-to-control-plane round trip MEASURED on the R750 2026-09-10 by a factor of
  // thirty, so it fires on an outage and never on a slow answer.
  refreshMs = 60_000,
  timeoutMs = 6_000,
  log = () => {},
} = {}) {
  const config = relayConfig(env);
  // The last good copy. `{}` is both the starting state and the honest answer for a console with no
  // control plane, so every caller below has exactly one shape to handle.
  let held = {};
  let inFlight = null;
  let everTried = false;
  let saidMissing = false;
  let timer = null;
  // WHETHER THE LAST READ GOT THROUGH, which is the difference between "the operator has pasted no
  // key" and "this relay cannot reach the control plane right now". They are the same empty object
  // and they are not the same sentence: the first is a thing the operator does, the second is a
  // thing that is broken. mail settles `key_unreachable` on the second and never on the first.
  let lastReadOk = false;

  async function fetchOnce() {
    try {
      const response = await fetchImpl(`${config.cpUrl}/v1/relay/keys`, {
        headers: { authorization: `Bearer ${config.relayToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) {
        // ONE DISTINCT SENTENCE, once. See rule 3 at the top: a missing door is a deploy fact and
        // must not read as an outage. Said once per process because a one minute timer would
        // otherwise write it into the log forever on a control plane that will never grow the route.
        //
        // AND IT COUNTS AS A READ THAT GOT THROUGH. A control plane too old to have this route is
        // answering, and the product's keys are on the files here, which is the correct working
        // arrangement for that deployment. Calling it unreachable would make every send on an older
        // control plane settle `key_unreachable` over a key that is sitting right there.
        lastReadOk = true;
        if (!saidMissing) {
          saidMissing = true;
          log("keys  this control plane does not have the keys door yet, so the product uses the keys on its own files");
        }
        return held;
      }
      if (response.status !== 200) {
        lastReadOk = false;
        log(`keys  the control plane would not hand over the keys the product uses (HTTP ${response.status}); keeping the last copy`);
        return held;
      }
      const body = await response.json();
      const next = {};
      for (const name of SECRET_NAMES) {
        const value = str(body?.keys?.[name]);
        // Present and non-empty, or absent. An empty string stored here would beat a working file.
        if (value.length > 0) next[name] = value;
      }
      held = next;
      lastReadOk = true;
    } catch (error) {
      lastReadOk = false;
      log(`keys  the keys the product uses could not be read (${str(error?.message)}); keeping the last copy`);
    }
    return held;
  }

  /** One in-flight fetch, shared. Two callers at boot must not be two requests. */
  function refresh() {
    if (config == null) return Promise.resolve(held);
    if (inFlight != null) return inFlight;
    everTried = true;
    inFlight = fetchOnce().finally(() => { inFlight = null; });
    return inFlight;
  }

  return {
    /** Is there a control plane to read from at all. False is the whole of "use the file". */
    get configured() { return config != null; },
    /**
     * Is this reader BLIND right now: there is a control plane, a read has been attempted, the last
     * one did not get through, and nothing is cached from a read that did.
     *
     * The one caller is mail's send refusal, which has to tell a person whether their operator has
     * not pasted a key yet or whether this relay cannot see the control plane at the moment. Both
     * conditions hand back the same empty string and only this tells them apart. False on a console
     * with no control plane, because there is nothing there to be unable to reach, and false once a
     * good read is cached, because a live copy is a live copy however the last refresh went.
     */
    get blind() { return config != null && everTried && !lastReadOk && Object.keys(held).length === 0; },
    /** The last good copy, synchronously. `{}` before the first answer and with no control plane. */
    current: () => held,
    refresh,
    /**
     * One key by name, ensuring at least one read has been attempted first.
     *
     * The dial and the send both go through this rather than through current(), because the first
     * press on a relay that has just started must not be refused for a key that is one HTTP request
     * away. Every press after that reads the cached copy with no network at all.
     */
    async value(name) {
      if (config == null) return "";
      if (!everTried) await refresh();
      return str(held[str(name)]);
    },
    start() {
      if (config == null) return () => {};
      void refresh();
      timer = setInterval(() => { void refresh(); }, refreshMs);
      timer.unref?.();
      return () => { if (timer != null) clearInterval(timer); timer = null; };
    },
  };
}
