// api.js — GitHub Contents/Trees API 客户端（fine-grained PAT，仅 planning-data 读写）
import { settings } from './store.js';

const API = 'https://api.github.com';

async function gh(path, opts = {}) {
  const s = settings.load();
  const res = await fetch(API + path, {
    ...opts,
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

// PUT 写回：sha 乐观并发。冲突时调用方可用 onConflict 重拉重试一次。
export async function putContent(path, text, sha, message) {
  const s = settings.load();
  try {
    const data = await gh(`/repos/${s.repo}/contents/${encodeURIComponent(path)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: message || `app: update ${path}`,
        content: textToB64(text),
        sha,
        branch: 'main',
      }),
    });
    return data.content.sha;
  } catch (e) {
    if (e.status === 409 || e.status === 422) {
      const fresh = await getContent(path);
      const data = await gh(`/repos/${s.repo}/contents/${encodeURIComponent(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `app: update ${path} (rebased)`,
          content: textToB64(text),
          sha: fresh.sha,
          branch: 'main',
        }),
      });
      return data.content.sha;
    }
    throw e;
  }
}
