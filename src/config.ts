import type { StorageErrorCode } from './types.js';

export const DEFAULT_ENV_ID = 'ww-d9g604vycbc0aa139';
export const DEFAULT_BUCKET_ID = 'public-assets';
export const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const DEFAULT_MAX_LIST_LIMIT = 100;
export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;

export const EXACT_MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/javascript': 'js',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/css': 'css',
};

const EXACT_MIMES = new Set(Object.keys(EXACT_MIME_EXTENSIONS));

export interface AppConfig {
  cloudBaseEnvId: string;
  cloudBaseServiceRoleKey?: string;
  cloudBasePublicBucket: string;
  maxFileBytes: number;
  port: number;
  publicOrigin?: string;
  corsOrigins: string[];
  rateLimitWindowMs: number;
  rateLimitMaxRequests: number;
  maxListLimit: number;
}

export class ConfigError extends Error {
  readonly code: StorageErrorCode = 'CONFIG_MISSING';

  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const corsOrigins = (env.CORS_ORIGINS || '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    cloudBaseEnvId: env.CLOUDBASE_ENV_ID?.trim() || DEFAULT_ENV_ID,
    cloudBaseServiceRoleKey: env.CLOUDBASE_SERVICE_ROLE_KEY?.trim() || undefined,
    cloudBasePublicBucket: env.CLOUDBASE_PUBLIC_BUCKET?.trim() || DEFAULT_BUCKET_ID,
    maxFileBytes: positiveInteger(env.CLOUDBASE_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    port: positiveInteger(env.PORT, 8787),
    publicOrigin: env.PUBLIC_ORIGIN?.trim() || undefined,
    corsOrigins: corsOrigins.length > 0 ? corsOrigins : ['*'],
    rateLimitWindowMs: positiveInteger(env.RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS),
    rateLimitMaxRequests: positiveInteger(env.RATE_LIMIT_MAX_REQUESTS, DEFAULT_RATE_LIMIT_MAX_REQUESTS),
    maxListLimit: positiveInteger(env.MAX_LIST_LIMIT, DEFAULT_MAX_LIST_LIMIT),
  };
}

export function isAllowedMimeType(mimeType: string): boolean {
  const normalized = mimeType.trim().toLowerCase();
  return EXACT_MIMES.has(normalized) || normalized.startsWith('font/');
}

export function extensionForMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  const exact = EXACT_MIME_EXTENSIONS[normalized];
  if (exact) return exact;
  if (normalized.startsWith('font/')) {
    const subtype = normalized.slice('font/'.length).replace(/[^a-z0-9]/g, '');
    return subtype || 'font';
  }
  throw new ConfigError(`Unsupported MIME type: ${mimeType}`);
}

export function validateProjectId(projectId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
    throw new ConfigError('projectId must contain only letters, numbers, underscores, or hyphens');
  }
  return projectId;
}

export function validateScope(scope: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scope)) {
    throw new ConfigError('scope must contain only letters, numbers, underscores, or hyphens');
  }
  return scope;
}

export function validateObjectName(objectName: string): string {
  if (
    !/^[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9]{1,16}$/.test(objectName) ||
    objectName.includes('..') ||
    objectName.includes('/') ||
    objectName.includes('\\')
  ) {
    throw new ConfigError('objectName is not a safe object name');
  }
  return objectName;
}

export function buildObjectPath(projectId: string, scope: string, extension: string): string {
  const safeProjectId = validateProjectId(projectId);
  const safeScope = validateScope(scope);
  const safeExtension = extension.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!safeExtension) throw new ConfigError('file extension is missing');
  return `projects/${safeProjectId}/${safeScope}/${crypto.randomUUID()}.${safeExtension}`;
}

export function validateOriginalNameExtension(name: string, mimeType: string): void {
  const extension = name.split('.').pop()?.toLowerCase();
  if (!extension) return;

  const expected = extensionForMimeType(mimeType);
  const aliases: Record<string, string[]> = {
    jpg: ['jpeg', 'jpg'],
    js: ['js', 'mjs', 'cjs'],
    font: ['font'],
  };
  const allowed = aliases[expected] || [expected];
  if (!allowed.includes(extension)) {
    throw new ConfigError(`Filename extension does not match MIME type ${mimeType}`);
  }
}

export function extensionMatchesMimeType(objectName: string, mimeType: string): boolean {
  const extension = objectName.split('.').pop()?.toLowerCase();
  if (!extension) return false;
  const expected = extensionForMimeType(mimeType);
  const aliases: Record<string, string[]> = {
    jpg: ['jpeg', 'jpg'],
    js: ['js', 'mjs', 'cjs'],
  };
  return (aliases[expected] || [expected]).includes(extension);
}
