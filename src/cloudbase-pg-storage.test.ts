import { describe, expect, it } from 'vitest';
import { CloudBasePgStorage } from './cloudbase-pg-storage.js';
import { DEFAULT_BUCKET_ID, DEFAULT_MAX_FILE_BYTES } from './config.js';

function config() {
  return {
    cloudBaseEnvId: 'test-env',
    cloudBaseServiceRoleKey: 'do-not-return-this-key',
    cloudBasePublicBucket: DEFAULT_BUCKET_ID,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    port: 8787,
    corsOrigins: ['*'],
    rateLimitWindowMs: 60_000,
    rateLimitMaxRequests: 60,
    maxListLimit: 100,
  };
}

describe('CloudBase PG HTTP adapter', () => {
  it('sends a binary upload to the PG Storage object endpoint', async () => {
    let received: { url: string; init: RequestInit } | undefined;
    const storage = new CloudBasePgStorage(config(), async (input, init) => {
      received = { url: String(input), init: init || {} };
      return new Response(JSON.stringify({ Id: 'object-id', Key: 'public-assets/projects/shop/assets/a.jpg' }), { status: 201 });
    });

    await storage.upload('projects/shop/assets/a.jpg', {
      body: new Blob(['image']),
      contentType: 'image/jpeg',
      sizeBytes: 5,
      originalName: 'a.jpg',
      metadata: { scope: 'assets' },
      overwrite: false,
    });

    expect(received?.url).toBe('https://test-env.api.tcloudbasegateway.com/v1/storages/object/public-assets/projects/shop/assets/a.jpg');
    expect(received?.init.method).toBe('POST');
    expect(new Headers(received?.init.headers).get('Authorization')).toBe('Bearer do-not-return-this-key');
    expect(new Headers(received?.init.headers).get('x-upsert')).toBe('false');
    expect(JSON.stringify(received)).not.toContain('service_role');
  });

  it('uses the cursor list endpoint and normalizes object metadata', async () => {
    let received: { url: string; init: RequestInit } | undefined;
    const storage = new CloudBasePgStorage(config(), async (input, init) => {
      received = { url: String(input), init: init || {} };
      return new Response(JSON.stringify({
        objects: [{ name: 'projects/shop/assets/a.jpg', size: 5, content_type: 'image/jpeg', metadata: { originalName: 'a.jpg' } }],
        nextCursor: 'next-page',
      }), { status: 200 });
    });

    const result = await storage.list('projects/shop/assets/', 20, 'cursor');
    expect(received?.url).toContain('/object/list/public-assets');
    expect(JSON.parse(String(received?.init.body))).toEqual({
      prefix: 'projects/shop/assets/',
      limit: 20,
      cursor: 'cursor',
      with_delimiter: false,
    });
    expect(result.cursor).toBe('next-page');
    expect(result.objects[0]?.mimeType).toBe('image/jpeg');
  });
});
