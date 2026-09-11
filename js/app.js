// app.js — v3：任务中心视图（今天/计划/收件箱/文档/聊天/设置）
// 数据流：GitHub( md + state.json + stats.json ) → state → render；写回 = 行级翻转/追加/整文件
import { settings } from './store.js';
import { testConnection, getTree, getContent, putContent } from './api.js';
import { render as mdRender, flipCheckbox, escapeHtml, inline } from './md.js';
import { buildContext, sendChat, renderMessage, usageSummary } from './chat.js';

const VAPID_PUBLIC = 'BPkee1I-7uyoJVE6Df3nIa9UqHT3vGKBnofIn7VwAWq9uuVbrHqLbaEOvDoiPCXVT7UdrSPtQBgl_Se44wCr-pE';
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

const state = { tree: [], fileCache: {}, currentFile: null, stateData: null, statsData: null, chatContext: null };
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- 基础 UI ----------
function show(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
  if (tab === 'chat') ensureChatContext();
  if (tab === 'today' && !$('#today-body').dataset.loaded) renderToday();
  if (tab === 'plan' && !$('#plan-body').dataset.loaded) renderPlan();
  if (tab === 'inbox' && !$('#inbox-body').dataset.loaded) renderInboxView();
}
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  setTimeout(() => { t.className = ''; }, 3200);
}
async function busy(p) {
  $('#loading').classList.add('on');
  try { return await p; } finally { $('#loading').classList.remove('on'); }
}
const skeleton = () => '<div class="skel"></div><div class="skel w70"></div><div class="skel w85"></div><div class="skel w60"></div>';
const emptyState = (icon, text, action = '') =>
  `<div class="empty">${icon}<p>${text}</p>${action}</div>`;
function vibrate(ms = 12) { if (navigator.vibrate) navigator.vibrate(ms); }

// ---------- GitHub 数据 ----------
async function loadTree() { state.tree = await busy(getTree()); }
async function fetchFile(path) {
  if (state.fileCache[path]) return state.fileCache[path];
  const { text, sha } = await getContent(path);
  state.fileCache[path] = { text, sha, lines: text.split('\n') };
  return state.fileCache[path];
}
async function writeFile(path, text, message) {
  const cached = state.fileCache[path];
  const sha = cached ? cached.sha : (await getContent(path)).sha;
  const newSha = await putContent(path, text, sha, message);
  state.fileCache[path] = { text, sha: newSha, lines: text.split('\n') };
}
async function fetchJSON(path) {
  const f = await fetchFile(path);
  return JSON.parse(f.text);
}

// 状态条目勾选 → 翻转源文件对应行
async function toggleStateItem(file, lineNo, inputEl) {
  vibrate();
  try {
    const cached = await fetchFile(file);
    const newText = flipCheckbox(cached.lines, lineNo - 1); // parser 行号 1-based
    if (newText === null) { inputEl.checked = !inputEl.checked; return; }
    await writeFile(file, newText, `app: ${file} 行 ${lineNo} 勾选`);
    inputEl.closest('.cb')?.querySelector('span')?.classList.toggle('done', inputEl.checked);
    toast('✓ 已同步');
  } catch (e) {
    inputEl.checked = !inputEl.checked;
    delete state.fileCache[file];
    toast('同步失败，' + e.message, true);
  }
}
function bindCb(container) {
  container.querySelectorAll('.cb[data-file]').forEach(input => {
    input.addEventListener('change', () =>
      toggleStateItem(input.dataset.file, +input.dataset.line, input));
  });
}
const itemCard = it => {
  const inner = `<span class="${it.d ? 'done' : ''}">${inline((it.s ? '⭐ ' : '') + it.t)}</span>`
    + `<em>（${it.f.replace(/^规划\//, '').replace(/\.md$/, '')}）</em>`;
  if (typeof it.d === 'boolean')
    return `<label class="cb" data-file="${it.f}" data-line="${it.l}">` +
      `<input type="checkbox" ${it.d ? 'checked' : ''}>${inner}</label>`;
  return `<div class="cb static">${inner}</div>`;
};

