// dialogs.mjs — 转写仓（R1 裁决①连带义务：会话中增量追加 + 行级 digest 链 P7）
// 行格式 {ts, role, text, sess, seq, prev_hash}；关闭只追加 seal 行（记链头）+ 文件级 sha256。
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256, nowIso, normQuote, quoteMatch, quoteDigest, similarity } from './util.mjs';
import * as Y from './yaml.mjs';

export function dialogPath(root, sessId) { return path.join(root, 'dialogs', `sess-${sessId}.jsonl`); }
export function metaPath(root, sessId) { return path.join(root, 'dialogs', `sess-${sessId}.meta.yaml`); }

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim())
    .map((l, i) => { try { return { line: JSON.parse(l), num: i + 1 }; } catch { return { line: null, num: i + 1, raw: l }; } });
}

export function chainHead(file) {
  const lines = readLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].line;
    if (l && l.kind === 'seal') return l;
  }
  return lines.length ? { hash: lines[lines.length - 1].line?.prev_hash_next || lineHash(lines[lines.length - 1].line) } : null;
}

function lineHash(l) {
  if (!l) return 'sha256:GENESIS';
  return sha256(`${l.seq}|${l.ts}|${l.role}|${l.sess}|${l.prev_hash}|${l.text ?? ''}`);
}

// 追加一行（增量落盘——quote 校验要求证据在调用瞬间已在盘）
export function appendDialog(root, sessId, { ts, role, text, meta } = {}, opts = {}) {
  mkdirSync(path.join(root, 'dialogs'), { recursive: true });
  const file = dialogPath(root, sessId);
  const lines = readLines(file);
  const seal = lines.find(x => x.line?.kind === 'seal');
  if (seal) throw new Error(`dialog sess-${sessId} sealed; append-only（P2），拒绝写入`);
  const prevHash = lines.length ? lineHash(lines[lines.length - 1].line) : 'sha256:GENESIS';
  const rec = { ts: ts || nowIso(), role: role || 'user', text: text ?? '', sess: sessId, seq: lines.length + 1, prev_hash: prevHash };
  writeFileSync(file, lines.map(x => JSON.stringify(x.line ?? { raw: x.raw })).join('\n') + (lines.length ? '\n' : '') + JSON.stringify(rec) + '\n', 'utf8');
  if (!opts.skipMeta) upsertMeta(root, sessId, { last_append: rec.ts });
  return { num: rec.seq, hash: lineHash(rec), rec };
}

export function sealDialog(root, sessId, { mode } = {}) {
  const file = dialogPath(root, sessId);
  const lines = readLines(file);
  if (!lines.length) throw new Error(`no dialog file for sess-${sessId}`);
  let content = readFileSync(file, 'utf8');
  if (content.includes('"kind": "seal"') || content.includes('"kind":"seal"')) {
    // 已封存
  } else {
    const prevHash = lineHash(lines[lines.length - 1].line);
    const seal = { kind: 'seal', ts: nowIso(), sess: sessId, seq: lines.length + 1, prev_hash: prevHash, head: prevHash };
    content += JSON.stringify(seal) + '\n';
    writeFileSync(file, content, 'utf8');
  }
  const fh = 'sha256:' + sha256(readFileSync(file));
  writeFileSync(file + '.sha256', fh + '\n', 'utf8');
  const meta = loadMeta(root, sessId) || {};
  meta.sealed = true; meta.closed_ts = meta.closed_ts || nowIso(); meta.file_sha256 = fh;
  if (mode) meta.mode = mode;
  meta.mode = meta.mode || 'mixed';
  saveMeta(root, sessId, meta);
  return { file_sha256: fh, sealed: true };
}

// P7 校验：链完整性 + 文件级 sha
export function verifyChain(root, sessId) {
  const file = dialogPath(root, sessId);
  const lines = readLines(file);
  if (!lines.length) return { sess: sessId, exists: false };
  let prev = 'sha256:GENESIS';
  for (const { line, num } of lines) {
    if (!line) return { sess: sessId, ok: false, reason: `line ${num}: malformed json` };
    if (line.prev_hash !== prev) return { sess: sessId, ok: false, reason: `line ${num}: chain break (prev_hash mismatch)` };
    prev = lineHash(line);
  }
  const shaFile = file + '.sha256';
  let sealed = false, fileOk = true;
  if (existsSync(shaFile)) {
    sealed = true;
    const expect = readFileSync(shaFile, 'utf8').trim();
    fileOk = expect === 'sha256:' + sha256(readFileSync(file));
  }
  return { sess: sessId, ok: fileOk, lines: lines.length, sealed, chain_head: prev, reason: fileOk ? null : 'file-level sha mismatch after seal' };
}

