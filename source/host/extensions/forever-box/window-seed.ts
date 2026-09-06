import { join } from "node:path";
import { buildBoxSecretsEnv } from "../../../shared/box-secrets.js";
import type { BoxEnvironmentUpdate } from "../../box/box-env.js";
import { BOX_SECRETS_FILENAME, readPersistedBoxSecrets } from "../secrets/secrets-service.js";
import { withShellSecretsPreserved } from "../shell-tools/shell-secrets.js";

/**
 * ENV-1. What a NEW desktop window's exec daemon has to start with. A window daemon is a fresh
 * process with the container's environment and nothing else, so everything the host has pushed
 * into the box since it came up has to be pushed into it again before it is handed back.
 *
 * BOTH stores, not just one. The shell-tool store (CONNECT-5) was the only half seeded here, and
 * the operator's box secrets go into the very same daemons through the very same applyEnvironment
 * -- so a window opened after a box secret was stored ran without it while every window already
 * open had it. `replace` stays false for the same reason it is false everywhere on this path: the
 * daemon's replace mode deletes every variable the update does not carry, PATH and HOME included,
 * and this host does not know the box's environment.
 *
 * The shell store wins a name collision: it is the store an agent's own `cr review --api-key
 * "$CODERABBIT_API_KEY"` reads, and a box secret cannot be named over it accidentally
 * (validateBoxSecretKey reserves the process-control names, not the credential ones).
 */
export function buildWindowSeedEnvironment(rootDir: string): BoxEnvironmentUpdate { return { env: withShellSecretsPreserved(buildBoxSecretsEnv(readPersistedBoxSecrets(join(rootDir, BOX_SECRETS_FILENAME))), rootDir), replace: false }; }
