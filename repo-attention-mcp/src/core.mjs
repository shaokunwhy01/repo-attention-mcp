// core.mjs — 两个核心：注意力引导（brief / expand / lookup / timeline）+ 归账（note / anchor）+ audit
// REFACTOR-v2 §3：节点构成一棵树（parent 链）；引导是**逐层下钻**（先粗后细），不再是固定两跳。
// Server 从不调用模型：此处全部为确定性代码（解析 / 校验 / hash / 折叠 / 归一 / 审计）。
import * as S from './scoring.mjs';
import {
  nowIso, estTokens, hashEvidence, scopeHash, scanRepo, linesUnder, filesUnder, parseProjRef,
} from './util.mjs';

const LAYERS = ['module', 'content'];
const BYS = ['main', 'sub', 'human', 'auto'];
const WHY = ['code_changed', 'attention_moved', 'new', 'split', 'merge', 'retire'];
const byOf = (v) => (BYS.includes(v) ? v : 'main');

export class Core {
  constructor(repo) { this.repo = repo; }
  get p() { return this.repo.params(); }

  // ============ 信封（§5：违例走 warnings/error 数据，不走异常） ============
  envelope(extra = {}, warnings = [], budgetUsed = null) {
    const idx = this.repo.loadIndex();
    return { ok: true, version: idx.version, latest_ts: idx.latest_ts, warnings, budget_used: budgetUsed, ...extra };
  }
  reject(code, message, details = null, warnings = []) {
    return { ok: false, error: { code, message, details }, warnings };
  }

  // ---------- 机械校验（§5：唯一被保留的五条）----------
  /** 校验 1：evidence ≥1 条，锚到 symbol 或 ## 小节级（禁 ≤2 行无 symbol 的行级锚）。 */
  validateRefs(refs) {
    if (!refs || !refs.length) return { ok: false, reason: 'evidence 必须 ≥1 条（锚到 symbol 或 ## 小节级）' };
    for (const r of refs) {
      const pr = parseProjRef(r);
      if (!pr) return { ok: false, reason: `ref 语法非法：${r}（须 proj://<repo>/<path>[:start-end][#symbol][@rev]）` };
      if (!pr.symbol && pr.lineStart != null && (pr.lineEnd - pr.lineStart) <= 2)
        return { ok: false, reason: `行级锚禁止：${r}（无 symbol/小节锚且 ≤2 行）。锚到函数/方法或 ## 小节级` };
    }
    return { ok: true };
  }

  /** §4.4：脏是自动推导的 —— hashEvidence(evidence) ≠ index[node].src_hash。 */
  isDirty(node) {
    const refs = node?.evidence || [];
    if (!refs.length) return false;
    const h = hashEvidence(this.repo.projectRoot, refs);
    if (h.bad) return false;
    return h.src_hash !== node.src_hash;
  }

  nextRound(explicit) {
    if (explicit != null && !Number.isNaN(Number(explicit))) return Number(explicit);
    return (this.repo.loadIndex().version || 0) + 1;
  }

  /** 一个节点的承载量（行）——树的分辨率判据的输入。 */
  sizeOf(evidence) { return linesUnder(this.repo.projectRoot, evidence || []); }

  /** 承载量双维（不变量 I）：文件数 + 行数。 */
  measure(evidence) {
    return {
      files: filesUnder(this.repo.projectRoot, evidence || []),
      lines: linesUnder(this.repo.projectRoot, evidence || []),
    };
  }

  /** 超载判据（不变量 I）：任一维度超 K 即违反——必须继续细分。 */
  violatesI(m, K_file, K_line) {
    return (Number(m.files) || 0) > K_file || (Number(m.lines) || 0) > K_line;
  }

  // ============ 读面 ============

