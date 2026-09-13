/** Application error carrying a stable machine code; serialized as {error:{code,message}}. */
export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toBody(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }
}

export const Errors = {
  unauthorized: (msg = "Missing or invalid API key") =>
    new AppError("unauthorized", msg, 401),
  forbidden: (msg = "Not allowed") => new AppError("forbidden", msg, 403),
  notFound: (msg = "Not found") => new AppError("not_found", msg, 404),
  conflict: (msg = "Conflict") => new AppError("conflict", msg, 409),
  validation: (msg = "Validation failed", details?: unknown) =>
    new AppError("validation_error", msg, 422, details),
  rateLimited: (msg = "Rate limit exceeded") => new AppError("rate_limited", msg, 429),
  budget: (msg = "LLM budget cap reached") => new AppError("budget_exceeded", msg, 503),
  badRequest: (msg = "Bad request") => new AppError("bad_request", msg, 400),
  internal: (msg = "Internal error") => new AppError("internal", msg, 500),
};
