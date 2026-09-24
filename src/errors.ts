/**
 * Standardized error type for every operation in operations.ts. `code` is a
 * stable machine-readable identifier (used by callers to branch on failure
 * kind); `message` is the human-readable text shown to the user/agent.
 */
export type TaskManagerErrorCode =
  | "invalid_input"
  | "not_found"
  | "collision"
  | "unknown_status"
  | "unknown_priority"
  | "unknown_type"
  | "unresolved_dependency"
  | "unresolved_based_on"
  | "invalid_config"
  | "invalid_operation";

export class TaskManagerError extends Error {
  readonly code: TaskManagerErrorCode;

  constructor(code: TaskManagerErrorCode, message: string) {
    super(message);
    this.name = "TaskManagerError";
    this.code = code;
  }
}

export interface StandardErrorResponse {
  ok: false;
  error: {
    code: TaskManagerErrorCode | "internal_error";
    message: string;
  };
}

export function toStandardError(err: unknown): StandardErrorResponse {
  if (err instanceof TaskManagerError) {
    return { ok: false, error: { code: err.code, message: err.message } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: "internal_error", message } };
}