  /** brief(opts)：开局唯一入口 —— 根层榜（分页，按 p 降序）+ 树/分辨率元信息 + 最近锚 + 按页预算。无任何待办项。 */
  brief(opts = {}) {
    const repo = this.repo, p = this.p;
    const idx = repo.loadIndex();
    const scan = scanRepo(repo.projectRoot);
    const proj = S.project(idx);
    const warnings = [];

    const pg = paginate(proj.root, opts.cursor, p.page_size);

    // 根层不过滤：低于 sigma_band 的仍列出，只标 edge:true（边缘区 = 注意力衰减，非否定）
    const modules = [];
    let edgeN = 0;
    for (const m of pg.items) {
      const row = {
        id: m.id, p: m.p, raw: m.raw, dirty: this.isDirty(idx.nodes[m.id]),
        unscored: !!idx.nodes[m.id]?.scaffold,
        ref: m.ref, refs: m.refs, depth: m.depth, branch: m.is_branch,
      };
      if (m.p < p.sigma_band) { row.edge = true; edgeN++; }
      modules.push(row);
      // 下钻判据：超载的点必须继续细分（不变量 I：每点承载量 ≤ K，文件/行双维）
      const cap = this.measure(m.evidence);
      if (!m.is_branch && this.violatesI(cap, p.K_file, p.K_line))
        warnings.push({ code: 'subdivide_suggested', node: m.id, msg: `承载 ${cap.files} 文件 / ${cap.lines} 行（上限 ${p.K_file} 文件 / ${p.K_line} 行）：该点超载，必须继续细分（expand 后补子节点，或 ra scan 建树）` });
    }
    if (edgeN) warnings.push({ code: 'edge_band', msg: `${edgeN} 个根节点处于边缘区（p < sigma_band=${p.sigma_band}）：仍然列出并标 edge:true（注意力衰减，非错误非否定）` });
    if (pg.next_cursor) warnings.push({ code: 'paged', msg: `根层共 ${pg.total} 个节点，本页 ${pg.returned} 个：翻页用 brief({cursor:"${pg.next_cursor}"})` });

    const orphans = Object.values(idx.nodes).filter(n => n.parent != null && !idx.nodes[n.parent]);
    if (orphans.length) warnings.push({ code: 'orphan_parents', nodes: orphans.slice(0, 5).map(n => n.id), msg: `${orphans.length} 个节点的 parent 未入账：暂挂根层显示，请补父节点` });

    const all = Object.values(idx.nodes);
    const maxDepth = all.length ? Math.max(...all.map(n => n.depth || 0)) : 0;
    const anchored = all.filter(n => n.is_branch).length;
    const anchors = idx.anchors.slice(-3).reverse().map(a => ({ r: a.round, label: a.label, ts: a.ts }));

    // 预算是**按页**的，与项目规模无关（这就是"分辨率无上限而响应有界"的兑现方式）
    const budget = { page_size: p.page_size, overview_tokens: Math.round(120 * p.page_size + 300) };
    budget.used = estTokens(modules) + estTokens(anchors) + estTokens({ F: scan.F, L: scan.L, maxDepth });

    return this.envelope({
      version: idx.version,
      latest_ts: idx.latest_ts,
      resolution: {
        basis: `${p.K_file}文件/点 · ${p.K_line}行/点`,
        F: scan.F, L: scan.L,
        max_depth: maxDepth, n_nodes: all.length, n_branch: anchored,
      },
      page: pg.meta,
      modules, anchors, budget,
    }, warnings, budget);
  }

