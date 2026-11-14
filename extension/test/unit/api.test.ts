import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiError, authHeaders, createApi, detectAccessBlock, isAccessHost } from '../../src/api/client';
import { describeError } from '../../src/lib/errors';
import { ALICE, DEMO_FAVICON_ID, startFakeServer } from '../fake-server/server.mjs';
import { tt } from '../helpers/memory-area';

type Fake = Awaited<ReturnType<typeof startFakeServer>>;

let server: Fake;
let token: string;

beforeAll(async () => {
  server = await startFakeServer();
  token = server.issueToken();
});
afterAll(() => server.close());
beforeEach(() => {
  server.setAccess(null);
  server.setLocked(null);
  server.state.requests.length = 0;
});

const lastRequest = () => server.state.requests[server.state.requests.length - 1]!;

async function expectApiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(ApiError);
    return err as ApiError;
  }
  throw new Error('expected an ApiError');
}

describe('auth', () => {
  it('exchanges username and password for an api token', async () => {
    const api = createApi({ serverUrl: server.url });
    const tok = await api.createToken(ALICE.username, ALICE.password, '插件 · Chrome · Linux');
    expect(tok.token).toMatch(/^smk_/);
    expect(tok.scopes).toEqual(['api']);
    expect(tok.name).toBe('插件 · Chrome · Linux');
    const me = await createApi({ serverUrl: server.url, token: tok.token }).me();
    expect(me.user.username).toBe('alice');
  });

  it('maps a wrong password to unauthorized', async () => {
    const err = await expectApiError(createApi({ serverUrl: server.url }).createToken('alice', 'nope', 'x'));
    expect(err.status).toBe(401);
    expect(err.code).toBe('unauthorized');
  });

  it('sends the bearer token and no cookies', async () => {
    await createApi({ serverUrl: server.url, token }).libraries();
    expect(lastRequest().headers.authorization).toBe(`Bearer ${token}`);
    expect(lastRequest().headers.cookie).toBeUndefined();
  });

  it('revokes a token', async () => {
    const extra = server.issueToken('extra');
    const api = createApi({ serverUrl: server.url, token: extra });
    const me = await api.me();
    expect(me.authMethod).toBe('token');
    const id = [...server.state.tokens.entries()].find(([k]) => k === extra)![1].id;
    await api.revokeToken(id);
    expect((await expectApiError(api.me())).code).toBe('unauthorized');
  });
});

describe('Cloudflare Access headers', () => {
  it('adds both service token headers when configured', async () => {
    const api = createApi({ serverUrl: server.url, token, accessClientId: 'cid.access', accessClientSecret: 'sekrit' });
    await api.libraries();
    expect(lastRequest().headers['cf-access-client-id']).toBe('cid.access');
    expect(lastRequest().headers['cf-access-client-secret']).toBe('sekrit');
  });

  it('sends them on every kind of request, including favicons', async () => {
    const api = createApi({ serverUrl: server.url, token, accessClientId: 'cid', accessClientSecret: 'sec' });
    await api.lookup('https://www.example.com/');
    await api.quickSave({ url: 'https://headers.example.com/' });
    await api.favicon(DEMO_FAVICON_ID);
    expect(server.state.requests).toHaveLength(3);
    for (const r of server.state.requests) {
      expect(r.headers['cf-access-client-id']).toBe('cid');
      expect(r.headers['cf-access-client-secret']).toBe('sec');
    }
  });

  it('omits them when not configured or incomplete', () => {
    expect(authHeaders({ serverUrl: 'x', token: 't' })).toEqual({ Authorization: 'Bearer t' });
    expect(authHeaders({ serverUrl: 'x', accessClientId: 'id', accessClientSecret: '  ' })).toEqual({});
    expect(authHeaders({ serverUrl: 'x', accessClientId: ' id ', accessClientSecret: ' s ' })).toEqual({
      'CF-Access-Client-Id': 'id',
      'CF-Access-Client-Secret': 's',
    });
  });

  it('passes through Access with the right service token', async () => {
    server.setAccess({ clientId: 'cid', clientSecret: 'sec', mode: 'redirect' });
    const api = createApi({ serverUrl: server.url, token, accessClientId: 'cid', accessClientSecret: 'sec' });
    expect((await api.libraries()).map((l) => l.slug)).toContain('bookmarks');
  });
});

