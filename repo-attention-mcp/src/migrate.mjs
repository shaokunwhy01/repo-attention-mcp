// migrate.mjs — 老仓 → 新格式一次性迁移（§9：账不毁）
//   packages/v*.yaml  → 每个包 1 条 anchor + 每活跃节点 1 条 score（raw 取该包 sigma/tau，why:"new"）
//   ledger / backlog / workorders / checklists / assess / drift / archive / dialogs → 原样移到 legacy/
//   INDEX.yaml        → 移到 legacy/（新 index.yaml 由 events.jsonl 折叠生成）
//
// ⚠️ 历史缺口如实声明：
//   1) 老包只存归一后的 σ/τ，原始强度不可还原 —— 迁移时把归一值当 raw，并加 anchor 注明仅作对比。
//   2) decision / edit 从 v7 起才成立：老账无「人的决定原话」「谁改了什么」的结构化记录，不伪造。
import { existsSync, readFileSync, readdirSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as Y from './yaml.mjs';
import { Repo } from './repo.mjs';
import { nowIso, scanRepo } from './util.mjs';

const LEGACY_DIRS = ['packages', 'ledger', 'backlog', 'workorders', 'checklists', 'assess', 'drift', 'archive', 'dialogs'];
const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

export function migrate(repoRoot, { log = () => {} } = {}) {
  const repo = new Repo(repoRoot);
  const root = repo.root;
  const scan = scanRepo(repo.projectRoot);
  const p = repo.params();
  const resolution = { basis: `${p.K_file}文件/点 · ${p.K_line}行/点`, F: scan.F, L: scan.L };

  // ① 先读老包（在归档之前），生成事件
  const events = [];
  const pkgDir = path.join(root, 'packages');
  if (existsSync(pkgDir)) {
    for (const f of readdirSync(pkgDir).filter(x => /^v\d+\.yaml$/.test(x)).sort()) {
      const k = Number(f.slice(1, -5));
      let pkg;
      try { pkg = Y.parse(readFileSync(path.join(pkgDir, f), 'utf8')); } catch (e) { log(`跳过 ${f}：${e.message}`); continue; }
      const ts = pkg?.created_ts || nowIso();
      events.push({
        ts, by: 'migrate', kind: 'anchor',
        label: `B${pkg?.segment?.s ?? k} v${k}${pkg?.built_at?.rev ? ' @' + pkg.built_at.rev : ''}`,
        resolution, refs: [], round: k,
        note: 'v1–v6 为归一值，仅作对比，不可与 v7 之后的 raw 直接比较',
      });
      for (const m of pkg?.corpora?.code?.modules || []) {
        const refs = m.evidence?.refs || (m.ref ? [m.ref] : []);
        events.push(scoreEvent(ts, m.id, 'module', null, num(m.sigma), refs, m.evidence?.src_hash, m.summary, k));
        for (const c of m.contents || []) {
          if (c.status && c.status !== 'active') continue;
          events.push(scoreEvent(ts, c.id, 'content', m.id, num(c.tau), c.evidence?.refs || [], c.evidence?.src_hash, c.summary, k));
        }
      }
      // 老 claims（对话语料）在 v2 已无对应层：挂到一个合成的分支节点下，避免污染根层 σ 榜
      const claims = (pkg?.corpora?.dialogue?.sessions || [])
        .flatMap(s => (s.claims || []).filter(c => !c.status || c.status === 'active').map(c => ({ c, s })));
      if (claims.length) {
        const CLAIM_BRANCH = 'legacy/claims';
        events.push(scoreEvent(ts, CLAIM_BRANCH, 'module', null, 0, [], null, '历史 claims（v1 对话语料，仅作对比）', k));
        for (const { c } of claims)
          events.push(scoreEvent(ts, c.id, 'content', CLAIM_BRANCH, num(c.score?.tau), c.code_refs || [], c.src_hash_at_claim, c.assert, k));
      }
    }
  }

  // ② 归档老产物（在新建布局之前，避免 INDEX.yaml 与 index.yaml 在大小写不敏感文件系统上冲突）
  const moved = [];
  for (const d of LEGACY_DIRS) {
    const src = path.join(root, d);
    if (!existsSync(src)) continue;
    const dst = path.join(root, 'legacy', d);
    mkdirSync(path.dirname(dst), { recursive: true });
    try { renameSync(src, dst); moved.push(d); } catch (e) { log(`移动 ${d} 失败：${e.message}`); }
  }
  for (const idxName of ['INDEX.yaml', 'INDEX.yml']) {
    const src = path.join(root, idxName);
    if (!existsSync(src)) continue;
    const dst = path.join(root, 'legacy', idxName);
    mkdirSync(path.dirname(dst), { recursive: true });
    try { renameSync(src, dst); moved.push(idxName); } catch { /* ignore */ }
  }

  // ③ 新布局 + 写事件（已有事件则不重复写）
  repo.ensureLayout();
  const existing = repo.readEvents();
  if (existing.length) log(`events.jsonl 已有 ${existing.length} 条事件：迁移只做归档，不重复写入事件`);
  else if (events.length) {
    writeFileSync(repo.eventsPath(), events.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    log(`写入 ${events.length} 条事件（含 ${events.filter(e => e.kind === 'anchor').length} 条 anchor）`);
  } else log('未找到 packages/*.yaml：无可迁移的历史打分');

  const idx = repo.fold();
  repo.saveIndex(idx);
  mkdirSync(path.join(root, 'legacy'), { recursive: true });
  writeFileSync(path.join(root, 'legacy', 'MIGRATION.txt'),
    `迁移于 ${nowIso()}\n事件数：${idx.count}\n节点数：${Object.keys(idx.nodes).length}\n已归档：${moved.join(', ') || '（无）'}\n`
    + 'decision / edit 从 v7 起才成立：老账无结构化记录，不伪造。\n', 'utf8');

  log(`迁移完成：events=${idx.count}，nodes=${Object.keys(idx.nodes).length}，version=${idx.version}，legacy=[${moved.join(', ')}]`);
  return { ok: true, events: idx.count, nodes: Object.keys(idx.nodes).length, version: idx.version, legacy: moved };
}

function scoreEvent(ts, node, layer, parent, raw, evidence, src_hash, summary, round) {
  const ev = {
    ts, by: 'migrate', kind: 'score', round,
    node, layer, parent: parent ?? null,
    raw, why: 'new', evidence: evidence || [], src_hash: src_hash || null,
  };
  if (summary) ev.summary = summary;
  return ev;
}
