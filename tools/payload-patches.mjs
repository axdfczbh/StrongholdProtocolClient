// Applies patches/game-client.patch to an assembled payload.
//
// The game repo is kept byte-identical to upstream (that is the point of the split), so the source-level hooks that
// let a packaged client talk to a remote server and look right on a phone live here as a patch instead of as commits
// in the game repo:
//
//   js/net.js            defaultWsUrl() honours globalThis.__SP_SERVER__ and ?server=host
//   js/screens/room.js   invite links (复制链接 / ?room=CODE) point at the remote web client
//   index.html           loads /js/runtime-config.js + /js/shell/picker.js before the module graph, and the shell
//                        stylesheet (css/shell-display.css) after the game's own CSS; its web fonts come from the
//                        payload's own mirror (/webfonts/google/google.css) instead of fonts.googleapis.com
//   dev/uikit.html       the same font swap, so no shipped page asks a third-party host anything
//   js/media.js          mediaAliasEnabled(): the switch Capacitor builds set to keep real /assets/audio URLs
//
// It is a normal `git diff` against the game's public/ tree, so it is applied with `-p2` (payload root ↔ public/).
// The patch target is the payload copy — the game checkout is never touched. When upstream edits one of those files
// the patch stops applying and the build fails (see tools/unified-diff.mjs).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFilePatch, filePatch } from './unified-diff.mjs';

export const CLIENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PATCH_FILE = path.join(CLIENT_ROOT, 'patches', 'game-client.patch');
/** Payload-relative files the patch edits (the payload root is the game's public/ tree). */
export const PATCHED_FILES = Object.freeze(['index.html', 'js/net.js', 'js/screens/room.js', 'dev/uikit.html', 'js/media.js']);

/**
 * Derive the patched files into the payload.
 *
 * The patch is always applied to the **pristine game source**, never to whatever is already in the payload: that
 * keeps the step idempotent (assembling twice writes nothing) and makes it impossible to stack the patch on itself.
 *
 * @param {{ gameRoot: string, payloadRoot: string, patchFile?: string }} opts
 * @returns {string[]} payload-relative files that were written
 */
export function applyPayloadPatch({ gameRoot, payloadRoot, patchFile = PATCH_FILE }) {
  if (!fs.existsSync(patchFile)) throw new Error(`缺少 payload 补丁文件：${patchFile}`);
  const patchText = fs.readFileSync(patchFile, 'utf8');
  const written = [];
  for (const rel of PATCHED_FILES) {
    const source = path.join(gameRoot, 'public', rel);
    if (!fs.existsSync(source)) throw new Error(`游戏仓库里找不到 ${path.join('public', rel)}`);
    const entry = filePatch(patchText, rel);
    if (!entry) throw new Error(`patches/game-client.patch 里没有 ${rel} —— 补丁需要重新生成`);
    const { text } = applyFilePatch(fs.readFileSync(source, 'utf8'), entry);
    const dst = path.join(payloadRoot, rel);
    let current = null;
    try { current = fs.readFileSync(dst, 'utf8'); } catch { /* not in the payload yet */ }
    if (current === text) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, text);
    written.push(rel);
  }
  return written;
}

/** Cheap sanity check that the patch really took (used by the build and by the tests). */
export function assertPatched(payloadRoot) {
  const net = fs.readFileSync(path.join(payloadRoot, 'js', 'net.js'), 'utf8');
  const room = fs.readFileSync(path.join(payloadRoot, 'js', 'screens', 'room.js'), 'utf8');
  const html = fs.readFileSync(path.join(payloadRoot, 'index.html'), 'utf8');
  const uikit = fs.readFileSync(path.join(payloadRoot, 'dev', 'uikit.html'), 'utf8');
  const media = fs.readFileSync(path.join(payloadRoot, 'js', 'media.js'), 'utf8');
  if (!net.includes('resolveServerTarget') || !net.includes('__SP_SERVER__')) throw new Error('payload js/net.js 没有被补丁改到（找不到 __SP_SERVER__ 支持）');
  if (!room.includes('toHttpUrl')) throw new Error('payload js/screens/room.js 没有被补丁改到（邀请链接仍是本地地址）');
  if (!html.includes('/js/runtime-config.js')) throw new Error('payload index.html 没有被补丁改到（缺少 runtime-config.js 的 <script>）');
  if (!html.includes('/js/shell/picker.js')) throw new Error('payload index.html 没有被补丁改到（缺少选择服务器页的 <script>）');
  if (!html.includes('/css/shell-display.css')) throw new Error('payload index.html 没有被补丁改到（缺少 shell-display.css 的 <link>）');
  // A shipped page that still names Google's font host stalls a mainland/offline player before the game starts.
  if (!html.includes('/webfonts/google/google.css')) throw new Error('payload index.html 没有被补丁改到（字体仍指向 fonts.googleapis.com）');
  if (!uikit.includes('/webfonts/google/google.css')) throw new Error('payload dev/uikit.html 没有被补丁改到（字体仍指向 fonts.googleapis.com）');
  // Without the switch, build-clients.yml's `__SP_MEDIA_ALIAS__ = false` line is inert and an APK goes silent.
  if (!media.includes('mediaAliasEnabled')) throw new Error('payload js/media.js 没有被补丁改到（缺 mediaAliasEnabled，安卓那边会静音）');
}
