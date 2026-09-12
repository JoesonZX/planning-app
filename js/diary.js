// diary.js — 今日日记编辑器（v7 T6：双区制——做了什么/感受）
// 感受区红线：本文件只负责读写 日记/YYYY-MM-DD.md；引擎报告永不读取该目录（skip_dirs），
// 聊天上下文可见（Q6b 全量）。行为区由周报 agent 显式按节提取汇总。

import { getContent } from './api.js';

const WD = ['日', '一', '二', '三', '四', '五', '六'];

function template(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `## ${dateStr} 周${WD[d.getDay()]}\n\n**做了什么**\n- \n\n**感受**\n- \n`;
}

export async function openDiary({ put, toast, dateStr }) {
  const path = `日记/${dateStr}.md`;
  let initial = template(dateStr);
  try {
    const { text } = await getContent(path);
    if (text && text.trim()) initial = text;
  } catch { /* 首次写日记 */ }

  const layer = document.createElement('div');
  layer.className = 'overlay diary on';
  layer.innerHTML =
    `<div class="filebar"><button class="diary-close">←</button>` +
    `<strong>日记 · ${dateStr}</strong></div>` +
    `<p class="dim small">做了什么写具体的事（会进周报摘要）；感受只属于你（任何报告都不读取）。</p>` +
    `<textarea class="diary-text"></textarea>` +
    `<button class="primary diary-save">保存日记</button>`;
  document.body.appendChild(layer);
  const ta = layer.querySelector('.diary-text');
  ta.value = initial;

  const close = () => layer.remove();
  layer.querySelector('.diary-close').addEventListener('click', close);
  layer.querySelector('.diary-save').addEventListener('click', async () => {
    const btn = layer.querySelector('.diary-save');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      const { unchanged } = await put(path, ta.value, `app: 日记 ${dateStr}`);
      toast(unchanged ? '日记未改动' : '✓ 日记已保存');
      close();
    } catch (e) {
      btn.disabled = false;
      btn.textContent = '保存日记';
      toast('保存失败：' + e.message, true);
    }
  });
}
