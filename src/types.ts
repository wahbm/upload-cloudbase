export type StorageVisibility = 'public';

export type StorageErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'INVALID_FILE'
  | 'FILE_TOO_LARGE'
  | 'NOT_FOUND'
  | 'URL_EXPIRED'
  | 'CONFIG_MISSING'
  | 'STORAGE_UNAVAILABLE'
  | 'CONFLICT'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED';

export interface StorageFileRef {
  bucketId: string;
  path: string;
  projectId: string;
  scope: string;
  visibility: StorageVisibility;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  contentUrl: string;
  downloadUrl: string;
}

export interface StorageObjectInfo {
  id?: string;
  name: string;
  bucketId: string;
  sizeBytes: number;
  mimeType: string;
  cacheControl?: string;
  etag?: string;
  metadata?: Record<string, unknown>;
  lastModified?: string;
  createdAt?: string;
}

export interface ListResult {
  objects: StorageObjectInfo[];
  cursor?: string;
}
