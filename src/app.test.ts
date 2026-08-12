import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { DEFAULT_BUCKET_ID, DEFAULT_MAX_FILE_BYTES, DEFAULT_RATE_LIMIT_MAX_REQUESTS, DEFAULT_RATE_LIMIT_WINDOW_MS } from './config.js';
import type { StorageBackend } from './cloudbase-pg-storage.js';
import type { ListResult, StorageObjectInfo } from './types.js';

function config() {
  return {
    cloudBaseEnvId: 'test-env',
    cloudBaseServiceRoleKey: 'server-only-test-key',
    cloudBasePublicBucket: DEFAULT_BUCKET_ID,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    port: 8787,
    corsOrigins: ['*'],
    rateLimitWindowMs: DEFAULT_RATE_LIMIT_WINDOW_MS,
    rateLimitMaxRequests: DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    maxListLimit: 100,
  };
}

class FakeStorage implements StorageBackend {
  objects = new Map<string, StorageObjectInfo>();
  contents = new Map<string, Uint8Array>();
  lastDownloadHeaders = new Headers();

  async upload(path: string, input: { body: BodyInit; contentType: string; sizeBytes: number; originalName: string }): Promise<void> {
    if (this.objects.has(path)) {
      const error = new Error('exists') as Error & { status?: number; upstreamCode?: string };
      error.status = 409;
      error.upstreamCode = 'OBJECT_ALREADY_EXIST';
      throw error;
    }
    await this.write(path, input);
  }

  async update(path: string, input: { body: BodyInit; contentType: string; sizeBytes: number; originalName: string }): Promise<void> {
    await this.write(path, input);
  }

  private async write(path: string, input: { body: BodyInit; contentType: string; sizeBytes: number; originalName: string }): Promise<void> {
    const response = new Response(input.body);
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.contents.set(path, bytes);
    this.objects.set(path, {
      name: path,
      bucketId: DEFAULT_BUCKET_ID,
      sizeBytes: input.sizeBytes,
      mimeType: input.contentType,
      metadata: { originalName: input.originalName },
    });
  }

  async list(prefix: string, limit: number, cursor?: string): Promise<ListResult> {
    const all = [...this.objects.values()].filter((object) => object.name.startsWith(prefix));
    const start = cursor ? Number(cursor) : 0;
    const objects = all.slice(start, start + limit);
    return { objects, cursor: start + limit < all.length ? String(start + limit) : undefined };
  }

  async info(path: string): Promise<StorageObjectInfo> {
    const object = this.objects.get(path);
    if (!object) throw new Error('not found');
    return object;
  }

  async remove(path: string): Promise<void> {
    this.objects.delete(path);
    this.contents.delete(path);
  }

  async download(path: string, options?: { range?: string }): Promise<Response> {
    const content = this.contents.get(path);
    const info = this.objects.get(path);
    if (!content || !info) throw new Error('not found');
    this.lastDownloadHeaders = new Headers({ range: options?.range || '' });
    return new Response(content as unknown as BodyInit, {
      status: options?.range ? 206 : 200,
      headers: {
        'Content-Type': info.mimeType,
        'Content-Length': String(content.byteLength),
        'Accept-Ranges': 'bytes',
        ...(options?.range ? { 'Content-Range': `bytes 0-${content.byteLength - 1}/${content.byteLength}` } : {}),
      },
    });
  }
}

function multipart(projectId: string, scope: string, name = 'cover.jpg', type = 'image/jpeg', body = 'image-bytes'): FormData {
  const form = new FormData();
  form.set('projectId', projectId);
  form.set('scope', scope);
  form.set('file', new File([body], name, { type }));
  return form;
}

describe('file proxy API', () => {
  it('uploads a public file and returns a proxy URL', async () => {
    const storage = new FakeStorage();
    const app = createApp({ config: config(), storage, publicOrigin: 'https://files.example.test' });
    const response = await app.request('/v1/files', { method: 'POST', body: multipart('shop', 'product-covers') });
    expect(response.status).toBe(201);
    const body = await response.json() as { data: { path: string; contentUrl: string; visibility: string } };
    expect(body.data.path).toMatch(/^projects\/shop\/product-covers\//);
    expect(body.data.contentUrl).toContain('https://files.example.test/v1/files/shop/product-covers/');
    expect(body.data.visibility).toBe('public');
  });

  it('rejects unsupported MIME types and unsafe scopes', async () => {
    const app = createApp({ config: config(), storage: new FakeStorage() });
    const invalidMime = await app.request('/v1/files', { method: 'POST', body: multipart('shop', 'assets', 'payload.exe', 'application/x-executable') });
    expect(invalidMime.status).toBe(400);
    const invalidScope = await app.request('/v1/files', { method: 'POST', body: multipart('shop', '../private') });
    expect(invalidScope.status).toBe(400);
  });

  it('lists, updates, streams, and deletes an object', async () => {
    const storage = new FakeStorage();
    const app = createApp({ config: config(), storage, publicOrigin: 'https://files.example.test' });
    const uploaded = await app.request('/v1/files', { method: 'POST', body: multipart('shop', 'product-covers') });
    const uploadedBody = await uploaded.json() as { data: { path: string } };
    const [, projectId, scope, objectName] = uploadedBody.data.path.split('/');

    const listed = await app.request(`/v1/files?projectId=${projectId}&scope=${scope}`);
    expect(listed.status).toBe(200);
    expect((await listed.json() as { data: { files: unknown[] } }).data.files).toHaveLength(1);

    const updated = await app.request(`/v1/files/${projectId}/${scope}/${objectName}`, { method: 'PUT', body: multipart(projectId!, scope!, 'new-cover.jpg', 'image/jpeg', 'updated') });
    expect(updated.status).toBe(200);

    const range = await app.request(`/v1/files/${projectId}/${scope}/${objectName}/content`, { headers: { Range: 'bytes=0-1' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('accept-ranges')).toBe('bytes');
    expect(range.headers.get('content-disposition')).toContain('inline');

    const removed = await app.request(`/v1/files/${projectId}/${scope}/${objectName}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });

  it('adds CORS headers without enabling credentials', async () => {
    const app = createApp({ config: config(), storage: new FakeStorage() });
    const response = await app.request('/healthz', { headers: { Origin: 'https://any.example' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });
});
