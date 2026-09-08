// app.js — 视图、路由、写回交互（移动优先）
import { settings } from './store.js';
import { testConnection, getTree, getContent, putContent } from './api.js';
import { render as mdRender, flipCheckbox } from './md.js';
import { buildContext, sendChat, renderMessage, usageSummary } from './chat.js';

const state = { tree: [], fileCache: {}, currentFile: null, chatContext: null };
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

// ---------- 基础 UI ----------
function show(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
  if (tab === 'chat') ensureChatContext();
}
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'show' + (err ? ' err' : '');
  setTimeout(() => { t.className = ''; }, 3200);
}
async function busy(promise) {
  $('#loading').classList.add('on');
  try { return await promise; }
  finally { $('#loading').classList.remove('on'); }
}

// ---------- GitHub 数据 ----------
async function loadTree() { state.tree = await busy(getTree()); }
const cacheGet = (path) => state.fileCache[path];
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

function bindCheckboxes(container, path) {
  container.querySelectorAll('.cb input').forEach(input => {
    input.addEventListener('change', async () => {
      const lineNo = +input.closest('.cb').dataset.line;
      const cached = await fetchFile(path);
      const newText = flipCheckbox(cached.lines, lineNo);
      if (newText === null) return;
      try {
        await writeFile(path, newText, `app: ${path} 行 ${lineNo + 1} 勾选`);
        cached.lines = newText.split('\n');
        input.closest('.cb').querySelector('span').classList.toggle('done', input.checked);
        toast('✓ 已同步到 GitHub');
      } catch (e) {
        input.checked = !input.checked;
        delete state.fileCache[path];
        toast('同步失败（已重拉最新），' + e.message, true);
      }
    });
  });
}
function renderInto(container, text, path) {
  const r = mdRender(text);
  container.innerHTML = r.html;
  if (path) bindCheckboxes(container, path);
}

// ---------- 仪表盘 ----------
async function renderDashboard() {
  const el = $('#dash-body');
  try {
    const f = await fetchFile('仪表盘.md');
    renderInto(el, f.text, '仪表盘.md');
  } catch (e) { el.innerHTML = `<p class="dim">仪表盘还没生成——今晚 21:00 后第一次晚间报告会创建它。${e.message}</p>`; }
}

// ---------- 报告 ----------
async function renderReports(selected) {
  const reports = state.tree.filter(t => /^reports\/(tomorrow|week-.*|triage.*)/.test(t.path))
                            .map(t => t.path).sort().reverse();
  const chips = $('#report-chips');
  chips.innerHTML = reports.map(p =>
    `<button class="chip" data-p="${p}">${p.replace('reports/', '')}</button>`).join('')
    || '<span class="dim">还没有报告</span>';
  chips.querySelectorAll('.chip').forEach(b =>
    b.addEventListener('click', () => loadReport(b.dataset.p)));
  if (selected) loadReport(selected);
  else if (reports.includes('reports/tomorrow.md')) loadReport('reports/tomorrow.md');
  else if (reports.length) loadReport(reports[0]);
}
async function loadReport(path) {
  $$('#report-chips .chip').forEach(b => b.classList.toggle('active', b.dataset.p === path));
  const f = await busy(fetchFile(path));
  renderInto($('#report-body'), f.text, path);
}

// ---------- 日历（ICS） ----------
function parseIcs(text) {
  // 折行还原（续行以空格开头）
  const unfolded = text.replace(/\r\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; }
    else if (cur) {
      const m = line.match(/^([^:]+):(.*)$/);
      if (!m) continue;
      const key = m[1].split(';')[0];
      if (key === 'DTSTART' || key === 'SUMMARY') cur[key] = m[2];
    }
  }
  return events
    .filter(e => e.DTSTART && e.SUMMARY)
    .map(e => ({ date: e.DTSTART, text: e.SUMMARY.replace(/\\,/g, ',').replace(/\\;/g, ';') }))
    .sort((a, b) => a.date.localeCompare(b.date));
}
function relLabel(ymd) {
  const d = new Date(ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff < 0) return `${-diff} 天前`;
  return `${diff} 天后`;
}
async function renderCalendar() {
  const el = $('#cal-body');
  try {
    const f = await fetchFile('reports/deadlines.ics');
    const events = parseIcs(f.text);
    if (!events.length) { el.innerHTML = '<p class="dim">日历为空</p>'; return; }
    el.innerHTML = events.map(e => {
      const past = relLabel(e.date).endsWith('前');
      const ymd = `${e.date.slice(0, 4)}/${e.date.slice(4, 6)}/${e.date.slice(6, 8)}`;
      return `<div class="cal-row ${past ? 'past' : ''}">
        <span class="rel">${relLabel(e.date)}</span>
        <span class="cal-text">${e.text}</span>
        <span class="dim">${ymd}</span></div>`;
    }).join('');
  } catch (e) { el.innerHTML = `<p class="dim">deadlines.ics 尚未生成（今晚晚间报告后出现）。</p>`; }
}

