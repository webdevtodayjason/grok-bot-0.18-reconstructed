/**
 * CODE-1. The one hop from a box to the relay for a coding task, and the box's whole half of the
 * credential story: there isn't one.
 *
 * Jason, 2026-09-09 06:11: "the E2B coding sandboxes are great, but E2B costs me and we have to
 * send it off ... could we just as easily spin up a local Docker container on our own inside of
 * the 750". The answer is yes, and the reason it can be done safely is that the box never holds
 * any of the parts. The relay holds the docker socket, mints the task directory, asks the control
 * plane for a per-task model key with a spend cap, and revokes it at the end. The box asks.
 *
 * THE ADDRESS AND THE BEARER COME OUT OF ONE STRING, and `resolveRelayCode` is deliberately
 * `resolveRelaySend` under another name rather than a second copy of the same regex:
 *
 *   SAND_HOST_BUNDLE_S3_BASE_URL = http://titanbot-relay:7777/runtime/<token>      (R750)
 *                                = http://host.docker.internal:7787/runtime/<token> (this Mac)
 *
 * That trailing segment is the value ui/tenant-registry.mjs `registry.matchToken` compares, which
 * handleRuntimeBundle already proves in production on every host upgrade, and which MAIL-3
 * measured inside the runner process itself on grok-bot-local-vm. Importing mail's parse means the
 * two can never drift: if the relay ever changes the shape of that URL, both the mail tool and the
 * coding tool stop resolving together rather than one of them quietly asking nowhere.
 *
 * `undefined` IS NOT A FAILURE. It is a box with no relay in front of it -- a customer's own
 * install, a loopback dev host with no pin -- and the caller WITHHOLDS the tool. A coding tool that
 * is offered and can only refuse teaches the model a capability the product does not have on that
 * box, which is the same reason there is no `repo` parameter in this release.
 *
 * THE FROZEN WIRE CONTRACT, written here because two items build the two halves and the only way
 * to check they agree is to have one of them say what it sends. Box-facing on the relay, bearer =
 * the box's gateway token, rate limited on sha256(bearer).slice(0,32):
 *
 *   POST /code/start  {agentId,title,instructions,files?,provider?}
 *     -> {started:true,taskId,provider,deadlineAt,capUsd} | {started:false,message}
 *        409 {error:"not_available",detail} | 429 {message}
 *   POST /code/status {agentId,taskId}
 *     -> {found,state,startedAt,endedAt,elapsedS,provider,lines[],message}
 *        state is running|done|failed|timed_out|stopped|spend_cap
 *   POST /code/stop   {agentId,taskId} -> {stopped,message}
 *   POST /code/result {agentId,taskId} -> {ready,summary,files:[{path,bytes}],path,message}
 *   POST /code/list   {agentId}        -> {tasks:[{taskId,title,state,startedAt,endedAt,provider}]}
 *
 * There is NO `key` and NO `model` on any of those requests, and there never will be. The bearer
 * proves the workspace; everything about what the sandbox may spend is decided on the far side.
 */
import { resolveRelaySend } from "../mail/relay-send-client.js";

/** Where the relay is, and the bearer this box already presents to it for everything else. */
export interface RelayCodeTarget {
  /** Origin only: `http://titanbot-relay:7777`. The route is appended by `postCode`. */
  readonly base: string;
  /** The box's own gateway token, as the relay's registry knows it. Never logged, never rendered. */
  readonly token: string;
}

export const CODE_START_ROUTE = "/code/start";
export const CODE_STATUS_ROUTE = "/code/status";
export const CODE_STOP_ROUTE = "/code/stop";
export const CODE_RESULT_ROUTE = "/code/result";
export const CODE_LIST_ROUTE = "/code/list";

export type CodeRoute =
  | typeof CODE_START_ROUTE
  | typeof CODE_STATUS_ROUTE
  | typeof CODE_STOP_ROUTE
  | typeof CODE_RESULT_ROUTE
  | typeof CODE_LIST_ROUTE;

/** The wall-clock ceiling on one relay call. A start is a docker create, not the task itself. */
export const CODE_CALL_TIMEOUT_MS = 30_000;
/** The watcher's own, shorter: a poll that outlives its own interval is a poll that piles up. */
export const CODE_POLL_TIMEOUT_MS = 10_000;

/**
 * The state vocabulary, frozen. `running` is the only value that keeps the watcher awake; every
 * other one is terminal, which is what makes "announce exactly once" a property of the data rather
 * than of a flag somebody has to remember to set.
 */
