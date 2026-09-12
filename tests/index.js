// Entry point so `node --test tests/` runs the suite.
//
// This Node build does not accept a directory as a --test argument: it resolves the path as a
// module and dies with "Cannot find module .../tests" (reproducible in an empty project, so it is
// the runtime, not this repo). Node then looks for an index in the directory, which is this file.
// Importing each suite registers its tests with the runner exactly as passing the glob does.
import "./deploy-sync-ships-relay-modules.test.mjs";
import "./host-bundle-ship.test.mjs";
import "./backup-snapshot.test.mjs";
import "./agent-state-results.test.mjs";
import "./handoff-host.test.mjs";
import "./backend-mcp-exec-json.test.mjs";
import "./codex-direct-responses.test.mjs";
import "./inference-extension-readiness.test.mjs";
import "./web-tools-ours.test.mjs";
import "./job-bus-event-stream.test.mjs";
import "./job-bus-store.test.mjs";
import "./job-bus-worker.test.mjs";
import "./inference-router-transcript.test.mjs";
import "./mcp-add-server-config.test.mjs";
import "./mcp-tools-discovery-unsettled.test.mjs";
import "./mcp-connecting-server-list.test.mjs";
import "./mcp-stub-sse.test.mjs";
import "./openai-compatible-provider.test.mjs";
import "./model-tier-router.test.mjs";
import "./publication-bootstrap.test.mjs";
import "./publication-packaging.test.mjs";
import "./reconstructed-updater-guard.test.mjs";
import "./research-archives.test.mjs";
import "./router-settings.test.mjs";
import "./secret-request-shell.test.mjs";
import "./ui-routine-triggers.test.mjs";
import "./routine-run-failure.test.mjs";
import "./machine-room-decisions.test.mjs";
import "./machine-room-trigger-availability.test.mjs";
import "./machine-room-transcript-fold.test.mjs";
import "./machine-room-transcript-pin.test.mjs";
import "./machine-room-gap-badge.test.mjs";
import "./openai-compatible-images.test.mjs";
import "./provider-image-parts.test.mjs";
import "./machine-room-markdown.test.mjs";
import "./machine-room-code-chip-pixels.test.mjs";
import "./ui-views-render.test.mjs";
import "./local-schedule-tick.test.mjs";
import "./openai-compatible-context-window.test.mjs";
import "./evidence-verdict.test.mjs";
import "./openai-responses-transport.test.mjs";
import "./token-limit-classifier.test.mjs";
import "./machine-room-plugins.test.mjs";
import "./marketing-pack.test.mjs";
import "./community-bots.test.mjs";
// KB-1c. The two handbook packs generated off those same catalogs, and the validators that refuse a
// pack which has drifted away from them.
import "./handbook-generated-packs.test.mjs";
// gate-pins passes its data root in explicitly, so it is safe in the shared process. Its sibling
// cursor-loops-off.test.mjs is deliberately NOT here: it moves SAND_DATA_ROOT to prove a live box
// takes a new backend setting from the settings file, and this runner loads every suite into one
// process, so it stays with sand-host-setting.test.mjs on the `npm test` glob, where each file has
// a process to itself.
import "./gate-pins.test.mjs";
import "./turn-toolset-projection.test.mjs";
import "./sand-host-setting.test.mjs";
import "./browser-tool-parameters.test.mjs";
import "./machine-room-gateway.test.mjs";
import "./machine-room-identity.test.mjs";
import "./connector-literal-refusal.test.mjs";
import "./connector-health.test.mjs";
import "./connector-custody.test.mjs";
import "./connector-plane.test.mjs";
import "./machine-room-connectors.test.mjs";
import "./machine-room-marketplace.test.mjs";
import "./machine-room-bots-tab.test.mjs";
import "./machine-room-marketplace-review.test.mjs";
import "./machine-room-byo-mcp.test.mjs";
import "./connector-tinyfish-preset.test.mjs";
import "./connector-preset-catalog.test.mjs";
import "./connector-spec.test.mjs";
import "./plugin-credential-fanout.test.mjs";
import "./managed-seed-skills.test.mjs";
import "./workflow-injected-body.test.mjs";
import "./workflow-frontmatter.test.mjs";
import "./machine-room-teach.test.mjs";
import "./machine-room-mail.test.mjs";
import "./window-assignments.test.mjs";
import "./window-orphan-sweep.test.mjs";
import "./forever-box-auto-update.test.mjs";
import "./agent-delete-prompt-report.test.mjs";
import "./relay-auth.test.mjs";
import "./relay-login-guards.test.mjs";
import "./relay-door.test.mjs";
import "./auth-device.test.mjs";
import "./relay-device-bearer.test.mjs";
import "./relay-hooks-absent.test.mjs";
// KEYS-1. The relay's copy of the keys the product uses: {} with no control plane, the last good
// copy through an outage, and its own distinct sentence for a door that is not there.
import "./relay-secrets-reader.test.mjs";
import "./auto-review-enforcement.test.mjs";
import "./relay-trusted-proxies.test.mjs";
import "./relay-job-bus.test.mjs";
import "./mail-edge.test.mjs";
import "./local-machine-prompt.test.mjs";
import "./local-machine-turn-read.test.mjs";
import "./self-talk-cap.test.mjs";
import "./send-cap-per-turn.test.mjs";
import "./tinyfish-key-stub.test.mjs";
import "./shell-tools.test.mjs";
import "./marketplace-bot-import.test.mjs";
import "./host-marketplace-bot-import.test.mjs";
import "./marketplace-catalog.test.mjs";
import "./marketplace-marketing-rows.test.mjs";
import "./marketplace-verification.test.mjs";
import "./cp-marketplace-admin.test.mjs";
import "./marketplace-logos.test.mjs";
import "./composer-paste.test.mjs";
import "./vnc-paste-bridge.test.mjs";
import "./skill-ownership.test.mjs";
import "./standing-persona.test.mjs";
// KB-1: the agent's handbook, its seeded packs and the rubric that scores what it changed.
import "./handbook-seeds.test.mjs";
import "./handbook-rubric.test.mjs";
import "./awaiting-operator.test.mjs";
import "./env-fanout.test.mjs";
import "./titan-crew.test.mjs";
import "./titan-catalog-tools.test.mjs";
import "./cp-session.test.mjs";
import "./cp-store.test.mjs";
import "./cp-providers.test.mjs";
import "./cp-provision.test.mjs";
import "./cp-remove.test.mjs";
import "./cp-proxy.test.mjs";
import "./cp-server.test.mjs";
// KEYS-1. The key door: the paste is proved before it is stored, nothing reads a value back, and the
// relay's own read refuses a wrong method before it looks at a credential.
import "./cp-secrets-door.test.mjs";
// ADMIN-2. Adding a client from the console, and the rule that holds it to the same refusals the
// customer's own sign-up door gives.
import "./cp-signup.test.mjs";
import "./cp-onboard.test.mjs";
// SIGNIN-1. This operator's own verification gates, told apart from strangers.
import "./cp-signins-gate.test.mjs";
import "./control-plane-deploy.test.mjs";
// PROXY-1. The proxy's deploy: the compose properties the design rests on, the two scripts held to
// running twice, and the isolation rule that opens one address and port to a box.
import "./proxy-deploy.test.mjs";
import "./cursor-free.test.mjs";

