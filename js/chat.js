// chat.js — GLM 直连聊天（CORS 已由 bigmodel 官方支持，无需代理）
// 上下文：vault 全量（Q6b，含情绪/感情文件）；历史仅存浏览器（Q7a）
import { settings, addUsage, usage, estCost } from './store.js';
import { render as mdRender } from './md.js';

const CONTEXT_FILE_CAP = 6000;   // 每文件字符上限
const CONTEXT_TOTAL_CAP = 120000;
// coding plan key 走 /api/coding/paas/v4；标准平台 key 走 /api/paas/v4（设置里可改）

const SYSTEM_PROMPT = [
  '你是用户的个人规划助手。用户会给你他的整个规划 vault（markdown）。',
  '回答要具体、可执行，引用文件名和日期；物流语气，不评判用户。',
  '用户可以用中文或英文提问。文件内容用 === 分隔标注路径。',
].join('\n');

export async function buildContext(fetchText) {
  const tree = await fetchText.tree();
  const mdPaths = tree.filter(t => t.path.endsWith('.md')).map(t => t.path);
  const parts = [];
  let total = 0;
  for (const p of mdPaths) {
    if (total >= CONTEXT_TOTAL_CAP) break;
    const text = await fetchText.raw(p);
    const slice = text.slice(0, CONTEXT_FILE_CAP);
    parts.push(`=== ${p} ===\n${slice}`);
    total += slice.length;
  }
  return parts.join('\n\n');
}

export function budgetBlocked() {
  const s = settings.load();
  const cost = estCost(s);
  return s.priceOutPerM > 0 && cost >= s.chatBudgetUsd;
}

export async function sendChat(userText, context, history) {
  const s = settings.load();
  if (!s.glmKey) throw new Error('未配置 GLM key（设置里填）');
  if (budgetBlocked() && s.model === 'glm-5.3') {
    throw new Error('本月聊天预算已用完（可在设置里调高或改单价），已阻止 5.3 调用。可切换 glm-5.3-flash（免费）。');
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + '\n\n' + context },
    ...history.slice(-16).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];
  const body = {
    model: s.model,
    messages,
    temperature: 0.6,
    // 思考模式下 reasoning 与正文共用输出预算，小帽会被思考耗光导致正文为空
    max_tokens: 8192,
  };
  if (s.model === 'glm-5.3' && s.thinking === 'enabled') {
    body.thinking = { type: 'enabled' };
  }

  const url = (s.glmBase || 'https://open.bigmodel.cn/api/coding/paas/v4')
    .replace(/\/+$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${s.glmKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `GLM ${res.status}`;
    try {
      const e = await res.json();
      if (e.error?.code === '1113' || /余额不足/.test(e.error?.message || '')) {
        msg = `模型 ${s.model} 需要 bigmodel 账户余额（错误 1113）。请充值、切换 glm-5.3-flash，或在设置里调整。`;
      } else if (res.status === 429) {
        msg = '限流了，稍等几秒再试。' + (e.error?.message || '');
      } else {
        msg = `GLM ${res.status}: ${e.error?.message || res.statusText}`;
      }
    } catch { /* keep default */ }
    throw new Error(msg);
  }
  const data = await res.json();
  const u = data.usage || {};
  addUsage(u.prompt_tokens || 0, u.completion_tokens || 0);
  const choice = data.choices[0] || {};
  const msg = choice.message || {};
  const content = msg.content || '';
  const reasoning = msg.reasoning_content || '';
  if (!content && !reasoning) {
    throw new Error(`GLM 返回空响应（finish=${choice.finish_reason}），请重试`);
  }
  return { content, reasoning, finish: choice.finish_reason };
}

export function renderMessage(text) {
  return mdRender(text).html;
}

export function usageSummary() {
  const s = settings.load();
  const u = usage();
  const cost = estCost(s).toFixed(2);
  return `本月聊天 tokens：${(u.inT + u.outT).toLocaleString()} ｜ 估算 $${cost} / 预算 $${s.chatBudgetUsd}`;
}
