// Writes <payload>/cs/<cs16>/{index.json,bounds/official.json} for every official version of a game checkout — the
// bytes its server would answer (server/versions.js indexOf / boundsOf), produced by the checkout's OWN modules.
//
// This is the child of tools/version-sets.mjs: it runs in a separate process so that assembleClient() stays
// synchronous (the same pattern packIndexOfCheckout uses for the game's tools/packs.mjs), and so that a checkout whose
// modules cannot be imported degrades to a warning instead of taking the whole packaging run down.
//
// Usage: node tools/version-sets-child.mjs --game <checkout> --out <payload root>
// Stdout: one JSON line { files, versions, problems } — nothing else is written to stdout.
//
// Why the payload needs it at all: public/js/content.js asks for another official version's set RELATIVELY
// (`/cs/<cs16>/index.json`, content.js loadVersionSet), because in the browser the page origin IS the server. A
// packaged client's page origin is the loopback shell (desktop/serve.mjs: a plain static file server, no proxy), so
// the payload must answer that path itself. 0.4.0 makes 规程·序列Ⅰ (act3autochess@V3_1) the lobby default, which is
// not the client's DEFAULT_VERSION — so this path is on the critical path of opening the lobby at all.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Minimal `--name value` / `--name=value` reader. */
function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 2);
  }
  return '';
}

/** Log sink: warnings become `problems` in the report instead of noise on stdout. */
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const gameRoot = path.resolve(arg('game') || '');
const out = path.resolve(arg('out') || '');
if (!gameRoot || !out) {
  process.stderr.write('用法：node tools/version-sets-child.mjs --game <游戏仓根> --out <payload 目录>\n');
  process.exit(2);
}

/** Absolute file URL of a path inside the checkout (dynamic import needs a URL on Windows). */
const gameUrl = (rel) => pathToFileURL(path.join(gameRoot, rel)).href;

const { DATA_SHIM_JS, readAppVersion } = await import('./game-contract.mjs');
const { VERSIONS, versionSlug } = await import(gameUrl('shared/versions.js'));
const { canonicalJson, csUrlPart } = await import(gameUrl('shared/plugins/identity.js'));
const { officialBoundsOf } = await import(gameUrl('shared/plugins/officialBounds.js'));
const { contentIndexOf, computeVanillaContent, nodeSha256, versionContentOf } = await import(gameUrl('server/plugins/identity.js'));
const { VERSION_DATA_FILES, loadData } = await import(gameUrl('server/data.js'));

// The server's own vanilla content (server/http/static.js computeVanillaContent): the same app / sim / data the
// version sets hash their own data against. verifyGameContract() has already pinned DATA_SHIM_JS to the checkout's.
const vanilla = computeVanillaContent({
  simDir: path.join(gameRoot, 'server', 'sim'),
  sharedDir: path.join(gameRoot, 'shared'),
  dataDir: path.join(gameRoot, 'data'),
  shim: DATA_SHIM_JS,
  app: readAppVersion(gameRoot),
  log: quiet,
});

/** Write one payload file, keeping an unchanged payload byte-identical (and therefore incremental). */
const write = (rel, body) => {
  const dst = path.join(out, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  let cur = null;
  try { cur = fs.readFileSync(dst); } catch { /* new file */ }
  if (!cur || !cur.equals(body)) fs.writeFileSync(dst, body);
};

const files = [];
const versions = [];
const problems = [];

for (const entry of VERSIONS) {
  // The default version (act2autochess, dir '') is the server's vanilla content: its data is /data/ itself and no
  // page ever asks for a /cs/ set of it (content.js loadVersionSet refuses DEFAULT_VERSION).
  if (!entry.dir) continue;
  const dir = path.join(gameRoot, 'data', entry.dir);
  try {
    JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  } catch (e) {
    problems.push(`${entry.id}: 读不了 ${entry.dir}/config.json（${e?.code || e?.message}），这一版不生成 —— 服务器也会禁用它`);
    continue;
  }
  const slug = versionSlug(entry);
  const dataUrl = `/data/versions/${slug}/`;
  const content = versionContentOf({ vanilla, dataDir: dir, dataUrl, version: entry.id, log: quiet });
  const missing = content ? VERSION_DATA_FILES.filter((f) => !content.data[f]) : [];
  if (!content || missing.length) {
    problems.push(`${entry.id}: ${content ? `缺 ${missing.map((f) => `${f}.json`).join(', ')}` : '没有数据文件'}，这一版不生成`);
    continue;
  }
  // Its official-bounds snapshot, as server/versions.js writes it: canonical JSON, hashed by its bytes.
  const boundsBody = Buffer.from(canonicalJson(officialBoundsOf(loadData(dir, { expected: VERSION_DATA_FILES, log: quiet }))), 'utf8');
  const cs16 = csUrlPart(content.cs);
  const indexBody = Buffer.from(JSON.stringify(contentIndexOf(content, {
    dataUrl,
    version: entry.id,
    bounds: { url: `/cs/${cs16}/bounds/official.json`, sha256: nodeSha256(boundsBody), bytes: boundsBody.length },
  })), 'utf8');
  for (const [rel, body] of [[`cs/${cs16}/index.json`, indexBody], [`cs/${cs16}/bounds/official.json`, boundsBody]]) {
    write(rel, body);
    files.push(rel);
  }
  versions.push({ id: entry.id, cs: content.cs, cs16, files: Object.keys(content.data).length });
}

process.stdout.write(JSON.stringify({ files, versions, problems }) + '\n');