// Everything below was in tests/ and NOT in this list, so `node --test tests/` did not run it.
// Measured on this Mac 2026-09-07: the list named 79 files, the directory held 101, and the
// directory form ran 891 tests where `node --test tests/*.test.mjs` ran 1101. The 210 tests in the
// gap were not failing and not skipped; as far as the command the runbook gives an operator was
// concerned they did not exist, and 22 files' worth of coverage read as green because nothing ran
// it. tests/test-index-covers-the-suite.test.mjs now fails the suite when this list drifts again,
// which is the only reason a hand-written list of files is allowed to stay hand-written.
//
// The list cannot become a readdir: a dynamic `await import` registers its tests after the runner
// has already started, so the run stops after the first file or two. Static imports are hoisted
// and all resolve before this module's body runs, which is why they work and nothing else does.
import "./agent-cap.test.mjs";
import "./read-fence.test.mjs";
import "./problem-report-tool.test.mjs";
// PUSH-1: the decider and the senders, then the four relay routes plus the console's card.
import "./push-edge.test.mjs";
import "./relay-push-routes.test.mjs";
import "./send-email-tool.test.mjs";
import "./code-task-tool.test.mjs";
import "./code-task-watch.test.mjs";
import "./machine-room-code-strip.test.mjs";
import "./box-secrets-preserve.test.mjs";
import "./box-store-secret-exclusion.test.mjs";
import "./box-copy-in-agent-db.test.mjs";
import "./audit-secret-redaction.test.mjs";
import "./turn-failed-entry.test.mjs";
import "./box-health-sweep.test.mjs";
import "./browser-direct-tools.test.mjs";
import "./browser-driver-address-guard.test.mjs";
import "./browser-driver-cloud.test.mjs";
import "./browser-driver-extraction.test.mjs";
import "./browser-driver-protocol.test.mjs";
import "./cloud-browser.test.mjs";
import "./cloud-browser-ledger.test.mjs";
import "./machine-room-cloud-browser.test.mjs";
import "./browser-tools-prompt.test.mjs";
import "./browser-tools.test.mjs";
import "./cp-admin.test.mjs";
import "./cp-admin-page-routes.test.mjs";
import "./cp-admin-guard.test.mjs";
import "./cp-feedback.test.mjs";
import "./cp-relay-pair.test.mjs";
import "./cp-relay-registry.test.mjs";
import "./deploy-sync-ships-browser-driver.test.mjs";
import "./gate-agent.test.mjs";
import "./login-ledger.test.mjs";
import "./machine-room-onboarding.test.mjs";
import "./mail-edge-routing.test.mjs";
import "./onboard-seam.test.mjs";
import "./onboarding-first-agent.test.mjs";
import "./onboarding-state.test.mjs";
import "./relay-admin-routes.test.mjs";
import "./relay-command-status.test.mjs";
import "./relay-docker-absent.test.mjs";
import "./relay-mail-tenant-claim.test.mjs";
import "./relay-one-console.test.mjs";
import "./relay-state-dir.test.mjs";
import "./relay-state-out-of-ui.test.mjs";
import "./relay-tenant-endpoints.test.mjs";
import "./relay-tenant-login.test.mjs";
import "./relay-tenant-registry.test.mjs";
import "./session-token.test.mjs";
import "./test-index-covers-the-suite.test.mjs";

