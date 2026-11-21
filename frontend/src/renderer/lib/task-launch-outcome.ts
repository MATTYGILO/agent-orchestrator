import { PLAN_REFUSAL_CODES } from "./cloud-cp/client";

const POST_START_ERRORS = new Set([
	"SPAWN_COMMIT_FAILED", "SPAWN_INTERNAL", "SPAWN_PROMPT_DELIVERY_FAILED", "SPAWN_LAUNCH_COMMAND_FAILED",
	"SPAWN_SUPERVISOR_FAILED", "SPAWN_PREPARE_LAUNCH_FAILED", "RUNTIME_CREATE_FAILED",
]);

/**
 * A send whose outcome is unknown: no answer, a server error (the create may
 * have gone through before it failed), a rate limit that names no plan limit,
 * or a failure after the session may exist.
 */
export function sendIsUncertain(error: unknown): boolean {
	if (!(error instanceof Error)) return true;
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
	if (status !== undefined && (status === 0 || status >= 500)) return true;
	// A plan's limit has its own message and its Upgrade; any other 429 is retried.
	if (status === 429) return !(code && PLAN_REFUSAL_CODES.has(code));
	if (code) return POST_START_ERRORS.has(code);
	return error.name !== "TaskCreateError";
}
