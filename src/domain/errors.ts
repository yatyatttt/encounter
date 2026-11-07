// One error type for every expected failure (domain rules, lookups, version conflicts). The server maps `code` to HTTP.
export type ErrorCode = 'VALIDATION' | 'NOT_FOUND' | 'VERSION_CONFLICT' | 'INVALID_STATE' | 'BAD_REQUEST' | 'STORAGE_BUSY' | 'FORBIDDEN';

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: { fieldErrors?: Record<string, string[]>; currentVersion?: number } = {},
  ) {
    super(message);
  }
}

export const fail = (code: ErrorCode, message: string, fieldErrors?: Record<string, string[]>): never => {
  throw new AppError(code, message, { fieldErrors });
};
