// scripts/level1-skeleton.mjs — 级 1 零代码演练的最小文件集（§12 级1 / 文档收尾建议）
// 用法: node scripts/level1-skeleton.mjs --repo <演练项目根>
// 落盘：INDEX + 三条空流 + dialogs 行格式模板（链哈希从第一天就写，人肉演练时它就是几行 JSONL）
//      + AGENTS.md 读规则（从本仓库模板复制）。空文件即空包；B₀ 打分是第一个写进 packages/v0001.yaml 的东西。
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __ = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const get = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const repo = path.resolve(get('repo', process.cwd()));

for (const d of ['packages', 'drift/reports', 'dialogs', 'backlog', 'checklists', 'workorders/open', 'workorders/closed', 'archive/nodes', 'ledger', 'assess'])
  mkdirSync(path.join(repo, '.repo-attention', ...d.split('/')), { recursive: true });

const idx = `.repo-attention/INDEX.yaml — 唯一可变点（手改=模拟 rename 原子换）
` + [
  'schema: index/v1', 'latest: 0', 'segment: 0', 'anchor: ~',
  'counters:', '  dialogs_total: 0', '  dialogs_since_eval: 0', '  dialogs_since_open: 0', '  seq: 0',
  'writer_lock: ~   # 级1不强制；默契：同时只开一个碰仓窗口',
  'params_overrides: {A: 12}   # §7 参数生效值',
  'episode: ~', 'close_pending: ~', 'assess_open: ~', 'flux: []',
  '',
].join('\n');
writeFileSyncIfAbsent(path.join(repo, '.repo-attention/INDEX.yaml'), idx);

writeFileSyncIfAbsent(path.join(repo, '.repo-attention/backlog/entries.jsonl'), '# append-only 声称队列；publish 标 consumed_at 不删行\n');
writeFileSyncIfAbsent(path.join(repo, '.repo-attention/drift/points.jsonl'), '# append-only 每次评估一行 {r,d,t,g,ep}\n');
writeFileSyncIfAbsent(path.join(repo, '.repo-attention/ledger/r0000.jsonl'), '# append-only 算子账本 {seq,ts,who,tool,args_digest,quote?,result}\n');

const dialogTpl = [
  '# dialogs/sess-NNN.jsonl 行格式（会话中增量追加；行级 digest 链从第一天就写）：',
  '# 每行 JSON: {"ts":"…","role":"user|assistant","text":"…","sess":"NNN","seq":N,"prev_hash":"上一行JSON的sha256，首行 sha256:GENESIS"}',
  '# 关闭时追加: {"kind":"seal","ts":"…","sess":"NNN","seq":N+1,"prev_hash":"链头","head":"链头"}',
  '# 再写 sess-NNN.jsonl.sha256 文件（内容级 sha256，一行即可）',
  '',
].join('\n');
writeFileSyncIfAbsent(path.join(repo, '.repo-attention/dialogs/README.txt'), dialogTpl);

const agSrc = path.join(__, '..', 'AGENTS.md');
if (existsSync(agSrc) && !existsSync(path.join(repo, 'AGENTS.md'))) copyFileSync(agSrc, path.join(repo, 'AGENTS.md'));

const gi = path.join(repo, '.gitignore');
const cur = existsSync(gi) ? (await import('node:fs')).readFileSync(gi, 'utf8') : '';
if (!cur.includes('.repo-attention')) writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.repo-attention/\n', 'utf8');

console.log(`级1 演练文件集已就绪: ${path.join(repo, '.repo-attention')}
下一步：全量打分建 B₀ —— 手写第一个 packages/v0001.yaml（combo/v1，§3.1 格式），INDEX.latest 改 1。`);

function writeFileSyncIfAbsent(f, content) {
  if (existsSync(f)) return;
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, content, 'utf8');
}
