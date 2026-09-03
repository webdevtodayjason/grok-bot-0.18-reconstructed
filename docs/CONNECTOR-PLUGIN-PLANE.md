# Connector and plugin plane — the decision this repo executes against

**Status:** DECIDED 2026-08-18, recorded for Titanium Frontier in
`/Users/sem/code/journeyman/docs/CONNECTOR-PLUGIN-PLANE.md` (with the candidate evidence in
`CONNECTOR-UPSTREAM-EVALUATION.md` beside it). This file is the pointer this repo was missing: the
2026-09-02 gap audit searched only this tree, found no decision, and filed CP-14 as an open
question. It was never open.

## The decision

- **Substrate: OOMOL OpenConnector** (`oomol-lab/open-connector`, Apache-2.0, self-hostable).
  A pinned upstream revision, run as an untrusted supervised sidecar. It supplies what this repo
  lacks: provider definitions, OAuth and API-key connection handling, action schemas, local
  executors, run logs, MCP/HTTP/OpenAPI surfaces. We do not maintain a catalog of our own.
- **Supplemental sources:** Activepieces for a connector OpenConnector lacks (after package and
  execution review); the official MCP Registry as a discovery feed only.
- **Not chosen:** Composio (evaluated as an optional hosted long tail), Pipedream Connect, Nango,
  Klavis. The general survey is closed; reopen only on license change, a failed adoption gate that
  cannot be fixed, unmaintainability, or a launch requirement its adapters cannot meet.
- **Adoption gates still open** (they gate live customer credentials, not implementation work):
  project age, the optional plaintext storage mode, dependency findings, unverified long-tail
  coverage, no effect/reversibility semantics, no Zoho connector.
- **Two paths stay in scope regardless of the catalog:** bring your own MCP server, and a
  first-class connector built against the SDK.

For Titanbot the Frontier governance gateway is out of scope ("that's crazy heavy governance",
2026-09-02): OpenConnector is the catalog and the local executor behind the transport this repo
already has, nothing more.

## What that means for this repo (Wave D)

1. **Transport is already ours.** Local stdio MCP servers run inside the box from
   `/home/box/sand-data/connectors.json` (`local-connectors.ts`), are discovered every turn, and
   since Wave A reach the model through GetMcpTools / CallMcpTool. Cursor is uninvolved.
2. **Run OpenConnector as a stdio sidecar in the box**, or make the HTTP/SSE MCP path execute
   locally (GAP-ANALYSIS CP-13). Today `tools-discovery.ts` sends http/sse servers to Cursor's
   backend, so consuming OpenConnector over remote MCP would hand execution back to Cursor and undo
   Wave A. The stdio bridge is the cheaper first step; the local HTTP client is D2.
3. **Credentials never touch a filesystem the agent can read.** The exec daemon runs as root and
   the agent can `cat` its own connector files, so a submitted secret must be injected into the
   MCP server's `env` at spawn from the host process (GAP-ANALYSIS CP-10), not written beside
   `connectors.json`. OpenConnector's encrypted store holds the OAuth tokens; the box holds none.
4. **Catalog ingestion executes nothing.** Listing, installing, connecting, and granting stay
   separate states; a catalog entry is never authority (the journeyman doc's acceptance checks).

Proof of closure for CP-14 is this file. Wave D1 (secrets into the server env, numeric local ids,
tool-permission reads, the connected connector on a card, the secret card answered) needs nothing
from OpenConnector and starts now; D2 wires the OpenConnector sidecar and catalog.
