// diary.js — 今日日记编辑器（v9：就地展开——今天视图原位放大编辑，全屏层退役）
// v9 复查修正：编辑器是 #btn-diary 的兄弟节点（button 内嵌 textarea/button 是非法 HTML，
// iOS 上嵌在 button 里的 textarea 点按聚焦不可靠）；展开时隐藏行卡按钮，收起时还原。
// 双区制不变：做了什么/感受。感受区红线：引擎报告永不读取该目录（skip_dirs），
// 聊天上下文可见（Q6b 全量）。行为区由周报 agent 显式按节提取汇总。

import { getContent } from './api.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];
const ENTRY_HTML = `<b>日记</b><span>记一笔今天 · 做了什么与感受</span>`;

function template(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `## ${dateStr} 周${WD[d.getDay()]}\n\n**做了什么**\n- \n\n**感受**\n- \n`;
}

export async function openDiary({ put, toast, dateStr }) {
  const btn = document.querySelector('#btn-diary');
  if (!btn || btn.dataset.open === '1') return;
  btn.dataset.open = '1';
  const path = `日记/${dateStr}.md`;
  let initial = template(dateStr);
  try {
    const { text } = await getContent(path);
    if (text && text.trim()) initial = text;
  } catch { /* 首次写日记 */ }

  const wd = WD[new Date(dateStr + 'T12:00:00').getDay()];
  const layer = document.createElement('div');
  layer.className = 'diary-inline';
  layer.innerHTML =
    `<div class="diary-head"><b>日记 · ${dateStr} 周${wd}</b>` +
    `<span>「做了什么」会进周报摘要；「感受」只属于你，任何报告都不读取</span></div>` +
    `<textarea class="diary-text"></textarea>` +
    `<div class="diary-actions"><button class="primary diary-save">保存日记</button>` +
    `<button class="mini diary-close">收起</button></div>`;
  btn.classList.add('hidden');
  btn.after(layer);
  const ta = layer.querySelector('.diary-text');
  ta.value = initial;
  ta.focus();
  ta.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const collapse = () => { layer.remove(); btn.classList.remove('hidden'); delete btn.dataset.open; };
  layer.querySelector('.diary-close').addEventListener('click', collapse);
  layer.querySelector('.diary-save').addEventListener('click', async () => {
    const saveBtn = layer.querySelector('.diary-save');
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    try {
      const { unchanged } = await put(path, ta.value, `app: 日记 ${dateStr}`);
      toast(unchanged ? '日记未改动' : '✓ 日记已保存');
      collapse();
    } catch (e) {
      saveBtn.disabled = false;
      saveBtn.textContent = '保存日记';
      toast('保存失败：' + e.message, true);
    }
  });
}
