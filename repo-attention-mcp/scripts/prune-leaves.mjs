// scripts/prune-leaves.mjs — 从事件流清出指定节点（含其所有 score/edit 事件），并刷新 index 缓存
//
// 用法：
//   node scripts/prune-leaves.mjs --repo <根> [--dry]
//
// 排除口径（与 subdivide-plan.mjs 一致）：node id 含 __pycache__ 段，或 == .codebuddy/rules / 以其开头。
// 会连带删除这些节点的全部事件（score scaffold + 真评分 + edit），并删除 parent 指向它们的孤儿事件。
// 删除前先把 events.jsonl 备份为 events.jsonl.bak.<ts>。

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Repo } from '../src/repo.mjs';

const { values } = parseArgs({
  options: { repo: { type: 'string', default: process.cwd() }, dry: { type: 'boolean', default: false } },
});
const repoPath = path.resolve(values.repo);
const repo = new Repo(repoPath);

const isExcluded = (id) => {
  if (!id) return false;
  const segs = id.split('/');
  return segs.includes('__pycache__') || id === '.codebuddy/rules' || id.startsWith('.codebuddy/rules/');
};

const { events } = repo.readEventsRaw();
const nodeIds = [...new Set(events.map((e) => e.node).filter(Boolean))];
const removeIds = new Set(nodeIds.filter(isExcluded));

// 也要删 parent 指向被删节点的孤儿事件
const removed = events.filter((e) => removeIds.has(e.node) || (e.parent && removeIds.has(e.parent)));
const kept = events.filter((e) => !(removeIds.has(e.node) || (e.parent && removeIds.has(e.parent))));

const byNode = {};
for (const e of removed) byNode[e.node] = (byNode[e.node] || 0) + 1;

console.log(JSON.stringify({
  dry: !!values.dry,
  repo: repoPath,
  remove_node_count: removeIds.size,
  remove_nodes: [...removeIds].sort(),
  remove_event_count: removed.length,
  by_node: byNode,
  keep_event_count: kept.length,
}, null, 2));

if (values.dry) {
  console.log('[dry-run] 未改动 events.jsonl。去掉 --dry 才真正删除。');
  process.exit(0);
}

// 备份
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const bak = repo.eventsPath() + '.bak.' + ts;
copyFileSync(repo.eventsPath(), bak);

// 写回（只保留有效事件；空行忽略）
writeFileSync(repo.eventsPath(), kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''), 'utf8');

// 刷新派生缓存（loadIndex 本就每次 fold 重算；此处仅保持 index.yaml 一致）
repo.saveIndex(repo.fold());

console.log(JSON.stringify({ ok: true, backup: bak, removed_events: removed.length, kept_events: kept.length }, null, 2));
