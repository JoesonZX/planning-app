// app.js — v3：任务中心视图（今天/计划/收件箱/文档/聊天/设置）
// 数据流：GitHub( md + state.json + stats.json ) → state → render；写回 = 行级翻转/追加/整文件
import { settings } from './store.js';
import { testConnection, getTree, getContent, putContent } from './api.js';
import { render as mdRender, flipCheckbox, escapeHtml, inline } from './md.js';
import { buildContext, sendChat, renderMessage, usageSummary } from './chat.js';
import { openDiary } from './diary.js';

const VAPID_PUBLIC = 'BPkee1I-7uyoJVE6Df3nIa9UqHT3vGKBnofIn7VwAWq9uuVbrHqLbaEOvDoiPCXVT7UdrSPtQBgl_Se44wCr-pE';
const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];

// v9：设备时钟是「今天」的唯一权威（state.today 由生成时刻写死——凌晨 0 点到
// 晨间刷新之间是昨天）。state.today 只在设备时钟反常落后时兜底。
const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDaysIso = (iso, n) => {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
// 桥接：state 快照落后于设备时钟时，今天的数据从 week 对应日组取
// （引擎 horizon=生成日+7，当日组就在 week 里）；快照正常则用 today 字段组
function todayGroups(sd) {
  const t = localToday();
  if (!sd || t <= sd.today)
    return { items: sd?.today_items || [], sched: sd?.sched_today || [], misc: sd?.misc_today || [] };
  const g = (sd.week || []).find(x => x.date === t);
  return { items: g?.items || [], sched: g?.sched || [], misc: g?.misc || [] };
}

const state = { tree: [], fileCache: {}, currentFile: null, stateData: null, statsData: null, chatContext: null };
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// ---------- 基础 UI ----------
function show(tab) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
  if (tab === 'assistant') { ensureChatContext(); renderInboxStrip(); }
  if (tab === 'today' && !$('#today-body').dataset.loaded) renderToday();
  if (tab === 'plan' && !$('#plan-body').dataset.loaded) { renderPlan(); renderDocs(); }
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
async function writeFile(path, textOrFn, message) {
  const cached = state.fileCache[path];
  let sha = cached ? cached.sha : null;
  if (!cached) {
    try { sha = (await getContent(path)).sha; }
    catch (e) { if (e.status !== 404) throw e; }  // 新文件（如首篇日记）：无 sha，PUT 不带 sha 即创建
  }
  const { sha: newSha, unchanged } = await putContent(path, textOrFn, sha, message);
  const text = typeof textOrFn === 'function'
    ? (await getContent(path)).text : textOrFn;
  state.fileCache[path] = { text, sha: newSha, lines: text.split('\n') };
  return { unchanged };
}
async function fetchJSON(path) {
  const f = await fetchFile(path);
  return JSON.parse(f.text);
}

// ---------- 条目行 + 底部动作表（v9：无完成交互，点任意条目行 = 动作表） ----------
// 红线纵深防御：日记/与 reports/ 的行不可经动作表删改（引擎本就不会输出它们）
const safeFile = f => !/^日记\//.test(f || '') && !/^reports\//.test(f || '');
// 语义键（与引擎 norm_text 同思路）：删除前按内容软校验，防渲染到点击之间行号漂移
const normKey = s => (s || '').replace(/\s+/g, '').replace(/[*_`#>|（）()【】\[\]]/g, '');

const itemCard = (it, opts = {}) => {
  const kind = opts.kind || (typeof it.d === 'boolean' ? 'task' : 'sched');
  const dup = (it.src && it.src.length > 1) ? ` +${it.src.length - 1} 处重复` : '';
  const srcAttr = dup ? ` data-src='${escapeHtml(JSON.stringify(it.src))}'` : '';
  // 改期预填：行内多个日期时取第一个还没过去的（首个未来日期归因同引擎；dates[0] 可能已过期）
  const dates = it.dates || [];
  const defDate = dates.find(x => x >= localToday()) || dates[0] || '';
  const inner = `<span class="${it.d ? 'done' : ''}">${inline(it.t)}</span>` +
    `<em>（${it.f.replace(/^规划\//, '').replace(/\.md$/, '')}${dup}）</em>`;
  return `<div class="cb act" data-kind="${kind}" data-f="${it.f}" data-l="${it.l}"` +
    ` data-t="${escapeHtml((it.t || '').slice(0, 120))}" data-s="${it.s ? 1 : ''}"` +
    ` data-date="${defDate}" data-seg="${it.seg ? 1 : ''}"${srcAttr}>${inner}</div>`;
};
const miscFold = (arr) => (arr && arr.length)
  ? `<details class="misifold"><summary>其他带日期 ${arr.length}</summary>` +
    `<div class="cards">${arr.map(it => itemCard(it, { kind: 'misc' })).join('')}</div></details>`
  : '';

function bindRows(container) {
  container.querySelectorAll('.cb.act[data-f]').forEach(row =>
    row.addEventListener('click', () => openActionSheet({ ...row.dataset })));
}

function closeSheet() {
  $('#actionsheet')?.remove();
  $('#sheet-backdrop')?.remove();
}
function openActionSheet(d) {
  closeSheet();
  vibrate();
  const delLabel = d.src ? `删除（含 ${JSON.parse(d.src).length} 处重复）` : '删除';
  const segNote = d.seg ? ' · 多日框架行，删除移除整行' : '';
  const dateRow = d.seg ? '' :
    `<div class="sheet-date"><input type="date" id="sheet-date" value="${d.date || ''}">` +
    `<button class="sheet-btn accent" data-act="resched">改期</button></div>`;
  const convBtn = d.kind === 'sched' ? `<button class="sheet-btn accent" data-act="conv">转任务</button>` : '';
  const delBtn = safeFile(d.f) ? `<button class="sheet-btn danger" data-act="del">${delLabel}</button>` : '';
  const el = document.createElement('div');
  el.id = 'actionsheet';
  el.innerHTML = `<div class="sheet-title">${escapeHtml(d.t || '（无文本）')}</div>` +
    `<div class="sheet-sub">（${d.f.replace(/^规划\//, '').replace(/\.md$/, '')}）${segNote}</div>` +
    convBtn + dateRow + delBtn +
    `<button class="sheet-cancel" data-act="cancel">取消</button>`;
  const bd = document.createElement('div');
  bd.id = 'sheet-backdrop';
  document.body.appendChild(bd);
  document.body.appendChild(el);
  requestAnimationFrame(() => { bd.classList.add('on'); el.classList.add('on'); });
  bd.addEventListener('click', closeSheet);
  el.addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    if (act === 'cancel') closeSheet();
    else if (act === 'del') sheetDelete(d);
    else if (act === 'resched') sheetResched(d, $('#sheet-date')?.value);
    else if (act === 'conv') sheetConvert(d);
  });
}
async function sheetDelete(d) {
  const targets = d.src ? JSON.parse(d.src) : [[d.f, +d.l]];
  try {
    await busy((async () => {
      for (const [f, l] of targets) {
        if (!safeFile(f)) throw new Error('该文件不可在此删除');
        await writeFile(f, cur => {
          const lines = cur.split('\n');
          if (l - 1 >= lines.length || !lines[l - 1].trim()) throw new Error('该行已变化，请刷新后重试');
          const hit = normKey(d.t).slice(0, 12);
          if (hit && !normKey(lines[l - 1]).includes(hit)) throw new Error('该行已变化，请刷新后重试');
          return lines.filter((_, i) => i !== l - 1).join('\n');
        }, `app: 删除条目 ${f}:${l}`);
      }
    })());
    vibrate(); closeSheet(); toast('已删除');
    patchLocalRemoveTargets(targets);
  } catch (e) { closeSheet(); toast('删除失败：' + e.message, true); }
}
async function sheetResched(d, val) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(val || '');
  if (!m) { closeSheet(); return toast('先选一个日期', true); }
  try {
    const { unchanged } = await busy(writeFile(d.f, cur => {
      const lines = cur.split('\n');
      if (d.l - 1 >= lines.length) throw new Error('行号已失效，请刷新');
      const before = lines[d.l - 1];
      const after = before.replace(/(\d{1,2})[.\/](\d{1,2})/, `${+m[2]}/${+m[3]}`);
      if (after === before) throw new Error('该行没有 M/D 日期可改');
      lines[d.l - 1] = after;  // v9 复查：算出 after 必须写回——否则整文件原文返回，unchanged 假成功
      return lines.join('\n');
    }, `app: 条目改期 ${d.f}:${d.l} → ${+m[2]}/${+m[3]}`));
    vibrate(); closeSheet();
    toast(unchanged ? '该条已是所选日期' : '✓ 已改期');
    const moved = state.fileCache[d.f]?.lines?.[d.l - 1];
    patchLocalRemoveTargets([[d.f, +d.l]]);
    if (moved && !unchanged) patchLocalInsert({
      t: moved.replace(/^[-*]\s+\[[ xX]\]\s*/, '').replace(/^>\s*/, '').replace(/\r$/, ''),
      s: d.s === '1',
      d: d.kind === 'task' ? /\[x\]/i.test(moved) : undefined,
      f: d.f, l: +d.l, dates: [`${m[1]}-${m[2]}-${m[3]}`],
    }, d.kind);
  } catch (e) { closeSheet(); toast('改期失败：' + e.message, true); }
}
async function sheetConvert(d) {
  const text = (d.t || '').slice(0, 120);
  try {
    await busy(writeFile(d.f, cur => cur.replace(/\s*$/, '') + `\n- [ ] ${text}（转自日程）\n`,
      'app: 日程转任务'));
    vibrate(); closeSheet();
    toast('✓ 已登记为任务（无日期，滑落跟踪）');
    const cached = state.fileCache[d.f];
    const lineNo = cached ? cached.lines.findIndex(ln => ln.includes('转自日程') && ln.includes(text.slice(0, 20))) : -1;
    patchLocalInsert({ t: `${text}（转自日程）`, s: false, d: false, f: d.f, l: lineNo + 1, dates: [localToday()] });
  } catch (e) { closeSheet(); toast('失败：' + e.message, true); }
}

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
  return `<h2 class="sec">坚持</h2><p class="dim small">近 12 周 · 越亮越活跃（仅你的提交计入）</p>${html}`;
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
    const t = localToday();
    const { items, sched, misc } = todayGroups(sd);
    let html = `<h2 class="sec">今天 · ${fmtDay(t)}</h2>`;
    if (t > sd.today)
      html += `<p class="dim small">引擎快照还是 ${fmtDay(sd.today)}——今天内容从周计划桥接</p>`;
    // 时间线
    if (sd.timeline?.length) {
      html += '<div class="timeline">';
      for (const [time, label] of sd.timeline)
        html += `<div class="trow"><b>${time}</b><span>${label}</span></div>`;
      html += '</div>';
    }
    // 日程安排在上（按计划走，不算任务），代办事项在下（v9 两区排列）
    if (sched.length)
      html += `<h2 class="sec">日程安排</h2><div class="cards sched">${sched.map(it => itemCard(it, { kind: 'sched' })).join('')}</div>`;
    html += items.length
      ? `<h2 class="sec">代办事项</h2><div class="cards">${items.map(it => itemCard(it, { kind: 'task' })).join('')}</div>`
      : emptyState('', '今天没有标注任务——把明天要做的提前想好');
    html += miscFold(misc);
    html += `<button id="btn-diary" class="diary-entry"><b>日记</b><span>记一笔今天 · 做了什么与感受</span></button>`;
    if (sd.stale.length)
      html += `<h2 class="sec">滑落（拖了很久）</h2><div class="cards">${sd.stale.map(it => itemCard(it, { kind: 'task' })).join('')}</div>`;
    if (state.statsData) html += renderHeatmap(state.statsData);
    el.innerHTML = html;
    bindRows(el);
    const db = document.querySelector('#btn-diary');
    if (db) db.addEventListener('click', () =>
      openDiary({ put: (p, t2, m) => writeFile(p, t2, m), toast, dateStr: t }));
  } catch (e) {
    el.innerHTML = emptyState('', 'state.json 还没生成——今晚 21:00 的晚间报告会带上它',
      e.message.includes('404') ? '' : `<p class="dim small">${e.message}</p>`);
  }
}

