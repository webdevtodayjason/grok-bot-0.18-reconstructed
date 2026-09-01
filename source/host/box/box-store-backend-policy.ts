import { isAbsolute } from "node:path";
import { isPathWithin } from "../../shared/node/paths.js";
import { SAND_BOX_HOME_DIR, getSandRootDir } from "../host-paths.js";
export const SAND_BOX_STORE_LOCAL_DIR_ENV = "SAND_BOX_STORE_LOCAL_DIR";
export const SAND_BOX_STORE_BACKEND_ENV = "SAND_BOX_STORE_BACKEND";
// Inside the box this is the one writable tree box-store-sync does not snapshot itself, and it is the
// volume the local-docker connector already mounts (electron-main/box/local-docker-host-connector.ts).
export const SAND_BOX_STORE_DEFAULT_BOX_DIR = "/var/lib/sand-box-store";
export type BoxStoreBackendKind = "local-fs" | "sand-box-store-v2" | "agent-store";
// local-fs always carries its directory: callers used to paper over a missing one with "", which put the
// store at the process working directory instead of failing.
export type BoxStoreBackendPolicy = { readonly kind: "local-fs"; readonly localDir: string } | { readonly kind: "sand-box-store-v2" | "agent-store"; readonly localDir?: undefined };
export class SandBoxStoreBackendError extends Error {}
// Object.hasOwn + a null prototype: SAND_BOX_STORE_BACKEND=constructor would otherwise resolve to
// an inherited member, slip past this check, and crash later with no backend selected.
const BACKEND_KINDS: Record<string, BoxStoreBackendKind> = Object.assign(Object.create(null) as Record<string, BoxStoreBackendKind>, { local: "local-fs", "local-fs": "local-fs", v2: "sand-box-store-v2", "sand-box-store-v2": "sand-box-store-v2", agent: "agent-store", "agent-store": "agent-store" });
const policies = new WeakMap<object, BoxStoreBackendPolicy>();
// An unconfigured box used to land on "agent-store", i.e. /workspace and sand-data uploaded to Cursor.
// Self-hosted default is local; every remote backend is now an explicit SAND_BOX_STORE_BACKEND opt-in.
export function resolveBackendKind(localDir: string | undefined, env: Record<string, string | undefined>): BoxStoreBackendKind { if (localDir != null) return "local-fs"; const requested = env[SAND_BOX_STORE_BACKEND_ENV]?.trim().toLowerCase(); if (requested == null || requested.length === 0) return "local-fs"; const kind = Object.hasOwn(BACKEND_KINDS, requested) ? BACKEND_KINDS[requested] : undefined; if (kind == null) throw new SandBoxStoreBackendError(`${SAND_BOX_STORE_BACKEND_ENV}=${requested} is not a box-store backend. Use "local" (the default, keeps box data on this machine), "v2", or "agent-store" (uploads box data to Cursor).`); return kind; }
// A relative path used to be dropped on the floor here, which silently promoted the box to the remote store.
function resolveConfiguredLocalDir(env: Record<string, string | undefined>): string | undefined { const raw = env[SAND_BOX_STORE_LOCAL_DIR_ENV]?.trim(); if (raw == null || raw.length === 0) return undefined; if (!isAbsolute(raw)) throw new SandBoxStoreBackendError(`${SAND_BOX_STORE_LOCAL_DIR_ENV}=${raw} is not an absolute path. Point it at an absolute directory, or unset it to use the default local store.`); return raw; }
// Sibling of the sand data root, never a child: box-store-sync snapshots that root, so a store inside it
// would copy itself into its own snapshots on every cycle. In the box the whole of /home/box is snapshotted
// when the box-home category is on, so the store goes to /var/lib instead.
function resolveDefaultLocalDir(): string { const root = getSandRootDir(), dir = isPathWithin(SAND_BOX_HOME_DIR, root, { isInclusive: true }) ? SAND_BOX_STORE_DEFAULT_BOX_DIR : `${root}-box-store`; if (!isAbsolute(dir)) throw new SandBoxStoreBackendError(`the local box store has no usable directory (resolved "${dir}" from sand data root "${root}"). Set ${SAND_BOX_STORE_LOCAL_DIR_ENV} to an absolute path.`); return dir; }
export function getBoxStoreBackendPolicy(env: Record<string, string | undefined> = process.env): BoxStoreBackendPolicy { const cached = policies.get(env); if (cached != null) return cached; const localDir = resolveConfiguredLocalDir(env), kind = resolveBackendKind(localDir, env), policy = Object.freeze(kind === "local-fs" ? { kind, localDir: localDir ?? resolveDefaultLocalDir() } : { kind }); policies.set(env, policy); return policy; }
function enabled(value: string | undefined): boolean { const raw = value?.trim().toLowerCase(); return raw === "1" || raw === "true" || raw === "yes"; }
export function isBoxStoreSyncEnabled(env: Record<string, string | undefined> = process.env): boolean { return enabled(env.SAND_BOX_STORE_SYNC); }
export function isBoxStoreCopyInEnabled(env: Record<string, string | undefined> = process.env): boolean { return enabled(env.SAND_BOX_STORE_COPY_IN); }