  /** expand(node, opts)：逐层下钻 —— 有子给子榜（分页）；无子（叶子）直接给它自己的 refs。 */
  expand(nodeId, opts = {}) {
    const p = this.p, repo = this.repo;
    const idx = repo.loadIndex();
    const node = idx.nodes[nodeId];
    if (!node) return this.reject('node_not_found', `节点 ${nodeId} 不在账中（先 note(kind="score") 打分，或用 ra scan 建树骨架）`);
    const proj = S.project(idx);
    const kids = proj.groups[String(nodeId)] || [];
    const warnings = [];

    if (kids.length) {
      const pg = paginate(kids, opts.cursor, p.page_size);
      let edgeN = 0;
      const children = pg.items.map(k => {
        const row = {
          id: k.id, p: k.p, raw: k.raw, dirty: this.isDirty(idx.nodes[k.id]),
          unscored: !!idx.nodes[k.id]?.scaffold,
          ref: k.ref, refs: k.refs, depth: k.depth, branch: k.is_branch,
        };
        if (k.p < p.tau_band) { row.edge = true; edgeN++; }
        return row;
      });
      if (edgeN) warnings.push({ code: 'edge_band', node: nodeId, msg: `${edgeN} 个子节点处于边缘区（p < tau_band=${p.tau_band}）：仍然列出并标 edge:true` });
      for (const k of pg.items) {
        const cap = this.measure(k.evidence);
        if (!k.is_branch && this.violatesI(cap, p.K_file, p.K_line))
          warnings.push({ code: 'subdivide_suggested', node: k.id, msg: `承载 ${cap.files} 文件 / ${cap.lines} 行（上限 ${p.K_file} / ${p.K_line}）：必须继续细分` });
      }
      if (pg.next_cursor) warnings.push({ code: 'paged', msg: `${nodeId} 共 ${pg.total} 个子节点，本页 ${pg.returned} 个：翻页用 expand({node:"${nodeId}",cursor:"${pg.next_cursor}"})` });
      return this.envelope({
        node: nodeId, kind: 'branch', depth: node.depth ?? 0,
        raw: node.raw ?? null, summary: node.summary || '',
        page: pg.meta, n_children: kids.length, children,
      }, warnings);
    }

    const cap = this.measure(node.evidence);
    if (this.violatesI(cap, p.K_file, p.K_line))
      warnings.push({ code: 'over_size_leaf', node: nodeId, msg: `叶子承载 ${cap.files} 文件 / ${cap.lines} 行（上限 ${p.K_file} 文件 / ${p.K_line} 行）：违反「每点承载量 ≤ K」——请补子节点细分` });
    return this.envelope({
      node: nodeId, kind: 'leaf', depth: node.depth ?? 0,
      raw: node.raw ?? null, summary: node.summary || '',
      refs: node.evidence || [], src_hash: node.src_hash || null,
      dirty: this.isDirty(node), size: cap.lines, over_size: this.violatesI(cap, p.K_file, p.K_line),
    }, warnings);
  }

  /** lookup(question)：问题式定位 —— 匹配 1–3 个节点，并**穿透到叶子**给出可读 refs。 */
  lookup(question) {
    const q = String(question || '').trim();
    if (!q) return this.reject('schema', 'question 必填');
    const idx = this.repo.loadIndex();
    const toks = tokenize(q);
    const hits = [];
    for (const n of Object.values(idx.nodes)) {
      const hay = [n.id, n.summary || '', (n.evidence || []).join(' ')].join(' ').toLowerCase();
      const why = toks.filter(t => hay.includes(t));
      if (!why.length) continue;
      hits.push({ n, why: why.slice(0, 4) });
    }
    hits.sort((a, b) => b.why.length - a.why.length || (b.n.raw || 0) - (a.n.raw || 0));
    const top = hits.slice(0, 3).map(({ n, why }) => {
      const leaves = n.is_branch
        ? S.descendants(idx, n.id).filter(d => !d.is_branch).slice(0, 3)
        : [n];
      return {
        id: n.id, raw: n.raw ?? null, depth: n.depth || 0, branch: !!n.is_branch, matched: why,
        ref: (n.evidence || [])[0] || null,
        leaves: leaves.map(l => ({ id: l.id, raw: l.raw ?? null, refs: l.evidence || [] })),
      };
    });
    if (!top.length)
      return this.envelope({ question: q, matches: [], reason: '关键词未命中任何节点 id/摘要/引用路径——改用 brief 逐层下钻，或按规则 §四 自查全项目后 note(score) 回流' },
        [{ code: 'no_match', msg: 'lookup 无匹配：不是错误，只是账里没有这个词' }]);
    return this.envelope({ question: q, matches: top, reason: `命中 ${top.length} 个节点（关键词：${top[0].matched.join('/')}）` });
  }