// ---------- 今天 ----------
function fmtDay(iso, withWeek = true) {
  const d = new Date(iso + 'T12:00:00');
  const s = `${+iso.slice(5, 7)}/${+iso.slice(8, 10)}`;
  return withWeek ? `${s} 周${WEEKDAY_CN[d.getDay()]}` : s;
}
function renderHeatmap(stats) {
  const days = stats.days;
  const dates = Object.keys(days).sort();
  if (!dates.length) return '';
  // 12 周 × 7 行，末列为当前周
  const cells = [];
  const total = 12 * 7;
  const padded = Array(total - dates.length).fill(null).concat(dates.map(d => ({ d, ...days[d] })));
  const now = new Date();
  let html = '<div class="heatmap" id="heatmap">';
  padded.forEach(cell => {
    if (!cell) { html += '<i class="hcell off"></i>'; return; }
    const level = cell.x + cell.c === 0 ? 0 : cell.x + cell.c <= 1 ? 1 : cell.x + cell.c <= 3 ? 2 : 3;
    const dt2 = new Date(cell.d + 'T12:00:00');
    const isFuture = dt2 > now;
    html += `<i class="hcell l${level}${isFuture ? ' future' : ''}" title="${cell.d}：${cell.c} 提交 / ${cell.x} 勾选"></i>`;
  });
  html += '</div>';
  return `<h2 class="sec">🔥 坚持</h2><p class="dim small">近 12 周 · 越亮越活跃（仅你的提交计入）</p>${html}`;
}
async function renderToday() {
  const el = $('#today-body');
  const s = settings.load();
  if (!s.pat) { $('#onboarding').classList.remove('hidden'); el.innerHTML = ''; return; }
  $('#onboarding').classList.add('hidden');
  el.innerHTML = skeleton();
  el.dataset.loaded = '1';
  try {
    const sd = state.stateData || (state.stateData = await fetchJSON('reports/state.json'));
    if (!state.statsData) {
      try { state.statsData = await fetchJSON('reports/stats.json'); } catch { /* 无热力图数据不致命 */ }
    }
    const today = sd.today;
    let html = `<h2 class="sec">☀️ 今天 · ${fmtDay(today)}</h2>`;
    // 时间线
    if (sd.timeline?.length) {
      html += '<div class="timeline">';
      for (const [time, label] of sd.timeline)
        html += `<div class="trow"><b>${time}</b><span>${label}</span></div>`;
      html += '</div>';
    }
    html += sd.today_items.length
      ? `<div class="cards">${sd.today_items.map(itemCard).join('')}</div>`
      : emptyState('🌤️', '今天没有标注事项——把明天要做的提前想好');
    if (sd.stale.length)
      html += `<h2 class="sec">🐌 滑落（拖了很久）</h2><div class="cards">${sd.stale.map(itemCard).join('')}</div>`;
    if (state.statsData) html += renderHeatmap(state.statsData);
    el.innerHTML = html;
    bindCb(el);
  } catch (e) {
    el.innerHTML = emptyState('🌙', 'state.json 还没生成——今晚 21:00 的晚间报告会带上它',
      e.message.includes('404') ? '' : `<p class="dim small">${e.message}</p>`);
  }
}

// ---------- 计划 ----------
async function renderPlan() {
  const el = $('#plan-body');
  el.innerHTML = skeleton();
  el.dataset.loaded = '1';
  try {
    const sd = state.stateData || (state.stateData = await fetchJSON('reports/state.json'));
    const today = sd.today;
    if (!sd.week.length) { el.innerHTML = emptyState('📅', '未来 7 天没有安排'); return; }
    el.innerHTML = sd.week.map(g => {
      const d = new Date(g.date + 'T12:00:00');
      const rel = g.date === today ? '明天→' : '';
      return `<h3 class="dayhead">${rel}${fmtDay(g.date)}</h3>
        <div class="cards">${g.items.map(itemCard).join('')}</div>`;
    }).join('');
    bindCb(el);
  } catch (e) {
    el.innerHTML = emptyState('🌙', '计划数据来自每晚的 state.json（今晚起生成）', e.message);
  }
}