// ---------- 文件 ----------
async function renderFileList() {
  const groups = { '': '根目录', '规划/': '规划', 'reports/': '报告' };
  const el = $('#file-list');
  el.innerHTML = Object.entries(groups).map(([prefix, label]) => {
    const files = state.tree.filter(t => t.path.startsWith(prefix) && t.path.endsWith('.md') && t.path.split('/').length <= (prefix ? 2 : 1));
    return `<h3>${label}</h3>` + (files.length
      ? files.map(f => `<button class="file-link" data-p="${f.path}">${f.path.replace(prefix, '')}</button>`).join('')
      : '<p class="dim">（无）</p>');
  }).join('');
  el.querySelectorAll('.file-link').forEach(b =>
    b.addEventListener('click', () => openFile(b.dataset.p)));
}
async function openFile(path) {
  state.currentFile = path;
  const f = await busy(fetchFile(path));
  $('#file-viewer').classList.add('on');
  $('#file-title').textContent = path;
  renderInto($('#file-body'), f.text, path);
  $('#file-editor').value = f.text;
  $('#file-editor').classList.remove('on');
  $('#btn-edit').textContent = '编辑';
  history.replaceState(null, '', '#file=' + encodeURIComponent(path));
}
async function toggleEditor() {
  const ed = $('#file-editor');
  const opening = !ed.classList.contains('on');
  ed.classList.toggle('on', opening);
  ed.classList.toggle('hidden', !opening);
  $('#btn-save').classList.toggle('hidden', !opening);
  $('#file-body').classList.toggle('hidden', opening);
  $('#btn-edit').textContent = opening ? '取消' : '编辑';
  if (opening && state.currentFile) {
    const f = state.fileCache[state.currentFile];
    if (f) ed.value = f.text;
  } else if (state.currentFile) {
    const f = state.fileCache[state.currentFile];
    if (f) renderInto($('#file-body'), f.text, state.currentFile);
  }
}
async function saveFile() {
  const path = state.currentFile;
  try {
    await writeFile(path, $('#file-editor').value, `app: 编辑 ${path}`);
    toast('✓ 已保存并提交');
    toggleEditor();
    renderInto($('#file-body'), state.fileCache[path].text, path);
  } catch (e) { toast('保存失败：' + e.message, true); }
}

// ---------- 随手记（inbox 快速捕获） ----------
async function captureSubmit() {
  const text = $('#capture-input').value.trim();
  if (!text) return;
  const asTask = $('#capture-task').checked;
  const line = asTask ? `- [ ] ${text}` : text;
  try {
    const inbox = await fetchFile('inbox.md');
    const next = inbox.text.replace(/\s*$/, '') + '\n' + line + '\n';
    await writeFile('inbox.md', next, `app: 随手记`);
    $('#capture-input').value = '';
    closeCapture();
    toast('✓ 已记入 inbox（周日自动分拣）');
  } catch (e) { toast('写入失败：' + e.message, true); }
}
function openCapture() { $('#capture-sheet').classList.add('on'); $('#capture-input').focus(); }
function closeCapture() { $('#capture-sheet').classList.remove('on'); }