export function loadMeta(root, sessId) {
  const f = metaPath(root, sessId);
  if (!existsSync(f)) return null;
  return Y.parse(readFileSync(f, 'utf8'));
}
export function saveMeta(root, sessId, meta) {
  mkdirSync(path.join(root, 'dialogs'), { recursive: true });
  writeFileSync(metaPath(root, sessId), Y.dump(meta), 'utf8');
}
export function upsertMeta(root, sessId, patch) {
  const meta = loadMeta(root, sessId) || { session_id: sessId };
  saveMeta(root, sessId, { ...meta, ...patch, session_id: sessId });
}

export function listDialogs(root) {
  const dir = path.join(root, 'dialogs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^sess-.+\.jsonl$/.test(f)).map(f => f.replace(/^sess-/, '').replace(/\.jsonl$/, ''));
}

// ---------- quote 三态校验（§10-C R1）----------
// 返回 {verdict: verified|failed|no_coverage, digest, matched: [{sess, line_num, role, text}], nearest: [...]}
export function verifyQuote(root, quote) {
  const text = typeof quote === 'string' ? quote : quote?.text;
  const sessHint = (typeof quote === 'object' && quote) ? quote.sess_hint : null;
  const digest = quoteDigest(text || '');
  if (!text || normQuote(text).replace(/\u0001/g, '') === '') {
    return { verdict: 'failed', reason: 'quote.text 为空或无实词', digest };
  }
  const sessIds = listDialogs(root);
  if (sessIds.length === 0) {
    return { verdict: 'no_coverage', reason: '仓内无任何转写（dialogs/*.jsonl 为空）——待补账', digest };
  }
  const pool = [];
  for (const s of sessIds) {
    if (sessHint && s !== sessHint && s !== `sess-${sessHint}` && `sess-${s}` !== sessHint) continue;
    for (const { line, num } of readLines(dialogPath(root, s))) {
      if (line && line.kind !== 'seal') pool.push({ sess: s, num, role: line.role, text: line.text });
    }
  }
  const searched = sessIds.length;
  if (pool.length === 0) {
    return { verdict: sessHint && !sessIds.includes(sessHint) && !sessIds.includes(`sess-${sessHint}`)
      ? 'no_coverage' : 'failed',
      reason: sessHint ? `sess_hint=${sessHint} 不在库中（链断或该窗无转写）——待补账` : `已检索 ${searched} 个会话，无候选行`, digest };
  }
  // 精确 → 归一匹配；优先 user 角色（主权在人），其次 sess_hint 会话
  let best = null;
  for (const cand of pool) {
    if (!quoteMatch(String(cand.text || ''), text)) continue;
    const score = (cand.role === 'user' ? 2 : 0) + (sessHint && cand.sess === String(sessHint).replace(/^sess-/, '') ? 1 : 0);
    if (!best || score > best.score) best = { ...cand, score };
  }
  if (best) {
    const exact = String(best.text).includes(text);
    return {
      verdict: 'verified', mode: exact ? 'exact' : 'normalized', digest,
      matched: [{ sess: best.sess, line_num: best.num, role: best.role, text: best.text }],
    };
  }
  const nearest = pool.map(c => ({ ...c, sim: similarity(c.text, text) }))
    .sort((a, b) => b.sim - a.sim).slice(0, 3)
    .map(c => ({ sess: c.sess, line_num: c.num, role: c.role, text: String(c.text).slice(0, 120), sim: +c.sim.toFixed(2) }));
  return { verdict: 'failed', reason: '库内无匹配（可能是记忆漂移）', digest, nearest };
}

// quote 唯一消费（重放防御）：digest 在 ledger 中不得服务于另一个主权动作
export function quoteAlreadyUsed(ledgerRows, digest, action) {
  return (ledgerRows || []).filter(r => r.quote_digest === digest && r.action && r.action !== action);
}
