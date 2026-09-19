export class AppError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "operation_aborted";
  }
  return "internal_error";
}
