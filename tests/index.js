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
import "./openai-compatible-images.test.mjs";
import "./machine-room-markdown.test.mjs";
import "./ui-views-render.test.mjs";
import "./local-schedule-tick.test.mjs";
import "./openai-compatible-context-window.test.mjs";
import "./evidence-verdict.test.mjs";
import "./openai-responses-transport.test.mjs";
import "./token-limit-classifier.test.mjs";
import "./machine-room-plugins.test.mjs";
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
import "./connector-plane.test.mjs";
import "./machine-room-connectors.test.mjs";
import "./machine-room-marketplace.test.mjs";
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
import "./marketplace-catalog.test.mjs";
import "./marketplace-logos.test.mjs";
import "./composer-paste.test.mjs";
import "./vnc-paste-bridge.test.mjs";
import "./skill-ownership.test.mjs";
import "./awaiting-operator.test.mjs";
import "./env-fanout.test.mjs";
import "./titan-crew.test.mjs";
import "./cp-session.test.mjs";
import "./cp-store.test.mjs";
import "./cp-providers.test.mjs";
import "./cp-provision.test.mjs";
import "./cp-proxy.test.mjs";
import "./cp-server.test.mjs";
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
import "./box-secrets-preserve.test.mjs";
import "./box-store-secret-exclusion.test.mjs";
import "./box-copy-in-agent-db.test.mjs";
import "./audit-secret-redaction.test.mjs";
import "./turn-failed-entry.test.mjs";
import "./box-health-sweep.test.mjs";
import "./browser-direct-tools.test.mjs";
import "./browser-driver-address-guard.test.mjs";
import "./browser-driver-extraction.test.mjs";
import "./browser-driver-protocol.test.mjs";
import "./browser-tools-prompt.test.mjs";
import "./browser-tools.test.mjs";
import "./cp-admin.test.mjs";
import "./cp-relay-pair.test.mjs";
import "./cp-relay-registry.test.mjs";
import "./deploy-sync-ships-browser-driver.test.mjs";
import "./login-ledger.test.mjs";
import "./machine-room-onboarding.test.mjs";
import "./mail-edge-routing.test.mjs";
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
// adapter's data shapes and the four seams items B, C and D plug into.
import "./machine-room-boot.test.mjs";
