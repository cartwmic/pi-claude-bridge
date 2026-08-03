export type DiagnosticDriverKind = "claude-p" | "claude-print";
export type DriverDiagnosticArtifact = "debug" | "stderr";

/** Stable cross-driver event names keep log queries independent of process adapter. */
export const DRIVER_DIAGNOSTIC_EVENTS = {
	stderrFile: "driver.lifecycle.stderrFile",
	stderrFileFailed: "driver.lifecycle.stderrFileFailed",
	stateDump: "driver.lifecycle.stateDump",
} as const;

/** Bridge-owned artifact name carrying explicit driver identity. */
export function driverDiagnosticFileName(
	driver: DiagnosticDriverKind,
	artifact: DriverDiagnosticArtifact,
	sessionId: string,
	pid: number | string | undefined,
	now: number = Date.now(),
): string {
	return `driver-${driver}-${artifact}-${sessionId.slice(0, 8)}-${pid ?? "x"}-${now}.log`;
}
