// util.mjs — 确定性工具：ref 解析与 hash、token 估算、quote 归一化
import { createHash } from 'node:crypto';
import path from 'node:path';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const sha256b = (b) => createHash('sha256').update(b).digest('hex');
export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const pad4 = (n) => String(n).padStart(4, '0');
export const argsDigest = (o) => 'sha256:' + sha256(stableJson(o)).slice(0, 16);
export function stableJson(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o) ?? 'null';
  if (Array.isArray(o)) return '[' + o.map(stableJson).join(',') + ']';
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
}

// ---------- 代码引用 proj://<repo>/<path>:<start>-<end>#<symbol>@<rev> ----------
export function parseProjRef(ref) {
  const m = /^proj:\/\/([^/]+)\/([^#@]*?)(?::(\d+)-(\d+))?(?:#([^@]*))?(?:@(\S+))?$/.exec(ref);
  if (!m) return null;
  return { repo: m[1], rel: m[2].replace(/\/$/, '') || '', lineStart: m[3] ? +m[3] : null, lineEnd: m[4] ? +m[4] : null, symbol: m[5] || null, rev: m[6] || null, dir: /\/$/.test(m[2]) || (!m[3] && !m[5] && /\.(?!)/.test('')) };
}

export function parseDialogRef(ref) {
  const m = /^dialog:\/\/([^#]+)(?:#(.*))?$/.exec(ref || '');
  return m ? { sess: m[1], span: m[2] || null } : null;
}

import * as nodeFs from 'node:fs';
const fsx = () => nodeFs;

function walkFiles(dir, out) {
  for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '.repo-attention' && e.name !== '.git' && e.name !== 'node_modules') walkFiles(p, out); }
    else out.push(p);
  }
}

// 计算一个 ref 的 src_hash 与 rev。行区间只作局部定位（I7），hash 稳定 → 邻近编辑不制造假脏集。
export function hashRef(repoRoot, ref) {
  const r = parseProjRef(ref);
  if (!r) return { ok: false, reason: 'malformed_ref', exists: false };
  const abs = path.join(repoRoot, r.rel.split('/').join(path.sep));
  if (!fsx().existsSync(abs)) {
    if (looksLikeDir(repoRoot, r)) return hashDir(repoRoot, r);
    return { ok: true, exists: false, src_hash: 'sha256:missing', rev: 'missing' };
  }
  const st = fsx().statSync(abs);
  if (st.isDirectory()) return hashDir(repoRoot, r);
  const buf = fsx().readFileSync(abs);
  const fileHash = sha256b(buf);
  const rev = fileHash.slice(0, 8);
  if (r.lineStart != null) {
    const lines = buf.toString('utf8').split(/\r?\n/);
    const region = lines.slice(r.lineStart - 1, r.lineEnd).join('\n');
    return { ok: true, exists: true, src_hash: 'sha256:' + sha256(region), rev, fileHash };
  }
  return { ok: true, exists: true, src_hash: 'sha256:' + fileHash, rev, fileHash };
}

function looksLikeDir(repoRoot, r) {
  const abs = path.join(repoRoot, (r.rel || '').split('/').join(path.sep));
  return r.rel && fsx().existsSync(abs) && fsx().statSync(abs).isDirectory();
}

function hashDir(repoRoot, r) {
  const abs = path.join(repoRoot, r.rel.split('/').join(path.sep));
  const files = [];
  walkFiles(abs, files);
  const cat = files.map(f => path.relative(abs, f).split(path.sep).join('/') + ':' + sha256b(fsx().readFileSync(f))).sort().join('\n');
  return { ok: true, exists: true, src_hash: 'sha256:' + sha256(cat), rev: sha256(cat).slice(0, 8) };
}

export function hashEvidence(repoRoot, refs) {
  if (!refs || refs.length === 0) return 'sha256:EMPTY';
  const parts = refs.map(x => hashRef(repoRoot, x));
  const bad = parts.find(p => !p.ok);
  if (bad) return { bad };
  return { src_hash: 'sha256:' + sha256(parts.map(p => p.src_hash).join('|')), anyMissing: parts.some(p => !p.exists) };
}

// ---------- token 估算（CJK 按字、其余按 4 字符）----------
export function estTokens(s) {
  if (s == null) return 0;
  const str = typeof s === 'string' ? s : JSON.stringify(s);
  let cjk = 0, other = 0;
  for (const ch of str) {
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) cjk++;
    else other++;
  }
  return cjk + Math.ceil(other / 4);
}

// ---------- quote 归一化（§10-C：NFKC、空白/标点折叠、… 通配分段）----------
export function normQuote(s) {
  return (s || '').normalize('NFKC').toLowerCase()
    .replace(/…|\.\.\.+/g, '\u0001')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
    .replace(/\u0001/g, '\u0001');
}

export function quoteMatch(haystack, quoteText) {
  const H = normQuote(haystack);
  const segs = normQuote(quoteText).split('\u0001').filter(Boolean);
  if (segs.length === 0) return false;
  let pos = 0;
  for (const seg of segs) {
    const idx = H.indexOf(seg, pos);
    if (idx < 0) return false;
    pos = idx + seg.length;
  }
  return true;
}

export function quoteDigest(quoteText) {
  return 'q-' + sha256(normQuote(quoteText).replace(/\u0001/g, '')).slice(0, 16);
}

// 相似度（failed 时返回最相近三行用）
export function similarity(a, b) {
  const A = normQuote(a).replace(/\u0001/g, ''), B = normQuote(b).replace(/\u0001/g, '');
  if (!A || !B) return 0;
  const grams = new Set();
  for (let i = 0; i + 2 <= A.length; i++) grams.add(A.slice(i, i + 2));
  let hit = 0;
  for (let i = 0; i + 2 <= B.length; i++) if (grams.has(B.slice(i, i + 2))) hit++;
  return hit / Math.max(1, A.length - 1);
}
