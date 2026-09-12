// chat.js — GLM 直连聊天（CORS 已由 bigmodel 官方支持，无需代理）
// 上下文：vault 全量（Q6b，含情绪/感情文件）；历史仅存浏览器（Q7a）
import { settings, addUsage, usage, estCost } from './store.js';
import { render as mdRender } from './md.js';

const CONTEXT_FILE_CAP = 15000;  // 每文件字符上限（最大真实文件 ~8.2k；提案协议禁止对截断文件提案，上限必须覆盖常用目标文件）
const CONTEXT_TOTAL_CAP = 120000;
// coding plan key 走 /api/coding/paas/v4；标准平台 key 走 /api/paas/v4（设置里可改）

const SYSTEM_PROMPT = [
  '你是用户的个人规划助手。用户会给你他的整个规划 vault（markdown）。',
  '回答要具体、可执行，引用文件名和日期；物流语气，不评判用户。',
  '用户可以用中文或英文提问。文件内容用 === 分隔标注路径。',
  '',
  '## 规划更新提案协议',
  '当用户要求把内容落进规划文件（如「加进执行清单」「改 26 fall」「写进计划」），'
  + '输出提案块，格式严格如下（无需其他许可，直接给出）：',
  '',
  '```planning-update',
  'path: 规划/26 fall.md',
  'note: 一句话说明改动',
  '---',
  '（该文件的完整新内容，首行到末行）',
  '```',
  '',
  '提案规则：',
  '- 必须基于上下文中该文件的当前内容做修改，输出完整新文件（不是 diff、不是片段）',
  '- 上下文中被截断（结尾带省略）的文件不要提案——会丢尾部内容',
  '- path 用 vault 相对路径，只允许 .md 文件；情绪与感情文件除非用户明确要求不要主动提案',
  '- 一次可以给多个提案块（每个文件一个）',
  '- 多日安排必须逐日成行：每天一个独立条目（如 `- [ ] SD 动物园（9/12）`），'
  + '禁止单行堆叠多天——「9.11–9.14 做 X ｜ 9.15 做 Y」这类大杂烩行是明确的反模式',
  '- 用户没要求落盘时，正常给建议即可，不要输出提案块',
].join('\n');

export async function buildContext(fetchText) {
  // 并行拉取（原来串行 20+ 个文件要 10s+）
  // briefs/ 是引擎生成的任务简报（会持续增长），不进聊天上下文——
  // 别让生成物挤占用户真实文件的 120k 预算（reports/ 排序在 规划/ 之前）
  const tree = await fetchText.paths();
  const mdPaths = tree.filter(t =>
    t.path.endsWith('.md') && !t.path.startsWith('reports/briefs/')).map(t => t.path);
  const texts = await Promise.all(mdPaths.map(p =>
    fetchText.raw(p).then(t => ({ p, t })).catch(() => ({ p, t: '' }))));
  const parts = [];
  let total = 0;
  for (const { p, t } of texts) {
    if (total >= CONTEXT_TOTAL_CAP) break;
    const slice = t.slice(0, CONTEXT_FILE_CAP);
    // 截断必须显式标记——提案协议靠它识别「不完整文件，禁止提案」
    const trunc = t.length > CONTEXT_FILE_CAP
      ? `\n…（⚠️ 已截断：上文只有此文件的前 ${CONTEXT_FILE_CAP} 字符，不完整——不要对此文件生成提案，可说明需用户提供全文）`
      : '';
    parts.push(`=== ${p} ===\n${slice}${trunc}`);
    total += slice.length;
  }
  return parts.join('\n\n');
}

export function budgetBlocked() {
  const s = settings.load();
  const cost = estCost(s);
  return s.priceOutPerM > 0 && cost >= s.chatBudgetUsd;
}

export async function sendChat(userText, context, history, signal) {
  const s = settings.load();
  if (!s.glmKey) throw new Error('未配置 GLM key（设置里填）');
  if (budgetBlocked() && s.model === 'glm-5.3') {
    throw new Error('本月聊天预算已用完（可在设置里调高或改单价），已阻止 5.3 调用。可切换 glm-5.3-flash（免费）。');
  }

  // 日期锚点：vault 与报告生成于昨晚，其中的「今天/明天」都滞后——不注入这行
  // 模型会把报告里的旧日期当今天（实测把周六答成周五）
  const now = new Date();
  const wd = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  const dateLine =
    `今天是 ${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日，周${wd}。` +
    'vault 文件与报告生成于昨晚，其中的「今天/明天/周五」等日期可能滞后，一律以本行为准。';

  // 空正文的历史消息（旧版截断残留）不进上下文——空 content 可能被 API 拒收
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT + '\n\n' + dateLine + '\n\n' + context },
    ...history.filter(h => h.content && h.content.trim()).slice(-16)
      .map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userText },
  ];
  const base = {
    model: s.model,
    messages,
    temperature: 0.6,
    // 思考模式下 reasoning 与正文共用输出预算，小帽会被思考耗光导致正文为空
    max_tokens: 8192,
  };
  if (s.model === 'glm-5.3' && s.thinking === 'enabled') {
    base.thinking = { type: 'enabled' };
  }

  const url = (s.glmBase || 'https://open.bigmodel.cn/api/coding/paas/v4')
    .replace(/\/+$/, '') + '/chat/completions';

  const doCall = async body => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${s.glmKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,   // 清空聊天时中止在途请求
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
    return {
      content: choice.message?.content || '',
      reasoning: choice.message?.reasoning_content || '',
      finish: choice.finish_reason,
    };
  };

  let r = await doCall(base);
  // 正文空但思考非空 = 思考吃光了输出预算（finish=length 或服务端截断）。
  // 自动降级重试一次：关思考 + 加大预算；thinking 参数被拒（400）再去掉参数裸试。
  if (!r.content && r.reasoning) {
    try {
      r = await doCall({ ...base, max_tokens: 16384, thinking: { type: 'disabled' } });
    } catch (e1) {
      if (!/GLM 4\d\d/.test(e1.message)) throw e1;
      const bare = { ...base, max_tokens: 16384 };
      delete bare.thinking;
      r = await doCall(bare);
    }
    r.retried = true;
  }
  if (!r.content && !r.reasoning) {
    throw new Error(`GLM 返回空响应（finish=${r.finish}），请重试`);
  }
  if (!r.content) {
    throw new Error('思考耗尽了输出预算（重试后仍无正文）——请关闭思考开关或换 glm-5.3-flash 后重试');
  }
  if (r.finish === 'length') {
    r.content += '\n\n*（达到长度上限被截断——可发「继续」）*';
  }
  return r;
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
