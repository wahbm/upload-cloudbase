import { cors } from 'hono/cors';
import { Hono } from 'hono';
import type { AppConfig } from './config.js';
import {
  buildObjectPath,
  extensionForMimeType,
  extensionMatchesMimeType,
  isAllowedMimeType,
  validateObjectName,
  validateOriginalNameExtension,
  validateProjectId,
  validateScope,
} from './config.js';
import { AppError, errorResponse } from './errors.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import type { StorageBackend, StorageUploadInput } from './cloudbase-pg-storage.js';
import type { StorageFileRef, StorageObjectInfo } from './types.js';

interface UploadPayload {
  projectId: string;
  scope: string;
  file: File;
}

type AppEnv = {
  Variables: {
    requestId: string;
  };
};

export interface AppDependencies {
  config: AppConfig;
  storage: StorageBackend;
  limiter?: FixedWindowRateLimiter;
  publicOrigin?: string;
}

function requestId(): string {
  return crypto.randomUUID();
}

function requestIp(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown';
}

function contentUrl(origin: string, projectId: string, scope: string, objectName: string, download = false): string {
  const url = new URL(`/v1/files/${encodeURIComponent(projectId)}/${encodeURIComponent(scope)}/${encodeURIComponent(objectName)}/content`, origin);
  if (download) url.searchParams.set('download', '1');
  return url.toString();
}

function parseObjectRoute(projectIdRaw: string, scopeRaw: string, objectNameRaw: string): { projectId: string; scope: string; objectName: string; path: string } {
  const projectId = validateProjectId(projectIdRaw);
  const scope = validateScope(scopeRaw);
  const objectName = validateObjectName(objectNameRaw);
  return { projectId, scope, objectName, path: `projects/${projectId}/${scope}/${objectName}` };
}

function isFile(value: FormDataEntryValue | null): value is File {
  return value instanceof Blob && 'name' in value;
}

async function parseMultipartUpload(request: Request, expected?: { projectId: string; scope: string }): Promise<UploadPayload> {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw new AppError('INVALID_REQUEST', 'Upload requests must use multipart/form-data', 400);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AppError('INVALID_REQUEST', 'The multipart request could not be parsed', 400);
  }

  const projectId = String(form.get('projectId') || expected?.projectId || '');
  const scope = String(form.get('scope') || expected?.scope || '');
  const file = form.get('file');
  if (!projectId || !scope || !isFile(file)) {
    throw new AppError('INVALID_REQUEST', 'projectId, scope, and file are required', 400);
  }
  if (expected && (projectId !== expected.projectId || scope !== expected.scope)) {
    throw new AppError('INVALID_REQUEST', 'Route and form projectId/scope must match', 400);
  }
  return { projectId, scope, file };
}

function validateUploadFile(file: File, maxFileBytes: number): string {
  const mimeType = file.type.trim().toLowerCase();
  if (!isAllowedMimeType(mimeType)) {
    throw new AppError('INVALID_FILE', `Unsupported MIME type: ${mimeType || 'unknown'}`, 400);
  }
  if (file.size <= 0) throw new AppError('INVALID_FILE', 'The file is empty', 400);
  if (file.size > maxFileBytes) throw new AppError('FILE_TOO_LARGE', 'File exceeds the configured size limit', 413);
  validateOriginalNameExtension(file.name || 'upload', mimeType);
  return extensionForMimeType(mimeType);
}

function uploadInput(file: File, overwrite: boolean): StorageUploadInput {
  return {
    body: file.stream(),
    contentType: file.type.toLowerCase(),
    sizeBytes: file.size,
    originalName: file.name || 'upload',
    metadata: {
      originalName: file.name || 'upload',
    },
    overwrite,
  };
}

function objectRef(
  info: StorageObjectInfo,
  projectId: string,
  scope: string,
  origin: string,
): StorageFileRef {
  const objectName = info.name.split('/').pop() || info.name;
  const originalName = typeof info.metadata?.originalName === 'string'
    ? info.metadata.originalName
    : objectName;
  return {
    bucketId: info.bucketId,
    path: info.name,
    projectId,
    scope,
    visibility: 'public',
    originalName,
    mimeType: info.mimeType,
    sizeBytes: info.sizeBytes,
    contentUrl: contentUrl(origin, projectId, scope, objectName),
    downloadUrl: contentUrl(origin, projectId, scope, objectName, true),
  };
}

function inferRouteOrigin(request: Request, configuredOrigin?: string): string {
  if (configuredOrigin) return configuredOrigin.replace(/\/$/, '');
  return new URL(request.url).origin;
}

function copyContentHeaders(source: Headers, destination: Headers): void {
  for (const name of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ]) {
    const value = source.get(name);
    if (value) destination.set(name, value);
  }
}