// HANDBACK-1: the computer hand-off card, the rail and the takeover banner.
import "./machine-room-handoff.test.mjs";

// CONSOLE-4: the plate before the first pixel, the boot cover, the transcript that settles, the
// adapter's data shapes, the four seams, the rail tile's reader and its plate, the badge that folds
// a gap of work into one row, and files that open -- the viewer, the download and the /files route.
import "./machine-room-boot.test.mjs";
import "./machine-room-feedback.test.mjs";
import "./machine-room-mail-chip.test.mjs";
import "./machine-room-screen-tile.test.mjs";
import "./machine-room-files.test.mjs";

// BOX-6b: repairing a wedged conversation store from the product. The host half is the recovery
// that already existed and had no caller on the turn path; the console half is the sentence a
// failed turn gets when asking again cannot work, the roster pill, and the Repair control.
import "./transcript-journal-repair.test.mjs";
import "./machine-room-transcript-repair.test.mjs";

// MAIL-2: every bot has an address of its own, agent<code>@myagents.email. The directory the
// control plane owns and mints, and the routing the relay does on it -- including the refusal that
// stops a stranger's guess landing in the operator's own Titan.
import "./cp-mail.test.mjs";
import "./mail-directory.test.mjs";

// MAIL-3: a bot sends from its own address. The relay holds the key and forces the From; the
// control plane holds the record and the caps. The refusal order is the security, so both files
// walk it a case at a time.
import "./mail-send-route.test.mjs";
import "./cp-mail-send.test.mjs";