// ---------- 收件箱 ----------
async function renderInboxView() {
  const el = $('#inbox-body');
  try {
    const f = await fetchFile('inbox.md');
    const lines = f.text.split('\n').map(x => x.trim())
      .filter(x => x && !x.startsWith('#'));
    el.innerHTML = lines.length
      ? `<div class="cards">${lines.map(l => {
          const m = l.match(/^([-*])\s+\[([ xX])\]\s*(.*)$/) || l.match(/^⏳\s*待人工[：:]\s*(.*)$/);
          const held = l.startsWith('⏳');
          const body = held ? m ? m[1] : l.slice(6)
            : m ? m[3] : l;
          return `<div class="card ${held ? 'warn' : ''}">${held ? '⏳ ' : ''}${escapeHtml(body)}<em>（${held ? '待人工处理' : 'inbox'}）</em></div>`;
        }).join('')}</div>
        <p class="dim small">每周日 20:00 自动分拣进对应文件；⏳ 项需要你亲手处理。</p>`
      : emptyState('📥', '收件箱是空的——上面的框随手记');
    el.dataset.loaded = '1';
  } catch (e) { el.innerHTML = emptyState('📥', 'inbox.md 读取失败：' + e.message); }
}
function enqueueOffline(line) {
  const q = JSON.parse(localStorage.getItem('pp_outbox') || '[]');
  q.push(line);
  localStorage.setItem('pp_outbox', JSON.stringify(q));
  toast('📴 当前离线，已存本地，联网后自动同步');
}
async function flushOutbox() {
  const q = JSON.parse(localStorage.getItem('pp_outbox') || '[]');
  if (!q.length || !settings.load().pat) return;
  try {
    const inbox = await fetchFile('inbox.md');
    await writeFile('inbox.md', inbox.text.replace(/\s*$/, '') + '\n' + q.join('\n') + '\n', 'app: 离线补记');
    localStorage.removeItem('pp_outbox');
    toast(`✓ 已补记 ${q.length} 条离线内容`);
  } catch { /* 下次再试 */ }
}
async function inboxSubmit() {
  const input = $('#inbox-input');
  const text = input.value.trim();
  if (!text) return;
  const line = $('#inbox-task').checked ? `- [ ] ${text}` : text;
  try {
    const inbox = await fetchFile('inbox.md');
    await writeFile('inbox.md', inbox.text.replace(/\s*$/, '') + '\n' + line + '\n', 'app: 随手记');
    input.value = '';
    vibrate();
    toast('✓ 已记入（周日自动分拣）');
    if ($('#view-inbox').classList.contains('active')) renderInboxView();
  } catch (e) {
    if (navigator.onLine === false || /Failed to fetch|NetworkError/i.test(e.message)) enqueueOffline(line);
    else toast('写入失败：' + e.message, true);
  }
}

