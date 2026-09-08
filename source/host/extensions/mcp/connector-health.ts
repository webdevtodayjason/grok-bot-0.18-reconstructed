/**
 * MARKET-6. What a connector's condition sounds like to the person who added it.
 *
 * What the console showed before this module was the box's raw `statusDetail`, which is a Node
 * stack the far end of a failed spawn produced:
 *
 *   MCP error -32000: Connection closed; stderr: ... SseError: SSE error: Non-200 status code (401)
 *   at EventSource.failConnection_fn (/root/.npm/_npx/705d.../node_modules/eventsource/dist/index.js:290:20)
 *
 * Several hundred characters, a vendor's file paths, a library nobody chose, and nowhere in it the
 * one fact the operator needs: the key is wrong. This maps the shapes that actually occur to one
 * plain sentence each, and the raw detail stays available behind a disclosure for whoever wants it.
 *
 * Pure on purpose -- no clock, no filesystem, no network -- so every sentence is unit-testable
 * against detail strings captured from real failures rather than described.
 *
 * Two rules the sentences keep. No tool name and no vendor name: the person reading has not been
 * told what mcp-remote or EventSource is and does not need to learn. And no "may be temporary" --
 * a sentence that hedges is a sentence that tells the operator to wait instead of to act.
 */

export type ConnectorHealthState =
  | "working"
  | "connecting"
  | "needs-key"
  | "needs-browser-sign-in"
  | "refused"
  | "not-an-endpoint"
  | "unreachable"
  | "missing-package"
  | "refused-by-host"
  | "failed";

export interface ConnectorHealth {
  readonly state: ConnectorHealthState;
  /** One sentence, in the words the person who pressed Add would use. */
  readonly sentence: string;
}

export interface ConnectorHealthInput {
  readonly status?: string | undefined;
  readonly statusDetail?: string | undefined;
  readonly toolCount?: number | undefined;
  /** Whether this connector still has a credential field with nothing stored behind it. */
  readonly hasUnstoredCredential?: boolean | undefined;
  /** Present when the connector names a credential at all. */
  readonly credentialFields?: readonly string[] | undefined;
}

const CONNECTING_STATUSES = new Set(["loading", "connecting", "initializing", "starting", "pending"]);

const has = (detail: string, ...needles: string[]): boolean =>
  needles.some((needle) => detail.includes(needle));

/** A status code in the detail, wherever the far end chose to put it. */
function statusCode(detail: string): number | null {
  const match = detail.match(/\b(?:status(?:\s+code)?|HTTP)\D{0,12}(\d{3})\b/i)
    ?? detail.match(/\((\d{3})\)/);
  const code = match == null ? Number.NaN : Number(match[1]);
  return Number.isInteger(code) && code >= 100 && code < 600 ? code : null;
}

export function describeConnectorHealth(input: ConnectorHealthInput): ConnectorHealth {
  const status = (input.status ?? "").toLowerCase();
  const detail = input.statusDetail ?? "";
  const lower = detail.toLowerCase();

  if (status === "refused") {
    return { state: "refused-by-host", sentence: detail.length > 0 ? detail : "This box will not run a connector under that name." };
  }
  if (status === "connected" || (status === "" && (input.toolCount ?? 0) > 0)) {
    const count = input.toolCount ?? 0;
    return {
      state: "working",
      sentence: count === 1 ? "Working. It offers 1 tool." : `Working. It offers ${count} tools.`,
    };
  }

  // A browser sign-in, said before the sixty-second timeout rather than after it. The bridge
  // writes this to stderr the moment it opens a window nobody is looking at.
  if (has(lower, "waiting for authorization", "waiting for auth", "please authorize", "open the following url")) {
    return {
      state: "needs-browser-sign-in",
      sentence: "This server wants a browser sign-in, and that has to be done in this box's own browser.",
    };
  }

  // Asked BEFORE the status codes, and that order is load-bearing: npm writes its own miss as
  // "npm error 404 Not Found - GET https://registry.npmjs.org/@acme%2fserver", so a generic 404
  // rule reads a mistyped package name as a dead endpoint and sends the operator to check a URL
  // that was never wrong.
  if (has(lower, "npm error code e404", "npm error 404", "registry.npmjs.org", "is not in this registry")) {
    return { state: "missing-package", sentence: "That package is not published under that name." };
  }

  // Asked before any status code, because these two are facts a key cannot fix: a name that does
  // not resolve stays unresolved and a package that is not published stays unpublished.
  if (has(lower, "enotfound", "eai_again", "getaddrinfo", "econnrefused", "ehostunreach", "enetunreach", "etimedout", "certificate", "self-signed", "self signed")) {
    return { state: "unreachable", sentence: "This box could not reach that address." };
  }

  // MEASURED on grok-bot-local-vm: a server refusing an unfilled bearer answers 401 on its MCP
  // endpoint and 404 on the discovery paths the client tries next, and the detail that reaches the
  // host carries the 404. Reading the code first told an operator whose only mistake was not having
  // typed the key yet that their address was dead. So an unstored credential wins over every code:
  // whatever else is also true, adding the key is what they do next.
  if (input.hasUnstoredCredential === true) {
    return { state: "needs-key", sentence: "It needs its key before it can connect. Add the key below." };
  }

  const code = statusCode(detail);
  if (code === 401 || code === 403 || has(lower, "unauthorized", "unauthorised", "invalid_auth", "not_authed", "invalid api key", "invalid token")) {
    return { state: "refused", sentence: "The server refused that key." };
  }
  if (code === 404 || code === 410 || has(lower, "not found", "gone")) {
    return { state: "not-an-endpoint", sentence: "That address is not a connectable endpoint any more." };
  }
  // Every word the box uses for "not finished yet". Measured on grok-bot-local-vm: a native remote
  // reports `initializing` while it does its handshake, and reading that as a failure told an
  // operator a working connector was broken for the two seconds before it came up.
  if (CONNECTING_STATUSES.has(status) || (status === "" && detail.length === 0)) {
    return { state: "connecting", sentence: "Still connecting." };
  }
  if (status === "needsauth") {
    return {
      state: "needs-browser-sign-in",
      sentence: "This server wants a browser sign-in, and that has to be done in this box's own browser.",
    };
  }
  return { state: "failed", sentence: "It did not connect, and the server gave no reason this box could read." };
}

/**
 * A connect that never finished. The bridge or the socket behind it is still holding a port and,
 * for an OAuth server, a browser window nobody will ever answer -- one on the local box had been
 * waiting nine hours and fifty-one minutes with eighty abandoned verifier files beside it. So a
 * timed-out connector is stopped rather than left running, and this is the sentence that says so.
 */
export const CONNECT_TIMEOUT_SENTENCE =
  "It did not answer in time and was stopped, so it is not holding anything open.";
