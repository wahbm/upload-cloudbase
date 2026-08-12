import type { Context } from 'hono';
import { ConfigError } from './config.js';
import type { StorageErrorCode } from './types.js';

export class AppError extends Error {
  readonly code: StorageErrorCode;
  readonly status: number;

  constructor(code: StorageErrorCode, message: string, status: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

export class CloudBaseApiError extends Error {
  readonly status: number;
  readonly upstreamCode?: string;

  constructor(status: number, message: string, upstreamCode?: string) {
    super(message);
    this.name = 'CloudBaseApiError';
    this.status = status;
    this.upstreamCode = upstreamCode;
  }
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ConfigError) {
    return new AppError('INVALID_REQUEST', error.message, 400);
  }

  if (error instanceof CloudBaseApiError) {
    const code = error.upstreamCode?.toUpperCase();
    if (code === 'CONFIG_MISSING') return new AppError('CONFIG_MISSING', 'CloudBase service credentials are not configured', 500);
    if (code === 'OBJECT_ALREADY_EXIST' || code === 'OBJECT_ALREADY_EXISTS') {
      return new AppError('CONFLICT', 'The object already exists', 409);
    }
    if (error.status === 401) return new AppError('UNAUTHENTICATED', 'CloudBase authentication failed', 401);
    if (error.status === 403) return new AppError('FORBIDDEN', 'CloudBase denied the storage operation', 403);
    if (error.status === 404 || code === 'OBJECT_NOT_EXIST') {
      return new AppError('NOT_FOUND', 'File not found', 404);
    }
    if (error.status === 413) return new AppError('FILE_TOO_LARGE', 'File is too large', 413);
    return new AppError('STORAGE_UNAVAILABLE', 'CloudBase storage is unavailable', 502);
  }

  if (error instanceof TypeError) {
    return new AppError('INVALID_REQUEST', 'The request could not be parsed', 400);
  }

  return new AppError('STORAGE_UNAVAILABLE', 'Unexpected storage proxy failure', 502);
}

export function errorResponse(context: Context, error: unknown, requestId: string): Response {
  const appError = toAppError(error);
  return context.json(
    {
      error: {
        code: appError.code,
        message: appError.message,
        requestId,
      },
    },
    appError.status as never,
  );
}
