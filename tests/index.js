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
import "./openai-compatible-provider.test.mjs";
import "./publication-bootstrap.test.mjs";
import "./publication-packaging.test.mjs";
import "./reconstructed-updater-guard.test.mjs";
import "./research-archives.test.mjs";
import "./router-settings.test.mjs";
import "./ui-routine-triggers.test.mjs";
import "./machine-room-decisions.test.mjs";
import "./openai-compatible-images.test.mjs";
import "./machine-room-markdown.test.mjs";
import "./ui-views-render.test.mjs";
import "./local-schedule-tick.test.mjs";
