#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TOOLS_DIR, '..');
const LOCK = path.join(REPO, '.git', 'mem-sync.lock');
const action = process.argv[2] || 'status';

function git(args, opts = {}) {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8',
    timeout: 45000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

function hasGit() {
  try { git(['rev-parse', '--is-inside-work-tree']); return true; } catch { return false; }
}

function remoteUrl() {
  try { return git(['remote', 'get-url', 'origin']); } catch { return ''; }
}

function branch() {
  try { return git(['symbolic-ref', '--short', 'HEAD']); } catch { return 'main'; }
}

function dirtyFiles() {
  try { return git(['status', '--porcelain']).split('\n').filter(Boolean); } catch { return []; }
}

function aheadBehind() {
  try {
    const out = git(['rev-list', '--left-right', '--count', `origin/${branch()}...HEAD`]);
    const [behind, ahead] = out.split(/\s+/).map(Number);
    return { ahead, behind };
  } catch {
    return { ahead: 0, behind: 0 };
  }
}

function ensureIdentity() {
  try { git(['config', 'user.name']); } catch { git(['config', 'user.name', os.hostname() || 'agent']); }
  try { git(['config', 'user.email']); } catch { git(['config', 'user.email', 'agent@local']); }
}

function lock() {
  try {
    const stat = fs.statSync(LOCK);
    if (Date.now() - stat.mtimeMs > 120000) fs.unlinkSync(LOCK);
    else return false;
  } catch {}
  fs.writeFileSync(LOCK, String(process.pid));
  return true;
}

function unlock() {
  try { fs.unlinkSync(LOCK); } catch {}
}

function commitLocal() {
  if (!dirtyFiles().length) return false;
  git(['add', '-A']);
  const host = os.hostname() || 'device';
  git(['commit', '-m', `memory sync from ${host} @ ${new Date().toISOString()}`]);
  return true;
}

function mergeRemote() {
  if (!remoteUrl()) return { skipped: true };
  try {
    const out = git(['pull', '--no-rebase', '--no-edit', '--autostash', 'origin', branch()]);
    return { ok: true, output: out };
  } catch (err) {
    try { git(['merge', '--abort']); } catch {}
    return { ok: false, error: (err.stderr || err.message || '').toString().trim() };
  }
}

function pushRemote() {
  if (!remoteUrl()) return { skipped: true };
  try {
    git(['push', 'origin', branch()]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err.stderr || err.message || '').toString().trim() };
  }
}

function statusPayload() {
  const files = dirtyFiles();
  const ab = aheadBehind();
  let lastCommit = '';
  try { lastCommit = git(['log', '-1', '--pretty=%h %s']); } catch {}
  return {
    ok: true,
    action: 'status',
    repo: REPO,
    branch: branch(),
    remote: remoteUrl(),
    dirty: files.length,
    changes: files.slice(0, 20),
    lastCommit,
    ahead: ab.ahead,
    behind: ab.behind,
    at: Date.now(),
    message: remoteUrl()
      ? `分支 ${branch()}，本地改动 ${files.length}，领先 ${ab.ahead}，落后 ${ab.behind}`
      : '尚未配置远端仓库',
  };
}

function run() {
  if (!hasGit()) {
    return { ok: false, action, message: '记忆目录还不是 git 仓库' };
  }
  if (action === 'status') return statusPayload();
  if (!lock()) {
    return { ok: false, action, message: '另一个同步正在运行' };
  }
  try {
    ensureIdentity();
    if (action === 'pull') {
      commitLocal();
      const merged = mergeRemote();
      if (merged.skipped) return { ...statusPayload(), action, ok: true, message: '本地模式：未配置远端' };
      if (!merged.ok) return { ok: false, action, message: `拉取失败：${merged.error}` };
      return { ...statusPayload(), action, ok: true, message: '已拉取远端记忆' };
    }
    if (action === 'push') {
      const committed = commitLocal();
      const merged = mergeRemote();
      if (merged.skipped) return { ...statusPayload(), action, ok: true, message: committed ? '已本地提交（未配置远端）' : '没有新变化' };
      if (!merged.ok) return { ok: false, action, message: `合并失败：${merged.error}` };
      const pushed = pushRemote();
      if (!pushed.ok) return { ok: false, action, message: `推送失败：${pushed.error}` };
      return { ...statusPayload(), action, ok: true, message: committed ? '已提交并推送' : '已推送' };
    }
    return { ok: false, action, message: `未知操作：${action}` };
  } finally {
    unlock();
  }
}

let result;
try {
  result = run();
} catch (err) {
  result = { ok: false, action, message: err?.message || String(err) };
}
console.log(JSON.stringify(result));
