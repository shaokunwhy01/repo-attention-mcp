// scripts/rescore-apply.mjs — 用重读后的 raw 更新 split 子点（规则侧重打分）
//
// 输入：
//   rescore-input.json  —— extract-splits.mjs 产出（每子点 node/ref/src_hash）
//   rescore-scores.json —— { "<node id>": <新 raw>, ... }（操作员重读后给的分）
// 行为：对 scores 里列出的节点，构造 note(kind="score", why:"split") 更新 raw
//       （evidence/src_hash 沿用，内容未变 → 过 validateScore）；不在 scores 的节点不动。
//
// 用法：node scripts/rescore-apply.mjs --repo <根> [--dry]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Repo, DEFAULT_PARAMS } from '../src/repo.mjs';
import { Core } from '../src/core.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: process.cwd() },
    input: { type: 'string', default: path.join(process.cwd(), 'rescore-input.json') },
    scores: { type: 'string', default: path.join(process.cwd(), 'rescore-scores.json') },
    dry: { type: 'boolean', default: false },
  },
});
const repo = new Repo(path.resolve(values.repo));
const core = new Core(repo, DEFAULT_PARAMS);
const byFile = JSON.parse(readFileSync(path.resolve(values.input), 'utf8'));
const scores = JSON.parse(readFileSync(path.resolve(values.scores), 'utf8'));

const items = [];
const seen = new Set();
for (const units of Object.values(byFile)) {
  for (const u of units) {
    if (scores[u.node] === undefined || seen.has(u.node)) continue;
    seen.add(u.node);
    items.push({
      by: 'main',
      node: u.node,
      parent: u.node.split('#')[0],
      layer: 'content',
      raw: Number(scores[u.node]),
      why: 'split',
      evidence: u.ref ? [u.ref] : u.evidence,
      src_hash: u.src_hash,
    });
  }
}
console.log(JSON.stringify({ score_entries: Object.keys(scores).length, items: items.length }, null, 2));

if (values.dry) {
  let bad = 0;
  for (const it of items) { const v = core.validateScore(it); if (!v.ok) { bad++; console.log('BAD', it.node, v.reason); } }
  console.log(JSON.stringify({ dry: true, valid: items.length - bad, bad }, null, 2));
  process.exit(0);
}
const res = core.note({ kind: 'score', items });
console.log(JSON.stringify(res, null, 2));
