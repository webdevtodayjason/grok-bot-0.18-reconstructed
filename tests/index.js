// Entry point so `node --test tests/` runs the suite.
//
// This Node build does not accept a directory as a --test argument: it resolves the path as a
// module and dies with "Cannot find module .../tests" (reproducible in an empty project, so it is
// the runtime, not this repo). Node then looks for an index in the directory, which is this file.
// Importing each suite registers its tests with the runner exactly as passing the glob does.
import "./backend-mcp-exec-json.test.mjs";
import "./codex-direct-responses.test.mjs";
import "./inference-extension-readiness.test.mjs";
import "./inference-router-transcript.test.mjs";
import "./mcp-add-server-config.test.mjs";
import "./openai-compatible-provider.test.mjs";
import "./publication-bootstrap.test.mjs";
import "./publication-packaging.test.mjs";
import "./reconstructed-updater-guard.test.mjs";
import "./research-archives.test.mjs";
import "./router-settings.test.mjs";
import "./ui-routine-triggers.test.mjs";
import "./routine-run-failure.test.mjs";
import "./machine-room-decisions.test.mjs";
import "./machine-room-trigger-availability.test.mjs";
import "./openai-compatible-images.test.mjs";
import "./machine-room-markdown.test.mjs";
import "./ui-views-render.test.mjs";
import "./local-schedule-tick.test.mjs";
import "./openai-compatible-context-window.test.mjs";
import "./evidence-verdict.test.mjs";
import "./openai-responses-transport.test.mjs";
import "./token-limit-classifier.test.mjs";
import "./machine-room-plugins.test.mjs";
import "./turn-toolset-projection.test.mjs";
import "./sand-host-setting.test.mjs";
import "./browser-tool-parameters.test.mjs";
import "./machine-room-gateway.test.mjs";
import "./machine-room-identity.test.mjs";
import "./connector-plane.test.mjs";
import "./machine-room-connectors.test.mjs";
import "./managed-seed-skills.test.mjs";
import "./workflow-injected-body.test.mjs";
import "./workflow-frontmatter.test.mjs";
import "./machine-room-teach.test.mjs";
import "./window-assignments.test.mjs";
import "./window-orphan-sweep.test.mjs";
import "./agent-delete-prompt-report.test.mjs";
import "./relay-auth.test.mjs";
import "./relay-login-guards.test.mjs";
import "./auto-review-enforcement.test.mjs";
import "./relay-trusted-proxies.test.mjs";
import "./local-machine-prompt.test.mjs";
import "./local-machine-turn-read.test.mjs";
import "./self-talk-cap.test.mjs";
import "./send-cap-per-turn.test.mjs";