// ---------- 聊天 ----------
async function ensureChatContext() {
  const s = settings.load();
  $('#chat-model').value = s.model;
  $('#chat-thinking').checked = s.thinking === 'enabled';
  $('#chat-usage').textContent = usageSummary();
  if (state.chatContext || !s.pat) return;
  $('#chat-status').textContent = '正在加载 vault 上下文…';
  try {
    state.chatContext = await buildContext({
      tree: getTree,
      raw: async p => (await fetchFile(p)).text,
    });
    $('#chat-status').textContent = `上下文就绪（${(state.chatContext.length / 1000).toFixed(0)}k 字符）`;
  } catch (e) { $('#chat-status').textContent = '上下文加载失败：' + e.message; }
}
function pushMessage(role, content) {
  const h = JSON.parse(localStorage.getItem('pp_chat') || '[]');
  h.push({ role, content });
  localStorage.setItem('pp_chat', JSON.stringify(h.slice(-40)));
}
function drawChat() {
  const el = $('#chat-messages');
  const h = JSON.parse(localStorage.getItem('pp_chat') || '[]');
  el.innerHTML = h.map(m => `
    <div class="msg ${m.role}">
      <div class="bubble">${m.role === 'assistant' ? renderMessage(m.content) : m.content.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>
      ${m.role === 'assistant' ? `<button class="mini to-inbox">↩ 写进 inbox</button>` : ''}
    </div>`).join('');
  el.scrollTop = el.scrollHeight;
  el.querySelectorAll('.to-inbox').forEach(b => b.addEventListener('click', async () => {
    const text = b.closest('.msg').querySelector('.bubble').innerText.slice(0, 800);
    try {
      const inbox = await fetchFile('inbox.md');
      await writeFile('inbox.md', inbox.text.replace(/\s*$/, '') + '\n来自聊天：' + text.replace(/\n+/g, ' ') + '\n', 'app: 聊天 → inbox');
      b.textContent = '✓ 已入 inbox'; b.disabled = true;
    } catch (e) { toast('写入失败：' + e.message, true); }
  }));
}
async function chatSend() {
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  pushMessage('user', text); drawChat();
  const errEl = $('#chat-status');
  errEl.textContent = '思考中…';
  try {
    const history = JSON.parse(localStorage.getItem('pp_chat') || '[]')
      .slice(0, -1).filter(m => m.role === 'user' || m.role === 'assistant');
    const reply = await sendChat(text, state.chatContext || '', history);
    pushMessage('assistant', reply);
    drawChat();
    $('#chat-usage').textContent = usageSummary();
    errEl.textContent = '';
  } catch (e) {
    errEl.textContent = e.message;
  }
}
function bindChat() {
  $('#chat-send').addEventListener('click', chatSend);
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
  });
  $('#chat-model').addEventListener('change', e => settings.save({ model: e.target.value }));
  $('#chat-thinking').addEventListener('change', e => settings.save({ thinking: e.target.checked ? 'enabled' : 'disabled' }));
  $('#chat-clear').addEventListener('click', () => {
    localStorage.removeItem('pp_chat'); drawChat(); toast('聊天记录已清空');
  });
  drawChat();
}

// ---------- 设置 ----------
function fillSettings() {
  const s = settings.load();
  $('#set-pat').value = s.pat;
  $('#set-repo').value = s.repo;
  $('#set-glm').value = s.glmKey;
  $('#set-budget').value = s.chatBudgetUsd;
  $('#set-pricein').value = s.priceInPerM;
  $('#set-priceout').value = s.priceOutPerM;
  $('#set-usage').textContent = usageSummary();
}
function bindSettings() {
  $('#btn-save-settings').addEventListener('click', async () => {
    settings.save({
      pat: $('#set-pat').value.trim(),
      repo: $('#set-repo').value.trim(),
      glmKey: $('#set-glm').value.trim(),
      chatBudgetUsd: parseFloat($('#set-budget').value) || 3,
      priceInPerM: parseFloat($('#set-pricein').value) || 0,
      priceOutPerM: parseFloat($('#set-priceout').value) || 0,
    });
    try {
      await busy(testConnection());
      toast('✓ 连接成功');
      await loadTree();
      await renderAll();
      show('dashboard');
    } catch (e) { toast('连接失败：' + e.message, true); }
  });
  $('#btn-clear-local').addEventListener('click', () => {
    if (!confirm('清空本浏览器保存的全部设置与聊天记录？')) return;
    Object.keys(localStorage).filter(k => k.startsWith('pp_')).forEach(k => localStorage.removeItem(k));
    location.reload();
  });
}

// ---------- 全局刷新与启动 ----------
async function renderAll() {
  renderDashboard();
  renderReports();
  renderCalendar();
  renderFileList();
}
function bindNav() {
  $$('.tab-btn').forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
  $('#fab').addEventListener('click', openCapture);
  $('#capture-cancel').addEventListener('click', closeCapture);
  $('#capture-save').addEventListener('click', captureSubmit);
  $('#btn-edit').addEventListener('click', toggleEditor);
  $('#btn-save').addEventListener('click', saveFile);
  $('#btn-close-file').addEventListener('click', () => {
    $('#file-viewer').classList.remove('on');
  });
}

async function boot() {
  bindNav(); bindSettings(); bindChat();
  const s = settings.load();
  if (!s.pat) { show('settings'); fillSettings(); toast('先在设置里粘贴 GitHub PAT', true); return; }
  try {
    await testConnection();
    await loadTree();
    await renderAll();
    show('dashboard');
  } catch (e) {
    show('settings'); fillSettings();
    toast('连接失败：' + e.message, true);
  }
}
boot();
