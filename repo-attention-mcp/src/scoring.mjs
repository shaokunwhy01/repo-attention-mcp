// scoring.mjs — 确定性打分机制：归一（§2.2）、脏扫描（I3）、边缘区与双轨（§2.6）、漂移三分类（§4.5）
// 注意：判断与打分由消费端 agent 提交；这里只有算术。Server 从不调用模型。
import { hashEvidence } from './util.mjs';

export function activeModules(pkg) { return (pkg.corpora?.code?.modules || []).filter(m => !m.status || m.status === 'active'); }
export function allModules(pkg) { return pkg.corpora?.code?.modules || []; }
export function activeContents(pkg) { return activeModules(pkg).flatMap(m => (m.contents || []).filter(c => !c.status || c.status === 'active')); }
export function allContents(pkg) { return allModules(pkg).flatMap(m => (m.contents || []).map(c => ({ ...c, module_id: m.id })) || []); }
export function activeSessions(pkg) { return (pkg.corpora?.dialogue?.sessions || []).filter(s => !s.status || s.status === 'active'); }
export function activeClaims(pkg) { return (pkg.corpora?.dialogue?.sessions || []).flatMap(s => (s.claims || []).filter(c => !c.status || c.status === 'active').map(c => ({ ...c, sess_id: s.id }))); }
export function allClaimsList(pkg) { return (pkg.corpora?.dialogue?.sessions || []).flatMap(s => (s.claims || []).map(c => ({ ...c, sess_id: s.id }))); }

export function findNode(pkg, id) {
  for (const m of allModules(pkg)) {
    if (m.id === id) return { kind: 'module', node: m };
    for (const c of m.contents || []) if (c.id === id) return { kind: 'content', node: c, parent: m };
  }
  for (const s of pkg.corpora?.dialogue?.sessions || []) {
    if (s.id === id) return { kind: 'session', node: s };
    for (const c of s.claims || []) if (c.id === id) return { kind: 'claim', node: c, parent: s };
  }
  const a = (pkg.archived || {})[id];
  if (a) return { kind: 'archived', node: a };
  return null;
}

// ---------- 归一（§2.2）：同段 Σσ=1；同模块 Στ=1；claims 按会话 Σ=1 ----------
function getv(x, key) {
  if (typeof key === 'string') return x[key];
  let c = x; for (const k of key.path) { c = c?.[k]; if (c == null) return undefined; } return c;
}
function setv(x, key, v) {
  if (typeof key === 'string') { x[key] = v; return; }
  let c = x; for (const k of key.path.slice(0, -1)) c = c[k]; c[key.path.at(-1)] = v;
}
export function normalizePool(items, key = 'sigma') {
  const active = items.filter(x => x && (!x.status || x.status === 'active'));
  const sum = active.reduce((a, x) => a + (Number(getv(x, key)) || 0), 0);
  if (sum <= 0) {
    if (active.length) active.forEach(x => { setv(x, key, +(1 / active.length).toFixed(6)); });
    return;
  }
  active.forEach(x => { setv(x, key, +((Number(getv(x, key)) || 0) / sum).toFixed(6)); });
}

export function normalizePkg(pkg) {
  const mods = (pkg.corpora?.code?.modules || []).filter(m => !m.status || m.status === 'active');
  normalizePool(mods, 'sigma');
  for (const m of mods) normalizePool((m.contents || []).filter(c => !c.status || c.status === 'active'), 'tau');
  for (const s of (pkg.corpora?.dialogue?.sessions || []).filter(x => x.status !== 'archived'))
    normalizePool((s.claims || []).filter(c => !c.status || c.status === 'active'), { path: ['score', 'tau'] });
  // sess_sigma 归一
  normalizePool((pkg.corpora?.dialogue?.sessions || []).filter(x => x.status !== 'archived'), 'sess_sigma');
  // 全 claim 归档 → sess 退出序列（§2.5）
  for (const s of pkg.corpora?.dialogue?.sessions || []) {
    const act = (s.claims || []).filter(c => !c.status || c.status === 'active');
    if (s.closed && act.length === 0 && (s.claims || []).length > 0) s.status = 'archived';
  }
}

// ---------- 脏扫描（I3：静默过期在机械上不可能） ----------
export function scanDirty(repoRoot, pkg) {
  const dirty = []; let checked = 0;
  const one = (nodeId, refs, stored) => {
    if (!refs || !refs.length) return false;
    const h = hashEvidence(repoRoot, refs.map(stripRev));
    if (h.bad) return false;
    checked++;
    if (h.src_hash !== stored) { dirty.push({ node: nodeId, old: stored || null, next: h.src_hash, missing: !!h.anyMissing }); return true; }
    return false;
  };
  for (const m of activeModules(pkg)) {
    let childDirty = null;
    for (const c of (m.contents || [])) {
      if (c.status && c.status !== 'active') continue;
      if (one(c.id, c.evidence?.refs, c.evidence?.src_hash) && !dirty.some(d => d.node === m.id)) childDirty = c.id;
    }
    const md = one(m.id, m.evidence?.refs, m.evidence?.src_hash);
    if (!md && childDirty) dirty.push({ node: m.id, old: m.evidence?.src_hash || null, next: 'child-dirty', child: childDirty });
  }
  for (const c of activeClaims(pkg)) {
    const refs = (c.code_refs || []).map(stripRev);
    if (!refs.length) continue;
    const h = hashEvidence(repoRoot, refs);
    checked++;
    if (h.src_hash && c.src_hash_at_claim && h.src_hash !== c.src_hash_at_claim)
      dirty.push({ node: c.id, old: c.src_hash_at_claim, next: h.src_hash, kind: 'claim-stale', missing: !!h.anyMissing });
  }
  return { dirty, checked };
}
export const stripRev = (r) => r.replace(/@[0-9a-f]{4,}$/, '');

