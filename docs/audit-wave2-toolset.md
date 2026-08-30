# Wave 2 — The toolset, enumerated

Sources: six exhaustive readers (`docs/evidence/reader-w2-*.md`), corroborated by the wire
capture: the local model received exactly **26 tools** (`docs/evidence/wire-request-0.json`).

## What the model actually got (wire, ground truth)

Task, TodoWrite, SendMessage, SendToAgent, ReactToMessage, CreateAgent, UpdateAgent,
update_state, ExternalShell, ExternalRead, ExternalAwaitShell, WebSearch, WebFetch, Shell,
Read, AwaitShell, SearchPlugins, GetPlugin, InstallPlugin, AddMcpServer, UninstallMcpServer,
UninstallPlugin, GetMcpServerStatus, SetMcpInstructions, RestartMcpServers,
AuthenticateMcpServer.

Notable absences and why (source): **no computerUse/browserUse in Task's enum** — computerUse
config is pushed only when `host.toolHost.remoteBoxHasDesktop && host.toolHost.getRemoteBoxAvailable()`
(`turn-agent-composition.ts:1695-1697`, no feature flag), browserUse additionally behind the
`sand_browser_use_subagent` experiment (`host-runner-composition.ts:1459-1460`). **No
CheckSubagent/MessageSubagent/StopSubagent** — co-gated with Task on `turn.subagentConfigs != null`
(`turn-toolset.ts:1327,1486`) but a separate registration; absence traced in
`reader-w2-toolset-2.md` (F11). **No Screenshot/computer tool at top level** — desktop work
is exclusively Task-dispatched, by design.

## Key structural facts

- The toolset is built by `buildTurnTools` (`turn-toolset.ts`); registrations at
  `:1324-1364` (Task, factory `:851-862`, underlying `packages/agent/tools/task.ts:475`),
  `:1365-1372` (TodoWrite), `:1374-1375` (SendMessage). Full tables per file in the
  reader evidence docs.
- `fencedToolSet([], …)` — a subagent runner with no configs gets **zero tools silently**
  (`:1298-1304`).
- `update_state` is `PLATFORM_ACTION` (`sand-state-tool.ts:315,326`), the tool behind
  conversational routine/workflow creation — present on the wire, confirming the teach
  prompt's `update_state (target "workflow")` contract is available locally.
- Task execution resolves `subagent_type` via normalization-tolerant name match with
  fallback to generalPurpose (`packages/agent/tools/task-subagent-preparation.ts:475-495`);
  an empty config list throws `"No subagent types are available."` (`:494`) — the P1 error.
- MCP tools ride a separate channel (mcpTools projection, `turn-toolset.ts:1158-1247`);
  discovery failures fail open to `[]` (`turn-agent-composition.ts:698-706`).
- Secret and permission cards are tools: `sand-secret-request.ts` / `sand-permission-request.ts`
  (tables in `reader-w2-tools-periphery.md`) — matching videos 5–6.

## Did not verify

- Which of the 26 offered tools the runner will actually EXECUTE end-to-end (only
  SendMessage, Task, Shell-family observed live).
- The `host.getSubagentConfigs?.()` base supplier's value on our box (composition read;
  runtime value inferred from the wire enum).
- MCP tool projection with a live MCP server attached (none connected).
