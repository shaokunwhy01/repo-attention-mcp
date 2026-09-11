// scripts/subdivide-plan.mjs — Phase 1：扫超载叶 → 产出 subdivision-plan.json
//
// 纯本地规划脚本（不是 MCP 工具、不改服务器）。它只机械执行 .codebuddy/rules/resolution-subdivision.md
// 定义的切分策略，产出可被后续「note(kind="score", why:"split")」一个可实施点直接回填的 plan.json。
//
// 用法：
//   node scripts/subdivide-plan.mjs --repo <根> [--out plan.json]
//
// 产出 plan.json 每个子点含：
//   range      : 精确 :start-end（1-based 含两端，与 hashRef / linesUnder 口径一致）
//   anchor     : 锚名（## 标题 / class·def 名 / JSON 顶层键 / <section> id）
//   id         : 拟用 node id = <leaf id>#<锚名 slug>
//   ref        : proj://<repo>/<rel>:<start>-<end>#<slug>
//   区间 src_hash : hashRef(ref).src_hash（区间内容 hash，规则第四节字面要求的值）
//   src_hash   : hashEvidence([ref]).src_hash（note 实际需要的、能过 validateScore 的值 —— 比区间 hash 多包一层 sha256）
//   default_raw: 默认 raw = 父 raw / 子点数（等权播种；操作员在 re-score 阶段按重读强度覆盖）
//   lines      : 该区间行数

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Repo } from '../src/repo.mjs';
import { Core } from '../src/core.mjs';
import { hashRef, hashEvidence, parseProjRef, walkFiles, linesUnder } from '../src/util.mjs';

const argv = process.argv.slice(2);
const getArg = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const repoPath = path.resolve(getArg('repo', process.cwd()));
const outPath = path.resolve(getArg('out', 'subdivision-plan.json'));

const repo = new Repo(repoPath);
const core = new Core(repo);
const P = repo.params();
const K_file = P.K_file, K_line = P.K_line;
const root = repo.projectRoot;

// ---------- 1. 从事件流折叠出 index，捞出超载叶（排除生成产物/规则目录）----------
const EXCLUDE = [
  (rel) => rel.split('/').includes('__pycache__'),                              // 编译字节码，非项目内容
  (rel) => rel === '.codebuddy/rules' || rel.startsWith('.codebuddy/rules/'),  // 规则文件自身，单列回填
];
const isExcluded = (rel) => EXCLUDE.some((fn) => fn(rel));
const idx = repo.loadIndex();
const overLeaves = [];
const excluded = [];
for (const n of Object.values(idx.nodes)) {
  if (n.is_branch) continue;                       // 分支不细切（其子若超 K 另行递归）
  const cap = core.measure(n.evidence);
  if (!core.violatesI(cap, K_file, K_line)) continue;
  const rel = (parseProjRef(n.evidence[0]) || {}).rel || '';
  if (isExcluded(rel)) { excluded.push(n.id); continue; }
  overLeaves.push({ id: n.id, evidence: n.evidence, raw: Number(n.raw || 0) });
}
overLeaves.sort((a, b) => a.id.localeCompare(b.id));

