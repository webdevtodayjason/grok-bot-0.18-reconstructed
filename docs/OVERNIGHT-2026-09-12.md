# Overnight 2026-09-12: the backlog, autonomous until morning

Jason, 23:46 CDT: "start going to the backlog for the connectors email and everything that's been in
your late-night orchestration, autonomous mode, until morning."

Rules for the night: ship only what its tests and a live measurement prove; relay restarts between
calls only (none expected); host updates on boxes idle for 30 minutes; never the proxy, never a cp
recreate with an onboarding in flight; every ship logged in ORCHESTRATION.md; a morning report
published as an artifact.

| id | what | worker | files |
|---|---|---|---|
| MAIL-4 | a bot's outbound mail takes several recipients, CC and BCC (Titan's own row, 2026-09-10 02:16Z: "exactly one recipient per message: no CC field, no BCC") | mail4 | ui/mail-edge.mjs, cp/mail.mjs if the send crosses it, docs/MAIL.md, tests/mail-*.test.mjs |
| VOICE-15b page | phone call screen: no message box in the call view; buttons at 44 px that do not overlap their text at 390x844; the call-ended card never shows provider text as the person's words; ROUTER-1d: Think harder as a row of the + menu on the phone | voice15b-page | ui/machine-room/voice.js, styles.css, voice-call.css, tests/machine-room-voice.test.mjs |
| VOICE-15b shell | mic trim (build 20 peak 0.0 dBFS): scale capture by 0.5 before conversion; earpiece choice drops .defaultToSpeaker (set category with options minus it) and speaker adds it back; report the chosen output in the route line | voice15b-shell | app repo TitaniumAudio.swift + tests |
| CP-FIX | boot error "plan-minimax cannot be its own fallback" on every cp start; Clients panel sign-in count includes sign-in-link logins; a lockout after a password change reaches the relay ledger; DEVICE-1: deleting an account revokes its device bearer | cp-fixes | cp/*.mjs, tests/cp-*.test.mjs |
| SUPPORT-1 | mail to support@titanium.bot lands in a Support panel on the admin console and pings Jason's workspace: a cp table + POST /v1/relay/support (bearer) + GET /v1/admin/support, the panel, a Titan message to the operator workspace on arrival; the Cloudflare Email Worker that posts inbound mail is the operator's to deploy (design its payload in docs/SUPPORT.md) | support1 | cp/support.mjs (new), cp/server.mjs and cp/admin.mjs (one route each), cp/admin/admin.js + admin.css (one panel), tests/cp-support.test.mjs, docs/SUPPORT.md |
| VOICE-16b | spoken brevity | voice16b-spoken (running) | ui/voice-edge.mjs |
| operator | beta-33..36 host to the current bundle when idle; verify the 3 closing notes from tonight's calls did not make Titan reply; morning report | me | |
