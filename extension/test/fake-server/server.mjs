// In-memory fake of the shelfmark REST API (api/openapi.yaml), limited to what the extension uses.
// Used by Vitest and Playwright; `npm run fake-server` runs it standalone for manual testing.
// It can also play Cloudflare Access in front of the API (see `access` below).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';

export const ALICE = { username: 'alice', password: 'alice-password' };
export const DEMO_FAVICON_ID = '0123456789abcdef0123456789abcdef';
export const FAKE_VERSION = '1.0.0-fake';
const ACCESS_TEAM = 'https://example.cloudflareaccess.com';

// Any real PNG will do as the demo favicon.
const PNG = readFileSync(new URL('../../static/icons/icon-16.png', import.meta.url));

const TRACKING = /^(utm_.*|fbclid|gclid|mc_eid|spm)$/i;

/** Design 3: lower-case scheme/host, no default port/fragment/tracking params, sorted params, no trailing slash. */
export function normalizeUrl(raw) {
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  u.hash = '';
  const params = [...u.searchParams].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

const iso = () => new Date().toISOString();

function defaultSettings() {
  return {
    language: 'auto',
    theme: 'system',
    openInNewTab: true,
    defaultSave: null,
    recentSaveTargets: [],
    startLocation: { kind: 'folder', library: 'bookmarks', folderId: 2 },
    startPage: { showSearch: true, showRecent: true, recentCount: 10, showFrequent: false, frequentCount: 10, sections: [] },
  };
}

export const DEMO_LIBRARIES = [
  {
    slug: 'bookmarks',
    name: '书签',
    items: [
      { title: 'Example Home', url: 'https://www.example.com/' },
      {
        title: '工具',
        children: [
          { title: 'Example Tools', url: 'https://tools.example.com/', tags: ['dev'], faviconId: DEMO_FAVICON_ID },
          { title: '子文件夹', children: [{ title: 'Deep Link', url: 'https://deep.example.com/a' }] },
        ],
      },
      { title: '阅读', children: [{ title: 'Example Blog', url: 'https://blog.example.org/post', notes: 'later' }] },
    ],
  },
  {
    slug: 'work',
    name: '工作',
    items: [{ title: '项目', children: [{ title: 'Project Tracker', url: 'https://tracker.example.net/' }] }],
  },
];

class Library {
  constructor(slug, name) {
    this.slug = slug;
    this.name = name;
    this.revision = 1;
    this.highestId = 0;
    this.items = new Map();
    this.createdAt = iso();
    this.updatedAt = this.createdAt;
  }

  children(parentId) {
    return [...this.items.values()].filter((i) => i.parentId === parentId).sort((a, b) => a.position - b.position);
  }

  reindex(parentId) {
    this.children(parentId).forEach((c, i) => (c.position = i));
  }

  add({ type, parentId = 0, title = '', url = null, notes = null, tags = [], faviconId = null, position }) {
    const id = ++this.highestId;
    const siblings = this.children(parentId);
    const pos = position === undefined ? siblings.length : Math.min(position, siblings.length);
    for (const s of siblings) if (s.position >= pos) s.position++;
    const now = iso();
    const item = {
      id, type, parentId, position: pos, title, url: type === 'bookmark' ? url : null,
      createdAt: now, updatedAt: now, notes, tags: [...tags], faviconId, health: null, visitCount: 0, lastVisitedAt: null,
    };
    this.items.set(id, item);
    return item;
  }

  remove(id) {
    const item = this.items.get(id);
    if (!item) return;
    for (const c of this.children(id)) this.remove(c.id);
    this.items.delete(id);
    this.reindex(item.parentId);
  }

  move(item, parentId, position) {
    const from = item.parentId;
    item.parentId = parentId;
    item.position = Number.MAX_SAFE_INTEGER;
    this.reindex(from);
    const siblings = this.children(parentId).filter((s) => s !== item);
    const pos = position === undefined ? siblings.length : Math.min(position, siblings.length);
    siblings.splice(pos, 0, item);
    siblings.forEach((s, i) => (s.position = i));
  }

  isAncestor(ancestorId, id) {
    for (let cur = this.items.get(id); cur; cur = this.items.get(cur.parentId)) if (cur.id === ancestorId) return true;
    return false;
  }

  bump() {
    this.revision++;
    this.updatedAt = iso();
  }

  path(item) {
    const titles = [], ids = [];
    for (let p = this.items.get(item.parentId); p; p = this.items.get(p.parentId)) {
      titles.unshift(p.title);
      ids.unshift(p.id);
    }
    return { path: titles, pathIds: ids };
  }

  withPath(item) {
    return { library: this.slug, item: apiItem(item), ...this.path(item) };
  }

  tree(parentId = 0) {
    return this.children(parentId).map((c) => (c.type === 'folder' ? { ...apiItem(c), children: this.tree(c.id) } : apiItem(c)));
  }

  bookmarks() {
    return [...this.items.values()].filter((i) => i.type === 'bookmark');
  }

  json() {
    const all = [...this.items.values()];
    return {
      slug: this.slug, name: this.name, davFile: `${this.slug}.xbel`, revision: this.revision, highestId: this.highestId,
      bookmarkCount: all.filter((i) => i.type === 'bookmark').length, folderCount: all.filter((i) => i.type === 'folder').length,
      createdAt: this.createdAt, updatedAt: this.updatedAt, lastSyncAt: null, lastSyncActor: null, lock: null, pendingCount: 0,
    };
  }
}

function apiItem(i) {
  return { ...i, tags: [...i.tags] };
}

function seedItems(lib, nodes, parentId = 0) {
  for (const n of nodes) {
    if (n.children) {
      const f = lib.add({ type: 'folder', parentId, title: n.title });
      seedItems(lib, n.children, f.id);
    } else {
      lib.add({ type: 'bookmark', parentId, title: n.title, url: n.url, notes: n.notes ?? null, tags: n.tags ?? [], faviconId: n.faviconId ?? null });
    }
  }
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const notFound = (what = 'not found') => new ApiError(404, 'not_found', what);
const invalid = (message, details) => new ApiError(422, 'validation', message, details);

function validTags(tags) {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > 50) throw invalid('tags must be an array (max 50)');
  for (const t of tags) {
    if (typeof t !== 'string' || !t || t.length > 64 || /[\s,]/.test(t)) throw invalid(`bad tag: ${t}`, { tags: 'no whitespace or commas' });
  }
  return tags;
}

/**
 * @param {{
 *   port?: number, host?: string, ai?: boolean, seed?: false | typeof DEMO_LIBRARIES,
 *   tokens?: string[],
 *   access?: null | { clientId: string, clientSecret: string, mode?: 'redirect' | 'forbidden' | 'html' },
 *   startPage?: object,
 * }} [options]
 */
export async function startFakeServer(options = {}) {
  const state = {
    ai: options.ai ?? true,
    access: options.access ?? null,
    /** @type {null | { actor: string, since: string }} */
    locked: null,
    /** @type {{ method: string, path: string, headers: import('node:http').IncomingHttpHeaders }[]} */
    requests: [],
    users: new Map(),
    tokens: new Map(),
    nextTokenId: 1,
    favicons: new Map([[DEMO_FAVICON_ID, { mime: 'image/png', data: PNG }]]),
  };

  const alice = {
    id: 1, username: ALICE.username, password: ALICE.password, isAdmin: true, createdAt: iso(),
    settings: defaultSettings(), libraries: new Map(),
  };
  if (options.startPage) alice.settings.startPage = { ...alice.settings.startPage, ...options.startPage };
  state.users.set(alice.username, alice);
  for (const spec of options.seed === false ? [] : (options.seed ?? DEMO_LIBRARIES)) {
    const lib = new Library(spec.slug, spec.name);
    seedItems(lib, spec.items);
    alice.libraries.set(lib.slug, lib);
  }
  for (const token of options.tokens ?? []) addToken(alice, 'preset', ['api'], token);

  function addToken(user, name, scopes, token = `smk_${randomBytes(24).toString('base64url')}`) {
    const rec = { id: state.nextTokenId++, userId: user.id, user, name, scopes, prefix: token.slice(0, 8), createdAt: iso(), lastUsedAt: null, lastUsedIp: null };
    state.tokens.set(token, rec);
    return { token, rec };
  }

  function tokenJson(rec) {
    const { id, name, scopes, prefix, createdAt, lastUsedAt, lastUsedIp } = rec;
    return { id, name, scopes, prefix, createdAt, lastUsedAt, lastUsedIp };
  }

  function lib(user, slug) {
    const l = user.libraries.get(slug);
    if (!l) throw notFound(`library ${slug} not found`);
    return l;
  }

  function item(l, id) {
    const it = l.items.get(Number(id));
    if (!it) throw notFound(`item ${id} not found`);
    return it;
  }

  function folderExists(l, id) {
    return id === 0 || l.items.get(id)?.type === 'folder';
  }

  function checkLock() {
    if (state.locked) throw new ApiError(423, 'locked', 'library is locked by a sync', { actor: state.locked.actor, since: state.locked.since });
  }

  function inbox(user) {
    let l = user.libraries.get('bookmarks');
    if (!l) {
      l = new Library('bookmarks', 'bookmarks');
      user.libraries.set(l.slug, l);
    }
    let f = l.children(0).find((c) => c.type === 'folder' && c.title === '收件箱');
    if (!f) f = l.add({ type: 'folder', title: '收件箱' });
    return { l, folderId: f.id };
  }

  function rememberTarget(user, library, folderId) {
    const list = user.settings.recentSaveTargets.filter((t) => !(t.library === library && t.folderId === folderId));
    user.settings.recentSaveTargets = [{ library, folderId }, ...list].slice(0, 10);
  }

  // --- Cloudflare Access imitation ---

  const BYPASS = [/^\/dav\//, /^\/manifest\.webmanifest$/, /^\/icons\//, /^\/__test\//, /^\/healthz$/];

  /** @returns {boolean} true if the request was answered by "Access". */
  function accessGate(req, res, path) {
    const a = state.access;
    if (!a || BYPASS.some((r) => r.test(path))) return false;
    const id = req.headers['cf-access-client-id'];
    const secret = req.headers['cf-access-client-secret'];
    const cf = { 'cf-ray': '0123456789abcdef-SJC', server: 'cloudflare' };
    if (id !== undefined || secret !== undefined) {
      if (id === a.clientId && secret === a.clientSecret) return false;
      res.writeHead(403, { ...cf, 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Forbidden</title><h1>Forbidden</h1><p>You don\'t have permission to view this.</p>');
      return true;
    }
    const mode = a.mode ?? 'redirect';
    if (mode === 'redirect') {
      const host = req.headers.host ?? 'localhost';
      const loc = `${ACCESS_TEAM}/cdn-cgi/access/login/${host}?kid=fake&redirect_url=${encodeURIComponent(req.url)}`;
      res.writeHead(302, { ...cf, location: loc });
      res.end();
    } else if (mode === 'forbidden') {
      res.writeHead(403, { ...cf, 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Access denied</title>');
    } else {
      res.writeHead(200, { ...cf, 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Sign in ・ Cloudflare Access</title><form></form>');
    }
    return true;
  }

  // --- routing ---

  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler, auth: opts.auth ?? true });
  };

  route('GET', '/healthz', () => ({ text: `ok ${FAKE_VERSION}` }), { auth: false });

  route('GET', '/__test/page', ({ query }) => ({
    html: `<!doctype html><html><head><meta charset="utf-8"><title>${(query.get('title') ?? 'Test page').replace(/[<&]/g, '')}</title></head><body><h1>test page</h1><a id="link" href="https://linked.example.com/x">linked</a></body></html>`,
  }), { auth: false });

  route('GET', '/api/v1/system/info', () => ({
    json: {
      version: FAKE_VERSION, commit: 'fake', needsSetup: false, davPath: '/dav/', baseUrl: null,
      features: { ai: state.ai, metrics: false, linkcheck: false, metadata: false, autoCreateLibrary: true, cfAccessSso: false },
    },
  }), { auth: false });

  route('POST', '/api/v1/auth/token', ({ body }) => {
    const { username, password, name, scopes } = body ?? {};
    if (typeof name !== 'string' || !name || name.length > 100) throw invalid('name required');
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => s !== 'api' && s !== 'dav')) throw invalid('bad scopes');
    const user = state.users.get(username);
    if (!user || user.password !== password) throw new ApiError(401, 'unauthorized', 'wrong username or password');
    const { token, rec } = addToken(user, name, scopes);
    return { status: 201, json: { ...tokenJson(rec), token } };
  }, { auth: false });

  route('POST', '/api/v1/auth/access', () => {
    throw new ApiError(503, 'unavailable', 'Cloudflare Access SSO is not configured');
  }, { auth: false });

  route('GET', '/api/v1/auth/me', ({ user }) => ({
    json: { user: { id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt }, authMethod: 'token' },
  }));

  route('GET', '/api/v1/tokens', ({ user }) => ({
    json: [...state.tokens.values()].filter((r) => r.userId === user.id).map(tokenJson),
  }));

  route('DELETE', '/api/v1/tokens/:id', ({ user, params }) => {
    const entry = [...state.tokens].find(([, r]) => r.id === Number(params.id) && r.userId === user.id);
    if (!entry) throw notFound('token not found');
    state.tokens.delete(entry[0]);
    return { status: 204 };
  });

  route('GET', '/api/v1/libraries', ({ user }) => ({ json: [...user.libraries.values()].map((l) => l.json()) }));

  route('GET', '/api/v1/libraries/:slug', ({ user, params }) => ({ json: lib(user, params.slug).json() }));

  route('GET', '/api/v1/libraries/:slug/tree', ({ user, params, req }) => {
    const l = lib(user, params.slug);
    const etag = `"r${l.revision}"`;
    if (req.headers['if-none-match'] === etag) return { status: 304, headers: { etag } };
    return { json: { library: l.slug, revision: l.revision, highestId: l.highestId, children: l.tree() }, headers: { etag } };
  });

  route('PATCH', '/api/v1/libraries/:slug/items/:id', ({ user, params, body }) => {
    const l = lib(user, params.slug);
    const it = item(l, params.id);
    checkLock();
    const b = body ?? {};
    if (b.title !== undefined) {
      if (typeof b.title !== 'string' || b.title.length > 2000) throw invalid('bad title');
      it.title = b.title;
    }
    if (b.url !== undefined) {
      if (it.type !== 'bookmark' || typeof b.url !== 'string' || !b.url) throw invalid('bad url');
      it.url = b.url;
    }
    if (b.notes !== undefined) it.notes = b.notes === '' ? null : b.notes;
    if (b.tags !== undefined) it.tags = [...validTags(b.tags)];
    if (b.parentId !== undefined || b.position !== undefined) {
      const parentId = b.parentId ?? it.parentId;
      if (!folderExists(l, parentId)) throw notFound('parent folder not found');
      if (it.type === 'folder' && l.isAncestor(it.id, parentId)) throw new ApiError(409, 'conflict', 'cannot move a folder into itself');
      l.move(it, parentId, b.position);
    }
    it.updatedAt = iso();
    l.bump();
    return { json: { revision: l.revision, item: apiItem(it) } };
  });

  route('DELETE', '/api/v1/libraries/:slug/items/:id', ({ user, params }) => {
    const l = lib(user, params.slug);
    item(l, params.id);
    checkLock();
    l.remove(Number(params.id));
    l.bump();
    return { json: { revision: l.revision } };
  });

  const discovery = (sort, filter) => ({ user, params, query }) => {
    const libs = params.slug ? [lib(user, params.slug)] : [...user.libraries.values()];
    const limit = Math.min(Math.max(Number(query.get('limit') ?? 20), 1), 100);
    const all = libs.flatMap((l) => l.bookmarks().filter(filter).map((i) => ({ l, i })));
    return { json: all.sort((a, b) => sort(a.i, b.i)).slice(0, limit).map(({ l, i }) => l.withPath(i)) };
  };
  const byCreated = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id;
  const byVisits = (a, b) => b.visitCount - a.visitCount;
  route('GET', '/api/v1/libraries/:slug/recent', discovery(byCreated, () => true));
  route('GET', '/api/v1/libraries/:slug/frequent', discovery(byVisits, (i) => i.visitCount > 0));
  route('GET', '/api/v1/recent', discovery(byCreated, () => true));
  route('GET', '/api/v1/frequent', discovery(byVisits, (i) => i.visitCount > 0));

  route('POST', '/api/v1/libraries/:slug/items/:id/transfer', ({ user, params, body }) => {
    const src = lib(user, params.slug);
    const it = item(src, params.id);
    const b = body ?? {};
    if (typeof b.library !== 'string') throw invalid('library required', { library: 'required' });
    const dst = lib(user, b.library);
    const parentId = b.parentId ?? 0;
    if (!folderExists(dst, parentId)) throw notFound('parent folder not found');
    checkLock();
    const copy = (from, toParent, position) => {
      const { id: _id, parentId: _p, position: _pos, ...rest } = from;
      const n = dst.add({ ...rest, parentId: toParent, position });
      Object.assign(n, { createdAt: from.createdAt, health: from.health, visitCount: from.visitCount, lastVisitedAt: from.lastVisitedAt });
      for (const c of src.children(from.id)) copy(c, n.id);
      return n;
    };
    const moved = copy(it, parentId, b.position);
    src.remove(it.id);
    src.bump();
    dst.bump();
    return { json: { revision: dst.revision, sourceRevision: src.revision, item: apiItem(moved) } };
  });

  route('POST', '/api/v1/quick-save', ({ user, body }) => {
    const b = body ?? {};
    if (typeof b.url !== 'string' || !b.url.trim() || b.url.length > 8192) throw invalid('url required', { url: 'required' });
    const tags = validTags(b.tags);
    let l, folderId;
    if (b.library !== undefined) {
      l = lib(user, b.library);
      folderId = b.parentId ?? 0;
    } else if (user.settings.defaultSave && user.libraries.get(user.settings.defaultSave.library)) {
      l = user.libraries.get(user.settings.defaultSave.library);
      folderId = b.parentId ?? user.settings.defaultSave.folderId;
    } else {
      ({ l, folderId } = inbox(user));
      if (b.parentId !== undefined) folderId = b.parentId;
    }
    if (!folderExists(l, folderId)) throw notFound('folder not found');
    const norm = normalizeUrl(b.url);
    if (!b.allowDuplicate) {
      const existing = l.bookmarks().find((i) => normalizeUrl(i.url) === norm);
      if (existing) return { status: 200, json: { existed: true, library: l.slug, item: apiItem(existing), path: l.path(existing).path, revision: l.revision } };
    }
    checkLock();
    let title = typeof b.title === 'string' ? b.title : '';
    if (!title) {
      try {
        title = new URL(b.url).hostname; // stands in for the server fetching the page title
      } catch {
        title = b.url;
      }
    }
    const it = l.add({ type: 'bookmark', parentId: folderId, title, url: b.url, notes: b.notes || null, tags });
    l.bump();
    rememberTarget(user, l.slug, folderId);
    return { status: 201, json: { existed: false, library: l.slug, item: apiItem(it), path: l.path(it).path, revision: l.revision } };
  });

  route('GET', '/api/v1/lookup', ({ user, query }) => {
    const url = query.get('url');
    if (!url) throw invalid('url required');
    const norm = normalizeUrl(url);
    const matches = [];
    for (const l of user.libraries.values()) for (const i of l.bookmarks()) if (normalizeUrl(i.url) === norm) matches.push(l.withPath(i));
    return { json: { url, normalizedUrl: norm, matches } };
  });

  route('GET', '/api/v1/search', ({ user, query }) => {
    const q = query.get('q') ?? '';
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const only = query.get('library');
    const limit = Number(query.get('limit') ?? 50);
    const offset = Number(query.get('offset') ?? 0);
    const hits = [];
    for (const l of user.libraries.values()) {
      if (only && l.slug !== only) continue;
      for (const i of l.bookmarks()) {
        const { path, pathIds } = l.path(i);
        const hay = [i.title, i.url, i.notes ?? '', ...i.tags, ...path].join(' ').toLowerCase();
        const ok = words.length > 0 && words.every((w) => {
          if (w.startsWith('#')) return i.tags.some((t) => t.toLowerCase() === w.slice(1));
          if (w.startsWith('site:')) return new URL(i.url).hostname.endsWith(w.slice(5));
          return hay.includes(w);
        });
        if (ok) hits.push({ library: l.slug, item: apiItem(i), path, pathIds, highlights: { title: i.title.replace(/[&<>]/g, '') } });
      }
    }
    return { json: { query: q, total: hits.length, results: hits.slice(offset, offset + limit) } };
  });

  route('POST', '/api/v1/visits', ({ user, body }) => {
    const b = typeof body === 'string' ? JSON.parse(body) : (body ?? {});
    const l = lib(user, b.library);
    const it = item(l, b.itemId);
    it.visitCount++;
    it.lastVisitedAt = iso();
    return { status: 204 };
  });

  route('GET', '/api/v1/favicons/:id', ({ params }) => {
    const f = state.favicons.get(params.id);
    if (!f) throw notFound('favicon not found');
    return { raw: f.data, headers: { 'content-type': f.mime, 'cache-control': 'public, max-age=31536000, immutable' } };
  }, { auth: false });

  route('GET', '/api/v1/settings', ({ user }) => ({ json: user.settings }));

  route('PATCH', '/api/v1/settings', ({ user, body }) => {
    const b = body ?? {};
    if (b.defaultSave) {
      const l = user.libraries.get(b.defaultSave.library);
      if (!l || !folderExists(l, b.defaultSave.folderId)) throw invalid('defaultSave points to nothing', { defaultSave: 'unknown folder' });
    }
    for (const k of ['language', 'theme', 'openInNewTab', 'defaultSave', 'startPage']) if (k in b) user.settings[k] = b[k];
    return { json: user.settings };
  });

  route('GET', '/api/v1/ai/status', () => ({ json: { enabled: state.ai, model: state.ai ? 'fake-model' : null } }));

  route('POST', '/api/v1/ai/suggest', ({ user, body }) => {
    if (!state.ai) throw new ApiError(503, 'unavailable', 'AI is not configured');
    const l = lib(user, body?.library);
    const folders = [...l.items.values()].filter((i) => i.type === 'folder').slice(0, 3);
    let host = '';
    try {
      host = new URL(body.url).hostname;
    } catch {
      throw invalid('bad url');
    }
    const tags = host.split('.').filter((p) => !/^\d+$/.test(p) && !['www', 'com', 'org', 'net'].includes(p)).slice(0, 4);
    return {
      json: {
        title: body.title ? `AI: ${body.title}` : null,
        folders: folders.map((f, idx) => ({ folderId: f.id, path: [...l.path(f).path, f.title], score: 0.9 - idx * 0.3 })),
        tags: [...tags, 'ai'].slice(0, 5),
      },
    };
  });

  // --- server ---

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text) return undefined;
    const type = req.headers['content-type'] ?? '';
    if (type.includes('json')) {
      try {
        return JSON.parse(text);
      } catch {
        throw invalid('invalid JSON');
      }
    }
    return text;
  }

  function send(res, status, out = {}) {
    const headers = { ...(out.headers ?? {}) };
    let payload = '';
    if (out.json !== undefined) {
      headers['content-type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(out.json);
    } else if (out.html !== undefined) {
      headers['content-type'] = 'text/html; charset=utf-8';
      payload = out.html;
    } else if (out.text !== undefined) {
      headers['content-type'] = 'text/plain; charset=utf-8';
      payload = out.text;
    } else if (out.raw !== undefined) {
      payload = out.raw;
    }
    res.writeHead(status, headers);
    res.end(payload);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake');
    state.requests.push({ method: req.method, path: url.pathname, headers: { ...req.headers } });
    if (accessGate(req, res, url.pathname)) return;
    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) throw notFound(`no route for ${req.method} ${url.pathname}`);
    const m = url.pathname.match(r.re);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    let user = null;
    if (r.auth) {
      const auth = req.headers.authorization ?? '';
      const rec = auth.startsWith('Bearer ') ? state.tokens.get(auth.slice(7)) : undefined;
      if (!rec || !rec.scopes.includes('api')) throw new ApiError(401, 'unauthorized', 'missing or invalid token');
      rec.lastUsedAt = iso();
      user = rec.user;
    }
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : undefined;
    const out = await r.handler({ req, params, query: url.searchParams, body, user });
    send(res, out.status ?? 200, out);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ApiError) {
        const headers = err.status === 423 ? { 'retry-after': '5' } : {};
        send(res, err.status, { json: { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } }, headers });
      } else {
        send(res, 500, { json: { error: { code: 'internal', message: String(err) } } });
      }
    });
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://${options.host ?? '127.0.0.1'}:${port}`;

  return {
    url,
    state,
    alice,
    /** Issue a token for alice without going through the API. */
    issueToken: (name = 'test', scopes = ['api']) => addToken(alice, name, scopes).token,
    setAccess(access) {
      state.access = access;
    },
    setLocked(actor) {
      state.locked = actor ? { actor, since: iso() } : null;
    },
    findBookmark(url) {
      const norm = normalizeUrl(url);
      for (const l of alice.libraries.values()) {
        const hit = l.bookmarks().find((i) => normalizeUrl(i.url) === norm);
        if (hit) return { library: l.slug, item: hit, path: l.path(hit).path };
      }
      return null;
    },
    folderId(slug, title) {
      const l = alice.libraries.get(slug);
      return [...(l?.items.values() ?? [])].find((i) => i.type === 'folder' && i.title === title)?.id ?? null;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