  /** timeline(scope?)：分值序列 + 锚 + 决定/改动（因）。 */
  timeline(scope) {
    const filt = scope ? String(scope) : null;
    const idx = this.repo.loadIndex();
    const byNode = {};
    for (const e of this.repo.readEvents()) {
      if (e.kind !== 'score') continue;
      if (filt && e.node !== filt) continue;
      (byNode[e.node] = byNode[e.node] || []).push(e);
    }
    const segments = idx.anchors.map(a => ({ r: a.round, label: a.label, ts: a.ts, resolution: a.resolution || null }));
    const causes = [...idx.decisions, ...idx.edits]
      .filter(e => !filt || (e.affects || []).includes(filt) || (e.scope || []).some(s => String(s).includes(filt)))
      .map(e => ({ ts: e.ts, kind: e.kind, by: e.by, label: e.label || e.summary, round: e.round }))
      .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    const nodes = Object.entries(byNode).map(([id, evs]) => ({
      id, depth: idx.nodes[id]?.depth ?? null,
      series: evs.map(e => ({ r: e.round ?? null, raw: e.raw, ts: e.ts, why: e.why || null })),
    }));

    const L = [];
    if (filt) {
      const n = nodes[0];
      L.push(`${filt}  raw: ${n ? n.series.map(x => x.raw).join(' → ') : '（无评分记录）'}`);
      L.push('（raw 只在被评分时变化，绝不会凭空跳）');
    } else {
      for (const n of nodes) L.push(`${n.id.padEnd(28)} raw: ${n.series.map(x => x.raw).join(' → ')}`);
    }
    L.push(`锚：${segments.length ? segments.map(s => `r${s.r} ${s.label}`).join(' → ') : '（无）'}`);
    for (const c of causes) L.push(`因：r${c.round} ← ${c.kind}(${c.by}, ${c.label})`);
    return this.envelope({ scope: filt, segments, nodes, causes, text: L.join('\n') });
  }

  // ============ 写面（note / anchor）============

  note(args = {}) {
    const kind = args.kind;
    if (kind === 'score') return this.noteScore(args);
    if (kind === 'decision') return this.noteDecision(args);
    if (kind === 'edit') return this.noteEdit(args);
    return this.reject('schema', `note.kind ∈ {score, decision, edit}（当前 ${kind}）`);
  }

  noteScore(args) {
    const items = Array.isArray(args.items) && args.items.length ? args.items : [args];
    const p = this.p;
    const round = this.nextRound(args.round);
    const idx = this.repo.loadIndex();
    const accepted = []; const rejected = []; const caps = {};
    for (const it of items) {
      const v = this.validateScore(it);
      if (!v.ok) { rejected.push({ node: it?.node || null, reason: v.reason }); continue; }
      const layer = it.layer || 'module';
      const parent = it.parent ?? null;
      // 真评分 → 骨架身份失效：必须显式落 scaffold，否则 fold 回落到 scan 写的 true，
      // 该点会永远被 progress/brief 标 unscored、并被 sweep 反复取回（全评无法收敛）。
      const scaffold = it.scaffold !== undefined ? !!it.scaffold : false;
      const ev = {
        ts: nowIso(), by: byOf(it.by), kind: 'score',
        round: it.round != null ? Number(it.round) : round,
        node: it.node, layer, parent,
        raw: Number(it.raw), why: it.why,
        evidence: it.evidence, src_hash: it.src_hash,
        scaffold,
      };
      if (it.summary != null) ev.summary = it.summary;
      if (it.tags) ev.tags = it.tags;
      if (it.caused_by) ev.caused_by = it.caused_by;
      if (it.note) ev.note = it.note;
      this.repo.appendEvent(ev);
      accepted.push(ev.node);
      caps[ev.node] = this.measure(ev.evidence);
    }
    if (!accepted.length)
      return this.reject('all_rejected', `全部条目被拒：${JSON.stringify(rejected)}`, { rejected });

    const warnings = [{ code: 'recorded', msg: `第 ${round} 轮记入 ${accepted.length} 笔独立强度（raw 不归一，概率在读取时按父分组计算）` }];
    if (rejected.length) warnings.push({ code: 'partial', msg: `${rejected.length} 条被拒（坏一笔不毁一单）`, rejected });

    // 软校验（不阻塞）：超载的点必须继续细分（不变量 I：每点承载量 ≤ K，文件/行双维）
    for (const id of accepted) {
      const cap = caps[id];
      if (srcHasChildren(idx, id) === false && this.violatesI(cap, p.K_file, p.K_line))
        warnings.push({ code: 'over_size_leaf', node: id, msg: `承载 ${cap.files} 文件 / ${cap.lines} 行（上限 ${p.K_file} 文件 / ${p.K_line} 行）：该点超载，应继续细分（补子节点）` });
    }
    // 软校验：parent 未入账（树会暂时把它挂到根层）
    for (const it of items) {
      if (it?.parent && !idx.nodes[it.parent] && !accepted.includes(it.parent))
        warnings.push({ code: 'orphan_parent', node: it.parent, msg: `parent ${it.parent} 尚未入账：该节点暂挂根层，请尽快补父节点` });
    }
    return this.envelope({ kind: 'score', round, accepted: accepted.length, nodes: accepted, rejected });
  }

