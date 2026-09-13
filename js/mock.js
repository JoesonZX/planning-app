// js/mock.js — 本地冒烟 mock（?mock 时由 api.js 加载）：内存版 GitHub Contents API。
// 数据来自 tools/mock_gen.py 生成的 .mock-data/（已 gitignore——真实 vault 内容绝不进公开仓）。
// 支持读/写（PUT 更新内存并换 sha），供动作表/添加/日记全链路冒烟与截图。

const idx = { files: new Map() };
const enc = new TextEncoder();

// 预置必须同步（模块顶层）：boot() 在 import 完成后立即读 settings，异步种子会输给首跑引导
if (!localStorage.getItem('pp_pat')) localStorage.setItem('pp_pat', 'mock-pat');
if (localStorage.getItem('pp_repo') !== 'mock/planning-data') localStorage.setItem('pp_repo', 'mock/planning-data');

async function init() {
  try {
    const tree = await (await fetch('.mock-data/tree.json')).json();
    for (const p of tree.files) {
      try { idx.files.set(p, await (await fetch('.mock-data/' + p)).text()); } catch { /* 单文件缺失不致命 */ }
    }
  } catch { /* 无 fixtures：空仓冷启动 */ }
  if (!idx.files.has('inbox.md')) idx.files.set('inbox.md', '# inbox\n');
}
const ready = init();
if (typeof window !== 'undefined') window.__mock = idx;  // 冒烟检查窗口（测试专用）

const sha = t => {
  const b = enc.encode(t);
  let h = 5381;
  for (const x of b) h = ((h << 5) + h + x) >>> 0;
  return 'm' + h.toString(36) + b.length;
};
const b64 = t => {
  const by = enc.encode(t);
  let bin = '';
  for (const x of by) bin += String.fromCharCode(x);
  return btoa(bin);
};
const unb64 = c => {
  const bin = atob(c.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from([...bin].map(ch => ch.charCodeAt(0))));
};

export async function route(path, opts = {}) {
  await ready;
  (window.__routeLog = window.__routeLog || []).push([opts.method || 'GET', path.slice(0, 90)]);
  const method = opts.method || 'GET';
  if (path.includes('/git/trees/')) {
    return {
      tree: [...idx.files.keys()].map(p => ({
        path: p, type: 'blob', size: enc.encode(idx.files.get(p)).length,
      })),
    };
  }
  if (path.includes('/contents/')) {
    const raw = decodeURIComponent(path.split('/contents/')[1].split('?')[0]);
    if (method === 'PUT') {
      const text = unb64(JSON.parse(opts.body).content);
      idx.files.set(raw, text);
      return { content: { sha: sha(text) } };
    }
    if (!idx.files.has(raw)) {
      throw Object.assign(new Error('GitHub 404: ' + raw), { status: 404 });
    }
    const text = idx.files.get(raw);
    return { content: b64(text), sha: sha(text) };
  }
  if (path.startsWith('/repos/')) return { full_name: 'mock/planning-data' };
  throw new Error('mock: 未路由 ' + path);
}
