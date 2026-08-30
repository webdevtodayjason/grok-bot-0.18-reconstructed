# Wave 4 — Wired / partial / absent, against upstream intent

Yardstick: §6/§6b of `docs/PLUMBING-AUDIT.md` (upstream docs + eight operator walkthrough
videos) and `docs/upstream-teach-prompt.md`. Evidence columns cite Waves 1–3 and live probes
from this session.

| capability (upstream intent) | state | evidence |
|---|---|---|
| Full behavioral system prompt (identity, SendMessage-only voice, work-out-loud, widgets, tone) | **WIRED** | 73,769 chars on the wire; all 24 base headings present (Wave 1/3) |
| SendMessage as only voice; transcript `send-message` entries | **WIRED** | wire + live replies all session |
| Cron/interval routines end-to-end | **WIRED** | created, fired, edited live (video-parity UI built earlier) |
| Event trigger types (slack/github/teams/linear/sentry/pagerduty, groups of 8) | **WIRED (host)** / listeners unconnected | all seven kinds round-trip the gateway; `getListenerIntegrations`: slack+github `isConnected:false` |
| Conversational routine creation (`update_state`) | **WIRED (tool offered)** | `update_state` in the wire's 26; end-to-end creation not yet exercised locally |
| Skills/workflows (`update_state` target "workflow", `sand-workflow:` links, teach prompt) | **PARTIAL** | tool present on wire; workflow-library/store + teach-recording-service exist in source; never exercised |
| Task subagents (generalPurpose) | **BROKEN — root cause named** | Wave 3: schema/execution config mismatch; "No subagent types are available" |
| computerUse / browserUse subagents (desktop work) | **ABSENT at runtime** | gate `remoteBoxHasDesktop && getRemoteBoxAvailable()` false on our connector (`turn-agent-composition.ts:1695`); browserUse also behind experiment |
| Per-agent screens (fork windows, dormancy) | **ABSENT in practice** | one X display, empty noVNC token dir; machinery present (`box-windows.ts`, window router) |
| Group channels (members, own routines, serialized rounds) | **WIRED (host)** / UI partial | `isGroup`+`memberIds` live; `group-chat.ts` turn tags; huddle UI built; sender labels/threading absent from our UI |
| Bot-to-bot handoffs (SendToAgent) | **WIRED (tool offered)** | `SendToAgent` in the 26; upstream videos show the UX our UI lacks |
| Plugins = MCP + skills bundles, per-tool toggles, marketplace | **PARTIAL** | gateway/settings model complete (`mcpDisabledToolsByServerId`, `mcpBoxServers`, plugin-skills.ts); 10 MCP-management tools on the wire; no marketplace source, no OAuth callback server (`completeMcpOAuth` stub) |
| Plugin OAuth (localhost:8767 callback) | **ABSENT** | lived in Electron main; relay is the natural home (video 4) |
| Secret request card / submitSecret | **WIRED (source+gateway)** | tool + command present (Wave 2); unexercised |
| Approval cards / auto-review NL rules | **PARTIAL** | settings store models rules; `sand-auto-review*.ts` unread beyond existence; local card flow unexercised |
| Local-computer execution policy (ask/allow/never) | **WIRED** | `localToolPermission` set + surfaced in our Settings view |
| WebAuthn / hardware key forwarding | **PARTIAL** | `webauthnProxyEnabled` + `requestWebAuthnCeremony` exist; unexercised |
| Webhook trigger | **ABSENT by design** | URL minted by Cursor cloud (video 2); local equivalent = relay receiver |
| Teach-a-task (record → watchVideo → skill) | **PARTIAL** | service + verbatim prompt held; `watchVideo` subagent type unavailable locally (same desktop gate family) |
| Widgets (choice cards), reactions, threads | **PARTIAL** | `respondToWidget`/`ReactToMessage` present (ReactToMessage on the wire); UI renders none of them |
| Memory (user/project/agent, freeze) | **WIRED (prompt-side)** | Wave 1 section 9; `getAgentMemories` empty but plumbed |
| Command palette / global search | **ABSENT (UI)** | upstream video 7; our UI has no search |
| Model/endpoint choice | **DIVERGENT on purpose** | upstream has no picker; our Endpoints panel is the point of the rebuild |

## Did not verify

- Rows marked unexercised: presence proven from source + wire, behavior not run end-to-end.
- Upstream cloud-agent surfaces (Cursor cloud agents, "Open in Cursor" cards) — no local
  counterpart attempted.
