// cli.mjs — 独立驱动器（**不是** MCP 工具面）：确定性作业都放这里。
//   init / audit / migrate  —— 与老 server CLI 相同职责
//   scan     —— 扫目录 → 建树骨架（scaffold，raw 占位 0），使"全评"有清单
//   progress —— 树 − 已评 = 未评集合（全评进度）
//   sweep    —— 取一批未评叶子 → 导出「内容 + 打分请求」任务包（交给模型判断）
// 工具面保持 6：以上命令均不进 MCP。写账仍走 note()（模型判断后回填）。
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { Repo } from './repo.mjs';
import { Core } from './core.mjs';
import { migrate } from './migrate.mjs';
import { scanRepo, walkFiles, hashEvidence, parseProjRef, nowIso } from './util.mjs';

function getArg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}
const num = (v, d) => (v == null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const has = (argv, name) => argv.includes(`--${name}`);

export async function runCli(argv) {
  const cmd = argv[0];
  const repoPath = path.resolve(getArg(argv, 'repo', process.cwd()));
  const defaults = new Repo(repoPath).params();
  const kFile = num(getArg(argv, 'k-file'), defaults.K_file);
  const kLine = num(getArg(argv, 'k-line'), defaults.K_line);

  switch (cmd) {
    case 'init': return cmdInit(repoPath);
    case 'audit': return cmdAudit(repoPath);
    case 'migrate': return cmdMigrate(repoPath);
    case 'scan': return cmdScan(repoPath, { kFile, kLine, force: has(argv, 'force'), dryRun: has(argv, 'dry-run') });
    case 'progress': return cmdProgress(repoPath);
    case 'sweep': return cmdSweep(repoPath, {
      batch: num(getArg(argv, 'batch'), 20),
      out: getArg(argv, 'out', null),
      node: getArg(argv, 'node', null),
      maxLines: num(getArg(argv, 'max-lines'), kLine * 2),
    });
    default: return usage();
  }
}

function usage() {
  console.log(`用法（独立驱动器；MCP 工具面仍为 6）:
  node src/cli.mjs init     --repo <根>
  node src/cli.mjs audit    --repo <根>            # 只读三检：事件可解析 / index 可重建 / hash 一致
  node src/cli.mjs migrate  --repo <根>            # 老仓 → 新格式（老产物移入 legacy/）
  node src/cli.mjs scan     --repo <根> [--k-file 5] [--k-line 250] [--dry-run] [--force]
                                                   # 扫目录建树骨架（raw 占位 0，标 unscored）= 全评清单
  node src/cli.mjs progress --repo <根>            # 全评进度：总数 / 已评 / 未评 / 分布
  node src/cli.mjs sweep    --repo <根> [--batch 20] [--node <id>] [--max-lines 500] [--out tasks.json]
                                                   # 取一批未评叶子 → 「内容 + 打分请求」任务包`);
}

// ---------------- init / audit / migrate ----------------
function cmdInit(repoPath) {
  const repo = new Repo(repoPath);
  repo.ensureLayout();
  writeFileSync(path.join(repo.root, 'README.txt'),
    '本目录 = 项目全部记忆。zip 此目录 = 搬走记忆。整树 .gitignore。\n'
    + 'events.jsonl = 唯一真相（只追加，永不修改）；index.yaml = 派生缓存（删掉可完全重建）。\n'
    + '空文件即空账；第一次 note(kind="score") 就是这条账的开始。\n'
    + '全评：先 ra scan 建树骨架 → ra sweep 取任务 → 逐个判断后 note(score) 回填 → ra progress 看进度。\n', 'utf8');
  const gi = path.join(repoPath, '.gitignore');
  let cur = '';
  try { cur = readFileSync(gi, 'utf8'); } catch { /* new file */ }
  if (!cur.includes('.repo-attention')) writeFileSync(gi, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '.repo-attention/\n', 'utf8');
  console.log(`initialized ${repo.root}`);
}

function cmdAudit(repoPath) {
  const repo = new Repo(repoPath);
  repo.ensureLayout();
  const a = new Core(repo).audit();
  console.log(JSON.stringify(a, null, 2));
  process.exitCode = a.ok ? 0 : 1;
}

function cmdMigrate(repoPath) {
  const r = migrate(repoPath, { log: (m) => console.log(m) });
  process.exitCode = r.ok ? 0 : 1;
}

// ---------------- scan：扫目录 → 树骨架 ----------------
/** 贪心分桶：每点 ≤ kFile 个文件且 ≤ kLine 行（不变量 I：每点承载量 ≤ K）。 */
function chunkFiles(list, kFile, kLine) {
  const out = []; let cur = []; let curLines = 0;
  for (const f of list) {
    if (cur.length && (cur.length >= kFile || curLines + f.lines > kLine)) { out.push(cur); cur = []; curLines = 0; }
    cur.push(f); curLines += f.lines;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** 纯函数：扫目录 → 候选树（不写盘）。节点 id = 相对路径（目录）或相对路径（文件）或 dir/_group-NN（多文件桶）。 */
export function buildPlan(repoRoot, { kFile = 5, kLine = 250 } = {}) {
  const scan = scanRepo(repoRoot);
  const repoName = path.basename(repoRoot) || 'repo';
  const dirFiles = new Map(); const dirLines = new Map();
  const bump = (d, n) => dirLines.set(d, (dirLines.get(d) || 0) + n);
  for (const f of scan.files) {
    const parts = f.rel.split('/'); parts.pop();
    const dir = parts.join('/');
    if (!dirFiles.has(dir)) dirFiles.set(dir, []);
    dirFiles.get(dir).push(f);
    bump('', f.lines);
    for (let i = 1; i <= parts.length; i++) bump(parts.slice(0, i).join('/'), f.lines);
  }
  const children = new Map();
  for (const d of dirLines.keys()) {
    if (!d) continue;
    const p = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    if (!children.has(p)) children.set(p, []);
    children.get(p).push(d);
  }
  const refDir = (d) => `proj://${repoName}/${d}/`;
  const refFile = (rel) => `proj://${repoName}/${rel}`;
  const out = [];

  const pushLoose = (dir, parent, depth) => {
    const list = dirFiles.get(dir) || [];
    if (!list.length) return;
    const scope = dir || '_root';   // 根层散文件用 _root 作伪目录名（保持 id 是路径形态）
    let gN = 0;
    for (const g of chunkFiles(list, kFile, kLine)) {
      if (g.length === 1) {
        out.push({ id: g[0].rel, parent, depth, layer: 'content', refs: [refFile(g[0].rel)], lines: g[0].lines, branch: false, n_files: 1 });
        continue;
      }
      gN++;
      out.push({
        id: `${scope}/_group-${String(gN).padStart(2, '0')}`, parent, depth, layer: 'content',
        refs: g.map(f => refFile(f.rel)), lines: g.reduce((a, f) => a + f.lines, 0), branch: false, n_files: g.length,
      });
    }
  };

  const emit = (dir, parent, depth) => {
    if (dir === '') {
      for (const c of (children.get('') || []).sort()) emit(c, null, 0);
      pushLoose('', null, 0);
      return;
    }
    const lines = dirLines.get(dir) || 0;
    if (lines <= kLine) { // 整个目录就是一个点（承载量 ≤ K_line）
      out.push({ id: dir, parent, depth, layer: 'module', refs: [refDir(dir)], lines, branch: false, n_files: null });
      return;
    }
    out.push({ id: dir, parent, depth, layer: 'module', refs: [refDir(dir)], lines, branch: true, n_files: null });
    for (const c of (children.get(dir) || []).sort()) emit(c, dir, depth + 1);
    pushLoose(dir, dir, depth + 1);
  };

  emit('', null, 0);
  return { nodes: out, F: scan.F, L: scan.L, repoName };
}

function cmdScan(repoPath, { kFile, kLine, force, dryRun }) {
  const plan = buildPlan(repoPath, { kFile, kLine });
  const repo = new Repo(repoPath);
  repo.ensureLayout();
  const idx = repo.loadIndex();
  const existing = new Set(Object.keys(idx.nodes));
  const fresh = plan.nodes.filter(n => force || !existing.has(n.id));

  if (dryRun) {
    console.log(JSON.stringify({
      dry_run: true, F: plan.F, L: plan.L,
      planned: plan.nodes.length, new: fresh.length, skipped_existing: plan.nodes.length - fresh.length,
      branches: plan.nodes.filter(n => n.branch).length,
      max_depth: plan.nodes.reduce((a, n) => Math.max(a, n.depth), 0),
      over_size_files: plan.nodes.filter(n => !n.branch && n.lines > kLine).length,
      sample: plan.nodes.slice(0, 15).map(n => ({ id: n.id, parent: n.parent, depth: n.depth, branch: n.branch, lines: n.lines })),
    }, null, 2));
    return;
  }

  const round = idx.version || 0;
  const evs = fresh.map(n => ({
    ts: nowIso(), by: 'scan', kind: 'score', round,
    node: n.id, layer: n.layer, parent: n.parent,
    raw: 0, why: 'new', scaffold: true,
    evidence: n.refs, src_hash: (hashEvidence(repoPath, n.refs).src_hash) || null,
  }));
  repo.appendEvents(evs);
  const after = repo.loadIndex();
  console.log(JSON.stringify({
    scanned: true, F: plan.F, L: plan.L,
    planned: plan.nodes.length, written: evs.length, skipped_existing: plan.nodes.length - fresh.length,
    n_nodes: Object.keys(after.nodes).length, max_depth: maxDepthOf(after.nodes),
    over_size_files: plan.nodes.filter(n => !n.branch && n.lines > kLine).length,
    next: 'ra progress --repo <根> 看全评进度；ra sweep --repo <根> 取任务包',
  }, null, 2));
}

// ---------------- progress：全评进度 ----------------
function cmdProgress(repoPath) {
  const repo = new Repo(repoPath);
  if (!existsSync(repo.eventsPath())) {
    console.log(JSON.stringify({ ok: false, error: '尚未 init（无 events.jsonl）' }, null, 2));
    process.exitCode = 1; return;
  }
  const idx = repo.loadIndex();
  const all = Object.values(idx.nodes);
  const unscored = all.filter(n => n.scaffold);
  const unscoredLeaves = unscored.filter(n => !n.is_branch);
  const byDepth = {};
  for (const n of unscored) byDepth[n.depth] = (byDepth[n.depth] || 0) + 1;
  console.log(JSON.stringify({
    total: all.length,
    scored: all.length - unscored.length,
    unscored: unscored.length,
    unscored_leaves: unscoredLeaves.length,
    branches: all.filter(n => n.is_branch).length,
    leaves: all.filter(n => !n.is_branch).length,
    max_depth: maxDepthOf(idx.nodes),
    unscored_by_depth: byDepth,
    next_up: unscoredLeaves.slice(0, 10).map(n => n.id),
    hint: unscored.length ? 'ra sweep --repo <根> --batch 20 导出下一批任务' : '全评已完成（无未评节点）',
  }, null, 2));
}

// ---------------- sweep：未评叶子 → 任务包 ----------------
function readRefs(repoRoot, refs, maxLines) {
  const out = []; let used = 0; let truncated = false;
  const repoName = path.basename(repoRoot) || 'repo';
  for (const ref of refs || []) {
    if (used >= maxLines) { truncated = true; break; }
    const r = parseProjRef(ref);
    if (!r) { out.push({ ref, error: 'malformed_ref' }); continue; }
    const abs = path.join(repoRoot, r.rel.split('/').join(path.sep));
    if (!existsSync(abs)) { out.push({ ref, missing: true }); continue; }
    const st = statSync(abs);
    const files = st.isDirectory() ? walkFiles(abs) : [abs];
    for (const f of files) {
      if (used >= maxLines) { truncated = true; break; }
      let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue; // 跳过二进制
      const lines = text.split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();   // 与 scanRepo 的行数口径一致
      let from = 1, to = lines.length;
      if (!st.isDirectory() && r.lineStart != null) { from = r.lineStart; to = Math.min(r.lineEnd, lines.length); }
      const take = Math.max(from, Math.min(to, from + (maxLines - used) - 1));
      const rel = st.isDirectory() ? `${r.rel}/${path.relative(abs, f).split(path.sep).join('/')}` : r.rel;
      out.push({ ref: `proj://${repoName}/${rel}`, from, to: take, lines: take - from + 1, text: lines.slice(from - 1, take).join('\n') });
      used += take - from + 1;
    }
  }
  return { content: out, used, truncated };
}

function cmdSweep(repoPath, { batch, out, node, maxLines }) {
  const repo = new Repo(repoPath);
  const idx = repo.loadIndex();
  let targets = Object.values(idx.nodes).filter(n => n.scaffold);
  if (node) targets = targets.filter(n => n.id === node || String(n.parent) === node);
  targets = targets.filter(n => !n.is_branch);
  targets.sort((a, b) => (b.depth - a.depth) || String(a.id).localeCompare(String(b.id)));
  const picked = targets.slice(0, batch);
  if (!picked.length) {
    console.log(JSON.stringify({ ok: true, tasks: 0, hint: '无未评叶子：先 ra scan 建树，或全评已完成' }, null, 2));
    return;
  }
  const tasks = picked.map(n => {
    const rd = readRefs(repoPath, n.evidence, maxLines);
    return { node: n.id, layer: n.layer, parent: n.parent, depth: n.depth, size: rd.used, truncated: rd.truncated, refs: n.evidence, content: rd.content };
  });
  const payload = {
    repo: repoPath, generated_ts: nowIso(), batch: tasks.length,
    remaining_after: Math.max(0, targets.length - tasks.length),
    how_to_write_back: '对每个 task 判断「该点在项目运作中的强度」→ 回填 MCP：note(kind="score", items=[{node, layer, parent, raw, why:"new", evidence, src_hash}])；src_hash 取本任务 refs 的 hashEvidence（或 brief/expand 返回值）。',
    tasks,
  };
  const json = JSON.stringify(payload, null, 2);
  if (out) {
    writeFileSync(path.resolve(out), json, 'utf8');
    console.log(JSON.stringify({ ok: true, tasks: tasks.length, remaining_after: payload.remaining_after, out: path.resolve(out), truncated: tasks.filter(t => t.truncated).length }, null, 2));
  } else {
    console.log(json);
  }
}

// ---------------- 小工具 ----------------
function maxDepthOf(nodes) {
  const all = Object.values(nodes || {});
  return all.length ? Math.max(...all.map(n => n.depth || 0)) : 0;
}

// 独立运行：node src/cli.mjs <cmd> --repo <根>
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/cli.mjs')) {
  await runCli(process.argv.slice(2));
}
