#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query } from '@anthropic-ai/claude-agent-sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || os.homedir();
const CONFIG_DIR = path.join(HOME, '.phone-agent');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_PATH = path.join(CONFIG_DIR, 'state.json');
const SERVER_LOG = path.join(CONFIG_DIR, 'server.log');
const APP_VERSION = '1.0.0';
const IS_TERMUX = Boolean(process.env.TERMUX_VERSION) || process.platform === 'android';

const DEFAULT_CONFIG = {
  port: 7777,
  baseUrl: 'https://api.anthropic.com/',
  authToken: '',
  model: 'claude-sonnet-4-5',
  smallModel: 'claude-sonnet-4-5',
  workdir: '~/agent',
  memoryRepo: '~/agent-memory',
  maxTurns: 60,
  permissionMode: 'default',
};

const ALLOWED_ORIGINS = new Set([
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
  'http://127.0.0.1:7777',
  'http://localhost:7777',
]);

const expandHome = (p) => {
  if (!p) return p;
  return p.startsWith('~') ? path.join(HOME, p.slice(1)) : path.resolve(p);
};

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(SERVER_LOG, line + '\n'); } catch {}
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, obj, mode = 0o600) {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), { mode });
  await fsp.rename(tmp, file);
}

let cfg = { ...DEFAULT_CONFIG, ...(await readJson(CONFIG_PATH, {})) };
let state = await readJson(STATE_PATH, { resumeSessionId: null, history: [] });
if (!Array.isArray(state.history)) state.history = [];

cfg.workdir = expandHome(cfg.workdir);
cfg.memoryRepo = expandHome(cfg.memoryRepo);
await fsp.mkdir(cfg.workdir, { recursive: true });

const publicCfg = () => ({
  baseUrl: cfg.baseUrl,
  tokenSet: Boolean(cfg.authToken),
  tokenPreview: cfg.authToken ? `${cfg.authToken.slice(0, 3)}…${cfg.authToken.slice(-4)}` : '',
  model: cfg.model,
  smallModel: cfg.smallModel,
  workdir: cfg.workdir,
  memoryRepo: cfg.memoryRepo,
  maxTurns: cfg.maxTurns,
  permissionMode: cfg.permissionMode,
  port: cfg.port,
});

/* ---------------- memory sync ---------------- */

let syncStatus = { ok: null, message: '尚未同步', at: 0, action: null };
let syncTimer = null;

function runMemSync(action) {
  const script = path.join(cfg.memoryRepo, 'tools', 'mem-sync.mjs');
  if (!fs.existsSync(script)) {
    return { ok: false, message: '记忆仓库未安装', action, at: Date.now() };
  }
  try {
    const out = execFileSync(process.execPath, [script, action], {
      timeout: 90000,
      encoding: 'utf8',
      env: { ...process.env, HOME },
    });
    const lines = out.trim().split('\n').filter(Boolean);
    const result = JSON.parse(lines[lines.length - 1]);
    return { ...result, action, at: Date.now() };
  } catch (err) {
    return { ok: false, message: err?.message || String(err), action, at: Date.now() };
  }
}

function updateSync(action, broadcastResult = true) {
  syncStatus = runMemSync(action);
  log(`mem-sync ${action}: ${syncStatus.ok ? 'ok' : 'fail'} ${syncStatus.message || ''}`);
  if (broadcastResult) broadcast({ type: 'sync', status: syncStatus });
  return syncStatus;
}

function scheduleSyncPush() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => updateSync('push'), 6000);
}

/* ---------------- websocket + agent ---------------- */

const clients = new Set();
let wss;

function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1) {
      try { ws.send(data); } catch {}
    }
  }
}

class AsyncQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  push(item) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }
  close() {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const item = this.items.length ? this.items.shift() : await new Promise((r) => this.waiters.push(r));
      if (item === null) return;
      yield item;
    }
  }
}

let activeQuery = null;
let activeQueue = null;
let activeAbort = null;
let busy = false;
let interruptRequested = false;
let currentTurn = null;
const streamedTextMessages = new Set();
let currentMsgId = null;
const toolIdByIndex = new Map();

function buildEnv() {
  const env = {
    ...process.env,
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.authToken,
    ANTHROPIC_MODEL: cfg.model,
    ANTHROPIC_SMALL_FAST_MODEL: cfg.smallModel || cfg.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
  };
  if (IS_TERMUX) env.USE_BUILTIN_RIPGREP = '0';
  return env;
}