export const CODE_TERMINAL_STATES = Object.freeze([
  "done", "failed", "timed_out", "stopped", "spend_cap",
] as const);

export type CodeTaskState = "running" | (typeof CODE_TERMINAL_STATES)[number];

export const isTerminalCodeState = (state: unknown): boolean =>
  typeof state === "string" && (CODE_TERMINAL_STATES as readonly string[]).includes(state);

/**
 * What one relay call came back with.
 *
 * `ok` is "the relay answered 200 with an object body", nothing more. Whether the TASK started is
 * `body.started`, and whether a result is ready is `body.ready`: this layer never decides that,
 * because a transport that infers an outcome is a transport that can invent one.
 */
export interface CodeRelayAnswer {
  readonly ok: boolean;
  /** The HTTP status, or 0 when the relay could not be reached at all. For the host log only. */
  readonly status: number;
  /** The parsed object body, or `{}` when there was none to read. */
  readonly body: Record<string, unknown>;
  /** One sentence, already in words a model may repeat to a person. */
  readonly message: string;
  /**
   * The relay has no docker socket, so the local provider cannot exist on this install. Its own
   * field rather than a string match, because the sentence the model reads is allowed to change
   * while the branch that offers a cloud sandbox instead is not.
   */
  readonly notAvailable: boolean;
}

/**
 * `{base, token}` when this box is served its bundle by a relay, `undefined` otherwise.
 *
 * Deliberately mail's parse and not a copy of it. See the header.
 */
export function resolveRelayCode(
  env: NodeJS.ProcessEnv = process.env,
): RelayCodeTarget | undefined {
  const target = resolveRelaySend(env);
  if (target == null || target.token.length === 0) return undefined;
  return { base: target.base, token: target.token };
}

const plainError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The sentence for an install whose relay holds no docker socket. CODE-5 is the row for it. */
export const CODE_NO_DOCKER_SENTENCE =
  "coding tasks cannot run on this installation, because the machine in front of this box does not"
  + " run containers for it. Say that plainly, and offer a cloud sandbox instead if the operator"
  + " wants one switched on.";

/**
 * POST one route and turn whatever comes back into one honest sentence.
 *
 * This NEVER THROWS and never invents a success. A body that cannot be read, a status that is not
 * 200, a relay that does not answer inside the timeout: all of them are `ok: false` with a sentence
 * a model may repeat, because "it did not happen and here is why" is always a better answer than a
 * thrown turn the model narrates as its own failure. A 409 carrying `not_available` becomes the
 * plain no-docker sentence rather than a stack, which is the one place this layer writes the words
 * itself: the relay's own `detail` is an operator's sentence about a socket, and the person reading
 * it owns a business.
 */
export async function postCode(
  target: RelayCodeTarget,
  route: CodeRoute,
  body: Record<string, unknown>,
  timeoutMs: number = CODE_CALL_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<CodeRelayAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(`${target.base}${route}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${target.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: {},
      message:
        "the machine that runs coding tasks could not be reached from this box"
        + ` (${plainError(error)})`,
      notAvailable: false,
    };
  }
  const status = response.status;
  let parsed: Record<string, unknown> = {};
  try {
    const raw = await response.text();
    const value = raw.length === 0 ? null : (JSON.parse(raw) as unknown);
    if (typeof value === "object" && value != null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch { /* an unreadable body is reported below as exactly that */ }

  const said = typeof parsed.message === "string" && parsed.message.trim().length > 0
    ? parsed.message.trim()
    : "";

  // 409 not_available is the absence case and has its own words. It is checked before the 200
  // branch because the relay answers it with a real body, and a model must not read "409" and guess.
  if (status === 409 && parsed.error === "not_available") {
    return {
      ok: false, status, body: parsed, message: CODE_NO_DOCKER_SENTENCE, notAvailable: true,
    };
  }
  if (status === 200) {
    return {
      ok: true,
      status,
      body: parsed,
      message: said || "the machine that runs coding tasks answered",
      notAvailable: false,
    };
  }
  if (said.length > 0) {
    return { ok: false, status, body: parsed, message: said, notAvailable: false };
  }
  return {
    ok: false,
    status,
    body: parsed,
    message:
      `the machine that runs coding tasks answered ${status} and said nothing this can repeat`,
    notAvailable: false,
  };
}

/** A string field off a relay body, trimmed, or "" -- so no caller has to re-type the guard. */
export const codeString = (body: Record<string, unknown>, key: string): string =>
  typeof body[key] === "string" ? (body[key] as string).trim() : "";

/** A finite number off a relay body, or undefined. */
export const codeNumber = (
  body: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
};