// ---------- 文档（报告 + 文件） ----------
async function renderDocs() {
  const reports = state.tree.filter(t =>
    /^reports\/(tomorrow|week-.*|triage.*)\.md$/.test(t.path)).map(t => t.path);
  reports.sort((a, b) => a.includes('tomorrow') ? -1 : b.includes('tomorrow') ? 1 : b.localeCompare(a));
  const chips = $('#report-chips');
  chips.innerHTML = reports.map(p =>
    `<button class="chip" data-p="${p}">${p.replace('reports/', '')}</button>`).join('')
    || '<span class="dim">还没有报告</span>';
  chips.querySelectorAll('.chip').forEach(b =>
    b.addEventListener('click', () => loadReport(b.dataset.p)));
  if (reports.length) loadReport(reports[0]);

  const groups = { '': '根目录', '规划/': '规划', 'reports/': '报告' };
  const el = $('#file-list');
  el.innerHTML = Object.entries(groups).map(([prefix, label]) => {
    const files = state.tree.filter(t => t.path.startsWith(prefix) && t.path.endsWith('.md')
      && t.path.split('/').length <= (prefix ? 2 : 1) && !/^reports\/(tomorrow|week)/.test(t.path));
    return `<h3>${label}</h3>` + (files.length
      ? files.map(f => `<button class="file-link" data-p="${f.path}">${f.path.replace(prefix, '')}</button>`).join('')
      : '<p class="dim">（无）</p>');
  }).join('');
  el.querySelectorAll('.file-link').forEach(b =>
    b.addEventListener('click', () => openFile(b.dataset.p)));
}
async function loadReport(path) {
  $$('#report-chips .chip').forEach(b => b.classList.toggle('active', b.dataset.p === path));
  const f = await busy(fetchFile(path));
  const r = mdRender(f.text);
  $('#report-body').innerHTML = r.html;
  // 报告内的 checkbox 指向源文件？报告是生成物——只读展示，不绑定写回
}
async function openFile(path) {
  state.currentFile = path;
  const f = await busy(fetchFile(path));
  $('#file-viewer').classList.add('on');
  $('#file-title').textContent = path;
  renderInto($('#file-body'), f.text, path);
  $('#file-editor').value = f.text;
  setFileMode('preview');
  history.replaceState(null, '', '#file=' + encodeURIComponent(path));
}
function setFileMode(mode) {
  const editing = mode === 'edit';
  $('#file-editor').classList.toggle('hidden', !editing);
  $('#btn-save').classList.toggle('hidden', !editing);
  $('#file-body').classList.toggle('hidden', editing);
  $('#btn-edit').classList.toggle('active', editing);
  $('#btn-preview').classList.toggle('active', !editing);
  if (!editing && state.currentFile) {
    const f = state.fileCache[state.currentFile];
    if (f) renderInto($('#file-body'), f.text, state.currentFile);
  }
}
async function saveFile() {
  const path = state.currentFile;
  try {
    await writeFile(path, $('#file-editor').value, `app: 编辑 ${path}`);
    toast('✓ 已保存并提交');
    setFileMode('preview');
  } catch (e) { toast('保存失败：' + e.message, true); }
}
function renderInto(container, text, path) {
  const r = mdRender(text);
  container.innerHTML = r.html;
  container.querySelectorAll('.cb input').forEach(input => {
    input.addEventListener('change', async () => {
      const lineNo = +input.closest('.cb').dataset.line;
      const cached = await fetchFile(path);
      const newText = flipCheckbox(cached.lines, lineNo);
      if (newText === null) return;
      try {
        vibrate();
        await writeFile(path, newText, `app: ${path} 行 ${lineNo + 1} 勾选`);
        input.closest('.cb').querySelector('span')?.classList.toggle('done', input.checked);
        toast('✓ 已同步到 GitHub');
      } catch (e) {
        input.checked = !input.checked;
        delete state.fileCache[path];
        toast('同步失败（已重拉最新），' + e.message, true);
      }
    });
  });
}

