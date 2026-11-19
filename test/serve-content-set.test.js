// The content-set fallback in desktop/serve.mjs: `/cs/…` the payload does not carry is asked of the game server it
// was built for, and nothing else is.
//
// Why this lane exists: public/js/content.js asks for another official version's set RELATIVELY, so in a packaged
// client the request lands on this loopback static server. The payload bundles the sets of the build it was packaged
// from (tools/version-sets.mjs); a client pointed at a *different* build would otherwise fail every version's check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { CONTENT_SET_PREFIX, UPSTREAM_REPORT, createStaticServer, readUpstream } from '../desktop/serve.mjs';

/** Start an upstream that answers exactly `routes` (`path` → [status, body]) and records every request. */
function upstreamOn(routes) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    const hit = routes[req.url];
    if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('nope'); return; }
    res.writeHead(hit[0], { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(hit[1]);
  });
  return { server, hits };
}

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** One request with `rawPath` sent verbatim (no client-side `..` normalisation). */
function rawStatus(base, rawPath) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, port, path: rawPath, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A payload root: always index.html, optionally build.json, optionally a bundled set. */
function makePayload({ server, bundled } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cs-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  if (server) fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ server }));
  if (bundled) {
    fs.mkdirSync(path.join(dir, 'cs', bundled, 'bounds'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cs', bundled, 'index.json'), `{"cs":"${bundled}","local":true}`);
    fs.writeFileSync(path.join(dir, 'cs', bundled, 'bounds', 'official.json'), '{"v":1}');
  }
  return dir;
}

async function withBoth({ routes = {}, payload, upstream = undefined }, run) {
  const { server, hits } = upstreamOn(routes);
  const port = await listen(server);
  const shell = await createStaticServer({
    root: payload,
    port: 0,
    log: {},
    upstream: upstream === undefined ? `http://127.0.0.1:${port}` : upstream,
  });
  try {
    await run({ base: shell.url, hits, upstream: `http://127.0.0.1:${port}` });
  } finally {
    await shell.close();
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(payload, { recursive: true, force: true });
  }
}

test('POST /sp/upstream retargets the fallback at the server the page really boots for', async () => {
  const a = upstreamOn({ '/cs/aaaa7777/index.json': [200, '{"from":"a"}'] });
  const b = upstreamOn({ '/cs/aaaa7777/index.json': [200, '{"from":"b"}'] });
  const ap = await listen(a.server);
  const bp = await listen(b.server);
  const payload = makePayload({ server: `http://127.0.0.1:${ap}/` });
  const shell = await createStaticServer({ root: payload, port: 0, log: {} });
  try {
    const first = await fetch(`${shell.url}/cs/aaaa7777/index.json`);
    assert.equal(await first.text(), '{"from":"a"}', 'before the report the payload\'s own server answers');

    const reported = await fetch(`${shell.url}${UPSTREAM_REPORT}`, { method: 'POST', body: `http://127.0.0.1:${bp}` });
    assert.equal(reported.status, 204);

    const state = await fetch(`${shell.url}${UPSTREAM_REPORT}`);
    assert.deepEqual(await state.json(), { upstream: `http://127.0.0.1:${bp}` });

    const second = await fetch(`${shell.url}/cs/aaaa7777/index.json`);
    assert.equal(await second.text(), '{"from":"b"}', 'after the report the picked server answers');

    // junk is refused and leaves the current target alone
    const junk = await fetch(`${shell.url}${UPSTREAM_REPORT}`, { method: 'POST', body: 'ws://not-an-http-origin' });
    assert.equal(junk.status, 400);
    assert.deepEqual(await (await fetch(`${shell.url}${UPSTREAM_REPORT}`)).json(), { upstream: `http://127.0.0.1:${bp}` });
  } finally {
    await shell.close();
    for (const s of [a.server, b.server]) { s.close(); s.closeAllConnections?.(); }
    fs.rmSync(payload, { recursive: true, force: true });
  }
});

test('a foreign page cannot retarget the fallback', async () => {
  const payload = makePayload({ server: 'http://127.0.0.1:1/' });
  await withBoth({ routes: {}, payload }, async ({ base }) => {
    const before = await (await fetch(`${base}${UPSTREAM_REPORT}`)).json();
    const res = await fetch(`${base}${UPSTREAM_REPORT}`, {
      method: 'POST',
      body: 'http://127.0.0.1:2',
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(res.status, 403, 'the report is same-origin only');
    assert.deepEqual(await (await fetch(`${base}${UPSTREAM_REPORT}`)).json(), before, 'a foreign page changes nothing');
  });
});

test('readUpstream reads build.json and refuses anything that is not an http(s) address', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cs-up-'));
  try {
    assert.equal(readUpstream(dir), null, 'no build.json → no fallback');
    fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ server: 'http://host.example:3000/' }));
    assert.equal(readUpstream(dir), 'http://host.example:3000', 'trailing slash trimmed');
    fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ server: 'ws://host.example' }));
    assert.equal(readUpstream(dir), null, 'a socket address is not a fetcher');
    fs.writeFileSync(path.join(dir, 'build.json'), '{not json');
    assert.equal(readUpstream(dir), null, 'an unreadable build.json must not take the shell down');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bundled content set is served from disk and never reaches the server', async () => {
  const payload = makePayload({ server: 'http://placeholder:1/', bundled: 'aaaa1111' });
  await withBoth({ routes: { '/cs/aaaa1111/index.json': [200, '{"from":"upstream"}'] }, payload }, async ({ base, hits }) => {
    const r = await fetch(`${base}/cs/aaaa1111/index.json`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), '{"cs":"aaaa1111","local":true}');
    assert.equal(r.headers.get('x-sp-content-set'), null, 'a bundled set carries no relay marker');
    assert.deepEqual(hits, [], 'the disk answered, so the server was never asked');
  });
});

