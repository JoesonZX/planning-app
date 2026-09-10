// md.js — 极简 markdown 渲染器：先整体转义，再做行级变换（无第三方库、无 XSS 面）
// 输出中 checkbox 行带 data-line（原始行号），供写回翻转用。

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 行内格式（先转义后加标记）：供状态条目卡片复用
export function inline(text) {
  let t = escapeHtml(text);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return t;
}

// 返回 {html, lines}：lines 是原始行数组（写回用），html 中 checkbox 带 data-line
export function render(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    // 表格（连续 | 行，第二行为分隔行则标准表格）
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      let html = '<table><thead><tr>';
      const head = trimmed.split('|').slice(1, -1).map(c => c.trim());
      html += head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().split('|').slice(1, -1).map(c => c.trim());
        html += '<tr>' + cells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      html += '</tbody></table>';
      out.push(html);
      continue;
    }

    // 标题
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
      i++; continue;
    }

    // 引用（合并连续行）
    if (trimmed.startsWith('>')) {
      let block = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        block.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(block.join(' '))}</blockquote>`);
      continue;
    }

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) { out.push('<hr>'); i++; continue; }

    // checkbox（带原始行号）
    const cb = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s*(.*)$/);
    if (cb) {
      const checked = cb[2].toLowerCase() === 'x';
      out.push(
        `<label class="cb" data-line="${i}">` +
        `<input type="checkbox" ${checked ? 'checked' : ''}>` +
        `<span class="${checked ? 'done' : ''}">${inline(cb[3])}</span></label>`
      );
      i++; continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      let items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]) && !/^\s*[-*]\s+\[[ xX]\]/.test(lines[i])) {
        items.push('<li>' + inline(lines[i].trim().replace(/^[-*]\s+/, '')) + '</li>');
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      let items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push('<li>' + inline(lines[i].trim().replace(/^\d+\.\s+/, '')) + '</li>');
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // 普通段落（合并连续非空行）
    let para = [line];
    i++;
    while (i < lines.length && lines[i].trim() &&
           !/^(#{1,6}\s|>|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i]) &&
           !/^(-{3,}|\*{3,})$/.test(lines[i].trim())) {
      para.push(lines[i]); i++;
    }
    out.push(`<p>${inline(para.join(' ').trim())}</p>`);
  }
  return { html: out.join('\n'), lines };
}

// 翻转 lines[idx] 的 checkbox（精确行操作，其余内容零改动）
export function flipCheckbox(lines, idx) {
  const m = lines[idx].match(/^(\s*[-*]\s+\[)([ xX])(\].*)$/);
  if (!m) return null;
  const next = m[2] === ' ' ? 'x' : ' ';
  const flipped = m[1] + next + m[3];
  const out = lines.slice();
  out[idx] = flipped;
  return out.join('\n');
}
