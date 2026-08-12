export type PublicStorageFileRef = {
  bucketId: string;
  path: string;
  projectId: string;
  scope: string;
  visibility: 'public';
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  contentUrl: string;
  downloadUrl: string;
};

type ApiResponse<T> = { data: T };

export class PublicStorageProxyClient {
  constructor(
    private readonly endpoint: string,
    private readonly projectId: string,
  ) {}

  async upload(file: File, scope: string): Promise<PublicStorageFileRef> {
    const form = new FormData();
    form.set('projectId', this.projectId);
    form.set('scope', scope);
    form.set('file', file);
    const response = await fetch(`${this.endpoint}/v1/files`, { method: 'POST', body: form });
    return this.read<ApiResponse<PublicStorageFileRef>>(response).then((result) => result.data);
  }

  async list(scope?: string): Promise<PublicStorageFileRef[]> {
    const query = new URLSearchParams({ projectId: this.projectId });
    if (scope) query.set('scope', scope);
    const response = await fetch(`${this.endpoint}/v1/files?${query}`);
    const result = await this.read<ApiResponse<{ files: PublicStorageFileRef[] }>>(response);
    return result.data.files;
  }

  async update(file: File, ref: Pick<PublicStorageFileRef, 'projectId' | 'scope' | 'path'>): Promise<PublicStorageFileRef> {
    const objectName = ref.path.split('/').pop();
    if (!objectName) throw new Error('Invalid storage file reference');
    const form = new FormData();
    form.set('projectId', ref.projectId);
    form.set('scope', ref.scope);
    form.set('file', file);
    const response = await fetch(
      `${this.endpoint}/v1/files/${encodeURIComponent(ref.projectId)}/${encodeURIComponent(ref.scope)}/${encodeURIComponent(objectName)}`,
      { method: 'PUT', body: form },
    );
    return this.read<ApiResponse<PublicStorageFileRef>>(response).then((result) => result.data);
  }

  async remove(ref: Pick<PublicStorageFileRef, 'projectId' | 'scope' | 'path'>): Promise<void> {
    const objectName = ref.path.split('/').pop();
    if (!objectName) throw new Error('Invalid storage file reference');
    const response = await fetch(
      `${this.endpoint}/v1/files/${encodeURIComponent(ref.projectId)}/${encodeURIComponent(ref.scope)}/${encodeURIComponent(objectName)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) await this.read(response);
  }

  getPreviewUrl(ref: Pick<PublicStorageFileRef, 'contentUrl'>): string {
    return ref.contentUrl;
  }

  getDownloadUrl(ref: Pick<PublicStorageFileRef, 'downloadUrl'>): string {
    return ref.downloadUrl;
  }

  private async read<T>(response: Response): Promise<T> {
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(payload?.error?.message || `Storage proxy request failed: ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}

// Example:
// const storage = new PublicStorageProxyClient(import.meta.env.VITE_STORAGE_PROXY_URL, 'shop');
// const cover = await storage.upload(file, 'product-covers');
// image.src = storage.getPreviewUrl(cover);
