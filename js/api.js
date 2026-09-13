// api.js — GitHub Contents/Trees API 客户端（fine-grained PAT，仅 planning-data 读写）
import { settings } from './store.js';

// ?mock：本地冒烟模式——请求走 js/mock.js 的内存仓（不触网；v9 测试基建，生产无感）
const MOCK = /[?&]mock\b/.test(location.search) || /mock/.test(location.hash);
let mockRoute = null;
if (MOCK) mockRoute = (await import('./mock.js')).route;

const API = 'https://api.github.com';

async function gh(path, opts = {}) {
  if (mockRoute) return mockRoute(path, opts);
  const s = settings.load();
  const res = await fetch(API + path, {
    ...opts,
    // 15s 超时：弱网/认证门户下请求悬挂是「记下无反馈」的主因——超时按网络错误走离线兜底
    signal: AbortSignal.timeout(15000),
    headers: {
      Authorization: `Bearer ${s.pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
    const err = new Error(`GitHub ${res.status}: ${detail || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function testConnection() {
  const s = settings.load();
  return gh(`/repos/${s.repo}`);
}

export async function getTree() {
  const s = settings.load();
  const data = await gh(`/repos/${s.repo}/git/trees/main?recursive=1`);
  return (data.tree || [])
    .filter(t => t.type === 'blob' && /\.md$|\.ics$|\.yml$/.test(t.path))
    .map(t => ({ path: t.path, size: t.size }));
}

function b64ToText(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function textToB64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export async function getContent(path) {
  const s = settings.load();
  const data = await gh(`/repos/${s.repo}/contents/${encodeURIComponent(path)}?ref=main`);
  return { text: b64ToText(data.content || ''), sha: data.sha };
}

// PUT 写回。两种用法：
//   putContent(path, text, sha, message)         —— 固定文本（整文件编辑/提案应用）
//   putContent(path, fn, null, message)          —— 变换函数 fn(currentText)→newText
//                                                   （追加/删行类操作必用：冲突时基于
//                                                    服务器最新内容重算，杜绝丢更新与空提交）
export async function putContent(path, textOrFn, sha, message) {
  const s = settings.load();
  const isFn = typeof textOrFn === 'function';
  const attempt = async (bodyText, curSha, msg) => {
    const data = await gh(`/repos/${s.repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: msg, content: textToB64(bodyText), sha: curSha, branch: 'main',
      }),
    });
    return data.content.sha;
  };
  try {
    if (isFn) {
      const cur = await getContent(path);
      const next = textOrFn(cur.text);
      if (next == null) throw new Error('写回失败：目标行已变化（文件可能被他处更新），请刷新后重试');
      if (next === cur.text) return { sha: cur.sha, unchanged: true };  // 目标态已达成，不产生空提交
      return { sha: await attempt(next, cur.sha, message || `app: update ${path}`), unchanged: false };
    }
    return { sha: await attempt(textOrFn, sha, message || `app: update ${path}`), unchanged: false };
  } catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e;
    const fresh = await getContent(path);
    const next = isFn ? textOrFn(fresh.text) : textOrFn;
    if (next == null) throw new Error('写回失败：目标行已变化，请刷新后重试');
    if (next === fresh.text) {
      // 冲突后目标态已达成（前次请求实际已生效）——绝不重发相同内容制造空提交
      return { sha: fresh.sha, unchanged: true };
    }
    const msg = (message || `app: update ${path}`) + ' (rebased)';
    return { sha: await attempt(next, fresh.sha, msg), unchanged: false };
  }
}
