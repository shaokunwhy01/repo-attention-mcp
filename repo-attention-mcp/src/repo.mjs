// repo.mjs — 仓库面（§11）：布局、INDEX 唯一可变点（P1）、账本（I9）、writer 锁（R1 裁决③）
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, appendFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as Y from './yaml.mjs';
import { nowIso, pad4, argsDigest } from './util.mjs';

export const DEFAULT_PARAMS = {
  N: 5,               // T2 兜底间隔（对话数），清单开放期豁免（I3）
  M: 10,              // 漂移总结间隔（评估轮）
  G_max: 10,          // 清单软提醒线（只提醒不触发）
  tau_band: [3, 30],  // 每模块 τ 单元带
  claim_band: [3, 30],// 每会话 claim 带
  N_cap: 500,         // 代码语料总单元预算
  claim_cap: 400,     // 对话语料独立预算
  co_move_corr: 0.9,  // 共移判定
  theta_edge: 0.01,   // 边缘分数区（§2.6）
  edge_rank_L: 3,
  A: 12,              // 归档周期 clamp[6,24]，报表占用率动态校准
  A_min: 6, A_max: 24, A_hi: 8, A_lo: 16,
  budget: { overview_tokens: 600, expand_tokens: 6000, brief_tokens: 900, session_board_tokens: 300 },
  trend_ratio: 2, pulse_thresh: 0.15, flip_thresh: 3, net_drift_thresh: 0.05,
  decisive_promotion: 'auto_on_promote', // 裁决②：晋升 canon 的 claim 自动继承 decisive
  promote_requires_human: false,         // 裁决③：晋升去人工门
  close_ignores_pending_wo: true,        // 裁决①：收口不因待裁工单被阻塞
  flux_void_threshold: 0.5,              // flux 面积超半 → 整包直读模式
  heartbeat_timeout_ms: 5 * 60 * 1000,
};

export class Repo {
  constructor(projectRoot, { role = 'writer', sessionId = 'sess-' + Date.now() } = {}) {
    this.projectRoot = path.resolve(projectRoot);
    this.root = path.join(this.projectRoot, '.repo-attention');
    this.role = role; this.sessionId = sessionId;
    this._pin = null; this._pinLoaded = false;
    this._seq = null;
  }

  // ---------- 布局 ----------
  ensureLayout() {
    for (const d of ['packages', 'drift/reports', 'dialogs', 'backlog', 'checklists', 'workorders/open', 'workorders/closed', 'archive/nodes', 'ledger', 'assess']) {
      mkdirSync(path.join(this.root, ...d.split('/')), { recursive: true });
    }
    if (!existsSync(this.indexPath())) {
      this.saveIndexRaw({
        schema: 'index/v1', latest: 0, segment: 0, anchor: null,
        counters: { dialogs_total: 0, dialogs_since_eval: 0, dialogs_since_open: 0, seq: 0, points: 0 },
        writer_lock: null,
        params_overrides: {},
        episode: null, close_pending: null, assess_open: null,
        created_ts: nowIso(),
      });
    }
  }
  indexPath() { return path.join(this.root, 'INDEX.yaml'); }

  // ---------- P1 唯一可变点：写新 + rename 原子换 ----------
  saveIndexRaw(idx) {
    idx.updated_ts = nowIso();
    const tmp = this.indexPath() + '.tmp';
    writeFileSync(tmp, Y.dump(idx), 'utf8');
    renameSync(tmp, this.indexPath());
    this._idxCache = idx;
    return idx;
  }
  loadIndex() {
    if (!existsSync(this.indexPath())) this.ensureLayout();
    return Y.parse(readFileSync(this.indexPath(), 'utf8'));
  }
  updateIndex(fn) {
    const idx = this.loadIndex();
    const r = fn(idx);
    this.saveIndexRaw(r ?? idx);
    return idx;
  }

  params() {
    const idx = this.loadIndex();
    return { ...DEFAULT_PARAMS, ...(idx.params_overrides || {}) };
  }

  // ---------- writer 锁（R1 裁决③） ----------
  acquireOrRenewLock() {
    const idx = this.loadIndex();
    const lk = idx.writer_lock;
    if (lk && lk.session_id !== this.sessionId) {
      const age = Date.now() - Date.parse(lk.ts || 0);
      const staleByHeartbeat = age >= this.params().heartbeat_timeout_ms;
      const holderDead = lk.pid && !pidAlive(lk.pid);
      if (lk.role === 'writer' && !staleByHeartbeat && !holderDead) {
        return { ok: false, reason: `该仓已有写会话（pid=${lk.pid} session=${lk.session_id}，心跳 ${Math.round(age / 1000)}s 前，进程存活）` };
      }
      this.auditLockTakeover({ ...lk, why: holderDead ? 'pid 已死' : '心跳超时' });
    }
    this.updateIndex(i => { i.writer_lock = { pid: process.pid, session_id: this.sessionId, role: 'writer', ts: nowIso() }; });
    return { ok: true, session_id: this.sessionId };
  }
  heartbeat() { this.updateIndex(i => { if (i.writer_lock && i.writer_lock.session_id === this.sessionId) i.writer_lock.ts = nowIso(); }); }
  releaseLock() { this.updateIndex(i => { if (i.writer_lock?.session_id === this.sessionId) i.writer_lock = null; }); }
  auditLockTakeover(old) {
    this.ledgerAppend({ tool: 'system:lock_takeover', action: 'lock_takeover', target: old.session_id, result: 'ok', msg: `接管失效锁 pid=${old.pid}（${old.why || '失效'}）` });
  }

