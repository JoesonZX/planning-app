// store.js — 设置与本地状态（localStorage，无外部依赖）
const PREFIX = 'pp_';

export const settings = {
  load() {
    const g = (k, d) => localStorage.getItem(PREFIX + k) ?? d;
    return {
      pat: g('pat', ''),
      repo: g('repo', 'JoesonZX/planning-data'),
      glmKey: g('glmKey', ''),
      model: g('model', 'glm-5.3'),
      thinking: g('thinking', 'enabled'),          // enabled | disabled
      chatBudgetUsd: parseFloat(g('chatBudgetUsd', '3')),
      priceInPerM: parseFloat(g('priceInPerM', '0')),   // 每百万输入 token 单价（USD）
      priceOutPerM: parseFloat(g('priceOutPerM', '0')), // 每百万输出 token 单价（USD）
    };
  },
  save(patch) {
    for (const [k, v] of Object.entries(patch)) localStorage.setItem(PREFIX + k, String(v));
  },
};

// 本月聊天用量（localStorage，仅本地估算）
export function usage() {
  const month = new Date().toISOString().slice(0, 7);
  const raw = JSON.parse(localStorage.getItem(PREFIX + 'usage') || '{}');
  if (raw.month !== month) return { month, inT: 0, outT: 0 };
  return raw;
}
export function addUsage(inT, outT) {
  const u = usage();
  u.inT += inT; u.outT += outT;
  localStorage.setItem(PREFIX + 'usage', JSON.stringify(u));
}
export function estCost(s) {
  const u = usage();
  return (u.inT / 1e6) * s.priceInPerM + (u.outT / 1e6) * s.priceOutPerM;
}

// 聊天历史（仅浏览器，Q7a）
export function chatHistory() {
  return JSON.parse(localStorage.getItem(PREFIX + 'chat') || '[]');
}
export function saveHistory(h) {
  localStorage.setItem(PREFIX + 'chat', JSON.stringify(h.slice(-40)));
}
