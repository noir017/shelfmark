import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from './schema';
import type {
  AiStatus,
  AiSuggestion,
  AiSuggestRequest,
  ApiErrorBody,
  ErrorCode,
  ItemWithPath,
  Library,
  LookupResult,
  Me,
  QuickSaveRequest,
  QuickSaveResult,
  SearchResult,
  Settings,
  SettingsPatch,
  SystemInfo,
  TokenCreated,
  TransferItemRequest,
  TransferItemResult,
  Tree,
  UpdateItemRequest,
  WriteItemResult,
  WriteResult,
} from '../lib/types';

export interface ApiConfig {
  serverUrl: string;
  token?: string;
  /** Cloudflare Access service token (optional, see design 7.1). */
  accessClientId?: string;
  accessClientSecret?: string;
}

export interface ApiOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export type ApiErrorCode = ErrorCode | 'network' | 'timeout' | 'access_blocked' | 'bad_response';

export type AccessBlockReason = 'redirect' | 'html' | 'forbidden';

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(status: number, code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isApiError(err: unknown, code?: ApiErrorCode): err is ApiError {
  return err instanceof ApiError && (code === undefined || err.code === code);
}

/** Headers every request to the server carries. */
export function authHeaders(cfg: ApiConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  const id = cfg.accessClientId?.trim();
  const secret = cfg.accessClientSecret?.trim();
  if (id && secret) {
    headers['CF-Access-Client-Id'] = id;
    headers['CF-Access-Client-Secret'] = secret;
  }
  return headers;
}

export function isAccessHost(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'cloudflareaccess.com' || host.endsWith('.cloudflareaccess.com');
  } catch {
    return false;
  }
}

type ResponseLike = Pick<Response, 'type' | 'status' | 'url' | 'headers'>;

/**
 * Recognize a response produced by Cloudflare Access (or a similar login gateway) instead of
 * the shelfmark API. The API itself never redirects and never answers with HTML.
 * Requests use `redirect: 'manual'`, so browsers hand us an opaque redirect (status 0) and
 * Node hands us the 3xx with its Location.
 */
export function detectAccessBlock(res: ResponseLike): AccessBlockReason | null {
  if (res.type === 'opaqueredirect') return 'redirect';
  if (res.status >= 300 && res.status < 400 && res.status !== 304) return 'redirect';
  if (isAccessHost(res.url)) return 'redirect';
  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  const isJson = type.includes('json');
  if (type.includes('text/html')) return res.status === 401 || res.status === 403 ? 'forbidden' : 'html';
  if ((res.status === 401 || res.status === 403) && !isJson && res.headers.has('cf-ray')) return 'forbidden';
  return null;
}

const STATUS_CODES: Record<number, ErrorCode> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  412: 'guarded',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation',
  423: 'locked',
  429: 'rate_limited',
  503: 'unavailable',
};

function errorFromResponse(status: number, body: unknown, statusText: string): ApiError {
  const err = (body as Partial<ApiErrorBody> | undefined)?.error;
  if (err && typeof err.code === 'string') {
    return new ApiError(status, err.code, err.message ?? err.code, err.details);
  }
  const code: ApiErrorCode = STATUS_CODES[status] ?? (status >= 500 ? 'internal' : 'bad_response');
  return new ApiError(status, code, statusText || `HTTP ${status}`);
}

function errorFromThrown(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return new ApiError(0, 'timeout', 'request timed out');
  if (err instanceof SyntaxError) return new ApiError(0, 'bad_response', err.message);
  return new ApiError(0, 'network', err instanceof Error ? err.message : String(err));
}

const accessGuard: Middleware = {
  onResponse({ response }) {
    const reason = detectAccessBlock(response);
    if (reason) {
      const location = response.headers.get('location');
      throw new ApiError(response.status, 'access_blocked', 'blocked by Cloudflare Access', {
        reason,
        ...(location ? { location } : {}),
      });
    }
    return undefined;
  },
};

interface Raw<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

async function run<T>(call: () => Promise<Raw<T>>): Promise<{ data: T; response: Response }> {
  let r: Raw<T>;
  try {
    r = await call();
  } catch (err) {
    throw errorFromThrown(err);
  }
  if (!r.response.ok) throw errorFromResponse(r.response.status, r.error, r.response.statusText);
  return { data: r.data as T, response: r.response };
}

async function data<T>(call: () => Promise<Raw<T>>): Promise<T> {
  return (await run(call)).data;
}

export type TreeFetch = { notModified: true } | { notModified: false; tree: Tree; etag: string | null };

export type Api = ReturnType<typeof createApi>;