// VOICE-1: talking to your team. The control plane half -- the vendor table, the caps a customer
// cannot raise, and the minutes ledger whose row is claimed before the provider socket opens.
import "./cp-voice.test.mjs";
// The relay half: the websocket codec the bridge hand-rolls, the two vendors' session shapes, the
// one tool's round trip into Titan's own conversation, the caps and the ledger row claimed before
// the dial, and the real relay answering an upgrade on /voice/socket.
import "./voice-frames.test.mjs";
import "./voice-wire.test.mjs";
import "./voice-turn.test.mjs";
import "./voice-caps-ledger.test.mjs";
import "./voice-socket.test.mjs";
// VOICE-7: the labelled words on the wire -- partial, settled, confirmed, and the turns that close
// without ever becoming a line in the conversation.
import "./voice-transcription.test.mjs";
// The console half: the microphone capture MEETING-1 shares, and the talk button, orb, notes and
// Voice card as they are sliced out of the live console files.
import "./voice-capture.test.mjs";
import "./machine-room-voice.test.mjs";

// BOTS-4: the write path behind Add on a catalog row. The host verb that seeds an agent's own
// remembered facts and refuses one over the store's ceiling rather than storing it short, and the
// console module that mints the bot, seeds it, installs its playbooks, creates its jobs switched
// off, and asks for the introduction last.
import "./agent-memory-seed.test.mjs";
import "./bot-setup.test.mjs";

// MOBILE-1: the console at phone widths. What the stylesheet has to say for the shell's column
// track, the two drawers and the scrim, and where those rules are allowed to live.
import "./machine-room-mobile.test.mjs";

// CODE-1: coding tasks in a throwaway computer. The plan every container is made from, the five
// box-facing routes against an injected execFile, and the sweep that is the only real wall clock.
import "./code-sandbox-plan.test.mjs";
import "./code-edge-routes.test.mjs";
import "./code-edge-sweep.test.mjs";
// CODE-1: a coding task's money. The per-task credential and the hidden coding deployment, and the
// ledger, the caps, the two relay routes and the operator's read that sit over them.
import "./cp-code-key.test.mjs";
import "./cp-code.test.mjs";
// COST-1: the data diet. The relay's two shaping modules and the console's half of the same
// contract -- the outline projection pinned against the real 1,578-item payload, the unchanged-answer
// protocol, the private-never-public asset policy, and the case where both modules are absent.
import "./api-diet.test.mjs";
import "./asset-cache.test.mjs";
// APPS-DOC-1, PUSH-4, PUSH-5 and CONSOLE-ATTR-1: the app-contract follow-up. The wire shapes
// docs/APPS.md documents, round-tripped through a real relay, and the three attributes a shell reads
// off the console's own page when it has no bearer yet.
import "./apps-wire-shapes.test.mjs";
import "./console-app-hooks.test.mjs";
import "./console-approval-card.test.mjs";
import "./console-needs-you-attributes.test.mjs";

// ONBOARD-2: the welcome mail the product sends a new customer, and the relay's two new doors.
// The link, the words, the send and the receipt on the control plane side; the product-mail door
// and the per-slug address sweep on the relay; and the purge, which is the only route in the
// product that can delete a customer's data.
import "./cp-welcome.test.mjs";
import "./relay-product-mail.test.mjs";
import "./relay-purge.test.mjs";

// SETTINGS-2: the settings surface, its rows, its words, and who is shown what.
import "./machine-room-settings.test.mjs";

// ALLOWANCE-1: five-day token accounting, relay enforcement, and the console meter/drawer.
import "./cp-allowance.test.mjs";
import "./relay-allowance-edge.test.mjs";
import "./machine-room-allowance.test.mjs";
