/**
 * MAIL-3. The one hop from a box to the relay, and the first one any host tool makes.
 *
 * Jason, 2026-09-09: "I didn't realize that the bots couldn't send mail yet." A Resend key scoped
 * to myagents.email can send as ANY address at that domain, so a copy of it inside a tenant box is
 * a copy that can send as every other customer and as Titan. The key therefore stays on the relay,
 * the relay forces the From to the calling bot's own code address, and the box asks rather than
 * sends. This module is the asking.
 *
 * BOTH THE ADDRESS AND THE CREDENTIAL COME OUT OF ONE STRING, and that is the whole reason this
 * file exists rather than two lines inside the tool.
 *
 *   SAND_HOST_BUNDLE_S3_BASE_URL = http://titanbot-relay:7777/runtime/<token>     (R750)
 *                                = http://host.docker.internal:7787/runtime/<token> (this Mac)
 *
 * That trailing segment IS the value ui/tenant-registry.mjs `registry.matchToken` compares, which
 * is what handleRuntimeBundle already proves in production on every host upgrade. Reading it here
 * instead of `process.env.SAND_GATEWAY_TOKEN` removes a trap rather than saving a line: on a
 * loopback host with no pin, gateway-config.ts generates a token of its own that the registry has
 * never heard of, and a send made with it fails as "the relay refused" when the truth is "there is
 * no relay here at all". It also means the tool is structurally absent on a non-tenant install,
 * whose base is still the default S3 bucket and has no /runtime/ path to parse.
 *
 * MEASURED on grok-bot-local-vm 2026-09-09 17:52Z, inside the runner process itself (pid 448,
 * /home/box/sand-host/host-main.cjs, the process buildTurnTools runs in) rather than with printenv
 * on the box: the variable is present there, its path is /runtime/<64-char token>, and that token
 * is byte-equal to SAND_GATEWAY_TOKEN. So the parse is readable where the tool needs it.
 *
 * deploy/r750/box-isolation.sh matches egress on destination PORT, so any path on 7777 is already
 * reachable from inside a box; nothing in the isolation rules changes for this.
 *
 * THE CONTRACT WITH THE RELAY, written out because the two halves of it ship from two different
 * items and the only way to check they agree is to have one of them say what it sends:
 *
 *   POST <relay origin>/mail/send
 *   Authorization: Bearer <the box's gateway token, which the registry maps to a workspace>
 *   {agentId, to, subject, text, html?, inReplyTo?, idempotencyKey}
 *
 *   200 {sent: true,  id: "<the provider's id>", message: "<one sentence>"}
 *       {sent: false, message: "<why not, in words a bot may repeat to a person>"}
 *   any other status: the same body shape, and `message` is what the model is told.
 *
 * There is NO `from`, NO `replyTo` and NO `headers` on that request, and there never will be: the
 * bearer proves the workspace, the relay looks this agent's row up in the directory it already
 * serves, and it composes the From itself. A box cannot even ask for a different one.
 */

/** Where the relay is, and the bearer this box already presents to it for everything else. */
export interface RelaySendTarget {
  /** Origin only: `http://titanbot-relay:7777`. The route is appended by `postMailSend`. */
  readonly base: string;
  /** The box's own gateway token, as the relay's registry knows it. Never logged, never rendered. */
  readonly token: string;
}

/** What the box asks the relay to send. There is deliberately no `from` and no `replyTo`. */
export interface RelaySendRequest {
  readonly agentId: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly inReplyTo?: string;
  /**
   * `${agentId}:${toolCallId}` -- stable per call, not per attempt. Nothing else in this path is
   * idempotent and a tool retry would otherwise send twice; Resend's 24-hour window on this header
   * is the actual dedupe, and a replay comes back with the id the first attempt got.
   */
  readonly idempotencyKey: string;
}

/** The relay's answer, already in the plain words a model may repeat to a person. */
export interface RelaySendAnswer {
  readonly sent: boolean;
  /** The mail provider's id, when there is one. Absent on every refusal. */
  readonly id?: string;
  /** One sentence. On a refusal this is the reason, and the tool repeats it verbatim. */
  readonly message: string;
  /** The HTTP status, or 0 when the relay could not be reached at all. For the host log only. */
  readonly status: number;
}

export const MAIL_SEND_ROUTE = "/mail/send";
export const MAIL_SEND_TIMEOUT_MS = 20_000;

/**
 * `{base, token}` when this box is served its bundle by a relay, `undefined` otherwise.
 *
 * Undefined is not a failure: it is a box with no relay in front of it, and the caller withholds
 * the tool rather than offering one that can only refuse.
 */
export function resolveRelaySend(
  env: NodeJS.ProcessEnv = process.env,
): RelaySendTarget | undefined {
  const raw = env.SAND_HOST_BUNDLE_S3_BASE_URL?.trim();
  if (raw == null || raw.length === 0) return undefined;
  let url: URL;
  try { url = new URL(raw); } catch { return undefined; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  // Exactly `/runtime/<one segment>`. A deeper path is not the shape the relay serves and a
  // default S3 base has no `/runtime/` in it at all, which is how a non-tenant install answers no.
  const match = /^\/runtime\/([^/]+)\/?$/.exec(url.pathname);
  const segment = match?.[1];
  if (segment == null) return undefined;
  let token: string;
  try { token = decodeURIComponent(segment); } catch { token = segment; }
  token = token.trim();
  if (token.length === 0) return undefined;
  return { base: url.origin, token };
}

const plainError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * POST the send to the relay and turn whatever comes back into one honest sentence.
 *
 * This never throws and never invents a success. A body that cannot be read, a status that is not
 * 200, a relay that does not answer inside the timeout: all of them are `sent: false` with a
 * sentence a model may repeat, because "the send did not happen and here is why" is always a
 * better answer than a thrown turn the model narrates as its own failure.
 */
export async function postMailSend(
  target: RelaySendTarget,
  body: RelaySendRequest,
  timeoutMs: number = MAIL_SEND_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<RelaySendAnswer> {
  let response: Response;
  try {
    response = await fetchImpl(`${target.base}${MAIL_SEND_ROUTE}`, {
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
      sent: false,
      status: 0,
      message: `the mail service could not be reached from this box (${plainError(error)})`,
    };
  }
  const status = response.status;
  let parsed: Record<string, unknown> | null = null;
  let raw = "";
  try {
    raw = await response.text();
    const value = raw.length === 0 ? null : (JSON.parse(raw) as unknown);
    if (typeof value === "object" && value != null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch { /* an unreadable body is reported below as exactly that */ }

  const said = typeof parsed?.message === "string" && parsed.message.trim().length > 0
    ? parsed.message.trim()
    : "";
  const id = typeof parsed?.id === "string" && parsed.id.trim().length > 0
    ? parsed.id.trim()
    : undefined;

  // `sent` is the relay's word and nothing else's. A 200 with no such field is not a send.
  if (parsed?.sent === true) {
    return { sent: true, status, message: said || "the mail was accepted for delivery", ...(id == null ? {} : { id }) };
  }
  if (said.length > 0) return { sent: false, status, message: said };
  return {
    sent: false,
    status,
    message: status === 0
      ? "the mail service did not answer"
      : `the mail service answered ${status} and said nothing this can repeat`,
  };
}