function findClaudeCli() {
  if (cfg.claudeExecutable) return expandHome(cfg.claudeExecutable);
  const candidates = [
    process.env.CLAUDE_CODE_PATH,
    path.join(process.env.PREFIX || path.join(HOME, '..', 'usr'), 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
    '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 15000 }).trim();
    const p = path.join(root, '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(p)) return p;
  } catch {}
  return null;
}

function ensureQuery() {
  if (activeQuery) return activeQuery;
  activeQueue = new AsyncQueue();
  activeAbort = new AbortController();

  const options = {
    cwd: cfg.workdir,
    model: cfg.model,
    permissionMode: cfg.permissionMode || 'bypassPermissions',
    maxTurns: Number(cfg.maxTurns) || 60,
    includePartialMessages: true,
    settingSources: ['user', 'project'],
    env: buildEnv(),
    abortController: activeAbort,
  };
  if (options.permissionMode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true;
  if (IS_TERMUX) {
    const cli = findClaudeCli();
    if (cli) {
      options.pathToClaudeCodeExecutable = cli;
      log(`using claude code cli at ${cli}`);
    } else {
      const hint = 'Termux 里找不到可用的 Claude Code CLI。请在 Termux 执行：npm install -g @anthropic-ai/claude-code@2.1.110，然后回到 App 重启服务。';
      log(`warning: ${hint}`);
      activeQueue = null;
      activeAbort = null;
      broadcast({ type: 'turn_done', subtype: 'error', is_error: true, error: hint });
      return null;
    }
  }
  if (state.resumeSessionId) options.resume = state.resumeSessionId;

  const q = query({ prompt: activeQueue, options });
  activeQuery = q;
  consumeQuery(q, activeAbort);
  log(`agent session started (resume=${state.resumeSessionId || 'none'}, model=${cfg.model})`);
  return q;
}

async function consumeQuery(q, controller) {
  try {
    for await (const msg of q) handleSdkMessage(msg);
  } catch (err) {
    if (!controller?.signal.aborted) {
      log(`agent error: ${err?.stack || err}`);
      busy = false;
      broadcast({ type: 'turn_done', subtype: 'error', is_error: true, error: err?.message || String(err) });
    }
  } finally {
    if (activeQuery === q) {
      activeQuery = null;
      activeQueue = null;
      activeAbort = null;
    }
  }
}

function markBusy(value) {
  busy = value;
  broadcast({ type: 'state', busy });
}

function resetActiveQuery() {
  if (activeAbort) {
    try { activeAbort.abort(); } catch {}
  }
  if (activeQueue) activeQueue.close();
  activeQuery = null;
  activeQueue = null;
  activeAbort = null;
  busy = false;
  interruptRequested = false;
  streamedTextMessages.clear();
  currentMsgId = null;
  toolIdByIndex.clear();
}

function textFromToolResult(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b?.type === 'text') return b.text || '';
        if (b?.type === 'image') return '[图片]';
        return JSON.stringify(b);
      })
      .join('\n');
  }
  try { return JSON.stringify(content); } catch { return String(content); }
}

