// PROXY-1 scaffolding: a console whose boxes are directories on this Mac.
//
// Not a .test.mjs, so `npm test` never runs it on its own. It exists because the three relay suites
// that cover the included set all need the same thing, and it is a thing none of the existing
// scaffolding could give them: every route in this wave writes INSIDE a box, and the only door to
// a box is `docker exec`. The other relay tests deliberately run with no docker on PATH, which is
// right for what they measure and useless for this.
//
// So `docker` here is a real program on PATH that reaches a directory instead of a container. It
// answers the four subcommands this relay actually uses -- version, ps, inspect, exec -- and for
// exec it rewrites /home/box/sand-data to that box's directory and runs the rest for real. That
// last part is the point: `umask 077 && cat > … && chmod 600 …` runs as itself, so the FILE MODE
// this suite asserts is a mode a shell actually produced, not one a mock agreed to report.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DOCKER_STUB = `#!/bin/sh
root="$FAKE_BOX_ROOT"
case "$1" in
  version) echo 27.0.0 ; exit 0 ;;
  ps) cat "$root/names" ; exit 0 ;;
  inspect) exit 0 ;;
  exec) ;;
  *) exit 1 ;;
esac
shift
if [ "$1" = "-i" ]; then shift; fi
box="$1"
shift
dir="$root/$box"
if [ ! -d "$dir" ]; then exit 1; fi
if [ "$1" = "cat" ]; then
  shift
  exec cat "$(printf '%s' "$1" | sed "s|^/home/box/sand-data|$dir|")"
fi
if [ "$1" = "sh" ] && [ "$2" = "-c" ]; then
  exec /bin/sh -c "$(printf '%s' "$3" | sed "s|/home/box/sand-data|$dir|g")"
fi
exit 1
`;

/**
 * A PATH with that docker on it, and one directory per box name.
 *
 * `pathValue` goes to startRelay. /usr/bin and /bin are on it because the stub shells out to cat,
 * sed and chmod; nothing else is, so a test cannot accidentally reach a real docker.
 */
export function boxStub(boxes = []) {
  const root = mkdtempSync(path.join(tmpdir(), "fake-boxes-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(bin, "docker"), DOCKER_STUB);
  chmodSync(path.join(bin, "docker"), 0o755);
  writeFileSync(path.join(root, "names"), `${boxes.join("\n")}\n`);
  for (const box of boxes) mkdirSync(path.join(root, box), { recursive: true });
  return {
    root,
    env: { FAKE_BOX_ROOT: root },
    pathValue: `${bin}:/usr/bin:/bin`,
    dirOf: (box) => path.join(root, box),
    fileOf: (box, name) => path.join(root, box, name),
    // The box-secrets document as the box holds it, or {} when there is none.
    secretsOf(box) {
      try { return JSON.parse(readFileSync(path.join(root, box, "box-secrets.json"), "utf8")).secrets ?? {}; }
      catch { return {}; }
    },
    writeSecrets(box, secrets) {
      writeFileSync(path.join(root, box, "box-secrets.json"), JSON.stringify({ version: 1, secrets }));
    },
    connectorSecretsOf(box) {
      try { return JSON.parse(readFileSync(path.join(root, box, "connector-env-secrets.json"), "utf8")); }
      catch { return null; }
    },
    writeConnectorSecrets(box, document) {
      writeFileSync(path.join(root, box, "connector-env-secrets.json"), JSON.stringify(document));
    },
  };
}

// One included set, in the shape the control plane sends and ui/tenant-registry.mjs normalises.
// The three model names are the frozen ones: they are a contract with every box pointed at them
// and a test that invents its own would stop measuring the contract.
export function includedSet({ baseUrl = "http://titanbot-proxy:4000/v1", key = "sk-virtual-demo-0000", keyId = "key-demo", enforced = false } = {}) {
  return {
    baseUrl, key, keyId, enforced,
    models: [
      { id: "plan-zai", model: "plan-zai", name: "Z.AI GLM (included with your plan)", contextWindow: 200000, servedBy: "Z.AI" },
      { id: "plan-minimax", model: "plan-minimax", name: "MiniMax M3 (included with your plan)", contextWindow: 1000000, servedBy: "MiniMax" },
      { id: "plan-qwen", model: "plan-qwen", name: "Qwen (included with your plan)", contextWindow: 256000, servedBy: "Qwen" },
    ],
  };
}
