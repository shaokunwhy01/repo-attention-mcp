// scoring.mjs — 确定性算术：事件流折叠 → 派生索引；raw → 概率投影；树 / 分辨率判据。
// REFACTOR-v2 §3（修订）：
//   · 分辨率**无上限**（解除 R₁/R₂ 的 clamp）；
//   · 树由 parent 链定义（parent:null = 根层），归一只在**同一父**内做（组内 Σp = 1）；
//   · 不变量 I：每点承载量 ≤ K（K_file 文件 / K_line 行）——这是"下限分辨率"，不可突破；
//   · 项目变大 → 只能增加**点数/深度**，不能靠"每点装更多"吸收规模。
//   展示的有界性由「分页」承担（page_size），不由分辨率承担。

// ---------- 树与分辨率判据 ----------
/** K 是「每点承载量上限」，即下限分辨率。 */

/** 建议扇出：把 size 个内容单位切成约 K 一份。**无上限**（上限由分页承担）。 */
export function fanoutFor(size, K) { return Math.max(1, Math.ceil((Number(size) || 0) / K)); }

/** 叶子判据：承载量不超 K 才可为叶。 */
export function isLeafSize(size, K) { return (Number(size) || 0) <= K; }

/** 下钻判据：超 K 必须继续分。 */
export function needsSplit(size, K) { return (Number(size) || 0) > K; }

// ---------- 折叠：事件流 → 派生索引 ----------
const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? d : Number(v));

/**
 * fold(events) → index
 * - nodes[id]：每节点当前 raw / 最近 evidence / src_hash / parent / depth / is_branch
 * - anchors / decisions / edits：时间序
 * - version = 已发生的最大 round；latest_ts = 末条事件时间
 */
export function fold(events = []) {
  const nodes = {};
  const anchors = []; const decisions = []; const edits = [];
  const counts = { score: 0, decision: 0, edit: 0, anchor: 0 };
  let version = 0; let latest_ts = null;

  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    if (e.round != null && !Number.isNaN(Number(e.round))) version = Math.max(version, Number(e.round));
    if (e.ts) latest_ts = e.ts;

    if (e.kind === 'score') {
      counts.score++;
      const id = e.node;
      if (!id) continue;
      const prev = nodes[id] || {};
      nodes[id] = {
        id,
        layer: e.layer || prev.layer || 'module',
        parent: e.parent !== undefined ? e.parent : (prev.parent ?? null),
        raw: num(e.raw, prev.raw ?? 0),
        evidence: e.evidence || prev.evidence || [],
        src_hash: e.src_hash || prev.src_hash || null,
        tags: e.tags || prev.tags || [],
        summary: e.summary !== undefined ? e.summary : (prev.summary || ''),
        why: e.why || prev.why || null,
        caused_by: e.caused_by !== undefined ? e.caused_by : (prev.caused_by ?? null),
        round: e.round != null ? Number(e.round) : (prev.round ?? null),
        updated_ts: e.ts || prev.updated_ts || null,
        // scaffold=true → 该节点只是 scan 建出的"骨架"（raw 占位 0），尚未真正评分
        scaffold: e.scaffold !== undefined ? !!e.scaffold : (prev.scaffold ?? false),
        depth: 0, is_branch: false,
        series: (prev.series || []).concat([{ r: e.round ?? null, raw: num(e.raw, 0), ts: e.ts || null, why: e.why || null }]),
      };
    } else if (e.kind === 'anchor') {
      counts.anchor++;
      anchors.push({
        kind: 'anchor',
        ts: e.ts || null, label: e.label || '', round: e.round != null ? Number(e.round) : null,
        resolution: e.resolution || null, refs: e.refs || [], note: e.note || null, by: e.by || null,
      });
    } else if (e.kind === 'decision') {
      counts.decision++;
      decisions.push({
        kind: 'decision',
        ts: e.ts || null, by: e.by || 'human', label: e.label || '', quote: e.quote || '',
        stage: e.stage || null, affects: e.affects || [], supersedes: e.supersedes || null,
        round: e.round != null ? Number(e.round) : null, note: e.note || null,
      });
    } else if (e.kind === 'edit') {
      counts.edit++;
      edits.push({
        kind: 'edit',
        ts: e.ts || null, by: e.by || 'main', scope: e.scope || [], summary: e.summary || '',
        before_hash: e.before_hash || null, after_hash: e.after_hash || null,
        round: e.round != null ? Number(e.round) : null, note: e.note || null,
      });
    }
  }

  // 派生：depth（沿 parent 链）+ is_branch（有子即分支）；parent 未入账则视作根
  for (const n of Object.values(nodes)) {
    let d = 0, cur = n; const seen = new Set([n.id]);
    while (cur.parent != null && nodes[cur.parent] && !seen.has(cur.parent)) { seen.add(cur.parent); d++; cur = nodes[cur.parent]; }
    n.depth = d;
  }
  for (const n of Object.values(nodes)) if (n.parent != null && nodes[n.parent]) nodes[n.parent].is_branch = true;

  return { nodes, anchors, decisions, edits, counts, version, latest_ts, count: events.length };
}

// ---------- 树辅助 ----------
/** 子节点表：键 = parent id（parent 未入账的挂到根 ''）。 */
export function childrenMap(index) {
  const m = {};
  for (const n of Object.values(index.nodes || {})) {
    const pid = (n.parent != null && index.nodes[n.parent]) ? String(n.parent) : '';
    (m[pid] = m[pid] || []).push(n);
  }
  return m;
}

/** 某节点的全部后代（raw 降序）。 */
export function descendants(index, id) {
  const cm = childrenMap(index);
  const out = []; const stack = [String(id)];
  while (stack.length) {
    const cur = stack.pop();
    for (const n of cm[cur] || []) { out.push(n); stack.push(n.id); }
  }
  return out.sort((a, b) => (b.raw || 0) - (a.raw || 0));
}

// ---------- 概率投影（§2.2：raw 独立入账，概率在读取时算）----------
/** 就地写入 p = raw / Σraw（**组内**归一）；Σ=0 时退化为等分。 */
export function normalizePool(items, key = 'raw') {
  const sum = items.reduce((a, x) => a + (Number(x[key]) || 0), 0);
  if (sum <= 0) {
    const n = items.length || 1;
    for (const x of items) x.p = +(1 / n).toFixed(6);
    return items;
  }
  for (const x of items) x.p = +((Number(x[key]) || 0) / sum).toFixed(6);
  return items;
}

/**
 * project(index) → { root, groups }
 * 每个**父节点之下**独立归一（组内 Σp = 1）；根组（parent:null 或 parent 未入账）即 σ 榜。
 * 两层各自排序、互不相乘（§2.1）——现在推广到任意层："先粗后细"逐层下钻。
 */
export function project(index) {
  const cm = childrenMap(index);
  const groups = {};
  for (const [key, list] of Object.entries(cm)) {
    groups[key] = normalizePool(list.map(n => ({ ...n })), 'raw')
      .map(n => ({
        id: n.id, p: n.p, raw: n.raw, parent: n.parent ?? null, depth: n.depth ?? 0,
        is_branch: !!n.is_branch, layer: n.layer,
        ref: (n.evidence || [])[0] || null, refs: n.evidence || [], evidence: n.evidence || [],
        src_hash: n.src_hash || null, summary: n.summary || '',
      }))
      .sort((a, b) => b.p - a.p || b.raw - a.raw);
  }
  return { groups, root: groups[''] || [] };
}
