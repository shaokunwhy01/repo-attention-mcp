// yaml.mjs — 零依赖 YAML 子集（P3：纯文本、diff 友好、可 grep）
// 支持：块映射 / 块序列 / 标量（字符串/数字/布尔/null）/ 引号串 / 块字面量 | |- /
//       流式空值 [] {} / 整行注释。dump 只产出该子集，parse 宽容手改格式。

export function dump(obj) {
  const lines = [];
  if (obj === null || obj === undefined) return '~\n';
  if (Array.isArray(obj)) emitSeq(obj, 0, lines);
  else if (typeof obj === 'object') emitMap(obj, 0, lines);
  else lines.push(String(scalar(obj) ?? obj));
  return lines.join('\n') + '\n';
}

function isPlain(v) {
  return typeof v === 'string' && /^[\p{L}\p{N}_.\/@#+:*\- ]+$/u.test(v) &&
    !/^(\d+(\.\d+)?([eE][+-]?\d+)?|true|false|null|~|-?\d+)$/.test(v) &&
    !v.startsWith('- ') && !v.startsWith('#') && !/:\s/.test(v) &&
    !v.endsWith(':') && !v.endsWith(' ') && v.trim() === v;
}

function scalar(v) {
  if (v === null || v === undefined) return '~';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  if (s.includes('\n')) {
    // 短多行：JSON 引号可完美往返（含尾换行）；长文本：块字面量（尾部空行会被 strip，可接受）
    if (s.split('\n').length <= 3 && s.length <= 200) return JSON.stringify(s);
    return null;
  }
  if (isPlain(s)) return s;
  return JSON.stringify(s);
}

function emitInto(value, indent, lines) {
  if (value === null || value === undefined) { lines.push(' '.repeat(indent) + '~'); return; }
  if (Array.isArray(value)) { emitSeq(value, indent, lines); return; }
  if (typeof value === 'object') { emitMap(value, indent, lines); return; }
  const s = scalar(value);
  if (s !== null) { lines.push(' '.repeat(indent) + s); return; }
  emitBlockLiteral(String(value), indent, lines, false);
}

function emitMap(obj, indent, lines) {
  const keys = Object.keys(obj).filter(k => obj[k] !== undefined);
  if (keys.length === 0) { lines.push(' '.repeat(indent - 2 > 0 ? indent - 2 : 0) + '{}'); return; }
  const pad = ' '.repeat(indent);
  for (const k of keys) {
    const v = obj[k];
    const kk = isPlain(String(k)) && !/[:#\s]/.test(k) ? k : JSON.stringify(String(k));
    if (v === null || v === undefined) { lines.push(`${pad}${kk}: ~`); continue; }
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${pad}${kk}: []`); continue; }
      lines.push(`${pad}${kk}:`);
      emitSeq(v, indent + 2, lines); // 嵌套序列一律 +2，消除与同层兄弟项的歧义
      continue;
    }
    if (typeof v === 'object') {
      const vk = Object.keys(v).filter(x => v[x] !== undefined);
      if (vk.length === 0) { lines.push(`${pad}${kk}: {}`); continue; }
      lines.push(`${pad}${kk}:`);
      emitMap(v, indent + 2, lines);
      continue;
    }
    const sv = scalar(v);
    if (sv !== null) { lines.push(`${pad}${kk}: ${sv}`); continue; }
    lines.push(`${pad}${kk}: |-`);
    emitBlockLiteral(String(v), indent + 2, lines, false);
  }
}

function emitSeq(arr, indent, lines) {
  const pad = ' '.repeat(indent);
  for (const item of arr) {
    if (item === null || item === undefined) { lines.push(`${pad}- ~`); continue; }
    if (Array.isArray(item)) {
      lines.push(`${pad}-`);
      emitSeq(item, indent + 2, lines);
      continue;
    }
    if (typeof item === 'object') {
      const keys = Object.keys(item).filter(k => item[k] !== undefined);
      if (keys.length === 0) { lines.push(`${pad}- {}`); continue; }
      let first = true;
      const sub = [];
      emitMap(item, indent + 2, sub);
      for (const sl of sub) {
        if (first) { lines.push(`${pad}- ${sl.trimStart()}`); first = false; }
        else lines.push(sl);
      }
      continue;
    }
    const sv = scalar(item);
    if (sv !== null) { lines.push(`${pad}- ${sv}`); continue; }
    lines.push(`${pad}- |-`);
    emitBlockLiteral(String(item), indent + 2, lines, true);
  }
}

function emitBlockLiteral(s, indent, lines) {
  const pad = ' '.repeat(indent);
  for (const ln of s.split('\n')) lines.push(pad + (ln === '' ? '' : ln));
}

// ---------------- parse ----------------

export function parse(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i];
    if (/^\s*#/.test(ln) || /^\s*$/.test(ln)) {
      // keep blank/structural only when inside possible block literal — handled by consumer
      lines.push({ text: ln, num: i + 1, blank: true });
      continue;
    }
    lines.push({ text: ln.replace(/\s+$/, ''), num: i + 1, blank: false });
  }
  const { value } = parseBlock(lines, 0, 0);
  return value;
}

function indentOf(t) { const m = t.match(/^( *)/); return m[1].length; }

function nextContentIdx(lines, i) {
  while (i < lines.length && (lines[i].blank)) i++;
  return i;
}

function parseBlock(lines, i, indent) {
  i = nextContentIdx(lines, i);
  if (i >= lines.length) return { value: null, i };
  const t = lines[i].text;
  if (indentOf(t) < indent) return { value: null, i };
  if (t.slice(indentOf(t)).startsWith('- ') || t.slice(indentOf(t)) === '-') return parseSeq(lines, i, indentOf(t));
  return parseMap(lines, i, indentOf(t));
}

function parseSeq(lines, i, indent) {
  const arr = [];
  while (i < lines.length) {
    const cur = nextContentIdx(lines, i);
    if (cur !== i) i = cur;
    if (i >= lines.length) break;
    const t = lines[i].text;
    if (indentOf(t) !== indent) break;
    const body = t.slice(indent);
    if (!body.startsWith('- ') && body !== '-') break;
    const rest = body === '-' ? '' : body.slice(2).trim();
    const childIndent = indent + 2;
    if (rest === '') {
      const r = parseBlock(lines, i + 1, childIndent);
      arr.push(r.value); i = r.i; continue;
    }
    const kv = splitKey(rest);
    if (kv) {
      const prefix = indent + 2;
      const itemLines = [{ text: ' '.repeat(prefix) + rest, num: lines[i].num, blank: false }];
      let j = i + 1;
      while (j < lines.length) {
        const lt = lines[j];
        const tt = lt.text;
        const ind = indentOf(tt);
        if (lt.blank) { itemLines.push(lt); j++; continue; }
        if (ind < prefix) break;
        if (ind === prefix && (tt.slice(ind).startsWith('- ') || tt.slice(ind) === '-')) break; // 同层兄弟项
        itemLines.push(lt); j++;
      }
      while (itemLines.length && itemLines[itemLines.length - 1].blank) { j--; itemLines.pop(); }
      const r = parseMap(itemLines, 0, prefix);
      arr.push(r.value); i = j; continue;
    }
    arr.push(coerce(rest)); i++;
  }
  return { value: arr, i };
}

function parseMap(lines, i, indent) {
  const obj = {};
  while (i < lines.length) {
    const cur = nextContentIdx(lines, i);
    if (cur !== i) i = cur;
    if (i >= lines.length) break;
    const t = lines[i].text;
    const ind = indentOf(t);
    if (ind < indent) break;
    if (ind > indent) { i++; continue; } // tolerate odd lines
    const body = t.slice(ind);
    if (body.startsWith('- ')) break;
    const kv = splitKey(body);
    if (!kv) { i++; continue; }
    const { key, val } = kv;
    if (val === '') {
      // child block | block literal | empty | 同层序列（人手写的宽容）
      let j = i + 1;
      while (j < lines.length && lines[j].blank) j++;
      const nl = lines[j];
      if (nl && !nl.blank && indentOf(nl.text) > ind) {
        const r = parseBlock(lines, j, indentOf(nl.text));
        obj[key] = r.value; i = r.i;
      } else if (nl && !nl.blank && indentOf(nl.text) === ind && nl.text.slice(ind).startsWith('- ')) {
        const r = parseSeq(lines, j, ind);
        obj[key] = r.value; i = r.i;
      } else obj[key] = null, i++;
    } else if (val === '|' || val === '|-' || val === '>' || val === '>-') {
      let j = i + 1; const collected = [];
      let baseIndent = null;
      while (j < lines.length) {
        const lt = lines[j];
        if (lt.blank) { collected.push(''); j++; continue; }
        const li = indentOf(lt.text);
        if (li <= ind) break;
        if (baseIndent === null) baseIndent = li;
        collected.push(lt.text.slice(Math.min(li, baseIndent)));
        j++;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      obj[key] = collected.join('\n'); i = j;
    } else {
      obj[key] = coerce(val); i++;
    }
  }
  return { value: obj, i };
}

function splitKey(body) {
  if (body.startsWith('"')) {
    let i = 1, esc = false;
    while (i < body.length) {
      const c = body[i];
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') break;
      i++;
    }
    if (i >= body.length) return null;
    const rest = body.slice(i + 1);
    if (!rest.startsWith(':')) return null;
    try { return { key: JSON.parse(body.slice(0, i + 1)), val: rest.slice(1).trim() }; } catch { return null; }
  }
  const idx = findColon(body);
  if (idx < 0) return null;
  const key = body.slice(0, idx).trim();
  if (!/^[\p{L}\p{N}_.\/@+:\-#*]+$/u.test(key)) return null;
  return { key, val: body.slice(idx + 1).trim() };
}

function findColon(body) {
  let inQ = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' && body[i - 1] !== '\\') inQ = !inQ;
    if (c === ':' && !inQ && (i + 1 >= body.length || body[i + 1] === ' ')) return i;
  }
  return -1;
}

function coerce(v) {
  if (v === '~' || v === 'null' || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === '[]') return [];
  if (v === '{}') return {};
  if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
    try { return JSON.parse(v); } catch { /* keep as string */ }
  }
  if (v.startsWith('"') && v.endsWith('"')) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(v)) return Number(v);
  return v;
}