// ---------- 聊天 ----------
async function ensureChatContext() {
  const s = settings.load();
  $('#chat-model').value = s.model;
  $('#chat-thinking').checked = s.thinking === 'enabled';
  $('#chat-usage').textContent = usageSummary();
  drawChat();
  if (state.chatContext || !s.pat) return;
  $('#chat-status').textContent = '正在并行加载 vault 上下文…';
  try {
    const t0 = Date.now();
    state.chatContext = await buildContext({
      paths: () => state.tree.length ? state.tree : getTree(),
      raw: async p => (await fetchFile(p)).text,
    });
    $('#chat-status').textContent =
      `上下文就绪（${(state.chatContext.length / 1000).toFixed(0)}k 字符 / ${((Date.now() - t0) / 1000).toFixed(1)}s）`;
  } catch (e) { $('#chat-status').textContent = '上下文加载失败：' + e.message; }
}
function pushMessage(role, content, reasoning) {
  const h = JSON.parse(localStorage.getItem('pp_chat') || '[]');
  h.push({ role, content, reasoning: reasoning || undefined });
  localStorage.setItem('pp_chat', JSON.stringify(h.slice(-40)));
}
function drawChat() {
  const el = $('#chat-messages');
  const h = JSON.parse(localStorage.getItem('pp_chat') || '[]');
  el.innerHTML = h.map(m => {
    let body;
    if (m.role === 'assistant') {
      let main = m.content
        ? renderMessage(m.content)
        : `<span class="dim">（正文为空——思考未完成即截断）</span>` +
          `<button class="mini retry-empty">↻ 重试这条</button>`;
      if (m.reasoning)
        main += `<details class="reason"><summary>💭 思考过程</summary>` +
          `<div class="reason-body">${escapeHtml(m.reasoning)}</div></details>`;
      body = main;
    } else body = escapeHtml(m.content);
    return `<div class="msg ${m.role}"><div class="bubble">${body}</div>` +
      (m.role === 'assistant' && m.content ? `<button class="mini to-inbox">↩ 写进 inbox</button>` : '') + `</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
  el.querySelectorAll('.retry-empty').forEach(b =>
    b.addEventListener('click', retryLastChat));
  el.querySelectorAll('.to-inbox').forEach(b => b.addEventListener('click', async () => {
    const text = b.closest('.msg').querySelector('.bubble').innerText.slice(0, 800);
    try {
      const inbox = await fetchFile('inbox.md');
      await writeFile('inbox.md', inbox.text.replace(/\s*$/, '') + '\n来自聊天：' + text.replace(/\n+/g, ' ') + '\n', 'app: 聊天 → inbox');
      b.textContent = '✓ 已入 inbox'; b.disabled = true;
    } catch (e) { toast('写入失败：' + e.message, true); }
  }));
}
async function retryLastChat() {
  // 重试最后一条：剥掉尾部空 assistant 消息，取最后一条 user 文本，重新走 chatSend
  const h = JSON.parse(localStorage.getItem('pp_chat') || '[]');
  while (h.length && h[h.length - 1].role === 'assistant' && !h[h.length - 1].content) h.pop();
  let idx = -1;
  for (let i = h.length - 1; i >= 0; i--) {
    if (h[i].role === 'user') { idx = i; break; }
  }
  if (idx < 0) return;
  const text = h[idx].content;
  h.length = idx;  // 该 user 消息及之后全部移除，chatSend 会重新推入
  localStorage.setItem('pp_chat', JSON.stringify(h));
  drawChat();
  chatSend(text);
}
async function chatSend(preset) {
  const input = $('#chat-input');
  const text = (preset || input.value).trim();
  if (!text) return;
  input.value = '';
  pushMessage('user', text); drawChat();
  const errEl = $('#chat-status');
  errEl.textContent = '思考中…';
  try {
    const history = JSON.parse(localStorage.getItem('pp_chat') || '[]')
      .slice(0, -1).filter(m => (m.role === 'user' || m.role === 'assistant')
        && m.content && m.content.trim());
    const reply = await sendChat(text, state.chatContext || '', history);
    if (reply.retried) toast('思考耗尽了输出预算，已自动关思考重试成功');
    pushMessage('assistant', reply.content, reply.reasoning);
    drawChat();
    $('#chat-usage').textContent = usageSummary();
    errEl.textContent = '';
  } catch (e) { errEl.textContent = e.message; }
}
function bindChat() {
  $('#chat-send').addEventListener('click', () => chatSend());
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
  });
  $('#chat-model').addEventListener('change', e => settings.save({ model: e.target.value }));
  $('#chat-thinking').addEventListener('change', e => settings.save({ thinking: e.target.checked ? 'enabled' : 'disabled' }));
  $('#chat-clear').addEventListener('click', () => { localStorage.removeItem('pp_chat'); drawChat(); toast('聊天记录已清空'); });
  const presets = [
    ['📊 周日复盘', '请带我做完本周复盘：1) 从 vault 列出本周完成与滑落；2) 一次一个地问我三个关于下周的问题，等我回答；3) 最后汇总「下周三件事」，每件带何时/何地。'],
    ['☀️ 今天做什么', '基于今天的日期和 vault，告诉我今天最该做的三件事和顺序，一句话理由。'],
    ['🗺️ 怎么用这个系统', '用 5 句话向新用户解释这个 app 各 tab 的用途和自动化流程。'],
  ];
  $('#chat-presets').innerHTML = presets.map((p, i) =>
    `<button class="mini preset" data-i="${i}">${p[0]}</button>`).join('');
  $$('#chat-presets .preset').forEach(b =>
    b.addEventListener('click', () => chatSend(presets[+b.dataset.i][1])));
  drawChat();
}

// ---------- 推送 ----------
function urlB64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function getPushSubs() {
  try {
    const f = await fetchFile('reports/push-sub.json');
    return JSON.parse(f.text).subscriptions || [];
  } catch { return []; }
}
async function savePushSubs(subs) {
  await writeFile('reports/push-sub.json',
    JSON.stringify({ subscriptions: subs }, null, 1), 'app: 更新推送订阅');
}
async function togglePush(btn) {
  btn.disabled = true;
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window))
      throw new Error('此浏览器不支持 Web Push');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub) { // 关闭
      await sub.unsubscribe();
      const subs = (await getPushSubs()).filter(s => s.endpoint !== sub.endpoint);
      await savePushSubs(subs);
      btn.textContent = '🔔 开启推送';
      toast('推送已关闭');
    } else {    // 开启
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('通知权限被拒绝');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(VAPID_PUBLIC),
      });
      const subs = await getPushSubs();
      subs.push(sub.toJSON());
      await savePushSubs(subs);
      btn.textContent = '🔕 关闭推送';
      toast('✓ 推送已开启（今晚 21:00 见）');
    }
  } catch (e) { toast('推送设置失败：' + e.message, true); }
  btn.disabled = false;
}
async function initPushBtn() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) $('#btn-push').textContent = '🔕 关闭推送';
  } catch { /* ignore */ }
}

// ---------- 设置 ----------
function fillSettings() {
  const s = settings.load();
  $('#set-pat').value = s.pat;
  $('#set-repo').value = s.repo;
  $('#set-glm').value = s.glmKey;
  $('#set-glmbase').value = s.glmBase;
  $('#set-budget').value = s.chatBudgetUsd;
  $('#set-pricein').value = s.priceInPerM;
  $('#set-priceout').value = s.priceOutPerM;
  $('#set-usage').textContent = usageSummary();
}
function bindSettings() {
  const saveAndConnect = async () => {
    settings.save({
      pat: ($('#set-pat').value || $('#ob-pat').value).trim(),
      repo: $('#set-repo').value.trim(),
      glmKey: $('#set-glm').value.trim(),
      glmBase: $('#set-glmbase').value.trim(),
      chatBudgetUsd: parseFloat($('#set-budget').value) || 3,
      priceInPerM: parseFloat($('#set-pricein').value) || 0,
      priceOutPerM: parseFloat($('#set-priceout').value) || 0,
    });
    try {
      await busy(testConnection());
      $('#conn').textContent = settings.load().repo;
      $('#conn').classList.add('on');
      toast('✓ 连接成功');
      await refreshAll(true);
      show('today');
    } catch (e) { toast('连接失败：' + e.message, true); }
  };
  $('#btn-save-settings').addEventListener('click', saveAndConnect);
  $('#ob-save').addEventListener('click', () => { $('#set-pat').value = $('#ob-pat').value; saveAndConnect(); });
  $('#btn-push').addEventListener('click', e => togglePush(e.currentTarget));
  $('#btn-clear-local').addEventListener('click', () => {
    if (!confirm('清空本浏览器保存的全部设置与聊天记录？')) return;
    Object.keys(localStorage).filter(k => k.startsWith('pp_')).forEach(k => localStorage.removeItem(k));
    location.reload();
  });
}

// ---------- 刷新 / 快捷键 / 下拉刷新 ----------
async function refreshAll(full = false) {
  await loadTree();
  state.stateData = state.statsData = null;
  state.fileCache = {}; // bot 可能已更新文件，强制重拉
  $('#today-body').dataset.loaded = '';
  $('#plan-body').dataset.loaded = '';
  $('#inbox-body').dataset.loaded = '';
  state.chatContext = null;
  await renderDocs();
  await renderToday();
  $('#today-body').dataset.loaded = '1';
}
let gChord = false;
function bindKeys() {
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if (e.key === 'Escape') { $('#file-viewer').classList.remove('on'); return; }
    if (typing || e.metaKey || e.ctrlKey) return;
    if (gChord) {
      gChord = false;
      const map = { t: 'today', p: 'plan', i: 'inbox', d: 'docs', c: 'chat', s: 'settings' };
      if (map[e.key]) { show(map[e.key]); return; }
    }
    if (e.key === 'g') { gChord = true; setTimeout(() => gChord = false, 900); }
    if (e.key === 'r') refreshAll().then(() => toast('已刷新'));
    if (e.key === '/') { e.preventDefault(); show('inbox'); $('#inbox-input').focus(); }
  });
}
function bindPTR() {
  let startY = 0, pulling = false;
  document.addEventListener('touchstart', e => {
    if (document.scrollingElement.scrollTop === 0) startY = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (!startY) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 60 && !pulling) { pulling = true; $('#ptr').classList.add('on'); }
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (pulling) { $('#ptr').classList.remove('on'); refreshAll().then(() => toast('已刷新')); }
    startY = 0; pulling = false;
  });
}

// ---------- 启动 ----------
function bindNav() {
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
  $$('.subtab').forEach(b => b.addEventListener('click', () => {
    $$('.subtab').forEach(x => x.classList.toggle('active', x === b));
    $('#doc-reports').classList.toggle('hidden', b.dataset.doc !== 'reports');
    $('#doc-files').classList.toggle('hidden', b.dataset.doc !== 'files');
  }));
  $('#btn-refresh').addEventListener('click', () => refreshAll().then(() => toast('已刷新')));
  $('#inbox-send').addEventListener('click', inboxSubmit);
  $('#inbox-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); inboxSubmit(); }
  });
  $('#btn-close-file').addEventListener('click', () => $('#file-viewer').classList.remove('on'));
  $('#btn-edit').addEventListener('click', () => setFileMode('edit'));
  $('#btn-preview').addEventListener('click', () => setFileMode('preview'));
  $('#btn-save').addEventListener('click', saveFile);
  bindSettings(); bindChat(); bindKeys(); bindPTR();
  window.addEventListener('online', flushOutbox);
  // 深链恢复
  const m = location.hash.match(/^#file=(.+)$/);
  if (m) {
    const path = decodeURIComponent(m[1]);
    setTimeout(() => openFile(path), 600);
  }
}
async function boot() {
  bindNav();
  const s = settings.load();
  fillSettings();
  initPushBtn();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!s.pat) { show('today'); toast('三步开始：粘贴 GitHub PAT', true); return; }
  try {
    await testConnection();
    $('#conn').textContent = s.repo;
    $('#conn').classList.add('on');
    await loadTree();
    // 并行：state + stats + inbox 预热
    const jobs = [fetchJSON('reports/state.json').then(d => state.stateData = d).catch(() => {}),
                  fetchJSON('reports/stats.json').then(d => state.statsData = d).catch(() => {}),
                  fetchFile('inbox.md').catch(() => {})];
    await busy(Promise.all(jobs));
    await renderDocs();
    show('today');
    await renderToday();
    flushOutbox();
  } catch (e) {
    show('today');
    toast('连接失败：' + e.message, true);
  }
}
boot();
