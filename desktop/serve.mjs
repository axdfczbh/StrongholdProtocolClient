// Minimal static file server for the packaged desktop client (desktop/main.mjs).
//
// tools/package-client.mjs already flattens the game server's mount layout into one directory (www/), so the
// Electron shell only has to serve plain files — no /data.js shim, no sim mount rules, no WebSocket. It binds
// loopback only: the packaged client is the sole consumer, and game traffic goes to the remote server instead.
//
// MIME / COMPRESSIBLE mirror server/index.js; test/packaging.test.js pins the two tables together so they cannot
// drift apart.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/** Extension → Content-Type (same table as server/index.js MIME). */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.atlas': 'text/plain; charset=utf-8',
  '.skel': 'application/octet-stream',
  '.bin': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
});

/**
 * Loopback port the desktop shell asks for. Chromium scopes localStorage (and the shell's own `sp.shell.*`
 * server choice) by *origin*, so the old `port: 0` — a fresh OS-assigned port every launch — meant every run
 * wrote to a different `http://127.0.0.1:<port>` and read back nothing: identity token, loadout, settings and
 * the remembered server were "lost" on every restart. A pinned port keeps the origin (and therefore the data).
 */
export const DEFAULT_PORT = 47821;
/** Consecutive ports tried when the preferred one is taken. The order is fixed, so the origin stays put anyway. */
export const PORT_SEARCH = 16;
/**
 * Bind errors that mean "this port is not usable *on this machine*", so the search should move on instead of
 * killing the shell. `EACCES` is the Windows case: Hyper-V / WSL2 / Docker Desktop reserve whole blocks of the
 * dynamic range (`netsh interface ipv4 show excludedportrange protocol=tcp`), and a bind into one of those answers
 * EACCES, not EADDRINUSE. Measured on windows-latest 2026-10-09 — the search from a busy 50000 died on
 * `listen EACCES: permission denied 127.0.0.1:50001` instead of trying 50002, which is the same shape as "the
 * desktop exe refuses to start on a player who happens to have a reservation over 47821..47836". The Tauri shell
 * already skipped every bind error (`tauri/src-tauri/src/server.rs`: `Err(_) => continue`); these two must agree.
 */
export const PORT_SKIP_CODES = new Set(['EADDRINUSE', 'EACCES', 'EPERM']);

/** First path segments under www/ that are content-addressed enough to cache for a day (server/index.js LONG_CACHE_DIRS). */
export const LONG_CACHE_DIRS = new Set(['assets', 'fonts', 'vendor', 'webfonts']);
export const LONG_CACHE = 'public, max-age=86400';
const NO_CACHE = 'no-cache';

/** The extension-less audio alias and the extensions it may resolve to (`shared/media.js`, served by server/index.js). */
export const MEDIA_PREFIX = '/media/';
export const AUDIO_EXTS = Object.freeze(['.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav']);
/** Where the real audio files live in the flattened payload. */
const AUDIO_ROOT_SEGMENTS = ['assets', 'audio'];

/**
 * `/media/bgm/act1` → `<root>/assets/audio/bgm/act1.mp3`.
 *
 * `public/js/media.js` rewrites every audio URL to this extension-less form so download managers (IDM / 迅雷) don't
 * grab each BGM, and only `server/index.js` knew how to resolve it back. The packaged shell is the only other host
 * of these files, so it has to answer the alias too — otherwise the desktop client plays nothing.
 *
 * @param {string} root absolute payload root
 * @param {string} rawUrl e.g. `/media/bgm/act1?v=3`
 * @returns {Promise<string|null>} absolute file path, or null when the request is not a media alias / matches nothing
 */