// ---------- 2. 切分工具 ----------
const slugify = (s) => (s || '').trim().replace(/\s+/g, '-').replace(/[^\w一-鿿.-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'sec';

function fixedSegs(lines, from, to, prefix) {
  const segs = []; let i = from, n = 0;
  while (i <= to) { const e = Math.min(i + K_line - 1, to); segs.push({ start: i, end: e, anchor: `${prefix || 'blk'}-${++n}` }); i = e + 1; }
  return segs;
}

function splitByHeadings(lines, from, to, level) {
  const re = new RegExp('^' + '#'.repeat(level) + '\\s+(.*)$');
  const hs = [];
  for (let i = from - 1; i <= to - 1; i++) { const m = re.exec(lines[i]); if (m) hs.push({ i, text: m[1].trim() }); }
  if (!hs.length) return fixedSegs(lines, from, to, 'blk');
  const segs = [];
  if (hs[0].i > from - 1) segs.push({ start: from, end: hs[0].i, anchor: '前言' });
  for (let k = 0; k < hs.length; k++) {
    const s = hs[k].i, e = (k + 1 < hs.length ? hs[k + 1].i - 1 : to - 1);
    segs.push({ start: s + 1, end: e + 1, anchor: hs[k].text });
  }
  return segs.flatMap((seg) => {
    const len = seg.end - seg.start + 1;
    if (len <= K_line) return [seg];
    if (level < 6) { const finer = splitByHeadings(lines, seg.start, seg.end, level + 1); if (finer.length > 1) return finer; }
    return fixedSegs(lines, seg.start, seg.end, seg.anchor);
  });
}

function splitPy(lines) {
  const segs = []; let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const ind = (lines[i].match(/^(\s*)/) || ['', ''])[1].length;
    const top = ind === 0 && /^(?:class|def|function)\s+([A-Za-z_]\w*)/.test(lines[i]);
    if (top) { if (cur) segs.push(cur); const m = /^(?:class|def|function)\s+([A-Za-z_]\w*)/.exec(lines[i]); cur = { start: i + 1, end: i + 1, anchor: m[1] }; }
    else if (cur) cur.end = i + 1;
  }
  if (cur) segs.push(cur);
  if (!segs.length) return fixedSegs(lines, 1, lines.length, 'blk');
  return segs.flatMap((seg) => (seg.end - seg.start + 1 <= K_line ? [seg] : fixedSegs(lines, seg.start, seg.end, seg.anchor)));
}

function splitHtml(lines) {
  const segs = []; let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /<section\b/i.test(lines[i]) ? (/<section[^>]*id="([^"]+)"/i.exec(lines[i]) || ['', 'section']) : null;
    if (m) { if (cur) segs.push(cur); cur = { start: i + 1, end: i + 1, anchor: m[1] || 'section' }; }
    else if (cur) cur.end = i + 1;
  }
  if (cur) segs.push(cur);
  if (!segs.length) return fixedSegs(lines, 1, lines.length, 'sec');
  return segs.flatMap((seg) => (seg.end - seg.start + 1 <= K_line ? [seg] : fixedSegs(lines, seg.start, seg.end, seg.anchor)));
}

function splitJson(lines, text) {
  let obj; try { obj = JSON.parse(text); } catch { return fixedSegs(lines, 1, lines.length, 'blk'); }
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const segs = [];
    for (const k of Object.keys(obj)) {
      const pat = new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:');
      const ks = lines.findIndex((l) => pat.test(l));
      if (ks < 0) continue;
      let depth = 0, started = false, end = ks;
      for (let i = ks; i < lines.length; i++) {
        for (const ch of lines[i]) { if (ch === '{' || ch === '[') { depth++; started = true; } else if (ch === '}' || ch === ']') { depth--; if (started && depth === 0) { end = i; break; } } }
        if (started && depth === 0) break;
      }
      segs.push({ start: ks + 1, end: end + 1, anchor: k });
    }
    if (segs.length) return segs.flatMap((seg) => (seg.end - seg.start + 1 <= K_line ? [seg] : fixedSegs(lines, seg.start, seg.end, seg.anchor)));
  }
  return fixedSegs(lines, 1, lines.length, 'blk');
}

function dedup(segs) { const seen = {}; for (const s of segs) { const a = s.anchor || 'sec'; if (seen[a]) { seen[a]++; s.anchor = a + '-' + seen[a]; } else seen[a] = 1; } return segs; }

