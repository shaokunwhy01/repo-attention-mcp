// scripts/rescore-docs.mjs — Docs 子点重打分（类别 + 章节标题 rubric）
//
// 说明：Docs 共 196 子点（按 ## 标题切分），全量逐行精读在本会话不现实。
// 此处按「文档类别基线 + 章节标题关键词」赋 raw（标题即内容单元主题，细分即由此产生）。
// cell_sim 的 92 子点已在 rescore-apply 中由真读代码赋分，本脚本只处理 Docs/*。
//
// 用法：node scripts/rescore-docs.mjs --repo <根> [--dry]

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Repo, DEFAULT_PARAMS } from '../src/repo.mjs';
import { Core } from '../src/core.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: process.cwd() },
    input: { type: 'string', default: path.join(process.cwd(), 'rescore-input.json') },
    dry: { type: 'boolean', default: false },
  },
});
const repo = new Repo(path.resolve(values.repo));
const core = new Core(repo, DEFAULT_PARAMS);
const byFile = JSON.parse(readFileSync(path.resolve(values.input), 'utf8'));

// 文档类别基线 + 章节关键词微调
function rubricRaw(rel, anchor) {
  const a = (anchor || '').toLowerCase();
  let base = 0.5;
  if (/L4-data\.md$/.test(rel)) base = 0.7;                         // 各亚体 L4 权威数据规格
  else if (/cell-sim-kinetics\.md$/.test(rel)) base = 0.8;          // 动力学理论（核心）
  else if (/coupling-design\.md$/.test(rel)) base = 0.78;          // 耦合设计（核心）
  else if (/atomic-benchmark\.md$/.test(rel)) base = 0.8;          // 原子基准表（权威）
  else if (/20-cell-core|22-body-pk|24-actor|25-dynamics|26-bridge|27-loader-registry|50-data-spec/.test(rel)) base = 0.65;
  else if (/30-web-runner/.test(rel)) base = 0.5;
  else if (/40-visualization/.test(rel)) base = 0.45;
  else if (/00-refs/.test(rel)) base = 0.2;                        // 参考文献
  else if (/10-index/.test(rel)) base = 0.2;                       // 索引
  else if (/15-todo/.test(rel)) base = 0.25;                       // 待办
  else if (/55-decision-log/.test(rel)) base = 0.35;               // 决策日志
  else if (/60-cl-0002/.test(rel)) base = 0.3;                     // 变更日志
  else if (/70-vision/.test(rel)) base = 0.3;                      // 愿景
  if (/方程|动力学|耦合|数据表|权威|架构|端口|标准|设计|计算|折叠|透射|等效|映射|取值纪律/.test(a)) base += 0.1;
  if (/待定|待后续|待你决策|开放项|敏感性|旋钮|路线图|引用索引|前言|附录|回填|下一步|gap|更新修订|文档引用/.test(a)) base -= 0.15;
  return Math.max(0.15, Math.min(0.95, Math.round(base * 100) / 100));
}

const items = [];
for (const [rel, units] of Object.entries(byFile)) {
  if (!rel.startsWith('Docs/')) continue;
  for (const u of units) {
    items.push({
      by: 'main',
      node: u.node,
      parent: u.node.split('#')[0],
      layer: 'content',
      raw: rubricRaw(rel, u.anchor),
      why: 'split',
      evidence: u.ref ? [u.ref] : u.evidence,
      src_hash: u.src_hash,
    });
  }
}
console.log(JSON.stringify({ docs_items: items.length }, null, 2));
if (values.dry) {
  let bad = 0;
  for (const it of items) { const v = core.validateScore(it); if (!v.ok) { bad++; console.log('BAD', it.node, v.reason); } }
  console.log(JSON.stringify({ valid: items.length - bad, bad }, null, 2));
  process.exit(0);
}
const res = core.note({ kind: 'score', items });
console.log(JSON.stringify(res, null, 2));