export async function resolveMediaPath(root, rawUrl) {
  const q = rawUrl.indexOf('?');
  let decoded;
  try { decoded = decodeURIComponent(q === -1 ? rawUrl : rawUrl.slice(0, q)); } catch { return null; }
  if (!decoded.startsWith(MEDIA_PREFIX)) return null;

  const rest = decoded.slice(MEDIA_PREFIX.length);
  const segments = rest.split('/').filter((s) => s.length > 0);
  // A trailing slash or an empty stem addresses a directory, and a dot-led/-ended segment could address something else.
  if (!segments.length || rest.endsWith('/')) return null;
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.') || s.endsWith('.'))) return null;

  const last = segments[segments.length - 1];
  const given = AUDIO_EXTS.find((e) => last.toLowerCase().endsWith(e)) || '';
  const stem = given ? last.slice(0, -given.length) : last;
  if (!stem) return null;

  const audioRoot = path.join(root, ...AUDIO_ROOT_SEGMENTS);
  const dir = path.join(audioRoot, ...segments.slice(0, -1));
  if (dir !== audioRoot && !dir.startsWith(audioRoot + path.sep)) return null;

  for (const ext of (given ? [given] : AUDIO_EXTS)) {
    const candidate = path.join(dir, stem + ext);
    try { if ((await fsp.stat(candidate)).isFile()) return candidate; } catch { /* try the next extension */ }
  }
  return null;
}

/** @param {string} ext @param {string[]} segments */
export function cacheControlFor(ext, segments) {
  if (ext === '.html' || ext === '.htm') return NO_CACHE;
  if (segments.length > 1 && LONG_CACHE_DIRS.has(segments[0])) return LONG_CACHE;
  return NO_CACHE;
}

/**
 * Resolve a request URL path to a file inside `root`, or null when it must be rejected (traversal, dotfile, …).
 * @param {string} root absolute
 * @param {string} rawUrl e.g. `/js/main.js?v=2`
 * @returns {string|null} absolute path (may not exist)
 */
