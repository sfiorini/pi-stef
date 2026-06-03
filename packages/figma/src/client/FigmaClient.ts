import { FigmaAuthorization } from '../auth/FigmaAuthorization';
import { FigmaCache } from '../cache/FigmaCache';
import type { FigmaFileResponse, FigmaNodesResponse } from '../schemas';
import { FigmaApiError, describeFigmaStatus } from './FigmaErrors';
import { parseRetryAfterMs, sleep } from './rateLimit';

export { FigmaApiError } from './FigmaErrors';

export const FIGMA_API_BASE = 'https://api.figma.com/v1';

export const FIGMA_REQUEST_TIMEOUT_MS = 15_000;
export const FIGMA_MAX_RETRIES = 3;
export const FIGMA_RETRY_AFTER_CAP_MS = 10_000;

export interface FigmaClientOptions {
  apiToken?: string;
  auth?: FigmaAuthorization;
  cache?: FigmaCache;
  timeoutMs?: number;
  maxRetries?: number;
  retryAfterCapMs?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
  cache?: boolean;
  cacheParts?: unknown[];
  query?: Record<string, string | number | boolean | undefined>;
}

export class FigmaClient {
  private readonly auth: FigmaAuthorization;
  private readonly cache?: FigmaCache;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryAfterCapMs: number;

  constructor(options: FigmaClientOptions = {}) {
    if (!options.auth && options.apiToken !== undefined && !options.apiToken.trim()) {
      throw new Error('Figma API token is required.');
    }
    this.auth =
      options.auth ??
      ({
        getConfig: () => ({ apiToken: options.apiToken ?? '' }),
      } as FigmaAuthorization);
    this.cache = options.cache;
    this.timeoutMs = options.timeoutMs ?? FIGMA_REQUEST_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? FIGMA_MAX_RETRIES;
    this.retryAfterCapMs = options.retryAfterCapMs ?? FIGMA_RETRY_AFTER_CAP_MS;
  }

  async getFile(
    fileKey: string,
    options: { ids?: string[]; depth?: number; branchData?: boolean; signal?: AbortSignal } = {},
  ): Promise<FigmaFileResponse> {
    const version = this.cache ? await this.getFileVersion(fileKey, options.signal) : undefined;
    return this.getJson<FigmaFileResponse>(`/files/${fileKey}`, {
      signal: options.signal,
      cache: true,
      cacheParts: ['file', fileKey, version, options],
      query: {
        ids: options.ids?.join(','),
        depth: options.depth,
        branch_data: options.branchData,
      },
    });
  }

  async getNodes(
    fileKey: string,
    nodeIds: string[],
    options: { depth?: number; signal?: AbortSignal } = {},
  ): Promise<FigmaNodesResponse> {
    if (nodeIds.length === 0) throw new Error('At least one node ID is required.');
    const version = this.cache ? await this.getFileVersion(fileKey, options.signal) : undefined;
    return this.getJson<FigmaNodesResponse>(`/files/${fileKey}/nodes`, {
      signal: options.signal,
      cache: true,
      cacheParts: ['nodes', fileKey, version, nodeIds, options],
      query: {
        ids: nodeIds.join(','),
        depth: options.depth,
      },
    });
  }

  async getImageRenderUrls(
    fileKey: string,
    nodeIds: string[],
    options: { format?: string; scale?: number; signal?: AbortSignal } = {},
  ): Promise<{ err: string | null; images: Record<string, string | null> }> {
    return this.getJson(`/images/${fileKey}`, {
      signal: options.signal,
      cache: false,
      query: {
        ids: nodeIds.join(','),
        format: options.format,
        scale: options.scale,
      },
    });
  }

  async getImageFills(fileKey: string, signal?: AbortSignal): Promise<{ meta: { images: Record<string, string> } }> {
    return this.getJson(`/files/${fileKey}/images`, { signal, cache: false });
  }

  async getComments(fileKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.getJson(`/files/${fileKey}/comments`, { signal });
  }

  async getStyles(fileKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.getJson(`/files/${fileKey}/styles`, { signal });
  }

  async getComponents(fileKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.getJson(`/files/${fileKey}/components`, { signal });
  }

  async getComponentSets(fileKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.getJson(`/files/${fileKey}/component_sets`, { signal });
  }

  async getVariables(fileKey: string, signal?: AbortSignal): Promise<unknown> {
    return this.getJson(`/files/${fileKey}/variables/local`, { signal });
  }

  private async getJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(`${FIGMA_API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const cacheParts = options.cacheParts ?? [path, options.query];
    if (options.cache && this.cache) {
      const cached = await this.cache.get<T>(cacheParts);
      if (cached !== null) return cached;
    }

    const result = await this.fetchJsonWithRetries<T>(url, options.signal);
    if (options.cache && this.cache) {
      await this.cache.set(cacheParts, result);
    }
    return result;
  }

  private async fetchJsonWithRetries<T>(url: URL, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const response = await this.fetchOnce(url, signal);
        if (response.status === 429 && attempt < this.maxRetries) {
          await sleep(parseRetryAfterMs(response.headers.get('Retry-After'), this.retryAfterCapMs));
          continue;
        }
        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new FigmaApiError(
            `Figma API error ${response.status}: ${describeFigmaStatus(response.status)}`,
            response.status,
            body,
          );
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (error instanceof FigmaApiError || attempt >= this.maxRetries) break;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error('Figma API request failed.');
  }

  private async fetchOnce(url: URL, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const headers = new Headers();
    headers.set('X-Figma-Token', this.auth.getConfig().apiToken);
    try {
      return await fetch(url, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async getFileVersion(fileKey: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(`${FIGMA_API_BASE}/files/${fileKey}`);
    url.searchParams.set('depth', '1');
    const response = await this.fetchJsonWithRetries<{ version?: string; lastModified?: string }>(url, signal);
    return response.version ?? response.lastModified ?? 'unknown';
  }
}