test('a set the payload does not carry is relayed, marked as relayed, and a 404 is relayed as a 404', async () => {
  const payload = makePayload({ server: 'http://placeholder:1/' });
  const routes = {
    '/cs/bbbb2222/index.json': [200, '{"cs":"bbbb2222"}'],
    '/cs/bbbb2222/bounds/official.json': [200, '{"v":1}'],
  };
  await withBoth({ routes, payload }, async ({ base, hits }) => {
    const r = await fetch(`${base}/cs/bbbb2222/index.json`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-sp-content-set'), 'upstream');
    assert.equal(await r.text(), '{"cs":"bbbb2222"}');

    const bounds = await fetch(`${base}/cs/bbbb2222/bounds/official.json`);
    assert.equal(bounds.status, 200);
    assert.equal(await bounds.text(), '{"v":1}');

    const missing = await fetch(`${base}/cs/cccc3333/index.json`);
    assert.equal(missing.status, 404, 'the server said 404, so the client sees a 404');

    assert.deepEqual(hits, ['/cs/bbbb2222/index.json', '/cs/bbbb2222/bounds/official.json', '/cs/cccc3333/index.json']);
  });
});

test('only /cs/ is relayed — the rest of the payload still 404s on its own', async () => {
  const payload = makePayload({ server: 'http://placeholder:1/' });
  await withBoth({ routes: { '/data/chess.json': [200, '{}'], '/servers.json': [200, '[]'] }, payload }, async ({ base, hits }) => {
    for (const p of ['/data/chess.json', '/servers.json', '/healthz']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 404, `${p} must not be relayed`);
      assert.equal(r.headers.get('x-sp-content-set'), null);
    }
    // `fetch` normalises `..` client-side, so the traversal case has to be sent raw: the static server answers 403
    // for it and never asks the game server anything.
    const raw = await rawStatus(base, '/cs/../index.html');
    assert.equal(raw.status, 403, 'a path escaping the payload is refused before the fallback runs');
    assert.equal(raw.body, 'forbidden');
    assert.deepEqual(hits, [], 'nothing outside /cs/ is ever asked of the game server');
  });
});

test('a payload with no build.json (or an explicit null) keeps the plain static behaviour', async () => {
  const payload = makePayload({});
  await withBoth({ routes: {}, payload, upstream: null }, async ({ base, hits }) => {
    assert.equal(CONTENT_SET_PREFIX, '/cs/');
    const r = await fetch(`${base}/cs/dddd4444/index.json`);
    assert.equal(r.status, 404);
    assert.deepEqual(hits, [], 'an explicit null disables the fallback outright');
  });
});

test('HEAD is relayed like GET, and an unreachable server degrades to the plain 404', async () => {
  const payload = makePayload({ server: 'http://placeholder:1/' });
  await withBoth({ routes: { '/cs/eeee5555/index.json': [200, '{"cs":"eeee5555"}'] }, payload }, async ({ base }) => {
    const head = await fetch(`${base}/cs/eeee5555/index.json`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('x-sp-content-set'), 'upstream');
  });

  // port 1 is not a game server: the row has to stay a 404, not an error page
  const broken = makePayload({ server: 'http://127.0.0.1:1/' });
  const shell = await createStaticServer({ root: broken, port: 0, log: {} });
  try {
    const r = await fetch(`${shell.url}/cs/ffff6666/index.json`);
    assert.equal(r.status, 404);
  } finally {
    await shell.close();
    fs.rmSync(broken, { recursive: true, force: true });
  }
});
