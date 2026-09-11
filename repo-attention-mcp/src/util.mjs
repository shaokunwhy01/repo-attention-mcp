// util.mjs — 确定性工具：ref 解析与 hash、仓库扫描（分辨率）、token 估算
// REFACTOR-v1 §8.1：保留 hashRef / hashEvidence / parseProjRef / sha256 / nowIso / estTokens。
// 老设计里的 quote 归一化 / 对话 ref / 相似度全部随 dialogs.mjs 一起删除。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
export const sha256b = (b) => createHash('sha256').update(b).digest('hex');
export const nowIso = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
export const pad4 = (n) => String(n).padStart(4, '0');

export function stableJson(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o) ?? 'null';
  if (Array.isArray(o)) return '[' + o.map(stableJson).join(',') + ']';
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stableJson(o[k])).join(',') + '}';
}
export const argsDigest = (o) => 'sha256:' + sha256(stableJson(o)).slice(0, 16);

// ---------- 受控文件（§3.2：排除 .repo-attention/.git/node_modules）----------
export const EXCLUDE_DIRS = new Set(['.repo-attention', '.git', 'node_modules']);

export function walkFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) walkFiles(path.join(dir, e.name), out); }
    else if (e.isFile()) out.push(path.join(dir, e.name));
  }
  return out;
}

function countLines(buf) {
  if (!buf || !buf.length) return 0;
  const s = buf.toString('utf8');
  if (s.includes('\u0000')) return 0; // 二进制：不计行
  const n = s.split(/\r?\n/).length;
  return s.endsWith('\n') ? Math.max(0, n - 1) : n;
}

/** F = 受控文件数；L = 受控总行数（分辨率推导的输入，§3.2）。 */
export function scanRepo(repoRoot) {
  const files = [];
  for (const abs of walkFiles(repoRoot)) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    let lines = 0;
    try { lines = countLines(readFileSync(abs)); } catch { /* unreadable → 0 */ }
    files.push({ rel, lines });
  }
  return { F: files.length, L: files.reduce((a, f) => a + f.lines, 0), files };
}

/**
 * 某模块覆盖的行数 L_m（R₂ 的输入）：refs 指向目录则递归求和，指向文件则取该文件；
 * 带 :start-end 时只计区间行数（与 hashRef 的行区间语义一致——不变量 I 才可在子文件点成立）。
 */
export function linesUnder(repoRoot, refs) {
  const seen = new Set(); let L = 0;
  for (const ref of refs || []) {
    const r = parseProjRef(ref);
    if (!r) continue;
    const abs = path.join(repoRoot, r.rel.split('/').join(path.sep));
    if (!existsSync(abs)) continue;
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      for (const f of walkFiles(abs)) {
        const rel = path.relative(repoRoot, f).split(path.sep).join('/');
        if (seen.has(rel)) continue; seen.add(rel);
        try { L += countLines(readFileSync(f)); } catch { /* ignore */ }
      }
    } else {
      if (seen.has(r.rel)) continue; seen.add(r.rel);
      if (r.lineStart != null) {
        // 与 hashRef 对齐：行区间局部定位，size 也按区间计（否则子文件点永远超载）
        try {
          const lines = readFileSync(abs, 'utf8').split(/\r?\n/);
          const region = lines.slice(r.lineStart - 1, r.lineEnd).join('\n');
          L += countLines(Buffer.from(region, 'utf8'));
        } catch { /* ignore */ }
      } else {
        try { L += countLines(readFileSync(abs)); } catch { /* ignore */ }
      }
    }
  }
  return L;
}

/**
 * 某模块覆盖的受控文件数 F_m（不变量 I 的文件维度，K_file 判据的输入）：
 * 目录递归去重计数，单文件计 1；:start-end 不影响文件数（仍算该文件 1 个）。
 */
