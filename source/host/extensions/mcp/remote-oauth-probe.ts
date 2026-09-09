/**
 * MARKET-13, made real.
 *
 * The console has carried an OAuth refusal since this wave landed and nothing could reach it: the
 * only writer of the field it tested was a pasted block carrying a literal `"auth":"oauth"` key,
 * which no vendor's config block has ever contained. So a person adding Notion, Zapier or any other
 * browser-only server was taken all the way through the form to a written entry and a connector
 * that never connects, while the docs said the door refused it in one sentence.
 *
 * The signal was there the whole time and nobody read it. Measured on 8 September 2026:
 * `https://mcp.notion.com/mcp` answers an unauthenticated POST with
 * `www-authenticate: Bearer realm="OAuth", resource_metadata="…/.well-known/oauth-protected-resource"`,
 * and so does every other hosted OAuth server checked. One request, before anything is written,
 * turns that into the sentence the docs already promised.
 *
 * It is asked ONLY when the operator supplied no key at all. `agent.tinyfish.ai` advertises the
 * same OAuth metadata and works perfectly well with an API key in a header, so "this endpoint
 * mentions OAuth" is not on its own a reason to refuse anything -- "it wants a sign-in and you gave
 * it nothing" is.
 *
 * A network failure refuses nothing. The probe is an early kindness, not a gate: a box behind a
 * flaky egress path must still be able to add a server, and the connector's own health line is what
 * reports a server that will not talk.
 */

/** The one sentence. OAuth remotes are a named non-goal of this wave, and this says so plainly. */
export const OAUTH_REMOTE_REFUSAL = "That server asks people to sign in through a browser, and this box has no browser sign-in to give it, so it would never finish connecting. If the server also takes an API key, add it again with that key in a header; otherwise it cannot be added here yet.";

/** What an OAuth-protected endpoint says when it is asked without a key (RFC 9728 and friends). */
const OAUTH_CHALLENGE = /(oauth|resource_metadata|authorization_uri|as_uri)/i;

export interface RemoteOAuthProbeOptions {
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Does this endpoint demand a browser sign-in? `true` when it answered a challenge naming an OAuth
 * authorization server, `false` when it answered anything else, and `null` when it did not answer
 * at all -- three different facts, and the caller refuses on exactly one of them.
 */
export async function probeRemoteMcpOAuth(
  url: string,
  options: RemoteOAuthProbeOptions = {},
): Promise<boolean | null> {
  const call = options.fetch ?? globalThis.fetch;
  if (typeof call !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
  try {
    const response = await call(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      // An initialize with no session and no key: the shortest request an MCP server will answer,
      // and the one whose answer is the challenge when the server is protected.
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "titanium-bot", version: "0" } } }),
      signal: controller.signal,
      redirect: "follow",
    });
    if (response.status !== 401 && response.status !== 403) return false;
    const challenge = response.headers.get("www-authenticate") ?? "";
    return OAUTH_CHALLENGE.test(challenge);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
