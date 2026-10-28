(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const Capacitor = window.Capacitor;
  const isNative = Boolean(Capacitor?.isNativePlatform?.());
  const TB = Capacitor?.Plugins?.TermuxBridge || null;
  const SERVER = (!isNative && location.port === '7777') ? '' : 'http://127.0.0.1:7777';

  const state = {
    online: false,
    busy: false,
    ws: null,
    wsRetry: 900,
    cfg: null,
    health: null,
    theme: localStorage.getItem('pa.theme') || 'auto',
    models: [],
    modelTarget: 'model',
    turn: null,
    pendingUser: null,
    historyLoaded: false,
    lastSync: null,
  };

  /* ---------------- theme ---------------- */

  const mql = window.matchMedia('(prefers-color-scheme: light)');

  function resolveTheme(pref) {
    if (pref === 'auto') return mql.matches ? 'light' : 'dark';
    return pref;
  }

  function applyTheme(pref, persist = true) {
    state.theme = pref;
    if (persist) localStorage.setItem('pa.theme', pref);
    const resolved = resolveTheme(pref);
    document.documentElement.dataset.theme = resolved;
    $('#themeColor').setAttribute('content', resolved === 'light' ? '#e9edf7' : '#07080c');
    const seg = $('#themeSeg');
    const idx = { auto: 0, light: 1, dark: 2 }[pref] ?? 0;
    seg?.style.setProperty('--seg-index', String(idx));
    $$('#themeSeg button').forEach((b) => b.classList.toggle('active', b.dataset.themeChoice === pref));
  }

  mql.addEventListener?.('change', () => {
    if (state.theme === 'auto') applyTheme('auto', false);
  });

  /* ---------------- toast ---------------- */

  function toast(message, type = '') {
    const wrap = $('#toastWrap');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, 2600);
  }

  /* ---------------- clipboard ---------------- */

  function unescapeHtml(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制');
      return;
    } catch { /* fall through */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    } catch {
      toast('复制失败，请手动选择', 'err');
    }
  }

  /* ---------------- api ---------------- */

  async function api(path, { method = 'GET', body, timeout = 8000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(SERVER + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------------- connection ---------------- */

  function shortModel(model) {
    if (!model) return '';
    return model.length > 28 ? model.slice(0, 26) + '…' : model;
  }

  function setStatus(mode, text) {
    const dot = $('#statusDot');
    dot.classList.remove('online', 'offline', 'connecting');
    dot.classList.add(mode);
    $('#statusText').textContent = text;
  }

  function setOnline(h) {
    const was = state.online;
    state.online = true;
    state.health = h;
    setStatus('online', `在线 · ${shortModel(h.model)}`);
    renderServiceStatus();
    connectWS();
    if (!was) {
      closeOverlay($('#setupOverlay'));
      toast('已连接');
    }
  }

  function setOffline() {
    state.online = false;
    state.busy = false;
    updateComposer();
    setStatus('offline', '服务未启动 · 点此启动');
    renderServiceStatus();
  }

  async function refreshHealth() {
    try {
      const h = await api('/health', { timeout: 2500 });
      setOnline(h);
      return true;
    } catch {
      setOffline();
      return false;
    }
  }

  function connectWS() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    const base = SERVER || location.origin;
    const url = base.replace(/^http/, 'ws') + '/ws';
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    state.ws = ws;

    ws.onopen = () => {
      state.wsRetry = 900;
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleWS(msg);
    };
    ws.onclose = () => {
      if (state.ws === ws) state.ws = null;
      if (state.online) {
        setTimeout(() => {
          if (state.online) connectWS();
        }, state.wsRetry);
        state.wsRetry = Math.min(state.wsRetry * 1.6, 8000);
      }
    };
    ws.onerror = () => {};
  }

  function handleWS(msg) {
    switch (msg.type) {
      case 'hello': {
        state.historyLoaded = true;
        setBusy(Boolean(msg.busy));
        if (msg.history?.length && !$('#messages').children.length) renderHistory(msg.history);
        if (msg.memory) updateSyncText(msg.memory);
        break;
      }
      case 'state': {
        setBusy(Boolean(msg.busy));
        break;
      }
      case 'user_echo': {
        if (state.pendingUser === msg.text) {
          state.pendingUser = null;
        } else {
          renderUser(msg.text);
        }
        break;
      }
      case 'assistant_delta': {
        appendAssistantText(msg.text, false);
        break;
      }
      case 'assistant_text': {
        appendAssistantText(msg.text, true);
        break;
      }
      case 'thinking_delta': {
        appendThinking(msg.text);
        break;
      }
      case 'thinking_text': {
        appendThinking(msg.text);
        break;
      }
      case 'tool_start': {
        ensureTool(msg.id, msg.name);
        break;
      }
      case 'tool_use': {
        ensureTool(msg.id, msg.name, msg.input);
        break;
      }
      case 'tool_result': {
        setToolResult(msg.id, msg.content, msg.is_error);
        break;
      }
      case 'turn_done': {
        setBusy(false);
        finalizeTurn(msg);
        if (msg.is_error && msg.error) toast(String(msg.error).slice(0, 160), 'err');
        break;
      }
      case 'error': {
        setBusy(false);
        toast(msg.message || '出错了', 'err');
        showError(msg.message || '出错了');
        break;
      }
      case 'session': {
        if (msg.model) {
          state.health = { ...(state.health || {}), model: msg.model };
          if (state.online) setStatus('online', `在线 · ${shortModel(msg.model)}`);
        }
        break;
      }
      case 'session_reset': {
        clearChat();
        break;
      }
      case 'sync': {
        updateSyncText(msg.status);
        break;
      }
      default:
        break;
    }
  }

  function setBusy(value) {
    state.busy = value;
    updateComposer();
  }

  function updateComposer() {
    const btn = $('#btnSend');
    btn.classList.toggle('busy', state.busy);
    btn.setAttribute('aria-label', state.busy ? '停止' : '发送');
  }

  /* ---------------- scrolling ---------------- */

  function chatEl() { return $('#chat'); }

  function nearBottom() {
    const c = chatEl();
    return c.scrollHeight - c.scrollTop - c.clientHeight < 160;
  }

  function scrollToBottom(force = false) {
    const c = chatEl();
    if (!force && !nearBottom()) return;
    requestAnimationFrame(() => {
      c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
    });
  }

  function updateFab() {
    $('#fabScroll').hidden = nearBottom();
  }

  /* ---------------- markdown ---------------- */

  const codeStore = new Map();
  let codeSeq = 0;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderMarkdown(text) {
    let src = escapeHtml(text || '');
    const blocks = [];
    src = src.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
      const id = ++codeSeq;
      codeStore.set(id, unescapeHtml(code.replace(/\n$/, '')));
      blocks.push({ id, lang, code: code.replace(/\n$/, '') });
      return `%%CBCODE${id}%%`;
    });

    src = src.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    src = src.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    src = src.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    src = src.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    src = src.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    const lines = src.split('\n');
    const out = [];
    let listType = null;
    let para = [];

    const closeList = () => {
      if (listType) { out.push(`</${listType}>`); listType = null; }
    };
    const flushPara = () => {
      if (para.length) { out.push(`<p>${para.join('<br>')}</p>`); para = []; }
    };

    for (const raw of lines) {
      const line = raw.trimEnd();
      const trimmed = line.trim();
      if (/^%%CBCODE\d+%%$/.test(trimmed)) {
        flushPara(); closeList(); out.push(trimmed); continue;
      }
      if (!trimmed) { flushPara(); closeList(); continue; }
      const h = line.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const level = h[1].length;
        out.push(`<h${level}>${h[2]}</h${level}>`);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
        flushPara(); closeList(); out.push('<hr>'); continue;
      }
      const ul = line.match(/^\s*[-*]\s+(.*)$/);
      const ol = line.match(/^\s*\d+\.\s+(.*)$/);
      if (ul || ol) {
        const type = ul ? 'ul' : 'ol';
        if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type; }
        out.push(`<li>${(ul || ol)[1]}</li>`);
        continue;
      }
      const bq = line.match(/^\s*>\s?(.*)$/);
      if (bq) {
        flushPara(); closeList(); out.push(`<blockquote>${bq[1]}</blockquote>`); continue;
      }
      para.push(line);
    }
    flushPara(); closeList();

    let html = out.join('\n');
    html = html.replace(/%%CBCODE(\d+)%%/g, (m, idStr) => {
      const block = blocks.find((b) => b.id === Number(idStr));
      if (!block) return '';
      const lang = escapeHtml(block.lang || '代码');
      return `<div class="code"><div class="code-head"><span>${lang}</span><button class="code-copy-btn" data-code-id="${block.id}">复制</button></div><pre><code>${block.code}</code></pre></div>`;
    });
    return html;
  }

  /* ---------------- messages ---------------- */

  function hideWelcome() {
    const w = $('#welcome');
    if (w) w.hidden = true;
  }

  function showWelcome() {
    const w = $('#welcome');
    if (w) w.hidden = false;
  }

  function clearChat() {
    $('#messages').innerHTML = '';
    state.turn = null;
    showWelcome();
    updateFab();
  }

  function renderUser(text) {
    hideWelcome();
    const msg = document.createElement('div');
    msg.className = 'msg user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    msg.appendChild(bubble);
    $('#messages').appendChild(msg);
    scrollToBottom(true);
  }

  function newTurn() {
    hideWelcome();
    const msg = document.createElement('div');
    msg.className = 'msg assistant';
    const turn = document.createElement('div');
    turn.className = 'turn';
    msg.appendChild(turn);
    $('#messages').appendChild(msg);
    state.turn = {
      root: msg,
      turn,
      bubble: null,
      mdEl: null,
      text: '',
      thinking: null,
      tools: new Map(),
      finalized: false,
      renderTimer: null,
    };
    return state.turn;
  }

  function ensureTurn() {
    return state.turn || newTurn();
  }

  function ensureBubble(t) {
    if (t.bubble) return t;
    const bubble = document.createElement('div');
    bubble.className = 'bubble assistant';
    const typ = document.createElement('div');
    typ.className = 'typing';
    typ.innerHTML = '<i></i><i></i><i></i>';
    bubble.appendChild(typ);
    t.turn.appendChild(bubble);
    t.bubble = bubble;

    const md = document.createElement('div');
    md.className = 'md streaming';
    md.hidden = true;
    bubble.appendChild(md);
    t.mdEl = md;
    return t;
  }

  function closeBubble(t) {
    if (!t.bubble) return;
    const typ = t.bubble.querySelector('.typing');
    if (typ) typ.remove();
    if (t.mdEl) {
      t.mdEl.classList.remove('streaming');
      t.mdEl.innerHTML = renderMarkdown(t.text);
    }
    t.bubble = null;
    t.mdEl = null;
    t.text = '';
  }

  function appendAssistantText(text, full) {
    if (!text) return;
    const t = ensureTurn();
    ensureBubble(t);
    if (t.bubble.querySelector('.typing')) t.bubble.querySelector('.typing').remove();
    t.mdEl.hidden = false;
    t.text += text;
    if (full) {
      t.mdEl.innerHTML = renderMarkdown(t.text);
    } else {
      scheduleRender(t);
    }
    if (nearBottom()) scrollToBottom();
  }

  function scheduleRender(t) {
    if (t.renderTimer) return;
    t.renderTimer = setTimeout(() => {
      t.renderTimer = null;
      if (!t.mdEl || t.finalized) return;
      t.mdEl.innerHTML = renderMarkdown(t.text);
    }, 70);
  }

  function appendThinking(text) {
    if (!text) return;
    const t = ensureTurn();
    if (!t.thinking) {
      const details = document.createElement('details');
      details.className = 'think';
      const summary = document.createElement('summary');
      summary.textContent = '思考中…';
      const body = document.createElement('div');
      body.className = 'think-body';
      details.appendChild(summary);
      details.appendChild(body);
      t.turn.insertBefore(details, t.turn.firstChild);
      t.thinking = { details, summary, body };
    }
    t.thinking.body.textContent += text;
    if (nearBottom()) scrollToBottom();
  }

  function toolSummary(name, input) {
    if (!input) return '';
    if (typeof input === 'string') return input.slice(0, 120);
    if (input.command) return String(input.command);
    if (input.file_path) return String(input.file_path);
    if (input.path) return String(input.path);
    if (input.pattern) return String(input.pattern);
    if (input.query) return String(input.query);
    try { return JSON.stringify(input).slice(0, 140); } catch { return ''; }
  }

  function ensureTool(id, name, input) {
    if (!id) id = `tool-${Math.random().toString(36).slice(2)}`;
    const t = ensureTurn();
    let item = t.tools.get(id);
    if (!item) {
      const el = document.createElement('div');
      el.className = 'tool running';
      el.innerHTML = `
        <button class="tool-head" type="button">
          <span class="tool-ico"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7l4 5-4 5M11 17h9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          <span class="tool-name"></span>
          <span class="tool-summary"></span>
          <span class="tool-spinner"></span>
          <svg class="tool-caret" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="tool-body"><div>
          <pre class="tool-pre input" hidden></pre>
          <pre class="tool-pre result" hidden></pre>
        </div></div>`;
      el.querySelector('.tool-name').textContent = name || '工具';
      el.querySelector('.tool-head').addEventListener('click', () => el.classList.toggle('open'));
      closeBubble(t);
      t.turn.appendChild(el);
      item = {
        el,
        name,
        inputPre: el.querySelector('.tool-pre.input'),
        resultPre: el.querySelector('.tool-pre.result'),
        summaryEl: el.querySelector('.tool-summary'),
      };
      t.tools.set(id, item);
    }
    if (name) {
      item.name = name;
      item.el.querySelector('.tool-name').textContent = name;
    }
    if (input !== undefined) {
      item.inputPre.hidden = false;
      item.inputPre.textContent = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
      const summary = toolSummary(name, input);
      if (summary) item.summaryEl.textContent = summary;
    }
    if (nearBottom()) scrollToBottom();
  }

  function setToolResult(id, content, isError) {
    const t = state.turn;
    if (!t) return;
    const item = t.tools.get(id);
    if (!item) return;
    item.el.classList.remove('running');
    item.el.classList.add('done');
    if (isError) item.el.classList.add('error');
    item.resultPre.hidden = false;
    item.resultPre.textContent = content || '(无输出)';
    if (isError) item.resultPre.classList.add('error');
    if (nearBottom()) scrollToBottom();
  }

  function showError(message) {
    const t = ensureTurn();
    ensureBubble(t);
    if (t.bubble.querySelector('.typing')) t.bubble.querySelector('.typing').remove();
    t.mdEl.hidden = false;
    t.finalized = true;
    t.mdEl.classList.remove('streaming');
    t.mdEl.innerHTML = `<p>${escapeHtml(message)}</p>`;
    t.bubble.classList.add('error');
    scrollToBottom(true);
    state.turn = null;
  }

  function finalizeTurn(payload) {
    const t = state.turn;
    if (!t) {
      if (payload?.is_error && payload?.error) showError(payload.error);
      return;
    }
    const hadContent = Boolean(t.bubble || t.tools.size);
    if (t.bubble) {
      if (t.renderTimer) { clearTimeout(t.renderTimer); t.renderTimer = null; }
      if (t.bubble.querySelector('.typing')) t.bubble.querySelector('.typing').remove();
      if (!t.text) {
        t.bubble.remove();
        t.bubble = null;
        t.mdEl = null;
      } else {
        t.mdEl.hidden = false;
        t.mdEl.classList.remove('streaming');
        t.mdEl.innerHTML = renderMarkdown(t.text);
      }
    }
    for (const item of t.tools.values()) {
      item.el.classList.remove('running');
      item.el.classList.add('done');
    }
    if (t.thinking) {
      t.thinking.summary.textContent = '思考过程';
    }
    if (payload?.is_error && payload?.error && !t.text) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble assistant error';
      bubble.textContent = payload.error;
      t.turn.appendChild(bubble);
    }
    if (!hadContent && !payload?.is_error) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble assistant';
      bubble.textContent = payload?.interrupted ? '已停止' : '没有返回内容。';
      t.turn.appendChild(bubble);
    }
    t.finalized = true;
    state.turn = null;
    scrollToBottom();
  }

  function renderHistory(history) {
    if (!history?.length) return;
    hideWelcome();
    for (const item of history) {
      if (item.role === 'user') {
        renderUser(item.text);
      } else {
        const t = newTurn();
        ensureBubble(t);
        t.bubble.querySelector('.typing')?.remove();
        t.text = item.text || '';
        t.mdEl.hidden = false;
        t.mdEl.classList.remove('streaming');
        t.mdEl.innerHTML = renderMarkdown(t.text);
        t.finalized = true;
        state.turn = null;
      }
    }
    scrollToBottom(true);
  }

  /* ---------------- composer ---------------- */

  function autosize() {
    const el = $('#input');
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }

  function sendCurrent() {
    if (state.busy) {
      abortTurn();
      return;
    }
    const input = $('#input');
    const text = input.value.trim();
    if (!text) return;
    if (!state.online) {
      openSetup();
      toast('服务还没启动', 'err');
      return;
    }
    if (!state.ws || state.ws.readyState !== 1) {
      toast('连接还没准备好，稍等一下', 'err');
      connectWS();
      return;
    }
    input.value = '';
    autosize();
    renderUser(text);
    state.pendingUser = text;
    state.busy = true;
    updateComposer();
    state.ws.send(JSON.stringify({ type: 'user', text }));
  }

  function abortTurn() {
    if (!state.ws || state.ws.readyState !== 1) return;
    state.ws.send(JSON.stringify({ type: 'abort' }));
    toast('正在停止…');
  }

  function newChat() {
    if (state.ws && state.ws.readyState === 1) {
      state.ws.send(JSON.stringify({ type: 'new_session' }));
    } else if (state.online) {
      api('/api/session', { method: 'POST' }).catch(() => {});
    }
    clearChat();
    setBusy(false);
    toast('新对话');
  }

  /* ---------------- overlays ---------------- */

  function openOverlay(el) {
    if (!el || !el.hidden) return;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('show'));
  }

  function closeOverlay(el) {
    if (!el || el.hidden) return;
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 340);
  }

  function topOverlay() {
    return $$('.overlay').filter((el) => !el.hidden).pop();
  }

  /* ---------------- settings ---------------- */

  async function openSettings() {
    openOverlay($('#settingsOverlay'));
    loadSync();
    renderServiceStatus();
    loadAbout();
    try {
      const res = await api('/api/config', { timeout: 4000 });
      state.cfg = res.config;
      fillConfig(res.config);
    } catch {
      toast('读取配置失败', 'err');
    }
  }

  function fillConfig(cfg) {
    if (!cfg) return;
    $('#cfgBaseUrl').value = cfg.baseUrl || '';
    $('#cfgToken').value = '';
    $('#cfgToken').placeholder = cfg.tokenSet ? `已保存 ${cfg.tokenPreview}，留空不修改` : '未设置，请输入';
    $('#modelName').textContent = cfg.model || '-';
    $('#cfgSmallModel').value = cfg.smallModel || '';
    $('#cfgWorkdir').value = cfg.workdir || '';
    $('#cfgMaxTurns').value = cfg.maxTurns || 60;
    $('#cfgPermission').value = cfg.permissionMode || 'bypassPermissions';
  }

  async function saveConfig() {
    const body = {
      baseUrl: $('#cfgBaseUrl').value.trim(),
      model: $('#modelName').textContent.trim(),
      smallModel: $('#cfgSmallModel').value.trim(),
      workdir: $('#cfgWorkdir').value.trim(),
      maxTurns: Number($('#cfgMaxTurns').value) || 60,
      permissionMode: $('#cfgPermission').value,
    };
    const token = $('#cfgToken').value.trim();
    if (token) body.authToken = token;
    try {
      const res = await api('/api/config', { method: 'POST', body, timeout: 12000 });
      toast(res.restartNeeded ? '已保存，重启服务后生效' : '配置已保存');
      closeOverlay($('#settingsOverlay'));
      refreshHealth();
    } catch (err) {
      toast(`保存失败：${err.message}`, 'err');
    }
  }

  async function loadSync() {
    try {
      const res = await api('/api/sync', { timeout: 4000 });
      updateSyncText(res.status);
    } catch {
      updateSyncText({ ok: false, message: '服务未连接' });
    }
  }

  function updateSyncText(status) {
    if (!status) return;
    state.lastSync = status;
    const el = $('#syncStatus');
    if (!el) return;
    el.className = `sync-status ${status.ok === false ? 'err' : (status.ok ? 'ok' : '')}`;
    const parts = [];
    parts.push(status.message || '状态未知');
    if (status.remote) parts.push(`远端：${status.remote}`);
    if (status.lastCommit) parts.push(`最近：${status.lastCommit}`);
    el.textContent = parts.join('\n');
  }

  async function syncNow(action) {
    try {
      toast(action === 'pull' ? '正在拉取…' : '正在推送…');
      const res = await api('/api/sync', { method: 'POST', body: { action }, timeout: 95000 });
      updateSyncText(res.status);
      toast(res.status?.ok ? '同步完成' : (res.status?.message || '同步失败'), res.status?.ok ? '' : 'err');
    } catch (err) {
      toast(`同步失败：${err.message}`, 'err');
    }
  }

  async function loadAbout() {
    const lines = [];
    if (state.health) {
      lines.push(`服务 ${state.health.version || '-'} · PID ${state.health.pid || '-'}`);
      lines.push(`Node ${state.health.node || '-'} · ${state.health.platform || '-'}`);
      lines.push(`模型 ${state.health.model || '-'}`);
      lines.push(`工作目录 ${state.health.cwd || '-'}`);
    } else {
      lines.push('服务未连接');
    }
    if (TB) {
      try {
        const info = await TB.getInfo();
        lines.push(`设备 ${info.model || '-'} · Android ${info.android || '-'}`);
        lines.push(`Termux ${info.termuxInstalled ? '已安装' : '未安装'}`);
      } catch {}
    }
    $('#aboutInfo').textContent = lines.join('\n');
  }

  function renderServiceStatus() {
    const el = $('#serviceStatus');
    if (!el) return;
    el.className = 'service-status';
    if (state.health) {
      el.classList.add('ok');
      el.textContent = `运行中 · ${state.health.version || ''} · PID ${state.health.pid || '-'}\n${state.health.cwd || ''}`;
    } else if (state.online) {
      el.textContent = '已连接';
    } else {
      el.classList.add('err');
      el.textContent = '服务未运行。点「启动服务」或按向导安装。';
    }
  }

  /* ---------------- models ---------------- */

  function openModels(target = 'model') {
    state.modelTarget = target;
    $('#modelSheetTitle').textContent = target === 'smallModel' ? '选择小模型' : '选择模型';
    openOverlay($('#modelsOverlay'));
    if (!state.models.length) loadModels(false);
    else renderModelList();
  }

  async function loadModels(force) {
    const list = $('#modelList');
    list.innerHTML = '<div class="model-empty">正在从网关拉取模型列表…</div>';
    try {
      const res = await api(`/api/models${force ? '?force=1' : ''}`, { timeout: 35000 });
      state.models = Array.isArray(res.models) ? res.models : [];
      if (!res.ok) toast(res.error || '模型列表获取失败', 'err');
    } catch (err) {
      state.models = [];
      toast(`模型列表获取失败：${err.message}`, 'err');
    }
    renderModelList();
  }

  function currentModelValue() {
    if (state.modelTarget === 'smallModel') {
      const v = $('#cfgSmallModel').value.trim();
      return v || $('#modelName').textContent.trim();
    }
    return $('#modelName').textContent.trim();
  }

  function renderModelList() {
    const query = ($('#modelSearch').value || '').trim().toLowerCase();
    const current = currentModelValue();
    const list = $('#modelList');
    list.innerHTML = '';
    const models = state.models.filter((m) => !query || m.toLowerCase().includes(query));
    if (!models.length) {
      list.innerHTML = `<div class="model-empty">${state.models.length ? '没有匹配的模型' : '没有拿到模型列表<br>检查 Base URL 和 Token，或手动填自定义模型'}</div>`;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const model of models) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `model-item${model === current ? ' current' : ''}`;
      const name = document.createElement('span');
      name.textContent = model;
      btn.appendChild(name);
      if (model === current) {
        const tick = document.createElement('span');
        tick.className = 'tick';
        tick.textContent = '当前';
        btn.appendChild(tick);
      }
      btn.addEventListener('click', () => {
        pickModel(model);
        closeOverlay($('#modelsOverlay'));
      });
      frag.appendChild(btn);
    }
    list.appendChild(frag);
  }

  function pickModel(model) {
    if (state.modelTarget === 'smallModel') {
      $('#cfgSmallModel').value = model;
    } else {
      $('#modelName').textContent = model;
    }
    toast(`已选择 ${model}`);
  }

  /* ---------------- setup / native ---------------- */

  function openSetup() {
    openOverlay($('#setupOverlay'));
    updateSetupAvailability();
  }

  async function updateSetupAvailability() {
    if (!TB) return;
    try {
      const info = await TB.getInfo();
      const hint = $('#startHint');
      if (!info.termuxInstalled) {
        hint.textContent = '还没检测到 Termux，先完成第 1 步。';
        hint.className = 'step-hint err';
      }
    } catch {}
  }

  function setStartHint(text, kind = '') {
    const el = $('#startHint');
    el.textContent = text;
    el.className = `step-hint ${kind}`;
  }

  async function startService() {
    if (!TB) { toast('需要在 App 内使用', 'err'); return; }
    setStartHint('正在调用 Termux 启动服务…');
    try {
      await TB.startServer();
    } catch (err) {
      const code = err?.code || '';
      if (code.includes('termux_not_installed')) toast('请先安装 Termux', 'err');
      else toast(err?.message || '启动失败', 'err');
      setStartHint(err?.message || '启动失败', 'err');
      return;
    }
    let elapsed = 0;
    const timer = setInterval(async () => {
      elapsed += 1200;
      const ok = await refreshHealth();
      if (ok) {
        clearInterval(timer);
        setStartHint('服务已启动', 'ok');
        closeOverlay($('#setupOverlay'));
        toast('服务已连接');
      } else if (elapsed >= 24000) {
        clearInterval(timer);
        setStartHint('还没有连上。检查 Termux 里 install.sh 是否执行完，再重试。', 'err');
      }
    }, 1200);
  }

  async function stopService() {
    if (!TB) return;
    try {
      await TB.stopServer();
      toast('已发送停止命令');
      setTimeout(refreshHealth, 1200);
    } catch (err) {
      toast(err?.message || '停止失败', 'err');
    }
  }

  async function exportBundle() {
    if (!TB) { toast('需要在 App 内使用', 'err'); return; }
    try {
      const res = await TB.exportBundle();
      toast(`安装包已导出到 ${res.path}`);
    } catch (err) {
      toast(err?.message || '导出失败', 'err');
    }
  }

  function openUrl(url) {
    if (TB) {
      TB.openUrl({ url }).catch(() => { window.open(url, '_blank'); });
    } else {
      window.open(url, '_blank');
    }
  }

  async function openBatterySettings() {
    if (!TB) { toast('需要在 App 内使用', 'err'); return; }
    try {
      await TB.openBatterySettings();
    } catch (err) {
      toast(err?.message || '打开失败', 'err');
    }
  }

  /* ---------------- events ---------------- */

  function bindEvents() {
    $('#btnSend').addEventListener('click', sendCurrent);
    $('#input').addEventListener('input', autosize);
    $('#input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendCurrent();
      }
    });

    $('#btnNew').addEventListener('click', newChat);
    $('#btnSettings').addEventListener('click', () => {
      if (!state.online && !state.health) {
        openSetup();
      }
      openSettings();
    });
    $('#statusPill').addEventListener('click', () => {
      if (state.online) openSettings();
      else openSetup();
    });

    $('#fabScroll').addEventListener('click', () => scrollToBottom(true));
    $('#chat').addEventListener('scroll', updateFab, { passive: true });

    $('#btnPickModel').addEventListener('click', () => openModels('model'));
    $('#btnReloadModels').addEventListener('click', () => loadModels(true));
    $('#modelSearch').addEventListener('input', renderModelList);
    $('#btnUseCustom').addEventListener('click', () => {
      const value = $('#customModel').value.trim();
      if (!value) { toast('先填一个模型 ID', 'err'); return; }
      pickModel(value);
      closeOverlay($('#modelsOverlay'));
    });
    $('#btnSave').addEventListener('click', saveConfig);
    $('#btnToggleToken').addEventListener('click', () => {
      const el = $('#cfgToken');
      el.type = el.type === 'password' ? 'text' : 'password';
    });

    $('#btnSyncPull').addEventListener('click', () => syncNow('pull'));
    $('#btnSyncPush').addEventListener('click', () => syncNow('push'));

    $$('#themeSeg button').forEach((btn) => {
      btn.addEventListener('click', () => applyTheme(btn.dataset.themeChoice));
    });

    $('#btnSvcStart').addEventListener('click', startService);
    $('#btnSvcStop').addEventListener('click', stopService);
    $('#btnOpenTermux').addEventListener('click', () => TB?.openTermux().catch((e) => toast(e?.message || '打开失败', 'err')));
    $('#btnExport').addEventListener('click', exportBundle);
    $('#btnBattery').addEventListener('click', openBatterySettings);
    $('#btnReinstall').addEventListener('click', async () => {
      if (!TB) return;
      try {
        await TB.installDependencies();
        toast('已发送安装命令，去 Termux 看进度');
      } catch (err) {
        toast(err?.message || '发送失败', 'err');
      }
    });

    $('#btnStartService').addEventListener('click', startService);
    $('#btnRetryHealth').addEventListener('click', async () => {
      const ok = await refreshHealth();
      toast(ok ? '服务在线' : '还是连不上', ok ? '' : 'err');
    });
    $('#btnExportSetup').addEventListener('click', exportBundle);
    $('#btnOpenTermuxSetup').addEventListener('click', () => TB?.openTermux().catch(() => {}));
    $('#btnBatterySetup').addEventListener('click', openBatterySettings);
    $('#btnCloseSetup').addEventListener('click', () => closeOverlay($('#setupOverlay')));

    document.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('[data-copy-text]');
      if (copyBtn) { copyText(copyBtn.dataset.copyText); return; }
      const codeBtn = e.target.closest('[data-code-id]');
      if (codeBtn) {
        const code = codeStore.get(Number(codeBtn.dataset.codeId));
        if (code) copyText(code);
        return;
      }
      const urlBtn = e.target.closest('[data-open-url]');
      if (urlBtn) { openUrl(urlBtn.dataset.openUrl); return; }
      const promptChip = e.target.closest('[data-prompt]');
      if (promptChip) {
        $('#input').value = promptChip.dataset.prompt;
        autosize();
        $('#input').focus();
        return;
      }
      const closeBtn = e.target.closest('[data-close]');
      if (closeBtn) {
        const overlay = closeBtn.closest('.overlay');
        if (overlay) closeOverlay(overlay);
        return;
      }
    });

    $$('.overlay').forEach((overlay) => {
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay && !overlay.classList.contains('setup-overlay')) closeOverlay(overlay);
      });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const top = topOverlay();
        if (top) closeOverlay(top);
      }
    });

    window.addEventListener('resize', () => { autosize(); updateFab(); });
  }

  function hideNativeOnly() {
    if (TB) return;
    ['btnSvcStart', 'btnSvcStop', 'btnOpenTermux', 'btnExport', 'btnBattery', 'btnReinstall',
     'btnExportSetup', 'btnOpenTermuxSetup', 'btnBatterySetup', 'btnStartService'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = true;
    });
  }

  /* ---------------- boot ---------------- */

  async function boot() {
    applyTheme(state.theme, false);
    bindEvents();
    hideNativeOnly();
    autosize();
    updateComposer();

    const ok = await refreshHealth();
    if (!ok) {
      setTimeout(openSetup, 500);
      setInterval(() => {
        if (document.visibilityState === 'visible') refreshHealth();
      }, 6000);
    } else {
      setInterval(() => {
        if (document.visibilityState === 'visible') refreshHealth();
      }, 15000);
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refreshHealth();
    });
  }

  boot();
})();
