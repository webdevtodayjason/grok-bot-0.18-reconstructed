// ui/docker-edge.mjs -- whether this relay has docker, and what it says when it does not.
//
// TENANT-2. A customer's instance is rendered without /var/run/docker.sock, because that socket is
// root on the host: anything that can write to it can start a container as root, mount any path on
// the machine and read every other tenant's data. So a tenant relay has no docker at all, and the
// four console features that reach the box through `docker exec` have nothing to reach it with.
//
// The failure that mode used to produce was worse than an error. dockerOut swallows ENOENT and
// resolves null, so the model picker answered 200 with every field null, the connectors editor
// answered 503 "the box could not be read" on every load, and the desktop pane painted an empty
// grey rectangle. All three read to an operator as "this console is broken", which is a support
// ticket, not a feature that is honestly absent.
//
// So: one probe, asked once, remembered, and a short table of plain sentences a business owner can
// read. A route that needs docker answers 409 with the sentence that belongs to it rather than
// pretending it measured something.
//
// The probe asks for the SERVER version, not the client's. `docker version --format
// {{.Client.Version}}` succeeds on a machine that has the binary and no daemon, which is exactly
// the shape a half-configured host has, and "the CLI is installed" is not the question any caller
// here is asking. With no socket the command exits non-zero and prints nothing on stdout.

// The sentences. They are the copy an owner reads, so: no jargon, no em dashes, and each one says
// what is missing and that it is this instance rather than a fault.
export const NOT_AVAILABLE = {
  // The exact wording of the TENANT-2 contract for POST /endpoints/use.
  endpointsUse: "This instance cannot switch models from the console yet.",
  desktop: "The desktop view is not available on this instance yet.",
  connectors: "This instance cannot edit connectors from the console yet.",
  // GET /endpoints and GET /model still answer, with the catalog and with nulls; this is the line
  // that stops a null from reading as "no model is configured".
  liveModel: "This instance does not report which model is answering yet.",
  // The host bundle really does need docker: the archive is composed inside the box from the box's
  // own /home/box/sand-host, so there is no way to build it from the relay's side of the wall. The
  // version file is served from the mounted runtime directory either way, so a host that asks gets
  // an honest refusal for the tarball instead of a truncated download.
  hostBundle: "This instance cannot build a host update of its own.",
  // CODE-1. A coding task runs in a container this relay makes, so without the socket there is no
  // local computer to run one on. The answer that carries this sentence also offers a cloud sandbox,
  // which is the only road on a customer's own instance: see CODE-5 and docs/CODE.md section 9.
  codeTask: "This instance cannot run a coding task on its own computer yet.",
  // TENANT-5. A subscription is a login already sitting in the OPERATOR's own home directory (the
  // Codex and Claude ones), so there is nothing for a customer's console to scan and nothing of
  // theirs to adopt. Said plainly rather than answered with an empty success.
  subscriptions: "Provider subscriptions are set up by the operator, not from this console.",
};

// The body every refusal sends. One shape, so the console can tell a refusal apart from a failure
// without reading prose: `error` is the machine word, `detail` is the sentence to show.
export const notAvailable = (detail) => ({ error: "not_available", detail });

// dockerAvailable(): probes once, remembers, and every later caller gets the same answer.
//
// The memo is the promise, not the value, so twenty concurrent requests during a cold start share
// one probe instead of racing twenty. execFile is injected so a test can answer for it; the relay
// passes node:child_process's own.
export function createDockerProbe({ execFile, timeoutMs = 5000, args = ["version", "--format", "{{.Server.Version}}"] } = {}) {
  if (typeof execFile !== "function") throw new Error("createDockerProbe needs an execFile");
  let asked = null;
  return function dockerAvailable() {
    asked ??= new Promise((resolve) => {
      let settled = false;
      const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
      try {
        execFile("docker", args, { timeout: timeoutMs }, (error, stdout) =>
          finish(error == null && String(stdout ?? "").trim().length > 0));
      } catch {
        // execFile throws synchronously when the binary name is unusable. Same answer as ENOENT.
        finish(false);
      }
    });
    return asked;
  };
}