// ---------- 计划 ----------
async function renderPlan() {
  const el = $('#plan-body');
  if (!$('#add-task-row')) {
    el.parentElement.insertAdjacentHTML('afterbegin', `
      <div id="add-task-row" class="nt-row">
        <input id="nt-text" type="text" placeholder="新任务…">
        <input id="nt-date" type="text" placeholder="M/D">
        <button id="nt-star" class="nt-star" title="硬节点">☆</button>
        <button id="nt-add" class="nt-add">添加</button>
      </div>`);
    $('#nt-star').addEventListener('click', e => {
      e.currentTarget.classList.toggle('on');
      e.currentTarget.textContent = e.currentTarget.classList.contains('on') ? '★' : '☆';
    });
    $('#nt-add').addEventListener('click', addTaskDirect);
  }
  el.innerHTML = skeleton();
  el.dataset.loaded = '1';
  try {
    const sd = state.stateData || (state.stateData = await fetchJSON('reports/state.json'));
    const t = localToday();
    const groups = (sd.week || []).filter(g => g.date >= t);  // 今天起（v9 桥接后不再显示过去的组）
    if (!groups.length) { el.innerHTML = emptyState('', '未来 7 天没有安排'); return; }
    el.innerHTML = groups.map(g => {
      const rel = g.date === t ? '今天 · ' : g.date === addDaysIso(t, 1) ? '明天 → ' : '';
      const items = (g.items || []).length
        ? `<div class="cards">${g.items.map(it => itemCard(it, { kind: 'task' })).join('')}</div>` : '';
      const sched = (g.sched || []).length
        ? `<div class="cards sched">${g.sched.map(it => itemCard(it, { kind: 'sched' })).join('')}</div>` : '';
      return `<h3 class="dayhead">${rel}${fmtDay(g.date)}</h3>${items}${sched}${miscFold(g.misc)}`;
    }).join('');
    bindRows(el);
  } catch (e) {
    el.innerHTML = emptyState('', '计划数据来自每晚的 state.json（今晚起生成）', e.message);
  }
}

