import { Value } from "@bufbuild/protobuf";

import { McpArgs } from "../../../packages/proto/generated/agent/v1/mcp_exec_pb.js";
import type { CapableBox } from "../../box/box-capabilities.js";
import { createBoxSandMcpExec } from "../mcp/box-mcp-exec.js";
import type { ConnectorToolCaller } from "./tinyfish-route.js";

/**
 * CURSOR-1. The host calling one of its own connectors' tools, for the web tools' backup route.
 *
 * The box already runs every local stdio connector and already holds its credential, so the way to
 * use TinyFish's `fetch_content` without this code ever seeing a key is to ask the box to run the
 * tool. That is exactly what an agent's MCP tool call does; this is the same call made by the host
 * on its own behalf, with `skipApproval` set because there is no agent here to approve anything and
 * the person already asked for the page.
 *
 * `listTools` is what supplies `providerIdentifier` and the qualified `name`. Guessing them would
 * work today and break the first time a connector's naming changed, and a wrong `name` fails as a
 * tool-not-found the caller cannot tell from a network error.
 */
export function createBoxConnectorToolCaller(box: CapableBox): ConnectorToolCaller {
  const exec = createBoxSandMcpExec(box);
  return {
    async callTool(request) {
      const servers = await exec.listTools([request.server]);
      const server = servers.find((entry) => entry.serverIdentifier === request.server);
      if (server == null) throw new Error(`the connector "${request.server}" is not running on this machine`);
      const tool = server.tools.find((entry) => entry.toolName === request.tool);
      if (tool == null) throw new Error(`the connector "${request.server}" does not offer "${request.tool}"`);
      const values: Record<string, Value> = {};
      for (const [key, value] of Object.entries(request.args)) {
        if (value === undefined) continue;
        values[key] = Value.fromJson(value as Parameters<typeof Value.fromJson>[0]);
      }
      const result = await exec.executeTool(new McpArgs({
        name: tool.name,
        args: values,
        toolCallId: `web-tools-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        providerIdentifier: tool.providerIdentifier,
        toolName: tool.toolName,
        serverIdentifier: request.server,
        skipApproval: true,
      }));
      if (result.result.case !== "success") {
        throw new Error(`the connector "${request.server}" could not run "${request.tool}"`);
      }
      const success = result.result.value;
      if (success.isError) throw new Error(`"${request.tool}" reported a failure`);
      const texts: string[] = [];
      for (const item of success.content) {
        if (item.content.case === "text") texts.push(item.content.value.text);
      }
      const joined = texts.join("\n").trim();
      if (joined.length === 0) throw new Error(`"${request.tool}" returned nothing`);
      return joined;
    },
  };
}
