#!/usr/bin/env node
// verify-proxy.mjs -- the gate for PROXY-1, the one place the operator's subscriptions live.
//
// Five legs, each in its own file under scripts/lib/proxy-legs/, so five people can own one each
// without touching this runner or each other:
//
//   service    the proxy itself, before any tenant exists: readiness, the door, a model, the
//              two-key pool draining to its second subscription, a config change read from the
//              directory bind, and a leak check over every response body in the run
//   providers  the proxy's configuration as a DATABASE rather than a text file (PROVIDERS-1): a
//              provider added, a second and third key on one plan model, a key rolled with traffic
//              flowing and zero failures, a key removed, an alias repointed at a new vendor model,
//              a catalog read without the caller holding the vendor key, spend per deployment, and
//              a tenant key refused the admin surface by its own allowed_routes
//   tenant     the control plane's side: minting one virtual key per tenant, writing it where the
//              box reads its provider configuration, and revoking it
//   box        what a box holds afterwards, proved by name, length and hash prefix, and what it no
//              longer holds
//   tinyfish   the passthrough, and the connector preset and web-tools route still working through it
//
//   node scripts/verify-proxy.mjs                    every leg, against the stub
//   node scripts/verify-proxy.mjs --leg service      one leg
//   node scripts/verify-proxy.mjs --real --url http://titanbot-proxy:4000 --master-key "$K"
//
// TITANBOT_PROXY_UPSTREAM_HOST is read by the providers leg on a --real run only. That leg creates
// deployments of its own and has to give the proxy somewhere real to send them, so it stands up
// stand-in subscriptions on THIS machine and needs the name the PROXY can reach this machine by:
// host.docker.internal from a container on Docker Desktop (the default), and on the R750 the name
// of whatever container the gate is running in. Everything it makes is deleted again at the end.
//
// WHY A STUB IS THE DEFAULT. The real image is a gigabyte, and a gate that pulls it does not fit in
// the 300 seconds every gate on this project is held to. A gate that does not fit is a gate that
// gets skipped, which is worse than a stub: this one proves OUR code, in seconds, on every commit.
// --real is the opt-in path that runs the identical legs against the pulled image, and the summary
// says which of the two ran, every time, so a stub run can never be mistaken for a real one.
//
// EXIT CODES. 0 every leg passed. 1 something failed. 2 the arguments are wrong. An inconclusive
// leg does not fail the run, and it is counted and printed on the summary line, so a run that
// proved less than usual cannot look like a run that proved everything.
import { createReport, leakCheck } from "./lib/proxy-legs/harness.mjs";

const LEGS = ["service", "providers", "tenant", "box", "tinyfish"];

const flag = (name) => {
  const inline = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (inline != null) return inline.slice(name.length + 3);
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? null : process.argv[at + 1];
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write([
    "verify-proxy.mjs -- the PROXY-1 gate.",
    "",
    "  --leg <name>       one of: " + LEGS.join(", ") + ", or all (the default)",
    "  --real             run the legs against a real proxy instead of the stub",
    "  --url <base>       where that proxy is, e.g. http://127.0.0.1:4000",
    "  --master-key <k>   its master key. Never printed, never written down.",
    "",
    "Exit 0 everything passed, 1 something failed, 2 the arguments are wrong.",
    "",
  ].join("\n"));
  process.exit(0);
}

const legName = (flag("leg") ?? "all").toLowerCase();
if (legName !== "all" && !LEGS.includes(legName)) {
  process.stderr.write(`\nFAILED: --leg ${legName} is not one of ${LEGS.join(", ")} or all\n`);
  process.exit(2);
}
const real = process.argv.includes("--real");
const baseUrl = (flag("url") ?? process.env.TITANBOT_PROXY_URL ?? "").replace(/\/+$/, "");
const masterKey = flag("master-key") ?? process.env.TITANBOT_PROXY_MASTER_KEY ?? "";
if (real && (!baseUrl || !masterKey)) {
  process.stderr.write("\nFAILED: --real needs --url and --master-key (or TITANBOT_PROXY_URL and TITANBOT_PROXY_MASTER_KEY)\n");
  process.exit(2);
}

const wanted = legName === "all" ? LEGS : [legName];
const report = createReport();

console.log(`verify-proxy: ${wanted.join(", ")}  against ${real ? `the REAL proxy at ${baseUrl}` : "the stub"}`);

let missing = 0;
for (const name of wanted) {
  let leg;
  try {
    // Each leg is imported only when it is asked for, so a leg somebody has not written yet is a
    // named INCONCLUSIVE rather than an import error that takes the whole gate down with it. That
    // matters while four people are landing four files against one runner.
    ({ run: leg } = await import(`./lib/proxy-legs/${name}.mjs`));
  } catch (error) {
    if (String(error?.code) === "ERR_MODULE_NOT_FOUND") {
      report.step(name);
      report.unresolved(`the ${name} leg`, `scripts/lib/proxy-legs/${name}.mjs is not in this tree yet`);
      missing += 1;
      continue;
    }
    throw error;
  }
  if (typeof leg !== "function") {
    report.step(name);
    report.unresolved(`the ${name} leg`, `scripts/lib/proxy-legs/${name}.mjs does not export a run() function`);
    missing += 1;
    continue;
  }
  await leg({ report, real, baseUrl, masterKey });
}

// ---- the leak check, over the whole run ------------------------------------------------------------
// Not a leg anybody has to remember to write. The harness keeps every response body it fetched and
// every value a leg registered as a secret, and this is where the two meet. The wave exists because
// one operator key was copied into three customers' sandboxes; a proxy that hands the same key back
// inside an error message would be the same failure with more steps.
report.step("no key in any answer");
const leak = leakCheck();
if (leak.secrets === 0) {
  report.unresolved("no response body carries a provider key",
    "no leg registered a secret to look for, so there was nothing to find");
} else {
  report.check(leak.found.length === 0,
    `no response body carries a provider key (${leak.bodies} bodies, ${leak.secrets} keys watched for)`,
    leak.found.map((one) => `${one.name} in ${one.where}`).join("; ") || "clean");
}

const summary = `\n${report.failures === 0 ? "PASS" : "FAIL"}  ${report.passes} passed, ${report.failures} failed, `
  + `${report.inconclusive} inconclusive${missing > 0 ? ` (${missing} leg(s) not in this tree yet)` : ""}`
  + `  --  ${real ? `measured against the real proxy at ${baseUrl}` : "against the stub, NOT a real proxy"}`;
console.log(summary);
process.exit(report.failures === 0 ? 0 : 1);