function splitLeaf(rel, abs) {
  const text = readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();   // 与 scanRepo 行数口径一致
  const ext = rel.toLowerCase().split('.').pop();
  let segs;
  if (ext === 'md') segs = splitByHeadings(lines, 1, lines.length, 2);
  else if (['py', 'js', 'mjs', 'ts'].includes(ext)) segs = splitPy(lines);
  else if (ext === 'html') segs = splitHtml(lines);
  else if (ext === 'json') segs = splitJson(lines, text);
  else segs = fixedSegs(lines, 1, lines.length, 'blk');
  return dedup(segs);
}

// ---------- 3. 生成 plan ----------
const plan = {
  generated_ts: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  repo: repoPath,
  K_file, K_line,
  note: '本 plan 由 scripts/subdivide-plan.mjs 机械生成；执行回填请用 note(kind="score", why:"split") 一个可实施点。',
  src_hash_note: 'src_hash 字段 = hashEvidence([ref]).src_hash（note 校验所需，比「区间 src_hash」多包一层 sha256）。规则 resolution-subdivision.md 第四节将其误写为 hashRef —— 以此 plan 的 src_hash 为准，或修正规则。',
  total_over_size: overLeaves.length,
  excluded: excluded,
  excluded_count: excluded.length,
  leaves: [],
};

for (const leaf of overLeaves) {
  const pr = parseProjRef(leaf.evidence[0]);
  const repoName = pr?.repo || path.basename(root);
  const rel = pr?.rel || '';
  const abs = path.join(root, rel.split('/').join(path.sep));
  const isDir = !!pr?.isDir || (existsSync(abs) && statSync(abs).isDirectory());

  let segs;
  if (isDir) {
    // 目录叶：按文件切（每文件 1 个，files≤5 自然满足；单文件仍 >K 则由操作员递归）
    segs = walkFiles(abs).map((f) => {
      const r = path.relative(root, f).split(path.sep).join('/');
      return { start: 1, end: 1, anchor: path.basename(f), _fileRel: r };
    });
    segs = dedup(segs);
  } else {
    segs = splitLeaf(rel, abs);
  }

  const n = segs.length;
  const defaultRaw = n ? +(leaf.raw / n).toFixed(4) : 0;
  const ranges = segs.map((s) => {
    const fileRel = s._fileRel || rel;
    const ref = s._fileRel
      ? `proj://${repoName}/${fileRel}`
      : `proj://${repoName}/${rel}:${s.start}-${s.end}#${slugify(s.anchor)}`;
    const hRef = hashRef(root, ref);
    const hEv = hashEvidence(root, [ref]);
    return {
      anchor: s.anchor,
      id: `${leaf.id}#${slugify(s.anchor)}`,
      ref,
      range: s._fileRel ? null : `${s.start}-${s.end}`,
      lines: s._fileRel ? linesUnder(root, [ref]) : (s.end - s.start + 1),
      区间_src_hash: hRef.src_hash,
      src_hash: hEv.src_hash,
      default_raw: defaultRaw,
    };
  });

  plan.leaves.push({
    leaf_id: leaf.id,
    leaf_raw: leaf.raw,
    file: rel,
    is_dir: !!isDir,
    n_children: n,
    recommend: (isDir && rel.includes('__pycache__')) ? '建议从 scan 的 EXCLUDE_DIRS 排除 __pycache__（编译产物）而非细分；若要细分则按规则逐文件切' : null,
    parent_action: '保留原 raw（作容器仍计入其父组）；子点建成后 fold 自动判其为分支。可选补一笔 why:"split" 仅更新 summary。',
    ranges,
  });
}

writeFileSync(outPath, JSON.stringify(plan, null, 2), 'utf8');
const totalPoints = plan.leaves.reduce((a, l) => a + l.n_children, 0);
console.log(JSON.stringify({
  ok: true,
  repo: repoPath,
  K_file, K_line,
  total_over_size: overLeaves.length,
  excluded_count: excluded.length,
  excluded,
  total_sub_points: totalPoints,
  out: outPath,
  per_leaf: plan.leaves.map((l) => ({ id: l.leaf_id, raw: l.leaf_raw, n: l.n_children })),
}, null, 2));
