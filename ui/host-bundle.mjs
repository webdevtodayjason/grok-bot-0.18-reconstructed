// The relay's half of the host-only ship (docs/GAP-ANALYSIS.md SHIP-2).
//
// The host already carries upstream's self-upgrade: it fetches <base>/sand-host-bundle-latest.version,
// then <base>/sand-host-bundle-<version>.tgz, hands the bytes to the in-box supervisor, and the
// supervisor swaps the bundle and relaunches ONLY the host process. `base` is
// SAND_HOST_BUNDLE_S3_BASE_URL. Nothing upstream ever pointed that at anything but Cursor's S3
// bucket; this module is what makes the relay serve that same two-file layout out of the runtime
// directory a ship already writes.
//
// Two things about the tarball are load-bearing and were read out of the image's
// /usr/local/bin/sand-supervisor.mjs (swapHostBundle), not guessed:
//
//   the archive's top level is a directory called `sand-host`, it must contain host-main.cjs, and
//   its `version` file must equal the version in the request or the swap is refused
//   ("version-mismatch"); and
//
//   after the swap the supervisor PRUNES every entry of /home/box/sand-host that the archive did
//   not carry. So a tarball holding only host-main.cjs would delete agent-isolation/, box-scripts/,
//   extensions/, node_modules/, the pdf and diff workers and sand-eval-runner.cjs -- the parts of
//   the bundle that come from the box image and that this repo does not build.
//
// That second rule is why the archive is composed INSIDE the box rather than on the machine that
// built host-main.cjs: the base tree is copied from the box's own /home/box/sand-host, so it always
// matches the image that is about to receive the swap, and a ship still ships exactly one file.

export const HOST_BUNDLE_PREFIX = "sand-host-bundle";
export const LATEST_VERSION_FILE = `${HOST_BUNDLE_PREFIX}-latest.version`;
// Upstream's own SHORT_GIT_SHA_REGEX (host-bundle-source.ts). The host refuses a version outside it
// before it ever asks for a tarball, so serving anything wider would only widen this door.
export const HOST_BUNDLE_VERSION_RE = /^[0-9a-f]{7,40}$/;
export const RUNTIME_ROUTE_PREFIX = "/runtime/";
// Paths inside the box. /tmp is the one tree box-store-sync never snapshots, so a 40 MB staging
// copy here never reaches the durable store.
export const BOX_STAGE_DIR = "/tmp/sand-host-bundle-stage";
export const BOX_INCOMING_ENTRY = "/tmp/sand-host-bundle-incoming.cjs";
export const BOX_TARBALL_PATH = "/tmp/sand-host-bundle-compose.tgz";

// /runtime/<token>/<file>. The token is a PATH segment rather than a header because the caller is
// the host's own `fetch(url)` inside the box, which sends no headers of its own: there is no hook
// upstream for one. It is the gateway bearer, which the box already holds in its environment, so
// this adds no new secret -- and the route is refused outright when the presented segment does not
// match, which is what keeps the runtime directory off the public surface.
export function parseRuntimeRequest(pathname) {
  if (!pathname.startsWith(RUNTIME_ROUTE_PREFIX)) return null;
  const rest = pathname.slice(RUNTIME_ROUTE_PREFIX.length).split("/");
  if (rest.length !== 2) return null;
  const [token, file] = rest;
  if (token.length === 0) return null;
  if (file === LATEST_VERSION_FILE) return { token, kind: "version" };
  const tarball = /^sand-host-bundle-([0-9a-f]{7,40})\.tgz$/.exec(file);
  if (tarball != null) return { token, kind: "tarball", version: tarball[1] };
  return null;
}

// The version file is written by scripts/stage-host-bundle.mjs and read by both sides, so its shape
// lives in one place: one short git sha, optionally with a trailing newline, and nothing else.
export function parseLatestVersionFile(raw) {
  const value = String(raw ?? "").trim();
  return HOST_BUNDLE_VERSION_RE.test(value) ? value : null;
}

export function formatLatestVersionFile(version) {
  if (!HOST_BUNDLE_VERSION_RE.test(String(version ?? ""))) {
    throw new Error(`not a short git sha: ${String(version)}`);
  }
  return `${version}\n`;
}

// The sh the relay runs in the box to build one tarball. Kept here, as a pure string, so a unit test
// can assert the layout rules above without a container: the sand-host top level, host-main.cjs
// replaced by the shipped one, and the version marker written to match the request.
//
// The two --exclude flags matter in opposite directions. host-main.cjs is excluded because the copy
// would be the OLD bundle and would then be overwritten anyway (and on a dev box it is a read-only
// bind mount, which `cp -a` refuses); `version` is excluded because the marker must be the version
// being served, not the one already installed.
export function composeHostBundleScript({ version, stageDir = BOX_STAGE_DIR, incoming = BOX_INCOMING_ENTRY, tarball = BOX_TARBALL_PATH } = {}) {
  if (!HOST_BUNDLE_VERSION_RE.test(String(version ?? ""))) {
    throw new Error(`not a short git sha: ${String(version)}`);
  }
  return [
    "set -e",
    `rm -rf ${stageDir} ${tarball}`,
    `mkdir -p ${stageDir}`,
    `tar -cf - -C /home/box --exclude=sand-host/host-main.cjs --exclude=sand-host/version sand-host | tar -xf - -C ${stageDir}`,
    `test -d ${stageDir}/sand-host`,
    `cp ${incoming} ${stageDir}/sand-host/host-main.cjs`,
    `printf '%s\\n' '${version}' > ${stageDir}/sand-host/version`,
    `tar -czf ${tarball} -C ${stageDir} sand-host`,
    `rm -rf ${stageDir} ${incoming}`,
  ].join("\n");
}