function handleSdkMessage(msg) {
  switch (msg.type) {
    case 'system': {
      if (msg.subtype === 'init') {
        if (msg.session_id) {
          state.resumeSessionId = msg.session_id;
          writeJson(STATE_PATH, state).catch(() => {});
        }
        broadcast({
          type: 'session',
          sessionId: msg.session_id,
          model: msg.model || cfg.model,
          tools: Array.isArray(msg.tools) ? msg.tools.length : 0,
          cwd: msg.cwd || cfg.workdir,
        });
      }
      break;
    }

    case 'stream_event': {
      const ev = msg.event;
      if (!ev) break;
      if (ev.type === 'message_start') {
        currentMsgId = ev.message?.id || null;
      } else if (ev.type === 'content_block_start') {
        const block = ev.content_block;
        if (block?.type === 'tool_use') {
          toolIdByIndex.set(ev.index, block.id);
          broadcast({ type: 'tool_start', id: block.id, name: block.name });
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta;
        if (d?.type === 'text_delta' && d.text) {
          if (currentMsgId) streamedTextMessages.add(currentMsgId);
          if (currentTurn) currentTurn.assistant += d.text;
          broadcast({ type: 'assistant_delta', text: d.text });
        } else if (d?.type === 'thinking_delta' && d.thinking) {
          broadcast({ type: 'thinking_delta', text: d.thinking });
        } else if (d?.type === 'input_json_delta') {
          const toolId = toolIdByIndex.get(ev.index);
          if (toolId) broadcast({ type: 'tool_input_delta', id: toolId, partial: d.partial_json || '' });
        }
      } else if (ev.type === 'message_stop') {
        currentMsgId = null;
      }
      break;
    }

    case 'assistant': {
      const messageId = msg.message?.id;
      const alreadyStreamed = messageId && streamedTextMessages.has(messageId);
      for (const block of msg.message?.content || []) {
        if (block.type === 'text') {
          if (!alreadyStreamed && block.text) {
            if (currentTurn) currentTurn.assistant += block.text;
            broadcast({ type: 'assistant_text', text: block.text });
          }
        } else if (block.type === 'tool_use') {
          broadcast({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
        } else if (block.type === 'thinking') {
          if (!alreadyStreamed && block.thinking) {
            broadcast({ type: 'thinking_text', text: block.thinking });
          }
        }
      }
      break;
    }

    case 'user': {
      for (const block of msg.message?.content || []) {
        if (block.type === 'tool_result') {
          broadcast({
            type: 'tool_result',
            id: block.tool_use_id,
            content: textFromToolResult(block.content).slice(0, 20000),
            is_error: Boolean(block.is_error),
          });
        }
      }
      break;
    }

    case 'result': {
      const interrupted = interruptRequested;
      interruptRequested = false;
      const payload = {
        type: 'turn_done',
        subtype: interrupted ? 'interrupted' : msg.subtype,
        is_error: Boolean(msg.is_error) && !interrupted,
        interrupted,
        duration_ms: msg.duration_ms,
        num_turns: msg.num_turns,
        cost_usd: msg.total_cost_usd ?? null,
        error: msg.is_error && !interrupted ? msg.result || msg.subtype : undefined,
      };
      if (currentTurn) {
        state.history.push({ role: 'user', text: currentTurn.user, ts: currentTurn.ts });
        state.history.push({
          role: 'assistant',
          text: currentTurn.assistant,
          ts: Date.now(),
          meta: { duration_ms: msg.duration_ms, cost_usd: msg.total_cost_usd ?? null, subtype: msg.subtype },
        });
        state.history = state.history.slice(-120);
        currentTurn = null;
        writeJson(STATE_PATH, state).catch(() => {});
      }
      markBusy(false);
      broadcast(payload);
      scheduleSyncPush();
      break;
    }

    default:
      break;
  }
}

function sendUserMessage(text) {
  if (!text || !text.trim()) return;
  if (busy) {
    broadcast({ type: 'error', message: '上一轮还在进行中，先点停止或等它结束。' });
    return;
  }
  currentTurn = { user: text, assistant: '', ts: Date.now() };
  if (!ensureQuery()) return;
  markBusy(true);
  activeQueue.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    session_id: state.resumeSessionId || '',
  });
  broadcast({ type: 'user_echo', text, ts: currentTurn.ts });
}

async function interruptTurn() {
  if (!activeQuery) return;
  try {
    interruptRequested = true;
    await activeQuery.interrupt();
    log('turn interrupted by user');
  } catch (err) {
    log(`interrupt failed: ${err}`);
    resetActiveQuery();
    markBusy(false);
    broadcast({ type: 'error', message: '已强制停止本轮。' });
  }
}

function newSession() {
  resetActiveQuery();
  state.resumeSessionId = null;
  state.history = [];
  writeJson(STATE_PATH, state).catch(() => {});
  broadcast({ type: 'session_reset' });
  log('new session');
}

/* ---------------- model list ---------------- */

let modelCache = { at: 0, ids: [] };

function gatewayUrl(pathname) {
  const base = cfg.baseUrl?.endsWith('/') ? cfg.baseUrl : `${cfg.baseUrl}/`;
  return new URL(pathname.replace(/^\//, ''), base).toString();
}

async function fetchModels(force = false) {
  if (!force && Date.now() - modelCache.at < 5 * 60 * 1000 && modelCache.ids.length) {
    return modelCache.ids;
  }
  const res = await fetch(gatewayUrl('v1/models'), {
    headers: { Authorization: `Bearer ${cfg.authToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const ids = Array.isArray(json.data) ? json.data.map((m) => m.id).filter(Boolean) : [];
  modelCache = { at: Date.now(), ids };
  return ids;
}

/* ---------------- http ---------------- */

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      Vary: 'Origin',
    };
  }
  return {};
}

function sendJson(req, res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    ...corsHeaders(req),
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res) {
  const wwwDir = path.join(__dirname, '..', 'www');
  if (!fs.existsSync(path.join(wwwDir, 'index.html'))) return false;
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.resolve(wwwDir, rel);
  if (!file.startsWith(path.resolve(wwwDir))) return false;
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req));
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;

    if (p === '/health' || p === '/api/health') {
      return sendJson(req, res, 200, {
        ok: true,
        version: APP_VERSION,
        pid: process.pid,
        uptime: process.uptime(),
        platform: IS_TERMUX ? 'termux' : process.platform,
        node: process.version,
        model: cfg.model,
        cwd: cfg.workdir,
        busy,
        sessionId: state.resumeSessionId,
        memory: syncStatus,
      });
    }

    if (p === '/api/config' && req.method === 'GET') {
      return sendJson(req, res, 200, { ok: true, config: publicCfg() });
    }

    if (p === '/api/config' && req.method === 'POST') {
      const body = await readBody(req);
      const next = { ...cfg };
      if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) next.baseUrl = body.baseUrl.trim();
      if (typeof body.authToken === 'string' && body.authToken.trim()) next.authToken = body.authToken.trim();
      if (typeof body.model === 'string' && body.model.trim()) next.model = body.model.trim();
      if (typeof body.smallModel === 'string') next.smallModel = body.smallModel.trim();
      if (typeof body.workdir === 'string' && body.workdir.trim()) next.workdir = body.workdir.trim();
      if (typeof body.memoryRepo === 'string' && body.memoryRepo.trim()) next.memoryRepo = body.memoryRepo.trim();
      if (Number.isFinite(Number(body.maxTurns))) next.maxTurns = Number(body.maxTurns);
      if (typeof body.permissionMode === 'string') next.permissionMode = body.permissionMode;
      if (Number.isFinite(Number(body.port))) next.port = Number(body.port);

      const restartNeeded =
        next.port !== cfg.port ||
        next.baseUrl !== cfg.baseUrl ||
        next.authToken !== cfg.authToken;

      cfg = next;
      cfg.workdir = expandHome(cfg.workdir);
      cfg.memoryRepo = expandHome(cfg.memoryRepo);
      await fsp.mkdir(cfg.workdir, { recursive: true });
      await writeJson(CONFIG_PATH, cfg);
      resetActiveQuery();
      newSession();
      return sendJson(req, res, 200, { ok: true, restartNeeded, config: publicCfg() });
    }

    if (p === '/api/models' && req.method === 'GET') {
      try {
        const force = url.searchParams.get('force') === '1';
        const ids = await fetchModels(force);
        return sendJson(req, res, 200, { ok: true, models: ids, cachedAt: modelCache.at });
      } catch (err) {
        return sendJson(req, res, 200, { ok: false, models: [], error: err?.message || String(err) });
      }
    }

    if (p === '/api/sync' && req.method === 'GET') {
      return sendJson(req, res, 200, { ok: true, status: syncStatus });
    }

    if (p === '/api/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action === 'pull' || body.action === 'push' ? body.action : 'status';
      const status = updateSync(action);
      return sendJson(req, res, 200, { ok: Boolean(status.ok), status });
    }

    if (p === '/api/session' && req.method === 'POST') {
      newSession();
      return sendJson(req, res, 200, { ok: true });
    }

    if (req.method === 'GET' && (await serveStatic(req, res))) return;

    sendJson(req, res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    log(`http error: ${err?.stack || err}`);
    sendJson(req, res, 500, { ok: false, error: err?.message || String(err) });
  }
});

wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    socket.destroy();
    return;
  }
  if (new URL(req.url, 'http://localhost').pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({
    type: 'hello',
    version: APP_VERSION,
    config: publicCfg(),
    sessionId: state.resumeSessionId,
    history: state.history.slice(-40),
    busy,
    memory: syncStatus,
  }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      if (msg.type === 'user') {
        sendUserMessage(String(msg.text || ''));
      } else if (msg.type === 'abort') {
        await interruptTurn();
      } else if (msg.type === 'new_session') {
        newSession();
      } else if (msg.type === 'sync') {
        updateSync(msg.action === 'pull' ? 'pull' : 'push');
      } else if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: 'error', message: err?.message || String(err) }));
    }
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(cfg.port, '127.0.0.1', () => {
  log(`phone-agent server ${APP_VERSION} listening on 127.0.0.1:${cfg.port} (termux=${IS_TERMUX}, cwd=${cfg.workdir})`);
  setTimeout(() => updateSync('pull', false), 800);
});

process.on('uncaughtException', (err) => {
  log(`uncaught: ${err?.stack || err}`);
});
process.on('unhandledRejection', (err) => {
  log(`unhandled rejection: ${err?.stack || err}`);
});
