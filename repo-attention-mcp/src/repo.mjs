// repo.mjs — 仓库面（§4.2）：events.jsonl 是唯一真相；index.yaml 是派生缓存（删掉可完全重建）。
// 写入永远是 O(1) 追加；没有锁、没有计数器、没有心跳（§7 删除清单）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as Y from './yaml.mjs';
import * as S from './scoring.mjs';
import { nowIso, pad4 } from './util.mjs';

/** 参数：分辨率**无上限**（解除 clamp）——K 是「每点承载量上限」= 下限分辨率；展示由 page_size 兜底。 */
export const DEFAULT_PARAMS = {
  K_file: 5,            // 每点承载量上限（文件）：一个点至多 5 个文件
  K_line: 250,          // 每点承载量上限（行）：一个点至多 250 行
  sigma_band: 0.02,     // 边缘区阈值（低于此仍列出，标 edge:true）
  tau_band: 0.02,       // 边缘区阈值（同上；截断只由分页决定）
  page_size: 64,        // 单次响应的条目上限（展示兜底；唯一与上下文有关的常数）
};

export class Repo {
  constructor(projectRoot, { by = 'main' } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.root = path.join(this.projectRoot, '.repo-attention');
    this.by = by;
  }

  // ---------- 布局 ----------
  ensureLayout() {
    mkdirSync(path.join(this.root, 'tags'), { recursive: true });
    if (!existsSync(this.eventsPath())) writeFileSync(this.eventsPath(), '', 'utf8');
    if (!existsSync(this.indexPath())) this.saveIndex(this.fold());
  }
  eventsPath() { return path.join(this.root, 'events.jsonl'); }
  indexPath() { return path.join(this.root, 'index.yaml'); }
  tagPath(k) { return path.join(this.root, 'tags', `v${pad4(k)}.yaml`); }

  // ---------- 事件流（只追加）----------
  appendEvent(ev) {
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.eventsPath(), JSON.stringify(ev) + '\n', 'utf8');
    this.saveIndex(this.fold()); // 缓存刷新（非权威：删掉也能重建）
    return ev;
  }
  /** 批量追加（scan 建骨架等一次性大量写入；只刷新一次缓存）。 */
  appendEvents(evs) {
    if (!evs || !evs.length) return 0;
    mkdirSync(this.root, { recursive: true });
    appendFileSync(this.eventsPath(), evs.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    this.saveIndex(this.fold());
    return evs.length;
  }
  readEventsRaw() {
    if (!existsSync(this.eventsPath())) return { events: [], bad: [] };
    const lines = readFileSync(this.eventsPath(), 'utf8').split(/\r?\n/);
    const events = []; const bad = [];
    lines.forEach((l, i) => {
      if (!l.trim()) return;
      try { events.push(JSON.parse(l)); } catch (e) { bad.push({ line: i + 1, error: String(e.message || e) }); }
    });
    return { events, bad };
  }
  readEvents() { return this.readEventsRaw().events; }
  fold() { return S.fold(this.readEvents()); }

  /** 权威读：始终由事件流折叠；缓存缺失时顺手重建（删掉 index.yaml 也能工作）。 */
  loadIndex() {
    const idx = this.fold();
    if (!existsSync(this.indexPath())) this.saveIndex(idx);
    return idx;
  }

  // ---------- index.yaml（派生缓存）----------
  saveIndex(idx) {
    mkdirSync(path.dirname(this.indexPath()), { recursive: true });
    const tmp = this.indexPath() + '.tmp';
    writeFileSync(tmp, Y.dump(toIndexFile(idx)), 'utf8');
    renameSync(tmp, this.indexPath());
    return idx;
  }
  /** 供 audit 用：读缓存文件本身（不做折叠）。 */
  readIndexCache() {
    if (!existsSync(this.indexPath())) return null;
    try { return Y.parse(readFileSync(this.indexPath(), 'utf8')); } catch { return null; }
  }

  params() { return { ...DEFAULT_PARAMS }; }

  // ---------- 冻结快照（可选）----------
  writeTag(k, idx) {
    mkdirSync(path.join(this.root, 'tags'), { recursive: true });
    const tmp = this.tagPath(k) + '.tmp';
    writeFileSync(tmp, Y.dump({ schema: 'tag/v1', k, built_ts: nowIso(), ...toIndexFile(idx) }), 'utf8');
    renameSync(tmp, this.tagPath(k));
    return `tags/v${pad4(k)}.yaml`;
  }
  listTags() {
    const dir = path.join(this.root, 'tags');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => /^v\d+\.yaml$/.test(f)).sort();
  }
}

function toIndexFile(idx) {
  const nodes = {};
  for (const [id, n] of Object.entries(idx.nodes || {})) {
    nodes[id] = {
      id: n.id, layer: n.layer, parent: n.parent ?? null, depth: n.depth ?? 0, is_branch: !!n.is_branch,
      scaffold: !!n.scaffold, raw: n.raw,
      src_hash: n.src_hash ?? null, evidence: n.evidence || [], tags: n.tags || [],
      summary: n.summary || '', why: n.why || null, caused_by: n.caused_by ?? null,
      round: n.round ?? null, updated_ts: n.updated_ts || null,
    };
  }
  return {
    schema: 'events-index/v1',
    version: idx.version || 0,
    latest_ts: idx.latest_ts || null,
    event_count: idx.count || 0,
    counts: idx.counts || {},
    nodes,
    anchors: idx.anchors || [],
  };
}
