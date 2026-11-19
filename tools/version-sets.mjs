// The payload's /cs/ tree: the content sets of the official versions, answered by the payload instead of a server.
//
// The browser client asks for another official version's data set RELATIVELY — public/js/content.js loadVersionSet
// fetches `/cs/<cs16>/index.json`, then every data file the manifest lists (under /data/versions/<slug>/), then
// `/cs/<cs16>/bounds/official.json`. In a browser that is the server's own origin. In a packaged client the page
// origin is the loopback shell (desktop/serve.mjs — a plain static file server, no proxy), so those two paths have to
// exist in the payload or every non-default version ends as 「版本数据校验失败」.
//
// Since 0.4.0 that is not an edge case: 规程·序列Ⅰ (act3autochess@V3_1) is the lobby's default version
// (shared/versions.js LOBBY_DEFAULT_VERSION), which is NOT the client's DEFAULT_VERSION — so the lobby loads a
// version set on first paint. Without this tree the lobby opens into a failed check.
//
// The bytes cannot be authored here: the page recomputes contentHashOf({app, sim, data}) and compares it to the `cs`
// the server announced in `welcome`, and it checks every file against the manifest's sha256/bytes. So there is exactly
// one acceptable manifest — the one the game server itself would serve (server/versions.js indexOf/boundsOf). This
// module therefore runs tools/version-sets-child.mjs, which imports the checkout's own modules to produce it.
//
// It runs in a child process for two reasons: assembleClient() stays synchronous (the same pattern
// packIndexOfCheckout uses for the game's tools/packs.mjs), and a checkout whose modules cannot be imported degrades to
// a warning instead of failing the whole packaging run.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generate `<out>/cs/**` for every official version of the game checkout.
 *
 * @param {{ gameRoot: string, out: string, log?: (...a: any[]) => void, warn?: (...a: any[]) => void }} opts
 * @returns {{ files: string[], versions: { id: string, cs: string, cs16: string, files: number }[] } | null}
 *   null: nothing was generated (the payload then only opens 第二期下半); `files` are payload-relative, `/`-separated
 */
export function writeVersionSets({ gameRoot, out, log = console.log, warn = console.warn }) {
  const child = path.join(TOOLS_DIR, 'version-sets-child.mjs');
  const r = spawnSync(process.execPath, [child, '--game', gameRoot, '--out', out], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const why = String(r.stderr || r.stdout || r.error || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  if (r.error || r.status !== 0) {
    warn(`package-client: /cs/ 版本清单没有生成（${why.slice(0, 200) || `exit ${r.status}`}）`
      + ' —— 这个 payload 只能进第二期下半，其他版本会是「版本数据校验失败」');
    return null;
  }
  let report;
  try {
    report = JSON.parse(String(r.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0]);
  } catch {
    warn(`package-client: /cs/ 版本清单的回报读不懂（${String(r.stdout || '').trim().slice(-200)}）—— 跳过`);
    return null;
  }
  for (const p of report.problems || []) warn(`package-client: 版本不完整 —— ${p}`);
  if (!report.versions?.length) {
    warn('package-client: 这份 checkout 没有可生成的官方版本（data/versions/ 空或都缺文件）—— payload 不带 /cs/');
    return { files: [], versions: [] };
  }
  log(`package-client: /cs/ 版本清单 ${report.versions.length} 个版本 —— `
    + report.versions.map((v) => `${v.id} (${v.files} 文件, cs ${String(v.cs16).slice(0, 8)}…)`).join(', '));
  return { files: report.files || [], versions: report.versions };
}