export function filesUnder(repoRoot, refs) {
  const seen = new Set(); let F = 0;
  for (const ref of refs || []) {
    const r = parseProjRef(ref);
    if (!r) continue;
    const abs = path.join(repoRoot, r.rel.split('/').join(path.sep));
    if (!existsSync(abs)) continue;
    let st; try { st = statSync(abs); } catch { continue; }
    if (st.isDirectory()) {
      for (const f of walkFiles(abs)) {
        const rel = path.relative(repoRoot, f).split(path.sep).join('/');
        if (seen.has(rel)) continue; seen.add(rel); F++;
      }
    } else {
      if (seen.has(r.rel)) continue; seen.add(r.rel); F++;
    }
  }
  return F;
}

// ---------- 代码引用 proj://<repo>/<path>[:<start>-<end>][#<symbol>][@<rev>] ----------
export function parseProjRef(ref) {
  const m = /^proj:\/\/([^/]+)\/([^#@]*?)(?::(\d+)-(\d+))?(?:#([^@]*))?(?:@(\S+))?$/.exec(String(ref || ''));
  if (!m) return null;
  return {
    repo: m[1], rel: m[2].replace(/\/$/, '') || '',
    lineStart: m[3] ? +m[3] : null, lineEnd: m[4] ? +m[4] : null,
    symbol: m[5] || null, rev: m[6] || null, isDir: /\/$/.test(m[2]),
  };
}

function hashDir(repoRoot, rel) {
  const abs = path.join(repoRoot, rel.split('/').join(path.sep));
  const files = walkFiles(abs);
  const cat = files
    .map(f => path.relative(abs, f).split(path.sep).join('/') + ':' + sha256b(readFileSync(f)))
    .sort().join('\n');
  return { ok: true, exists: true, src_hash: 'sha256:' + sha256(cat), rev: sha256(cat).slice(0, 8) };
}

/** 单 ref 的 src_hash。行区间只作局部定位，hash 稳定 → 邻近编辑不制造假脏集（§4.4）。 */
export function hashRef(repoRoot, ref) {
  const r = parseProjRef(ref);
  if (!r) return { ok: false, reason: 'malformed_ref', exists: false };
  const abs = path.join(repoRoot, r.rel.split('/').join(path.sep));
  if (!existsSync(abs)) return { ok: true, exists: false, src_hash: 'sha256:missing', rev: 'missing' };
  let st; try { st = statSync(abs); } catch { return { ok: false, reason: 'unreadable', exists: false }; }
  if (st.isDirectory()) return hashDir(repoRoot, r.rel);
  const buf = readFileSync(abs);
  const fileHash = sha256b(buf);
  const rev = fileHash.slice(0, 8);
  if (r.lineStart != null) {
    const lines = buf.toString('utf8').split(/\r?\n/);
    const region = lines.slice(r.lineStart - 1, r.lineEnd).join('\n');
    return { ok: true, exists: true, src_hash: 'sha256:' + sha256(region), rev, fileHash };
  }
  return { ok: true, exists: true, src_hash: 'sha256:' + fileHash, rev, fileHash };
}

export function hashEvidence(repoRoot, refs) {
  if (!refs || refs.length === 0) return { bad: { reason: 'empty_refs' } };
  const parts = refs.map(x => hashRef(repoRoot, x));
  const bad = parts.find(p => !p.ok);
  if (bad) return { bad };
  return {
    src_hash: 'sha256:' + sha256(parts.map(p => p.src_hash).join('|')),
    anyMissing: parts.some(p => !p.exists),
  };
}

/** edit 事件的 scope（文件/目录混排）→ 一个可机械核对的 hash。 */
export function scopeHash(repoRoot, scope) {
  const parts = [];
  for (const s of scope || []) {
    const raw = String(s);
    const ref = raw.startsWith('proj://') ? raw : `proj://${'repo'}/${raw}`;
    const h = hashRef(repoRoot, ref);
    parts.push(`${raw}:${h.src_hash || (h.ok ? 'sha256:missing' : 'sha256:malformed')}`);
  }
  return 'sha256:' + sha256(parts.join('|'));
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