  validateScore(it) {
    if (!it || !it.node) return { ok: false, reason: 'node 必填' };
    const layer = it.layer || 'module';
    if (!LAYERS.includes(layer)) return { ok: false, reason: 'layer ∈ module|content（仅作标注；树由 parent 链定义）' };
    if (it.raw == null || Number.isNaN(Number(it.raw))) return { ok: false, reason: 'raw 必填（独立强度，不做归一）' };
    if (!WHY.includes(it.why)) return { ok: false, reason: `why ∈ ${WHY.join('|')}` };
    const vr = this.validateRefs(it.evidence);
    if (!vr.ok) return vr;
    if (!it.src_hash) return { ok: false, reason: 'src_hash 必填（防「没读就改分」）' };
    const h = hashEvidence(this.repo.projectRoot, it.evidence);
    if (h.bad) return { ok: false, reason: 'evidence 无法解析（ref 不可读/不存在）' };
    if (h.src_hash !== it.src_hash)
      return { ok: false, reason: `src_hash 与实况不符（期望 ${h.src_hash}，收到 ${it.src_hash}）` };
    return { ok: true };
  }

  noteDecision(args) {
    if (!args.label) return this.reject('schema', 'decision.label 必填（模型归纳的一句话）');
    const quote = args.quote;
    if (!quote || !String(quote).trim())
      return this.reject('schema', 'decision.quote 必填：对话者原话——模型只能代录，不得自拟');
    const idx = this.repo.loadIndex();
    const round = args.round != null ? Number(args.round) : (idx.version || 0);
    const ev = { ts: nowIso(), by: 'human', kind: 'decision', label: args.label, quote: String(quote), round };
    if (args.stage) ev.stage = args.stage;
    if (args.affects) ev.affects = args.affects;
    if (args.supersedes) ev.supersedes = args.supersedes;
    if (args.note) ev.note = args.note;
    this.repo.appendEvent(ev);
    return this.envelope({ kind: 'decision', ts: ev.ts, label: ev.label, round, supersedes: ev.supersedes || null },
      [{ code: 'recorded', msg: '只记不禁：决定不是闸门，是 timeline 里分值突变的「因」（改主意 = 再记一条 + supersedes）' }]);
  }

  noteEdit(args) {
    if (!Array.isArray(args.scope) || !args.scope.length)
      return this.reject('schema', 'edit.scope 必填（改了哪些路径，文件/目录混排）');
    if (!args.summary) return this.reject('schema', 'edit.summary 必填（一句话：改成什么样）');
    if (!args.before_hash) return this.reject('schema', 'edit.before_hash 必填（改动前的 hash）');
    if (!args.after_hash) return this.reject('schema', 'edit.after_hash 必填（改动后的现状 hash）');
    const actual = scopeHash(this.repo.projectRoot, args.scope);
    if (actual !== args.after_hash)
      return this.reject('src_hash_mismatch', 'after_hash 与实况不符（edit 是事实，可机械核对）', { expected: actual, got: args.after_hash });
    const idx = this.repo.loadIndex();
    const round = args.round != null ? Number(args.round) : (idx.version || 0) + 1;
    const ev = {
      ts: nowIso(), by: byOf(args.by), kind: 'edit', scope: args.scope, summary: args.summary,
      before_hash: args.before_hash, after_hash: args.after_hash, round,
    };
    if (args.note) ev.note = args.note;
    this.repo.appendEvent(ev);
    return this.envelope({ kind: 'edit', ts: ev.ts, scope: ev.scope, round, after_hash: ev.after_hash },
      [{ code: 'recorded', msg: '认领操作：随后可用 score.caused_by 指向这条 edit，让「分为什么变」落在一次真实改动上' }]);
  }