// ---------- 收件箱（并入助手 tab：乐观纸条 + 展开/删除） ----------
function inboxLines(text) {
  return text.split('\n').map(x => x.trim())
    .map((x, i) => ({ x, i }))
    .filter(o => o.x && !o.x.startsWith('#'));
}
async function renderInboxStrip() {
  const wrap = $('#inbox-strip-wrap');
  try {
    const f = await fetchFile('inbox.md');
    const lines = inboxLines(f.text);
    wrap.classList.toggle('hidden', false);
    const strip = $('#inbox-strip');
    strip.innerHTML = lines.length
      ? lines.map((o, k) => `<button class="strip-chip${o.x.startsWith('⏳') ? ' held' : ''}" data-k="${k}">${escapeHtml(o.x.replace(/^[-*]\s+\[[ xX]\]\s*/, '').slice(0, 18))}</button>`).join('')
      : '<span class="dim small">待分拣是空的——下面的框随手记，周日自动分拣</span>';
    strip.querySelectorAll('.strip-chip').forEach(b =>
      b.addEventListener('click', () => showStripDetail(+b.dataset.k)));
    $('#strip-detail').classList.add('hidden');
  } catch { wrap.classList.add('hidden'); }
}
function showStripDetail(k) {
  const f = state.fileCache['inbox.md'];
  if (!f) return;
  const lines = inboxLines(f.text);
  const o = lines[k];
  if (!o) return;
  const d = $('#strip-detail');
  d.classList.remove('hidden');
  d.innerHTML = `<div class="strip-full">${escapeHtml(o.x.replace(/^[-*]\s+\[[ xX]\]\s*/, ''))}</div>` +
    `<button class="mini prop-apply strip-del" data-line="${o.i}">删除这条</button>` +
    `<button class="mini strip-close">收起</button>`;
  d.querySelector('.strip-del').addEventListener('click', async () => {
    try {
      await busy(writeFile('inbox.md', cur => {
        const lines = cur.split('\n');
        // 按内容定位（渲染到点击之间可能新增过条目，索引会漂移）
        const idx = lines.findIndex(x => x.trim() === o.x);
        if (idx < 0) throw new Error('该条已变化，请刷新');
        return lines.filter((_, i) => i !== idx).join('\n');
      }, 'app: 删除 inbox 条目'));
      vibrate();
      toast('已删除');
      renderInboxStrip();
    } catch (e) { toast('删除失败：' + e.message, true); }
  });
  d.querySelector('.strip-close').addEventListener('click', () =>
    d.classList.add('hidden'));
}
// 记下：乐观上屏 + 三态按钮 + 离线兜底
let noteBusy = false;
async function recordDown() {
  if (noteBusy) return;
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  const btn = $('#btn-note');
  noteBusy = true;
  btn.disabled = true; $('#chat-send').disabled = true;
  btn.textContent = '记下…';
  const line = `- [ ] ${text}`;
  // 乐观上屏：立即出现在纸条行（同步中样式）
  const strip = $('#inbox-strip');
  strip.querySelectorAll('.strip-chip.syncing').forEach(x => x.remove());
  const sync = document.createElement('button');
  sync.className = 'strip-chip syncing';
  sync.textContent = text.slice(0, 18);
  strip.prepend(sync);
  input.value = ''; updateInputState();
  try {
    const { unchanged } = await writeFile('inbox.md',
      cur => cur.replace(/\s*$/, '') + '\n' + line + '\n',
      'app: 随手记');
    vibrate();
    btn.textContent = unchanged ? '已在（未重复记）' : '✓ 已记入';
    setTimeout(() => { btn.textContent = '记下'; updateInputState(); noteBusy = false; }, 1100);
    renderInboxStrip();
    localStorage.setItem('pp_enterAction', 'note');
  } catch (e) {
    sync.remove();
    input.value = text; updateInputState();
    noteBusy = false; btn.textContent = '记下'; updateInputState();
    if (navigator.onLine === false || /Failed to fetch|NetworkError|timeout/i.test(e.message)) enqueueOffline(line);
    else toast('写入失败：' + e.message, true);
    return;
  }
}
function enqueueOffline(line) {
  const q = JSON.parse(localStorage.getItem('pp_outbox') || '[]');
  q.push(line);
  localStorage.setItem('pp_outbox', JSON.stringify(q));
  toast('当前离线，已存本地，联网后自动同步');
}
let outboxFlushing = false;  // boot 与 online 事件会双触发，单飞锁防竞态
async function flushOutbox() {
  if (outboxFlushing) return;
  const q = JSON.parse(localStorage.getItem('pp_outbox') || '[]');
  if (!q.length || !settings.load().pat) return;
  outboxFlushing = true;
  try {
    await writeFile('inbox.md',
      cur => cur.replace(/\s*$/, '') + '\n' + q.join('\n') + '\n',
      'app: 离线补记');
    localStorage.removeItem('pp_outbox');
    toast(`✓ 已补记 ${q.length} 条离线内容`);
    if ($('#view-assistant').classList.contains('active')) renderInboxStrip();
  } catch { /* 下次再试 */ }
  finally { outboxFlushing = false; }
}
// 直通任务 CRUD（不经 LLM，sha 冲突安全）
// 本地补丁：直通操作改的是 md 文件，state.json 要等引擎（6/9/21 点）才重算——
// 在前端同步打补丁让操作即时可见，引擎数据到位后自然覆盖
function rerenderTaskViews() {
  $('#today-body').dataset.loaded = '';
  $('#plan-body').dataset.loaded = '';
  if ($('#view-today').classList.contains('active')) renderToday();
  if ($('#view-plan').classList.contains('active')) { renderPlan(); renderDocs(); }
}
function patchLocalRemoveTargets(targets) {
  const sd = state.stateData;
  const hit = it => targets.some(([f, l]) => it.f === f && it.l === l);
  if (!sd) return rerenderTaskViews();
  sd.today_items = (sd.today_items || []).filter(it => !hit(it));
  sd.sched_today = (sd.sched_today || []).filter(it => !hit(it));
  sd.misc_today = (sd.misc_today || []).filter(it => !hit(it));
  (sd.week || []).forEach(g => {
    g.items = (g.items || []).filter(it => !hit(it));
    g.sched = (g.sched || []).filter(it => !hit(it));
    g.misc = (g.misc || []).filter(it => !hit(it));
  });
  sd.stale = (sd.stale || []).filter(it => !hit(it));
  rerenderTaskViews();
}
const patchLocalRemove = (f, l) => patchLocalRemoveTargets([[f, l]]);
function patchLocalInsert(item, kind = 'task') {
  const sd = state.stateData;
  if (!sd) return rerenderTaskViews();
  const t = localToday();
  const d = (item.dates || [])[0];
  const slot = g => (kind === 'sched' ? g.sched : kind === 'misc' ? g.misc : g.items);
  if (d === t) {
    if (t <= sd.today) (kind === 'sched' ? sd.sched_today : kind === 'misc' ? sd.misc_today : sd.today_items).push(item);
    else {
      let g = (sd.week || []).find(x => x.date === d);
      if (!g) { g = { date: d, items: [], sched: [], misc: [] }; sd.week.push(g); sd.week.sort((a, b) => a.date < b.date ? -1 : 1); }
      slot(g).push(item);
    }
  } else if (d && d > t) {
    let g = (sd.week || []).find(x => x.date === d);
    if (!g) { g = { date: d, items: [], sched: [], misc: [] }; sd.week.push(g); sd.week.sort((a, b) => a.date < b.date ? -1 : 1); }
    slot(g).push(item);
  }
  rerenderTaskViews();
}
async function addTaskDirect() {
  const text = $('#nt-text').value.trim();
  if (!text) return;
  // v8 紧凑表单去掉了文件选择——默认执行清单（学期主文件）；要进别的文件用聊天提案
  const file = '规划/26fall 9月执行清单.md';
  const dv = $('#nt-date').value.trim();
  const today = new Date();
  const m = dv.match(/^(\d{1,2})[\/.](\d{1,2})$/);
  const dateStr = m ? `${+m[1]}/${+m[2]}` : `${today.getMonth() + 1}/${today.getDate()}`;
  const star = $('#nt-star').classList.contains('on') ? '⭐' : '';
  const btn = $('#nt-add');
  btn.disabled = true; btn.textContent = '添加中…';
  try {
    const { unchanged } = await writeFile(file,
      cur => cur.replace(/\s*$/, '') + `
- [ ] ${star}${text}（${dateStr}）
`,
      `app: 添加任务 ${file}`);
    vibrate();
    btn.textContent = unchanged ? '已存在' : '✓ 已添加';
    $('#nt-text').value = '';
    setTimeout(() => { btn.textContent = '添加任务'; btn.disabled = false; }, 900);
    // 乐观上屏：从写回后的缓存定位行号，本地补丁进今天/计划视图
    const cached = state.fileCache[file];
    const lineNo = cached ? cached.lines.findIndex(ln => ln.includes(text) && ln.includes(dateStr)) : -1;
    const [mm, dd] = dateStr.split('/').map(Number);
    const y = new Date().getFullYear();
    patchLocalInsert({
      t: `${text}（${dateStr}）`, s: !!star, d: false, f: file,
      l: lineNo + 1, dates: [`${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`],
    });
  } catch (e) {
    btn.disabled = false; btn.textContent = '添加任务';
    toast('添加失败：' + e.message, true);
  }
}