export function createApi(cfg: ApiConfig, opts: ApiOptions = {}) {
  const baseUrl = cfg.serverUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const client = createClient<paths>({
    baseUrl,
    headers: authHeaders(cfg),
    redirect: 'manual',
    credentials: 'omit',
    cache: 'no-store',
    fetch: (req: Request) => fetchImpl(req, { signal: AbortSignal.timeout(timeoutMs) }),
  });
  client.use(accessGuard);

  return {
    baseUrl,

    systemInfo: (): Promise<SystemInfo> => data(() => client.GET('/api/v1/system/info')),

    me: (): Promise<Me> => data(() => client.GET('/api/v1/auth/me')),

    createToken: (username: string, password: string, name: string): Promise<TokenCreated> =>
      data(() =>
        client.POST('/api/v1/auth/token', { body: { username, password, name, scopes: ['api'] } }),
      ),

    revokeToken: async (tokenId: number): Promise<void> => {
      await run(() => client.DELETE('/api/v1/tokens/{tokenId}', { params: { path: { tokenId } } }));
    },

    libraries: (): Promise<Library[]> => data(() => client.GET('/api/v1/libraries')),

    tree: async (slug: string, etag?: string | null): Promise<TreeFetch> => {
      let r: Raw<Tree>;
      try {
        r = await client.GET('/api/v1/libraries/{slug}/tree', {
          params: { path: { slug }, header: etag ? { 'If-None-Match': etag } : {} },
        });
      } catch (err) {
        throw errorFromThrown(err);
      }
      if (r.response.status === 304) return { notModified: true };
      if (!r.response.ok) throw errorFromResponse(r.response.status, r.error, r.response.statusText);
      return { notModified: false, tree: r.data as Tree, etag: r.response.headers.get('etag') };
    },

    lookup: (url: string): Promise<LookupResult> =>
      data(() => client.GET('/api/v1/lookup', { params: { query: { url } } })),

    quickSave: async (body: QuickSaveRequest): Promise<{ result: QuickSaveResult; created: boolean }> => {
      const r = await run(() => client.POST('/api/v1/quick-save', { body }));
      return { result: r.data, created: r.response.status === 201 };
    },

    updateItem: (slug: string, itemId: number, body: UpdateItemRequest): Promise<WriteItemResult> =>
      data(() =>
        client.PATCH('/api/v1/libraries/{slug}/items/{itemId}', {
          params: { path: { slug, itemId } },
          body,
        }),
      ),

    deleteItem: (slug: string, itemId: number): Promise<WriteResult> =>
      data(() =>
        client.DELETE('/api/v1/libraries/{slug}/items/{itemId}', { params: { path: { slug, itemId } } }),
      ),

    /** Move an item (with descendants) to another library; the target library assigns a new ID. */
    transferItem: (slug: string, itemId: number, body: TransferItemRequest): Promise<TransferItemResult> =>
      data(() =>
        client.POST('/api/v1/libraries/{slug}/items/{itemId}/transfer', {
          params: { path: { slug, itemId } },
          body,
        }),
      ),

    search: (q: string, limit = 10): Promise<SearchResult> =>
      data(() => client.GET('/api/v1/search', { params: { query: { q, limit } } })),

    /** Most recently added bookmarks across all libraries. */
    recent: (limit = 20): Promise<ItemWithPath[]> =>
      data(() => client.GET('/api/v1/recent', { params: { query: { limit } } })),

    /** Most visited bookmarks across all libraries. */
    frequent: (limit = 20): Promise<ItemWithPath[]> =>
      data(() => client.GET('/api/v1/frequent', { params: { query: { limit } } })),

    recordVisit: async (library: string, itemId: number): Promise<void> => {
      await run(() => client.POST('/api/v1/visits', { body: { library, itemId }, keepalive: true }));
    },

    settings: (): Promise<Settings> => data(() => client.GET('/api/v1/settings')),

    updateSettings: (patch: SettingsPatch): Promise<Settings> =>
      data(() => client.PATCH('/api/v1/settings', { body: patch })),

    aiStatus: (): Promise<AiStatus> => data(() => client.GET('/api/v1/ai/status')),

    aiSuggest: (body: AiSuggestRequest): Promise<AiSuggestion> =>
      data(() => client.POST('/api/v1/ai/suggest', { body })),

    /** Favicon bytes, fetched with the auth headers so it passes Cloudflare Access. */
    favicon: async (faviconId: string): Promise<Blob> => {
      const blob = await data(() =>
        client.GET('/api/v1/favicons/{faviconId}', {
          params: { path: { faviconId } },
          parseAs: 'blob',
        }),
      );
      return blob as unknown as Blob;
    },

    /** Address of the server's web search page (no auth needed to build it). */
    webSearchUrl: (q: string): string => `${baseUrl}/search?q=${encodeURIComponent(q)}`,
  };
}
