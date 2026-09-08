import type { HostExtensionContext } from "../../../internal/host-extensions.js";
import type { SandAgentModelSelection } from "../../../shared/agents/sand-agent-model.js";
import { ToolCallError } from "../../../packages/agent/tools/common.js";
import { getSandRootDir } from "../../host-paths.js";
import { readConnectorEnvSecrets } from "../mcp/connector-secrets.js";
import { readLocalConnectorFile } from "../mcp/local-connectors.js";
import { createHostInference } from "./inference-service.js";
import type { InferenceExtensionContext } from "./extension.js";
import {
  resolveWebFallback,
  TINYFISH_CONNECTOR_NAME,
  TINYFISH_KEY_FIELD,
  type ConnectorToolCaller,
} from "./tinyfish-route.js";
import { createSandWebFetchService, createSandWebSearchService } from "./web-tools.js";

type ProductionContext = HostExtensionContext<unknown> & {
  readonly deps: InferenceExtensionContext["deps"];
};

/** Recreates the artifact's concrete inference construction at host-main.cjs:617672-617732. */
export function createInferenceProductionExtras(
  context: ProductionContext,
): Omit<InferenceExtensionContext, "deps"> {
  const auth = context.deps.auth;
  /**
   * CURSOR-1. Late-bound because the web tools cannot declare the box as a peer: telemetry already
   * depends on inference, so inference depending on mcp or forever-box is a cycle the extension
   * graph refuses to boot. sand-host.ts hands this in once every extension is up, which is before
   * any turn can run a tool.
   */
  let connectorTools: ConnectorToolCaller | null = null;
  const webToolsOptions = {
    resolveFallback: () => resolveWebFallback({
      listConnectors: () => Object.keys(readLocalConnectorFile(getSandRootDir())),
      readApiKey: () => readConnectorEnvSecrets(getSandRootDir())[TINYFISH_CONNECTOR_NAME]?.[TINYFISH_KEY_FIELD] ?? null,
      connectorTools: () => connectorTools,
    }),
    createError: (fields: ConstructorParameters<typeof ToolCallError>[0]) => new ToolCallError(fields),
  };
  return {
    createPort(onModelExperimentApplied) {
      return createHostInference({
        auth,
        experiments: context.deps.experiments,
        settings: context.deps.settings,
        onModelExperimentApplied,
      });
    },
    setConnectorToolCaller(caller: ConnectorToolCaller | null) {
      connectorTools = caller;
    },
    // CURSOR-1. Both tools keep their names, their schemas, their renderers and their console tool
    // rows. What changed is the service behind them: `AiService.RunWebSearch` and
    // `AiService.RunWebFetch` on api2.cursor.sh answered 401 on every one of our boxes, so the page
    // is now read from this machine and only handed to the backup web service when the site refuses.
    createWebSearch() {
      return createSandWebSearchService(webToolsOptions);
    },
    createWebFetch() {
      return createSandWebFetchService(webToolsOptions);
    },
  };
}

export type InferenceModelSelection = SandAgentModelSelection;
