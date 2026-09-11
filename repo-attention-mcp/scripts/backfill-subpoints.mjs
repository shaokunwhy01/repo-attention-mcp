// scripts/backfill-subpoints.mjs — Phase 2：按 subdivision-plan.json 批量回填子点
//
// 忠实复刻操作员手敲的 note(kind="score", why:"split")：直接走服务器的 Core.note
// （含 validateScore 校验 + 单轮批量追加），不重启、不碰 MCP 传输。
//
// 用法：
//   node scripts/backfill-subpoints.mjs --repo <根> --plan subdivision-plan.json [--dry]
//
// 每个子点：node=<leaf>#<锚>, parent=<leaf>, layer:"content", why:"split",
//           raw=<default_raw>, evidence=[ref], src_hash=<plan.src_hash>。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Repo, DEFAULT_PARAMS } from '../src/repo.mjs';
import { Core } from '../src/core.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: process.cwd() },
    plan: { type: 'string', default: path.join(process.cwd(), 'subdivision-plan.json') },
    dry: { type: 'boolean', default: false },
  },
});
const repoPath = path.resolve(values.repo);
const repo = new Repo(repoPath);
const core = new Core(repo, DEFAULT_PARAMS);

const plan = JSON.parse(readFileSync(path.resolve(values.plan), 'utf8'));
const items = [];
for (const leaf of plan.leaves) {
  for (const r of leaf.ranges) {
    items.push({
      by: 'main',
      node: r.id,
      parent: leaf.leaf_id,
      layer: 'content',
      raw: r.default_raw,
      why: 'split',
      evidence: [r.ref],
      src_hash: r.src_hash,
    });
  }
}

console.log(JSON.stringify({ plan_leaves: plan.leaves.length, total_items: items.length, dry: !!values.dry }, null, 2));

if (values.dry) {
  let okN = 0; const bad = [];
  for (const it of items) { const v = core.validateScore(it); if (v.ok) okN++; else bad.push({ node: it.node, reason: v.reason }); }
  console.log(JSON.stringify({ valid: okN, invalid: bad.length, first_bad: bad.slice(0, 5) }, null, 2));
  process.exit(0);
}

const res = core.note({ kind: 'score', items });
console.log(JSON.stringify(res, null, 2));