  // ---------- 包（不可变快照） ----------
  pkgPath(k) { return path.join(this.root, 'packages', `v${pad4(k)}.yaml`); }
  pkgExists(k) { return existsSync(this.pkgPath(k)); }
  readPackage(k) {
    if (k === 0) return emptyPackage();
    if (!existsSync(this.pkgPath(k))) throw new Error(`package v${pad4(k)} 不存在`);
    return Y.parse(readFileSync(this.pkgPath(k), 'utf8'));
  }
  writePackage(k, pkg) {
    const f = this.pkgPath(k);
    if (existsSync(f)) throw new Error(`v${pad4(k)} 已存在——packages 不可变（P2）`);
    const tmp = f + '.tmp';
    writeFileSync(tmp, Y.dump(pkg), 'utf8');
    renameSync(tmp, f);
  }
  // 会话钉版（规则1）：首次读自动 pin latest，进程全程不换；ro 不参与钉版（只有快照时刻）
  pinned() {
    if (this.role === 'ro') return { k: this.loadIndex().latest, mode: 'snapshot' };
    if (!this._pinLoaded) {
      const idx = this.loadIndex();
      this._pin = idx.latest; this._pinLoaded = true;
    }
    return { k: this._pin, mode: 'pinned' };
  }
  latest() { return this.loadIndex().latest; }

  // ---------- 流水（append-only） ----------
  appendJsonl(rel, obj) {
    const f = path.join(this.root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify(obj) + '\n', 'utf8');
    return f;
  }
  readJsonl(rel) {
    const f = path.join(this.root, rel);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  }

  // ---------- 账本（I9：每次调用一行） ----------
  nextSeq() {
    if (this._seq == null) this._seq = (this.loadIndex().counters?.seq || 0);
    return ++this._seq;
  }
  ledgerAppend(row) {
    if (this.role === 'ro') return 0; // ro 无状态读：不落账不写盘（R1 裁决③；写账归 writer）
    const idx = this.loadIndex();
    const seg = idx.segment || 0;
    const seq = (idx.counters?.seq || 0) + 1;
    this.updateIndex(i => { i.counters = i.counters || {}; i.counters.seq = seq; });
    const full = { seq, ts: nowIso(), session_id: this.sessionId, role: this.role, ...row };
    if (full.args && !full.args_digest) full.args_digest = argsDigest(full.args);
    delete full.args_raw;
    this.appendJsonl(`ledger/r${pad4(seg)}.jsonl`, full);
    return seq;
  }
  ledgerRowsAll() {
    const dir = path.join(this.root, 'ledger');
    if (!existsSync(dir)) return [];
    const out = [];
    for (const f of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort())
      for (const l of readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/).filter(x => x.trim()))
        try { out.push(JSON.parse(l)); } catch { /* tolerate */ }
    return out;
  }

  // ---------- 通用小文件 ----------
  readYaml(rel) {
    const f = path.join(this.root, rel);
    return existsSync(f) ? Y.parse(readFileSync(f, 'utf8')) : null;
  }
  writeYamlAtomic(rel, obj) {
    const f = path.join(this.root, rel);
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, Y.dump(obj), 'utf8');
    renameSync(tmp, f);
  }
  listYaml(dirRel, pattern) {
    const dir = path.join(this.root, dirRel);
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(f => pattern.test(f)).sort().map(f => ({ name: f, data: Y.parse(readFileSync(path.join(dir, f), 'utf8')) }));
  }

  // backlog / points 访问
  backlogOpen() { return this.readJsonl('backlog/entries.jsonl').filter(e => !e.consumed_at); }
  backlogAll() { return this.readJsonl('backlog/entries.jsonl'); }
  markBacklog(ids, atRound) {
    const all = this.readJsonl('backlog/entries.jsonl');
    const set = new Set(ids);
    for (const e of all) if (set.has(e.id) && !e.consumed_at) e.consumed_at = { round: atRound, ts: nowIso() };
    const tmp = path.join(this.root, 'backlog/entries.jsonl.tmp');
    writeFileSync(tmp, all.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    renameSync(tmp, path.join(this.root, 'backlog/entries.jsonl'));
  }
  driftPoints() { return this.readJsonl('drift/points.jsonl'); }

  // ---------- 对话计数（T2 节拍 = 会话数） ----------
  registerDialogClosed() {
    this.updateIndex(i => {
      i.counters = i.counters || { dialogs_total: 0, dialogs_since_eval: 0, dialogs_since_open: 0 };
      i.counters.dialogs_total = (i.counters.dialogs_total || 0) + 1;
      i.counters.dialogs_since_eval = (i.counters.dialogs_since_eval || 0) + 1;
      if (i.episode) i.counters.dialogs_since_open = (i.counters.dialogs_since_open || 0) + 1;
    });
    return this.loadIndex().counters;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function emptyPackage() {
  return {
    package: 'combo/v1',
    version: { k: 0, parent: null },
    trigger: 'init', episode: null,
    segment: { s: 0, anchor: null },
    built_at: { rev: null, session_count: 0, gap_from_prev: 0 },
    resolution: { tier_by_module: {}, n_units: 0, cap: 500 },
    flux: [],
    budget: { overview_tokens: 600, expand_tokens: 6000, overflow: 'degrade_to_ref' },
    corpora: {
      code: { modules: [] },
      dialogue: { resolution: { tier: 'claim', n_claims: 0, claim_cap: 400, archive_cycle_A: 12 }, sessions: [] },
    },
    edge_state: {}, archived: {},
    created_ts: null,
  };
}
