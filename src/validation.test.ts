import { describe, expect, it } from 'vitest';
import {
  buildObjectPath,
  extensionForMimeType,
  extensionMatchesMimeType,
  isAllowedMimeType,
  validateObjectName,
  validateProjectId,
  validateScope,
} from './config.js';

describe('storage validation', () => {
  it('accepts the supported MIME types and maps safe extensions', () => {
    expect(isAllowedMimeType('image/png')).toBe(true);
    expect(isAllowedMimeType('video/mp4')).toBe(true);
    expect(isAllowedMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true);
    expect(extensionForMimeType('image/jpeg')).toBe('jpg');
    expect(extensionForMimeType('application/json')).toBe('json');
    expect(isAllowedMimeType('application/x-executable')).toBe(false);
  });

  it('rejects unsafe path components', () => {
    expect(() => validateProjectId('../other-project')).toThrow();
    expect(() => validateScope('article/images')).toThrow();
    expect(() => validateObjectName('../secret.txt')).toThrow();
    expect(() => validateObjectName('a/b.txt')).toThrow();
  });

  it('builds the required project-scoped object path', () => {
    const path = buildObjectPath('shop', 'product-covers', 'jpg');
    expect(path).toMatch(/^projects\/shop\/product-covers\/[0-9a-f-]+\.jpg$/);
  });

  it('matches update MIME types to the existing object extension', () => {
    expect(extensionMatchesMimeType('cover.jpg', 'image/jpeg')).toBe(true);
    expect(extensionMatchesMimeType('cover.png', 'image/jpeg')).toBe(false);
  });
});
