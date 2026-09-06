import { findSystemErrno } from "../shared/system-errno.js";

/**
 * A command failure that already knows its HTTP answer.
 *
 * Every other command failure here is classified after the fact, and lands as a 500 the relay turns
 * into "the gateway broke". The Job Bus (docs/JOB-BUS.md section 3) is a public API with a fixed
 * status table -- 400 for a bad job, 404 for an unknown id, 409 for a job that already finished,
 * 503 when the bus is off -- and those are the caller's answers, not gateway faults. Carrying the
 * status and the whole JSON body on the error is what lets `relayCommand` pass both through
 * unchanged, `{"error":"unknown job type","allowed":[...]}` included.
 */
export class GatewayCommandError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" ? body.error : "gateway command failed");
    this.name = "GatewayCommandError";
    this.status = status;
    this.body = body;
  }
}

/** The status a command failure carries itself, or undefined when it does not carry one. */
export function explicitCommandErrorStatus(error: unknown): number | undefined {
  const node = error as { status?: unknown } | null;
  return error instanceof GatewayCommandError && Number.isInteger(node?.status)
    ? node?.status as number
    : undefined;
}

/** The JSON body a command failure carries itself, or undefined when it does not carry one. */
export function explicitCommandErrorBody(error: unknown): Record<string, unknown> | undefined {
  return error instanceof GatewayCommandError ? error.body : undefined;
}

const NETWORK_ERRNOS = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "ENETRESET"]);
function hasTimeoutName(error: unknown): boolean { const seen = new Set<object>(); let current = error; while (typeof current === "object" && current != null && !seen.has(current)) { seen.add(current); const node = current as { name?: unknown; cause?: unknown }; if (typeof node.name === "string" && (node.name === "AbortError" || /TimeoutError$/.test(node.name))) return true; current = node.cause; } return false; }
export function classifyGatewayCommandError(error: unknown) { const node = error as { name?: string; outcome?: string } | null; const errorClass = error instanceof Error ? error.name || "Error" : "unknown"; const errno = findSystemErrno(error); if (node?.name === "SandBoxDaemonUnreachableError") return { reason: node.outcome === "refused" ? "daemon_refused" : node.outcome === "timeout" ? "daemon_timeout" : "daemon_crash", errorClass, errno }; if (node?.name === "SandBoxNoMonitorAvailableError") return { reason: "no_monitor", errorClass, errno }; if (errno === "ECONNREFUSED") return { reason: "refused", errorClass, errno }; if (errno === "ENOTFOUND" || errno === "EAI_AGAIN") return { reason: "dns", errorClass, errno }; if (errno === "ETIMEDOUT" || hasTimeoutName(error)) return { reason: "timeout", errorClass, errno }; if (errno != null && NETWORK_ERRNOS.has(errno)) return { reason: "network", errorClass, errno }; return { reason: "application", errorClass, errno }; }
export function commandErrorReportToTelemetry(report: Record<string, unknown> & { method: string; reason: string; errorClass: string; durationMs: number }) { return { level: "error", metadata: { method: report.method, reason: report.reason, error_class: report.errorClass, errno: report.errno, duration_ms: String(Math.round(report.durationMs)), request_id: report.requestId, trace_id: report.traceId, span_id: report.spanId } }; }
export function commandSuccessReportToTelemetry(report: Record<string, unknown> & { method: string; durationMs: number }) { return { level: "info", metadata: { method: report.method, duration_ms: String(Math.round(report.durationMs)), request_id: report.requestId, trace_id: report.traceId, span_id: report.spanId } }; }
