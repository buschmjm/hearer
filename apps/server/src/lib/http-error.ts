/**
 * An error that maps straight to the API error envelope `{error:{code,message,details?}}`.
 * Throw it from handlers and hooks; the app-level error handler renders it.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const unauthorized = (message = 'Authentication required'): HttpError =>
  new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Insufficient permissions', code = 'forbidden'): HttpError =>
  new HttpError(403, code, message);
export const notFound = (message = 'Not found'): HttpError =>
  new HttpError(404, 'not_found', message);
export const conflict = (code: string, message: string): HttpError =>
  new HttpError(409, code, message);
