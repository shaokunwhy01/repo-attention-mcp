// scripts/level1-skeleton.mjs — 级 1 零代码演练的最小文件集（REFACTOR-v1 新布局）
// 用法: node scripts/level1-skeleton.mjs --repo <演练项目根>
// 落盘：events.jsonl（空）+ index.yaml（空派生缓存）+ tags/ + AGENTS.md 读规则。
// 空文件即空账；第一次 note(kind="score") 就是这条账的开始。
import { mkdirSync, writeFileSync, existsSync, copyFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __ = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const repo = path.resolve(get('repo', process.cwd()));
const root = path.join(repo, '.repo-attention');

mkdirSync(path.join(root, 'tags'), { recursive: true });
mkdirSync(path.join(root, 'legacy'), { recursive: true });
writeFileSyncIfAbsent(path.join(root, 'events.jsonl'), '');
writeFileSyncIfAbsent(path.join(root, 'index.yaml'), [
  'schema: events-index/v1',
  'version: 0',
  'latest_ts: ~',
  'event_count: 0',
  'counts: {score: 0, decision: 0, edit: 0, anchor: 0}',
  'nodes: {}',
  'anchors: []',
  '',
].join('\n'));
writeFileSyncIfAbsent(path.join(root, 'README.txt'),
  'events.jsonl = 唯一真相（只追加，永不修改）；index.yaml = 派生缓存（删掉可完全重建）。\n'
  + '四类事件：score（独立强度）/ decision（对话者的决定关键）/ edit（项目修改者的操作情况）/ anchor（一段的起点）。\n');

const agSrc = path.join(__, '..', 'AGENTS.md');
if (existsSync(agSrc) && !existsSync(path.join(repo, 'AGENTS.md'))) copyFileSync(agSrc, path.join(repo, 'AGENTS.md'));

const gi = path.join(repo, '.gitignore');
const cur = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
if (!cur.includes('.repo-attention')) writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.repo-attention/\n', 'utf8');

console.log(`级1 演练文件集已就绪: ${root}
下一步：初次打分建首段 —— 用 note(kind="score") 写入模块/内容的独立强度，然后 anchor(label="B₀ …")。`);

function writeFileSyncIfAbsent(f, content) {
  if (existsSync(f)) return;
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content, 'utf8');
}