describe('Cloudflare Access interception', () => {
  const api = () => createApi({ serverUrl: server.url, token });

  it('recognizes the redirect to the Access login page', async () => {
    server.setAccess({ clientId: 'cid', clientSecret: 'sec', mode: 'redirect' });
    const err = await expectApiError(api().lookup('https://www.example.com/'));
    expect(err.code).toBe('access_blocked');
    expect(err.details?.reason).toBe('redirect');
    expect(String(err.details?.location)).toContain('.cloudflareaccess.com/');
  });

  it('recognizes an HTML login page served with 200', async () => {
    server.setAccess({ clientId: 'cid', clientSecret: 'sec', mode: 'html' });
    const err = await expectApiError(api().settings());
    expect(err.code).toBe('access_blocked');
    expect(err.details?.reason).toBe('html');
  });

  it("recognizes Access's own 403", async () => {
    server.setAccess({ clientId: 'cid', clientSecret: 'sec', mode: 'forbidden' });
    const err = await expectApiError(api().libraries());
    expect(err.code).toBe('access_blocked');
    expect(err.details?.reason).toBe('forbidden');
  });

  it('treats a rejected service token as blocked and says so', async () => {
    server.setAccess({ clientId: 'cid', clientSecret: 'sec', mode: 'redirect' });
    const bad = createApi({ serverUrl: server.url, token, accessClientId: 'cid', accessClientSecret: 'wrong' });
    const err = await expectApiError(bad.libraries());
    expect(err.code).toBe('access_blocked');
    expect(describeError(err, tt, { accessTokenSet: true })).toBe('errAccessRejected');
    expect(describeError(err, tt, { accessTokenSet: false })).toBe('errAccessBlocked');
  });

  it('also guards binary responses (favicons)', async () => {
    server.setAccess({ clientId: 'cid', clientSecret: 'sec', mode: 'html' });
    expect((await expectApiError(api().favicon(DEMO_FAVICON_ID))).code).toBe('access_blocked');
  });

  it('detectAccessBlock classifies raw responses', () => {
    const res = (status: number, headers: Record<string, string> = {}, extra: Partial<Response> = {}) =>
      ({ status, type: 'basic', url: 'https://bm.example.com/api/v1/x', headers: new Headers(headers), ...extra }) as Response;
    // What browsers hand back for redirect: 'manual'.
    expect(detectAccessBlock(res(0, {}, { type: 'opaqueredirect' }))).toBe('redirect');
    expect(detectAccessBlock(res(302, { location: 'https://team.cloudflareaccess.com/cdn-cgi/access/login' }))).toBe('redirect');
    // A followed redirect that ended on the Access host.
    expect(detectAccessBlock(res(200, { 'content-type': 'text/html' }, { url: 'https://team.cloudflareaccess.com/x' }))).toBe('redirect');
    expect(detectAccessBlock(res(200, { 'content-type': 'text/html; charset=utf-8' }))).toBe('html');
    expect(detectAccessBlock(res(403, { 'content-type': 'text/html' }))).toBe('forbidden');
    expect(detectAccessBlock(res(403, { 'cf-ray': 'abc', 'content-type': 'text/plain' }))).toBe('forbidden');
    // Normal shelfmark answers are left alone.
    expect(detectAccessBlock(res(403, { 'content-type': 'application/json', 'cf-ray': 'abc' }))).toBeNull();
    expect(detectAccessBlock(res(401, { 'content-type': 'application/json' }))).toBeNull();
    expect(detectAccessBlock(res(304))).toBeNull();
    expect(detectAccessBlock(res(200, { 'content-type': 'image/png' }))).toBeNull();
    expect(detectAccessBlock(res(204))).toBeNull();
  });

  it('isAccessHost only matches cloudflareaccess.com', () => {
    expect(isAccessHost('https://team.cloudflareaccess.com/login')).toBe(true);
    expect(isAccessHost('https://cloudflareaccess.com.evil.example/')).toBe(false);
    expect(isAccessHost('not a url')).toBe(false);
  });
});

