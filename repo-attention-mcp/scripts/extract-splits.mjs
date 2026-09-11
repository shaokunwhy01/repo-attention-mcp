// scripts/extract-splits.mjs — 从事件流抽出某轮的 split 子点（供重打分/复查用）
//
// 用法：node scripts/extract-splits.mjs --repo <根> [--round 10] [--out rescore-input.json]
// 输出：按文件分组的子点 { node, ref, src_hash, current_raw, start, end, anchor }

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Repo } from '../src/repo.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: process.cwd() },
    round: { type: 'string', default: '10' },
    out: { type: 'string', default: path.join(process.cwd(), 'rescore-input.json') },
  },
});
const repo = new Repo(path.resolve(values.repo));
const { events } = repo.readEventsRaw();
const splits = events.filter((e) => e.kind === 'score' && e.why === 'split' && e.round === Number(values.round));
const byFile = {};
for (const e of splits) {
  const ref = (e.evidence && e.evidence[0]) || '';
  const m = /^proj:\/\/[^/]+\/(.+?)(?::(\d+)-(\d+))?(?:#(.+))?$/.exec(ref);
  const rel = m ? m[1] : ref;
  const unit = {
    node: e.node,
    ref,
    src_hash: e.src_hash,
    current_raw: e.raw,
    start: m && m[2] ? Number(m[2]) : null,
    end: m && m[3] ? Number(m[3]) : null,
    anchor: m && m[4] ? m[4] : null,
  };
  (byFile[rel] = byFile[rel] || []).push(unit);
}
writeFileSync(path.resolve(values.out), JSON.stringify(byFile, null, 2));
const summary = Object.entries(byFile)
  .map(([f, us]) => ({ file: f, n: us.length }))
  .sort((a, b) => a.file.localeCompare(b.file));
console.log(JSON.stringify({ total: splits.length, files: summary }, null, 2));