export function resolveTarget(root, rawUrl) {
  const q = rawUrl.indexOf('?');
  let decoded;
  try { decoded = decodeURIComponent(q === -1 ? rawUrl : rawUrl.slice(0, q)); } catch { return null; }
  if (!decoded.startsWith('/') || decoded.includes('\0') || decoded.includes('\\')) return null;
  const segments = decoded.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null;
  const target = path.join(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

/** `bytes=a-b` → [start, end] clamped to the file, or null (ignored / unsatisfiable). */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end;
  if (!m[1]) { const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1; }
  else { start = Number(m[1]); end = m[2] ? Number(m[2]) : size - 1; }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return [start, Math.min(end, size - 1)];
}

/**
 * The `/cs/<cs16>/…` prefix: another official version's content set, which the page asks for relative to its own
 * origin (public/js/content.js loadVersionSet). The payload carries the sets tools/version-sets.mjs generated, i.e.
 * the ones belonging to the build it was made from.
 */
export const CONTENT_SET_PREFIX = '/cs/';
/** How long the content-set fallback waits for the game server before the request just 404s. */
export const CONTENT_SET_TIMEOUT_MS = 5000;

/**
 * `POST /sp/upstream` — where the picker reports the server this page is booting for (shell/picker.js). It is the one
 * fact the loopback server cannot see on its own: the picker hands the address to the *page* (`globalThis.__SP_SERVER__`
 * then `location.reload()`), never to this process, and the content-set fallback has to ask that same server.
 */
export const UPSTREAM_REPORT = '/sp/upstream';

/** `http(s)://host[:port]` of an address, or null. Anything else (a bare host, a ws:// URL, junk) is refused. */
export function toOrigin(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * The game server a payload was built for (`build.json`'s `server`), normalised without its trailing slash, or null.
 * @param {string} root payload root
 * @returns {string|null}
 */
export function readUpstream(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
    const raw = String(j?.server ?? '').trim();
    return /^https?:\/\//i.test(raw) ? raw.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

/**
 * Ask the game server for one `/cs/…` file the payload does not carry.
 *
 * The payload's own copy covers the server it was packaged for. A client pointed at a *different* build (a friend's
 * server, a newer release) would otherwise end every match at 「版本数据校验失败」, because the page's relative
 * `/cs/` request lands on this loopback server and its cs16 is not the one bundled. The manifest is content-addressed
 * and hash-checked by the page, so a relayed one is exactly as trustworthy as a bundled one — no local file is ever
 * replaced, the fallback only runs after the disk says 404.
 *
 * @param {string} upstream e.g. `http://150.158.38.174:3000`
 * @param {string} rawUrl the request URL (query string ignored)
 * @param {number} timeoutMs
 * @param {{ warn?: Function }} log
 * @returns {Promise<{ status: number, headers: Record<string, string>, body: Buffer } | null>} null: not a content
 *          set, or the server did not answer
 */
async function fetchContentSet(upstream, rawUrl, timeoutMs, log) {
  const pathname = rawUrl.split('?')[0];
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (!decoded.startsWith(CONTENT_SET_PREFIX) || decoded.includes('..') || decoded.includes('\\')) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(upstream + pathname, { signal: ctrl.signal, cache: 'no-store' });
    const body = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      body,
      headers: {
        'Content-Type': res.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': NO_CACHE,
        'Content-Length': String(body.length),
        // Observable on purpose: a test (and a bug report) can tell a relayed set from a bundled one.
        'X-SP-Content-Set': 'upstream',
      },
    };
  } catch (e) {
    log.warn?.(`[client] ${pathname} is not in the payload and ${upstream} did not answer (${e?.name || e?.message || e}) — the version set will fail its check`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start the loopback static server.
 *
 * `port > 0` is preferred and, if it is busy, the next PORT_SEARCH consecutive ports are tried before giving up
 * and letting the OS pick one (`port: 0`). The caller keeps the resulting origin stable by passing a fixed port
 * (see DEFAULT_PORT) — persistence in the page depends on it.
 *
 * `upstream` is the game server the content-set fallback asks (see fetchContentSet). Omitted = derived from
 * `<root>/build.json`; `null` = no fallback at all.
 *
 * @param {{ root: string, host?: string, port?: number, log?: { warn?: Function, error?: Function }, lan?: any,
 *           upstream?: string | null }} opts
 * @returns {Promise<{ url: string, port: number, server: http.Server, close: () => Promise<void> }>}
 */
export function createStaticServer({ root, host = '127.0.0.1', port = 0, log = console, lan = null, upstream } = {}) {
  const rootAbs = path.resolve(root);
  const gameServer = upstream === undefined ? readUpstream(rootAbs) : upstream;
  /** The server the page reported it is booting for (see UPSTREAM_REPORT); null until the picker says so. */
  let pickedUpstream = null;
  const activeUpstream = () => pickedUpstream || gameServer;

  const finish = (req, res, status, headers, body) => {
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  /**
   * `POST /sp/upstream` (same origin only): remember the server the page is booting for, so the content-set fallback
   * asks THAT server. `GET` answers with the active one (testability + a bug report can read it).
   * @returns {Promise<boolean>} true when the request was this endpoint
   */
  async function handleUpstreamReport(req, res) {
    if ((req.url || '').split('?')[0] !== UPSTREAM_REPORT) return false;
    // Browsers always send Origin on a POST; anything that is not this shell's own page is refused (a random site
    // must not be able to point the fallback at itself).
    const origin = String(req.headers.origin || '');
    if (origin && origin !== `http://${req.headers.host}`) {
      finish(req, res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden');
      return true;
    }
    if (req.method === 'GET') {
      finish(req, res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify({ upstream: activeUpstream() }));
      return true;
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      finish(req, res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed');
      return true;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 512) { finish(req, res, 413, { 'Content-Type': 'text/plain; charset=utf-8' }, 'too large'); return true; }
    }
    const normalized = toOrigin(body);
    if (!normalized) {
      finish(req, res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'an http(s) origin is required');
      return true;
    }
    pickedUpstream = normalized;
    log.info?.(`[client] content-set fallback will ask ${normalized}`);
    finish(req, res, 204, {}, undefined);
    return true;
  }

  async function handle(req, res) {
    // The virtual-LAN sidecar owns `/lan/*` (see lan.mjs). It answers same-origin so the picker needs neither a
    // second origin nor a CORS rule; when no sidecar is wired the paths simply fall through to a 404 below, which
    // the picker reads as "this build cannot do LAN play".
    if (lan && await lan.handle(req, res)) return;
    if (await handleUpstreamReport(req, res)) return;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      finish(req, res, 405, { 'Content-Type': 'text/plain; charset=utf-8' }, 'method not allowed');
      return;
    }
    const target = resolveTarget(rootAbs, req.url || '/');
    if (!target) { finish(req, res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'forbidden'); return; }

    // `/media/…` never names a real directory — resolve it to the audio file it aliases, and 404 on a miss
    // instead of falling through to a `<root>/media/…` lookup.
    let absPath = await resolveMediaPath(rootAbs, req.url || '/');
    if (!absPath) {
      if ((req.url || '').split('?')[0].startsWith(MEDIA_PREFIX)) {
        finish(req, res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'not found');
        return;
      }
      absPath = target;
    }
    let stat;
    try {
      stat = await fsp.stat(absPath);
      if (stat.isDirectory()) {
        absPath = path.join(absPath, 'index.html');
        stat = await fsp.stat(absPath);
      }
      if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
    } catch (e) {
      const status = e && (e.code === 'EACCES' || e.code === 'EPERM') ? 403 : 404;
      // A content set this payload was not built for: ask the server the payload names (see fetchContentSet). Only
      // after the disk has said 404, and only for GET/HEAD, so a bundled set is always served from disk.
      const asked = activeUpstream();
      if (status === 404 && asked && (req.method === 'GET' || req.method === 'HEAD')) {
        const relayed = await fetchContentSet(asked, req.url || '/', CONTENT_SET_TIMEOUT_MS, log);
        if (relayed) {
          finish(req, res, relayed.status, relayed.headers, req.method === 'HEAD' ? undefined : relayed.body);
          return;
        }
      }
      finish(req, res, status, { 'Content-Type': 'text/plain; charset=utf-8' }, status === 403 ? 'forbidden' : 'not found');
      return;
    }

    const segments = path.relative(rootAbs, absPath).split(path.sep);
    const ext = path.extname(absPath).toLowerCase();
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': cacheControlFor(ext, segments),
      ETag: etag,
      'Last-Modified': stat.mtime.toUTCString(),
      'Accept-Ranges': 'bytes',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }

    const range = parseRange(req.headers.range, stat.size);
    if (range) {
      const [start, end] = range;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
      headers['Content-Length'] = String(end - start + 1);
      res.writeHead(206, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(absPath, { start, end }).pipe(res);
      return;
    }
    if (req.headers.range) {
      headers['Content-Range'] = `bytes */${stat.size}`;
      res.writeHead(416, headers);
      res.end();
      return;
    }
    headers['Content-Length'] = String(stat.size);
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(absPath).pipe(res);
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    handle(req, res).catch((e) => {
      log.error?.('[client] request failed', req.url, e);
      if (!res.headersSent) finish(req, res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'internal error');
      else res.end();
    });
  });

  const candidates = port > 0
    ? [...Array.from({ length: PORT_SEARCH }, (_, i) => port + i).filter((p) => p <= 65535), 0]
    : [0];

  const listen = (p) => new Promise((resolve, reject) => {
    const onError = (e) => { server.off('listening', onListening); reject(e); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(p, host);
  });

  return (async () => {
    let failure = null;
    for (let i = 0; i < candidates.length; i++) {
      const p = candidates[i];
      try {
        await listen(p);
        failure = null;
        break;
      } catch (e) {
        failure = e;
        if (!PORT_SKIP_CODES.has(e?.code)) throw e;
        if (candidates[i + 1] > 0) log.warn?.(`[client] loopback port ${p} is not usable here (${e?.code}) — trying ${candidates[i + 1]}`);
      }
    }
    if (failure) throw failure;
    server.on('error', (e) => log.error?.('[client] server error', e));
    const actual = server.address().port;
    return {
      url: `http://${host}:${actual}`,
      port: actual,
      server,
      close: () => new Promise((done) => { server.close(() => done()); server.closeAllConnections?.(); }),
    };
  })();
}