describe('data endpoints', () => {
  const api = () => createApi({ serverUrl: `${server.url}/`, token });

  it('supports ETag on the tree', async () => {
    const first = await api().tree('bookmarks');
    expect(first.notModified).toBe(false);
    if (first.notModified) return;
    expect(first.etag).toBe(`"r${first.tree.revision}"`);
    expect(first.tree.children.length).toBeGreaterThan(0);
    expect(await api().tree('bookmarks', first.etag)).toEqual({ notModified: true });
    expect(lastRequest().headers['if-none-match']).toBe(first.etag);
  });

  it('quick-saves once and then reports the existing bookmark', async () => {
    const first = await api().quickSave({ url: 'https://dup.example.com/page?utm_source=x', title: 'Dup' });
    expect(first.created).toBe(true);
    expect(first.result.existed).toBe(false);
    const again = await api().quickSave({ url: 'https://dup.example.com/page' });
    expect(again.created).toBe(false);
    expect(again.result.existed).toBe(true);
    expect(again.result.item.id).toBe(first.result.item.id);
  });

  it('looks up by normalized URL across libraries', async () => {
    const r = await api().lookup('https://WWW.example.com#top');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]!.library).toBe('bookmarks');
    expect((await api().lookup('https://unknown.example.com/')).matches).toEqual([]);
  });

  it('updates and deletes items', async () => {
    const { result } = await api().quickSave({ url: 'https://edit.example.com/', title: 'Before' });
    const tools = server.folderId('bookmarks', '工具')!;
    const upd = await api().updateItem('bookmarks', result.item.id, { title: 'After', tags: ['a', 'b'], notes: 'n', parentId: tools });
    expect(upd.item).toMatchObject({ title: 'After', tags: ['a', 'b'], notes: 'n', parentId: tools });
    const del = await api().deleteItem('bookmarks', result.item.id);
    expect(del.revision).toBeGreaterThan(upd.revision);
    expect(server.findBookmark('https://edit.example.com/')).toBeNull();
  });

  it('transfers an item to another library', async () => {
    const { result } = await api().quickSave({ url: 'https://move.example.com/', title: 'Move me', tags: ['x'] });
    const project = server.folderId('work', '项目')!;
    const r = await api().transferItem('bookmarks', result.item.id, { library: 'work', parentId: project });
    expect(r.item).toMatchObject({ title: 'Move me', tags: ['x'], parentId: project });
    expect(r.sourceRevision).toBeGreaterThan(0);
    const found = await api().lookup('https://move.example.com/');
    expect(found.matches.map((m) => m.library)).toEqual(['work']);
    await api().deleteItem('work', r.item.id);
  });

  it('maps 423 to locked with the syncing device', async () => {
    server.setLocked('laptop-floccus');
    const err = await expectApiError(api().quickSave({ url: 'https://locked.example.com/' }));
    expect(err.status).toBe(423);
    expect(err.code).toBe('locked');
    expect(describeError(err, tt)).toBe('errLocked(laptop-floccus)');
  });

  it('maps validation errors with the server message', async () => {
    const err = await expectApiError(api().quickSave({ url: 'https://x.example.com/', tags: ['has space'] }));
    expect(err.code).toBe('validation');
    expect(err.status).toBe(422);
  });

  it('reads and patches settings', async () => {
    const tools = server.folderId('bookmarks', '工具')!;
    const s = await api().updateSettings({ defaultSave: { library: 'bookmarks', folderId: tools } });
    expect(s.defaultSave).toEqual({ library: 'bookmarks', folderId: tools });
    expect((await api().settings()).defaultSave).toEqual(s.defaultSave);
    await api().updateSettings({ defaultSave: null });
  });

  it('searches, lists recent and records visits', async () => {
    const res = await api().search('#dev');
    expect(res.results.map((r) => r.item.title)).toEqual(['Example Tools']);
    const hit = res.results[0]!;
    await api().recordVisit(hit.library, hit.item.id);
    const freq = await api().frequent();
    expect(freq[0]!.item.id).toBe(hit.item.id);
    expect((await api().recent(2)).length).toBe(2);
  });

  it('returns favicons as blobs and builds the web search URL', async () => {
    const blob = await api().favicon(DEMO_FAVICON_ID);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBeGreaterThan(0);
    expect(api().webSearchUrl('a b')).toBe(`${server.url}/search?q=a%20b`);
  });

  it('ai suggest and status', async () => {
    expect((await api().aiStatus()).enabled).toBe(true);
    const s = await api().aiSuggest({ library: 'bookmarks', url: 'https://www.example.com/', title: 'Home' });
    expect(s.title).toBe('AI: Home');
    expect(s.folders.length).toBeGreaterThan(0);
    expect(s.tags).toContain('example');
  });
});

describe('transport failures', () => {
  it('maps connection refused to network', async () => {
    const tmp = await startFakeServer({ seed: false });
    const url = tmp.url;
    await tmp.close();
    const err = await expectApiError(createApi({ serverUrl: url, token: 'x' }).libraries());
    expect(err.code).toBe('network');
  });

  it('maps a hung request to timeout', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    const err = await expectApiError(createApi({ serverUrl: 'https://bm.example.com', token: 'x' }, { fetch: hang, timeoutMs: 30 }).libraries());
    expect(err.code).toBe('timeout');
  });
});