  anchor(args = {}) {
    if (!args.label) return this.reject('schema', 'anchor.label 必填（给这一段起个名）');
    const p = this.p;
    const scan = scanRepo(this.repo.projectRoot);
    const idx = this.repo.loadIndex();
    const all = Object.values(idx.nodes);
    const resolution = args.resolution || {
      basis: `${p.K_file}文件/点 · ${p.K_line}行/点`,
      F: scan.F, L: scan.L,
      max_depth: all.length ? Math.max(...all.map(n => n.depth || 0)) : 0,
      n_nodes: all.length,
    };
    const round = this.nextRound(args.round);
    const ev = {
      ts: nowIso(), by: byOf(args.by), kind: 'anchor', label: args.label,
      resolution, refs: args.refs || [], round,
    };
    if (args.note) ev.note = args.note;
    this.repo.appendEvent(ev);
    return this.envelope({ kind: 'anchor', label: ev.label, round, resolution },
      [{ code: 'anchored', msg: `第 ${round} 段起点已记：timeline 由此分段（树规模 max_depth=${resolution.max_depth} / n_nodes=${resolution.n_nodes} 随锚入账）` }]);
  }

  // ============ 维护面 ============

  /** audit：只读三检 —— 事件可解析 / index 可重建 / hash 一致。 */
  audit() {
    const repo = this.repo;
    const problems = [];
    const { events, bad } = repo.readEventsRaw();
    for (const b of bad) problems.push(`events.jsonl 第 ${b.line} 行不可解析：${b.error}`);

    const folded = S.fold(events);
    const cache = repo.readIndexCache();
    if (!cache) problems.push('index.yaml 缺失（可由 events.jsonl 折叠重建）');
    else if ((cache.event_count || 0) !== events.length)
      problems.push(`index.yaml 与事件流不同步：缓存 event_count=${cache.event_count ?? '—'}，实际 ${events.length}（缓存非权威，可重建）`);
    else {
      for (const [id, n] of Object.entries(folded.nodes)) {
        const c = cache.nodes?.[id];
        if (!c) { problems.push(`index.yaml 缺节点 ${id}`); continue; }
        if (Number(c.raw) !== Number(n.raw)) problems.push(`index.yaml 节点 ${id} raw 不一致：${c.raw} ≠ ${n.raw}`);
      }
    }

    // 树完整性：parent 必须已入账
    for (const n of Object.values(folded.nodes))
      if (n.parent != null && !folded.nodes[n.parent]) problems.push(`节点 ${n.id} 的 parent=${n.parent} 未入账（树断链）`);

    let unresolvable = 0;
    for (const n of Object.values(folded.nodes)) {
      if (!n.evidence?.length) { problems.push(`节点 ${n.id} 无 evidence（机械校验 1 要求 ≥1 条锚）`); continue; }
      const h = hashEvidence(repo.projectRoot, n.evidence);
      if (h.bad) { unresolvable++; problems.push(`节点 ${n.id} 的 evidence 不可解析：${JSON.stringify(h.bad)}`); }
    }

    const all = Object.values(folded.nodes);
    return {
      ok: problems.length === 0,
      events: events.length,
      nodes: all.length,
      branches: all.filter(n => n.is_branch).length,
      leaves: all.filter(n => !n.is_branch).length,
      max_depth: all.length ? Math.max(...all.map(n => n.depth || 0)) : 0,
      anchors: folded.anchors.length,
      decisions: folded.decisions.length,
      edits: folded.edits.length,
      version: folded.version,
      dirty: all.filter(n => this.isDirty(n)).length,
      unresolvable,
      problems: problems.slice(0, 50),
    };
  }
}

// ---------- 辅助 ----------
function srcHasChildren(idx, id) {
  return Object.values(idx.nodes).some(n => String(n.parent) === String(id));
}

/** 分页：cursor 就是偏移量（字符串），页内顺序 = 传入顺序（调用方已按 p 降序排好）。 */
function paginate(rows, cursor, size) {
  const total = rows.length;
  let off = Number(cursor);
  if (!Number.isFinite(off) || off < 0) off = 0;
  const items = rows.slice(off, off + size);
  const nextCursor = off + size < total ? String(off + size) : null;
  return {
    items, total, returned: items.length, next_cursor: nextCursor,
    meta: { size, offset: off, total, returned: items.length, next_cursor: nextCursor },
  };
}

function tokenize(q) {
  const out = new Set();
  for (const w of q.toLowerCase().match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  for (const seg of q.match(/[\p{Script=Han}]+/gu) || []) {
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i + 1 < seg.length; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}
