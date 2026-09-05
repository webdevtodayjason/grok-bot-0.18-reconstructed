import { z } from "zod";
import { SandMcpConfigError } from "./mcp-config-error.js"; import type { McpServerConfig } from "./mcp-display-runtime.js";
const RESERVED_SERVER_NAMES = new Set(["__proto__", "constructor", "prototype"]);
export function getTransport(config: McpServerConfig): "stdio" | "sse" | "http" { return "command" in config ? "stdio" : config.type === "sse" ? "sse" : "http"; }
export function getCommand(config: McpServerConfig): string | undefined { return "command" in config ? [config.command, ...(config.args ?? [])].join(" ") : undefined; }
export function validateServerName(raw: string): string { const name = raw.trim(); if (name.length === 0) throw new SandMcpConfigError("MCP server name is required."); if (RESERVED_SERVER_NAMES.has(name)) throw new SandMcpConfigError(`MCP server name "${name}" is reserved.`); if (name.includes("/") || name.includes("\\") || name.includes("\0")) throw new SandMcpConfigError("MCP server names cannot include slashes or null bytes."); if (name.includes("--")) throw new SandMcpConfigError('MCP server names cannot include "--".'); return name; }

export const MAX_CA_BUNDLE_LENGTH = 128 * 1024;
const commandBasedMcpServer = z.object({
  type: z.literal("stdio").optional(),
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
});
const mcpAuthConfig = z.object({
  CLIENT_ID: z.string(),
  CLIENT_SECRET: z.string().optional(),
  scopes: z.array(z.string()).optional(),
});
const mcpTlsConfig = z.object({ caBundle: z.string().trim().min(1).max(MAX_CA_BUNDLE_LENGTH) }).strict();
const remoteMcpServer = z.object({
  type: z.enum(["http", "sse"]).optional(),
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  auth: mcpAuthConfig.optional(),
  tls: mcpTlsConfig.optional(),
});
/** The one shape a server config may take: a stdio command, or a remote http/sse endpoint. */
export const mcpServerSchema = z.union([commandBasedMcpServer, remoteMcpServer]);
export type ParsedMcpServerConfig = z.infer<typeof mcpServerSchema>;

// This validator used to be a callback the caller injected, and no caller ever injected one, so
// every AddMcpServer call died on "parse is not a function" before it reached the account. The
// schema belongs here beside the name rules, where there is nothing left to forget to wire up.
export function parseServerConfig(configJson: string): ParsedMcpServerConfig {
  let value: unknown;
  try { value = JSON.parse(configJson); }
  catch { throw new SandMcpConfigError("The MCP server configuration is not valid JSON."); }
  const parsed = mcpServerSchema.safeParse(value);
  if (!parsed.success) {
    throw new SandMcpConfigError(`The MCP server configuration is not a valid stdio or remote server: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")}`);
  }
  return parsed.data;
}
export function toJsonArgs(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [
    key,
    typeof value === "object" && value != null && "toJson" in value && typeof value.toJson === "function"
      ? value.toJson()
      : value,
  ]));
}