export function createApp(dependencies: AppDependencies): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const limiter = dependencies.limiter || new FixedWindowRateLimiter(
    dependencies.config.rateLimitWindowMs,
    dependencies.config.rateLimitMaxRequests,
  );

  app.use('*', async (context, next) => {
    const id = requestId();
    context.set('requestId', id);
    context.header('X-Request-Id', id);
    await next();
  });

  const origins = dependencies.config.corsOrigins;
  app.use('*', cors({
    origin: (origin) => origins.includes('*') ? '*' : origins.includes(origin) ? origin : null,
    allowMethods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Range', 'If-None-Match', 'If-Modified-Since'],
    exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'Content-Disposition', 'ETag', 'Last-Modified', 'X-Request-Id'],
    credentials: false,
  }));

  app.use('/v1/*', async (context, next) => {
    if (!limiter.allow(requestIp(context.req.raw))) {
      throw new AppError('RATE_LIMITED', 'Too many requests', 429);
    }
    if (['POST', 'PUT'].includes(context.req.method)) {
      const contentLength = Number(context.req.header('content-length') || 0);
      if (contentLength > dependencies.config.maxFileBytes + 1024 * 1024) {
        throw new AppError('FILE_TOO_LARGE', 'Request body exceeds the configured size limit', 413);
      }
    }
    await next();
  });

  app.get('/healthz', (context) => context.json({
    status: 'ok',
    service: 'cloudbase-public-file-proxy',
    storageConfigured: Boolean(dependencies.config.cloudBaseServiceRoleKey),
  }));

  app.post('/v1/files', async (context) => {
    const payload = await parseMultipartUpload(context.req.raw);
    const projectId = validateProjectId(payload.projectId);
    const scope = validateScope(payload.scope);
    const extension = validateUploadFile(payload.file, dependencies.config.maxFileBytes);
    const path = buildObjectPath(projectId, scope, extension);
    await dependencies.storage.upload(path, uploadInput(payload.file, false));
    const info = await dependencies.storage.info(path);
    const origin = inferRouteOrigin(context.req.raw, dependencies.publicOrigin);
    return context.json({ data: objectRef({ ...info, name: path }, projectId, scope, origin) }, 201);
  });

  app.put('/v1/files/:projectId/:scope/:objectName', async (context) => {
    const route = parseObjectRoute(
      context.req.param('projectId'),
      context.req.param('scope'),
      context.req.param('objectName'),
    );
    const payload = await parseMultipartUpload(context.req.raw, { projectId: route.projectId, scope: route.scope });
    const extension = validateUploadFile(payload.file, dependencies.config.maxFileBytes);
    if (!extensionMatchesMimeType(route.objectName, payload.file.type)) {
      throw new AppError('INVALID_FILE', 'Updated file MIME type does not match the object extension', 400);
    }
    await dependencies.storage.update(route.path, uploadInput(payload.file, true));
    const info = await dependencies.storage.info(route.path);
    const origin = inferRouteOrigin(context.req.raw, dependencies.publicOrigin);
    return context.json({ data: objectRef({ ...info, name: route.path, mimeType: payload.file.type, sizeBytes: payload.file.size }, route.projectId, route.scope, origin) });
  });

  app.get('/v1/files', async (context) => {
    const projectId = validateProjectId(context.req.query('projectId') || '');
    const scopeValue = context.req.query('scope');
    const scope = scopeValue ? validateScope(scopeValue) : undefined;
    const rawLimit = Number(context.req.query('limit') || dependencies.config.maxListLimit);
    const limit = Number.isInteger(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, dependencies.config.maxListLimit)
      : dependencies.config.maxListLimit;
    const cursor = context.req.query('cursor');
    const prefix = `projects/${projectId}/${scope ? `${scope}/` : ''}`;
    const result = await dependencies.storage.list(prefix, limit, cursor);
    const origin = inferRouteOrigin(context.req.raw, dependencies.publicOrigin);
    const files = result.objects.flatMap((info) => {
      const parts = info.name.split('/');
      if (parts.length !== 4 || parts[0] !== 'projects' || parts[1] !== projectId) return [];
      return [objectRef(info, projectId, parts[2]!, origin)];
    });
    return context.json({ data: { files, cursor: result.cursor } });
  });

  app.get('/v1/files/:projectId/:scope/:objectName/content', async (context) => {
    const route = parseObjectRoute(
      context.req.param('projectId'),
      context.req.param('scope'),
      context.req.param('objectName'),
    );
    const upstream = await dependencies.storage.download(route.path, {
      range: context.req.header('range'),
      ifNoneMatch: context.req.header('if-none-match'),
      ifModifiedSince: context.req.header('if-modified-since'),
    });
    const headers = new Headers();
    copyContentHeaders(upstream.headers, headers);
    const download = context.req.query('download') === '1' || context.req.query('download') === 'true';
    headers.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${encodeURIComponent(route.objectName)}"`);
    return new Response(upstream.body, { status: upstream.status, headers });
  });

  app.get('/v1/files/:projectId/:scope/:objectName', async (context) => {
    const route = parseObjectRoute(
      context.req.param('projectId'),
      context.req.param('scope'),
      context.req.param('objectName'),
    );
    const info = await dependencies.storage.info(route.path);
    const origin = inferRouteOrigin(context.req.raw, dependencies.publicOrigin);
    return context.json({ data: objectRef({ ...info, name: route.path }, route.projectId, route.scope, origin) });
  });

  app.delete('/v1/files/:projectId/:scope/:objectName', async (context) => {
    const route = parseObjectRoute(
      context.req.param('projectId'),
      context.req.param('scope'),
      context.req.param('objectName'),
    );
    await dependencies.storage.remove(route.path);
    return new Response(null, { status: 204, headers: { 'X-Request-Id': context.get('requestId') } });
  });

  app.onError((error, context) => errorResponse(context, error, context.get('requestId') || 'unknown'));
  return app;
}
