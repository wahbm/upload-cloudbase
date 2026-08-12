import { CloudBaseApiError } from './errors.js';
import type { AppConfig } from './config.js';
import type { ListResult, StorageObjectInfo } from './types.js';

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface StorageUploadInput {
  body: BodyInit;
  contentType: string;
  sizeBytes: number;
  originalName: string;
  metadata: Record<string, string>;
  overwrite: boolean;
}

export interface StorageDownloadOptions {
  range?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: string;
}

export interface StorageBackend {
  upload(path: string, input: StorageUploadInput): Promise<void>;
  update(path: string, input: StorageUploadInput): Promise<void>;
  list(prefix: string, limit: number, cursor?: string): Promise<ListResult>;
  info(path: string): Promise<StorageObjectInfo>;
  remove(path: string): Promise<void>;
  download(path: string, options?: StorageDownloadOptions): Promise<Response>;
}

interface CloudBaseObjectPayload {
  Id?: string;
  Key?: string;
  id?: string;
  path?: string;
  name?: string;
  bucket_id?: string;
  size?: number;
  content_type?: string;
  cache_control?: string;
  etag?: string;
  metadata?: Record<string, unknown>;
  last_modified?: string;
  created_at?: string;
}

function encodeObjectPath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function base64Json(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function unwrapPayload(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return (payload as { data?: unknown }).data;
  }
  return payload;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export class CloudBasePgStorage implements StorageBackend {
  private readonly baseUrl: string;
  private readonly fetcher: Fetcher;

  constructor(
    private readonly config: AppConfig,
    fetcher: Fetcher = fetch,
  ) {
    this.baseUrl = `https://${config.cloudBaseEnvId}.api.tcloudbasegateway.com/v1/storages`;
    this.fetcher = fetcher;
  }

  private requireCredentials(): string {
    if (!this.config.cloudBaseServiceRoleKey) {
      throw new CloudBaseApiError(500, 'CLOUDBASE_SERVICE_ROLE_KEY is not configured', 'CONFIG_MISSING');
    }
    return this.config.cloudBaseServiceRoleKey;
  }

  private async request(
    method: string,
    path: string,
    options: {
      body?: BodyInit;
      headers?: Record<string, string>;
      query?: Record<string, string | undefined>;
      json?: unknown;
      stream?: boolean;
    } = {},
  ): Promise<Response> {
    const token = this.requireCredentials();
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (options.json !== undefined) headers.set('Content-Type', 'application/json');

    const body = options.json !== undefined ? JSON.stringify(options.json) : options.body;
    const init: RequestInit & { duplex?: 'half' } = {
      method,
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    };
    const response = await this.fetcher(url, init);
    if (options.stream) return response;

    if (!response.ok) {
      throw await this.toApiError(response);
    }
    return response;
  }

  private async toApiError(response: Response): Promise<CloudBaseApiError> {
    let message = `CloudBase request failed with status ${response.status}`;
    let code: string | undefined;
    try {
      const payload = asRecord(await response.clone().json());
      const nested = asRecord(payload.error);
      code = String(payload.code || nested.code || payload.error_code || '') || undefined;
      message = String(payload.message || nested.message || message);
    } catch {
      // Keep the generic status message when CloudBase did not return JSON.
    }
    return new CloudBaseApiError(response.status, message, code);
  }

  private async json<T>(response: Response): Promise<T> {
    const payload = unwrapPayload(await response.json());
    return payload as T;
  }

  private uploadHeaders(input: StorageUploadInput): Record<string, string> {
    return {
      'Content-Type': input.contentType,
      'Content-Length': String(input.sizeBytes),
      'Cache-Control': 'max-age=3600',
      'x-metadata': base64Json({
        ...input.metadata,
        originalName: input.originalName,
      }),
      ...(input.overwrite ? { 'x-upsert': 'true' } : { 'x-upsert': 'false' }),
    };
  }

  async upload(path: string, input: StorageUploadInput): Promise<void> {
    const response = await this.request(
      'POST',
      `/object/${encodeURIComponent(this.config.cloudBasePublicBucket)}/${encodeObjectPath(path)}`,
      { body: input.body, headers: this.uploadHeaders(input) },
    );
    await response.body?.cancel();
  }

  async update(path: string, input: StorageUploadInput): Promise<void> {
    const response = await this.request(
      'PUT',
      `/object/${encodeURIComponent(this.config.cloudBasePublicBucket)}/${encodeObjectPath(path)}`,
      { body: input.body, headers: this.uploadHeaders({ ...input, overwrite: true }) },
    );
    await response.body?.cancel();
  }

  async list(prefix: string, limit: number, cursor?: string): Promise<ListResult> {
    const response = await this.request('POST', `/object/list/${encodeURIComponent(this.config.cloudBasePublicBucket)}`, {
      json: {
        prefix,
        limit,
        ...(cursor ? { cursor } : {}),
        with_delimiter: false,
      },
    });
    const payload = asRecord(await this.json<unknown>(response));
    const objects = Array.isArray(payload.objects) ? payload.objects : [];
    return {
      objects: objects.map((object) => this.toObjectInfo(asRecord(object), prefix)),
      cursor: typeof payload.nextCursor === 'string'
        ? payload.nextCursor
        : typeof payload.next_cursor === 'string'
          ? payload.next_cursor
          : undefined,
    };
  }

  async info(path: string): Promise<StorageObjectInfo> {
    const response = await this.request(
      'GET',
      `/object/info/${encodeURIComponent(this.config.cloudBasePublicBucket)}/${encodeObjectPath(path)}`,
    );
    return this.toObjectInfo(asRecord(await this.json<CloudBaseObjectPayload>(response)), path);
  }

  async remove(path: string): Promise<void> {
    const response = await this.request('DELETE', `/object/${encodeURIComponent(this.config.cloudBasePublicBucket)}`, {
      json: { prefixes: [path] },
    });
    await response.body?.cancel();
  }

  async download(path: string, options: StorageDownloadOptions = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (options.range) headers.Range = options.range;
    if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;
    if (options.ifModifiedSince) headers['If-Modified-Since'] = options.ifModifiedSince;
    const response = await this.request(
      'GET',
      `/object/${encodeURIComponent(this.config.cloudBasePublicBucket)}/${encodeObjectPath(path)}`,
      { headers, stream: true },
    );
    if (!response.ok) throw await this.toApiError(response);
    return response;
  }

  private toObjectInfo(payload: Record<string, unknown>, fallbackName: string): StorageObjectInfo {
    const metadata = payload.metadata && typeof payload.metadata === 'object'
      ? payload.metadata as Record<string, unknown>
      : undefined;
    return {
      id: typeof payload.id === 'string' ? payload.id : typeof payload.Id === 'string' ? payload.Id : undefined,
      name: String(payload.name || payload.path || payload.Key || fallbackName),
      bucketId: String(payload.bucket_id || this.config.cloudBasePublicBucket),
      sizeBytes: Number(payload.size || 0),
      mimeType: String(payload.content_type || payload.contentType || 'application/octet-stream'),
      cacheControl: typeof payload.cache_control === 'string' ? payload.cache_control : undefined,
      etag: typeof payload.etag === 'string' ? payload.etag : undefined,
      metadata,
      lastModified: typeof payload.last_modified === 'string' ? payload.last_modified : undefined,
      createdAt: typeof payload.created_at === 'string' ? payload.created_at : undefined,
    };
  }
}