// ---------- 文档（报告 + 文件，住进「计划」子页） ----------
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

// ---------- 聊天提案（v5.1：LLM 提案 → diff 审查 → 手动应用，git 兜底） ----------
// note 行允许缺省（模型偶尔只给 path+正文；缺 note 时整块失配会静默降级成普通代码块）
const PROPOSAL_RE = /```planning-update\npath:[ \t]*(.+)\n(?:note:[ \t]*(.*)\n)?---\n([\s\S]*?)```/g;
const propStore = new Map();   // key -> {path, note, body}

function propKey(path, body) {
  let h = 5381;
  const s = path + '\n' + body.slice(0, 400);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return 'p' + h.toString(36);
}
function propDecisions() {
  return JSON.parse(localStorage.getItem('pp_propdec') || '{}');
}
function propDecide(key, what) {
  const d = propDecisions();
  d[key] = what;
  localStorage.setItem('pp_propdec', JSON.stringify(d));
}
function parseProposals(content) {
  const out = [];
  const re = new RegExp(PROPOSAL_RE.source, 'g');
  let m;
  while ((m = re.exec(content)) !== null) {
    const path = m[1].trim();
    if (!path.endsWith('.md')) continue;   // 只允许 .md（写守卫的一部分）
    out.push({ path, note: (m[2] || '').trim(), body: m[3].replace(/\n+$/, '') });
  }
  return out;
}
// 行级 diff（LCS；带行数上限，超限退化为摘要）
function diffLines(oldS, newS) {
  const a = oldS.split('\n'), b = newS.split('\n');
  const n = a.length, m = b.length;
  if (n * m > 1200000) return null;
  const dp = new Int32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i * (m + 1) + j] = a[i] === b[j]
        ? dp[(i + 1) * (m + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ t: ' ', s: a[i] }); i++; j++; }
    else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { rows.push({ t: '-', s: a[i] }); i++; }
    else { rows.push({ t: '+', s: b[j] }); j++; }
  }
  while (i < n) rows.push({ t: '-', s: a[i++] });
  while (j < m) rows.push({ t: '+', s: b[j++] });
  // 折叠：只保留变更行 ±2 行上下文
  const keep = new Set();
  rows.forEach((r, k) => { if (r.t !== ' ') for (let x = k - 2; x <= k + 2; x++) keep.add(x); });
  const out = [];
  let skip = false;
  rows.forEach((r, k) => {
    if (keep.has(k)) { out.push({ ...r, k }); skip = false; }
    else if (!skip) { out.push({ t: '…', s: '' }); skip = true; }
  });
  return out;
}
function proposalCard(p) {
  const key = propKey(p.path, p.body);
  propStore.set(key, p);
  const dec = propDecisions()[key];
  if (dec === 'ignored') return '';
  if (dec === 'applied')
    return `<div class="prop done">✓ 已应用到 ${escapeHtml(p.path)}（git 可 revert）</div>`;
  const oldText = state.fileCache[p.path]?.text;
  const stat = oldText
    ? `<span class="pstat">${oldText.split('\n').length} → ${p.body.split('\n').length} 行</span>` : '';
  return `<div class="prop" data-key="${key}">
    <div class="prop-head">📋 提案 · ${escapeHtml(p.path)} ${stat}</div>
    ${p.note ? `<div class="prop-note">${escapeHtml(p.note)}</div>` : ''}
    <details class="prop-diff"><summary>查看 diff</summary><div class="diffbody">（展开时计算）</div></details>
    <div class="prop-actions">
      <button class="mini primary-mini prop-apply" data-key="${key}">✓ 应用</button>
      <button class="mini prop-ignore" data-key="${key}">忽略</button>
    </div></div>`;
}
function bindProposals(container) {
  container.querySelectorAll('.prop-diff').forEach(d => {
    if (d.dataset.bound) return;
    d.dataset.bound = '1';
    d.addEventListener('toggle', async () => {
      if (!d.open || d.querySelector('.drow')) return;
      const card = d.closest('.prop');
      const p = propStore.get(card.dataset.key);
      const cur = state.fileCache[p.path]?.text ?? (await fetchFile(p.path).catch(() => null))?.text ?? '';
      const rows = diffLines(cur, p.body);
      const box = d.querySelector('.diffbody');
      if (!rows) { box.textContent = '文件过大，diff 略——请用「查看完整提案」人工核对'; return; }
      box.innerHTML = rows.map(r =>
        `<div class="drow ${r.t === '+' ? 'add' : r.t === '-' ? 'del' : ''}">${escapeHtml(r.s) || '&nbsp;'}</div>`).join('');
    });
  });
  container.querySelectorAll('.prop-apply').forEach(b => b.addEventListener('click', () =>
    applyProposal(b.dataset.key)));
  container.querySelectorAll('.prop-ignore').forEach(b => b.addEventListener('click', () => {
    propDecide(b.dataset.key, 'ignored'); drawChat();
  }));
}
async function applyProposal(key) {
  const p = propStore.get(key);
  if (!p) return;
  try {
    const cur = await fetchFile(p.path);
    const curN = cur.text.split('\n').length, newN = p.body.split('\n').length;
    if (newN < curN * 0.8 &&
        !confirm(`提案只有 ${newN} 行，当前文件 ${curN} 行——可能是上下文截断导致内容丢失。确定覆盖？`))
      return;
    await busy(writeFile(p.path, p.body, `app: 聊天提案更新 ${p.path}`));
    propDecide(key, 'applied');
    drawChat();
    vibrate();
    toast('✓ 已应用到 ' + p.path + '（git revert 可撤销）');
  } catch (e) { toast('应用失败：' + e.message, true); }
}
function ensureChatContext() {
  const s = settings.load();
  $('#chat-model').value = s.model;
  $('#chat-thinking').checked = s.thinking === 'enabled';
  $('#chat-usage').textContent = usageSummary();
  drawChat();
  if (state.chatContext || !s.pat) return;
  if (state.chatContextReady) return state.chatContextReady;  // 复用在途构建
  $('#chat-status').textContent = '正在并行加载 vault 上下文…';
  const t0 = Date.now();
  state.chatContextReady = buildContext({
    paths: () => state.tree.length ? state.tree : getTree(),
    raw: async p => (await fetchFile(p)).text,
  }).then(ctx => {
    state.chatContext = ctx;
    $('#chat-status').textContent =
      `上下文就绪（${(ctx.length / 1000).toFixed(0)}k 字符 / ${((Date.now() - t0) / 1000).toFixed(1)}s）`;
  }).catch(e => {
    $('#chat-status').textContent = '上下文加载失败：' + e.message;
  }).finally(() => { state.chatContextReady = null; });
  return state.chatContextReady;
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
      const props = parseProposals(m.content || '');
      const text = props.length ? (m.content || '').replace(PROPOSAL_RE, '').trim() : (m.content || '');
      let main = text ? renderMessage(text)
        : (props.length ? '' : `<span class="dim">（正文为空——思考未完成即截断）</span>` +
          `<button class="mini retry-empty">↻ 重试这条</button>`);
      for (const p of props) main += proposalCard(p);
      if (m.reasoning)
        main += `<details class="reason"><summary>💭 思考过程</summary>` +
          `<div class="reason-body">${escapeHtml(m.reasoning)}</div></details>`;
      body = main;
    } else body = escapeHtml(m.content);
    return `<div class="msg ${m.role}"><div class="bubble">${body}</div>` +
      (m.role === 'assistant' && m.content && !parseProposals(m.content).length ? `<button class="mini to-plan">落进规划</button>` : '') + `</div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
  el.querySelectorAll('.retry-empty').forEach(b =>
    b.addEventListener('click', retryLastChat));
  bindProposals(el);
  // 落进规划：把该轮对话整理成提案（常驻入口；已有提案的消息不再给）
  el.querySelectorAll('.to-plan').forEach(b => b.addEventListener('click', () => {
    localStorage.setItem('pp_enterAction', 'ask');
    $('#chat-status').textContent = '整理提案中——若 2 分钟内没有出现提案卡，请重试或用「记下」手记';
    chatSend('把我们最近的对话整理成 planning-update 提案块（每个文件一个，note 说明理由；情绪与感情文件不要动）。若没有值得落盘的内容，直接说明。');
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
let sendBusy = false;
async function chatSend(preset) {
  if (sendBusy) return;
  const input = $('#chat-input');
  const text = (preset || input.value).trim();
  if (!text) return;
  if (state.chatContextReady) await state.chatContextReady;  // 上下文构建中则等它（否则首条消息会裸发）
  input.value = ''; updateInputState();
  sendBusy = true; updateInputState();
  const sendBtn = $('#chat-send');
  const oldLabel = sendBtn.textContent;
  sendBtn.textContent = '…';
  pushMessage('user', text); drawChat();
  const errEl = $('#chat-status');
  errEl.textContent = '思考中…';
  const ac = new AbortController();
  state.chatAbort = ac;
  try {
    // 历史里的提案块（含完整文件内容）换成一行摘要再回传——否则每次提问
    // 都复读整个文件，上下文与 token 成倍膨胀
    const stripProps = c => c.replace(/```planning-update\n[\s\S]*?```/g,
      '（此处曾生成规划提案，内容已省略）');
    const history = JSON.parse(localStorage.getItem('pp_chat') || '[]')
      .slice(0, -1).filter(m => (m.role === 'user' || m.role === 'assistant')
        && m.content && m.content.trim())
      .map(m => ({ role: m.role, content: stripProps(m.content) }));
    const reply = await sendChat(text, state.chatContext || '', history, ac.signal);
    if (reply.retried) toast('思考耗尽了输出预算，已自动关思考重试成功');
    pushMessage('assistant', reply.content, reply.reasoning);
    drawChat();
    $('#chat-usage').textContent = usageSummary();
    errEl.textContent = '';
  } catch (e) {
    errEl.textContent = e.name === 'AbortError' ? '已停止' : e.message;
  }
  finally {
    sendBusy = false;
    sendBtn.textContent = oldLabel;
    updateInputState();
  }
}
function bindChat() {
  $('#chat-send').addEventListener('click', () => chatSend());
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
  });
  $('#chat-model').addEventListener('change', e => settings.save({ model: e.target.value }));
  $('#chat-thinking').addEventListener('change', e => settings.save({ thinking: e.target.checked ? 'enabled' : 'disabled' }));
  $('#chat-clear').addEventListener('click', () => {
    if (state.chatAbort) { try { state.chatAbort.abort(); } catch { /* 已结束 */ } }
    localStorage.removeItem('pp_chat');
    drawChat();
    toast('聊天记录已清空');
  });
  const presets = [
    ['周日复盘', '请带我做完本周复盘：1) 从 vault 列出本周完成与滑落；2) 一次一个地问我三个关于下周的问题，等我回答；3) 最后汇总「下周三件事」，每件带何时/何地。'],
    ['今天做什么', '基于今天的日期和 vault，告诉我今天最该做的三件事和顺序，一句话理由。'],
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
      btn.textContent = '开启推送';
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
      btn.textContent = '关闭推送';
      toast('推送已开启，今晚 21:00 见');
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
  state.chatContext = null;
  await renderDocs();
  await renderToday();
  $('#today-body').dataset.loaded = '1';
  // 跨天刷新时若正停在计划 tab，就地重渲染（否则陈旧分组留屏直到切走再切回）
  if ($('#view-plan').classList.contains('active')) await renderPlan();
  renderInboxStrip();
}
let gChord = false;
function bindKeys() {
  document.addEventListener('keydown', e => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    if (e.key === 'Escape') { $('#file-viewer').classList.remove('on'); closeSheet(); return; }
    if (typing || e.metaKey || e.ctrlKey) return;
    if (gChord) {
      gChord = false;
      const map = { t: 'today', p: 'plan', a: 'assistant' };
      if (map[e.key]) { show(map[e.key]); return; }
    }
    if (e.key === 'g') { gChord = true; setTimeout(() => gChord = false, 900); }
    if (e.key === 'r') refreshAll().then(() => toast('已刷新'));
    if (e.key === '/') { e.preventDefault(); show('assistant'); $('#chat-input').focus(); }
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
    $('#plan-tasks').classList.toggle('hidden', b.dataset.doc !== 'tasks');
    $('#doc-reports').classList.toggle('hidden', b.dataset.doc !== 'reports');
    $('#doc-files').classList.toggle('hidden', b.dataset.doc !== 'files');
  }));
  $('#btn-refresh').addEventListener('click', () => refreshAll().then(() => toast('已刷新')));
  $('#btn-settings').addEventListener('click', () => $('#settings-view').classList.add('on'));
  $('#btn-close-settings').addEventListener('click', () => $('#settings-view').classList.remove('on'));
  // 助手输入：一框双钮 + Enter 记忆（默认问）+ 空输入禁用
  const input = $('#chat-input');
  const updateInputState = () => {
    const has = !!input.value.trim();
    $('#btn-note').disabled = !has || noteBusy;
    $('#chat-send').disabled = !has || sendBusy;
  };
  window.updateInputState = updateInputState;
  input.addEventListener('input', updateInputState);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const action = localStorage.getItem('pp_enterAction') || 'ask';
      (action === 'note' ? recordDown : chatSend)();
    }
  });
  $('#btn-note').addEventListener('click', () => { localStorage.setItem('pp_enterAction', 'note'); recordDown(); });
  $('#chat-send').addEventListener('click', () => { localStorage.setItem('pp_enterAction', 'ask'); chatSend(); });
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
  // 跨天自动刷新：PWA 挂夜后恢复前台时，设备日期变了就重拉（配合 localToday 桥接）
  state.lastDay = localToday();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && settings.load().pat &&
        localToday() !== state.lastDay) {
      state.lastDay = localToday();
      refreshAll().then(() => toast('新的一天，已刷新'));
    }
  });
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