// ---------- 边缘分数区（§2.6，机械全自动入区） ----------
export function edgeSweep(pkg, params) {
  pkg.edge_state = pkg.edge_state || {};
  const pools = [];
  pools.push(activeModules(pkg).map(m => ({ id: m.id, v: m.sigma })));
  pools.push(activeContents(pkg).map(c => ({ id: c.id, v: c.tau })));
  pools.push(activeClaims(pkg).map(c => ({ id: c.id, v: c.score?.tau })));
  for (const pool of pools) {
    const below = pool.filter(x => (x.v ?? 1) < params.theta_edge).sort((a, b) => (a.v ?? 0) - (b.v ?? 0));
    const cand = new Set(below.slice(0, params.edge_rank_L).map(x => x.id));
    for (const x of pool) {
      const st = pkg.edge_state[x.id];
      if (cand.has(x.id)) {
        if (!st) pkg.edge_state[x.id] = { n: 1, A: params.A };
        else { st.n += 1; st.A = params.A; }
      } else if (st) {
        delete pkg.edge_state[x.id]; // 撤标归零
      }
    }
  }
  // 清理已退出节点的 edge_state
  for (const id of Object.keys(pkg.edge_state)) if (!cand0(pkg, id)) delete pkg.edge_state[id];
  // 归档候选：连续 n ≥ A
  const archiveCands = Object.entries(pkg.edge_state).filter(([, s]) => s.n >= s.A).map(([id]) => id);
  return { archiveCands };
}
function cand0(pkg, id) {
  if (findNode(pkg, id)) { const f = findNode(pkg, id); return f.kind !== 'archived'; }
  return false;
}

// ---------- 动态 A 校准（§7：预算占用率闭环） ----------
export function calibrateA(pkg, params) {
  const claimLoad = activeClaims(pkg).length / params.claim_cap;
  const unitLoad = (activeContents(pkg).length + activeModules(pkg).length) / params.N_cap;
  let A = params.A;
  if (claimLoad > 0.8 || unitLoad > 0.8) A = Math.max(params.A_min, params.A_hi);
  else if (claimLoad < 0.4 && unitLoad < 0.4) A = Math.min(params.A_max, params.A_lo);
  return Math.min(params.A_max, Math.max(params.A_min, A));
}

// ---------- 漂移量 d（相对段锚 B_s） ----------
export function driftDistance(pkg, anchorPkg) {
  if (!anchorPkg) return 0;
  let d = 0;
  const curVal = (id) => { const f = findNode(pkg, id); if (!f || f.kind === 'archived') return 0; const n = f.node; return (n.sigma ?? n.tau ?? n.sess_sigma ?? n.score?.tau ?? 0); };
  for (const m of allModules(anchorPkg)) {
    d += Math.abs(curVal(m.id) - (m.sigma || 0));
    for (const c of m.contents || []) d += Math.abs(curVal(c.id) - (c.tau || 0));
  }
  for (const s of anchorPkg.corpora?.dialogue?.sessions || [])
    for (const c of s.claims || []) d += Math.abs(curVal(c.id) - (c.score?.tau || 0));
  return +d.toFixed(4);
}

// ---------- 三分类（§4.5 判定顺序：先脉冲、再趋势、余震荡） ----------
export function classifySeries(anchor, values) {
  if (!values.length) return { kind: 'stable' };
  const diffs = []; let prev = anchor;
  for (const v of values) { diffs.push(v - prev); prev = v; }
  for (let i = 0; i < diffs.length; i++) {
    if (Math.abs(diffs[i]) >= 0.15) {
      const before = i === 0 ? anchor : values[i - 1];
      const after = values[i + 1];
      if (after != null && Math.abs(after - before) < 0.05) return { kind: 'pulse', at: i, magnitude: Math.abs(diffs[i]) };
    }
  }
  const w = diffs.slice(-10);
  const pos = w.filter(x => x > 0.001).length, neg = w.filter(x => x < -0.001).length;
  const first = values[0] || 1e-9, last = values[values.length - 1];
  const sameSign = Math.max(pos, neg);
  if (w.length >= 5 && sameSign >= Math.ceil(w.length * 0.8) && Math.abs(last / first) >= 2 && first !== 0) {
    return { kind: 'trend', dir: last > first ? 'up' : 'down', hint: '真实迁移 / 重锚候选' };
  }
  let flips = 0;
  for (let i = 1; i < w.length; i++) if (w[i] * w[i - 1] < 0) flips++;
  if (flips >= 3 && Math.abs(last - first) < 0.05) return { kind: 'oscillation', hint: '粒度问题 → §2.4 重划工单' };
  return { kind: 'stable' };
}

export function nodeSeries(pkg, id) {
  const f = findNode(pkg, id); if (!f) return null;
  const n = f.node;
  const hist = (n.score && n.score.hist) || n.hist || null;
  return { hist, node: n, kind: f.kind };
}
