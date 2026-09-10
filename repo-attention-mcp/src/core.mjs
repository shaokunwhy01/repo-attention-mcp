// core.mjs — 三面协议的工具面核心（五组 16 工具）+ 评估事务状态机
// 总架构裁决①：Server 从不调用模型。此处全部为确定性代码：hash/schema/校验/归一/预算/快照/账本。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync } from 'node:fs';
import path from 'node:path';
import * as Y from './yaml.mjs';
import * as S from './scoring.mjs';
import * as DG from './dialogs.mjs';
import { nowIso, pad4, estTokens, hashEvidence, parseProjRef, sha256 } from './util.mjs';

const clone = (o) => structuredClone(o);
const safe = (id) => id.replace(/[^\w.-]+/g, '_');

export class Core {
  constructor(repo) { this.repo = repo; }
  get p() { return this.repo.params(); }

  // ============ 返回信封（§10：违例不走异常，走 warnings 数据） ============
  envelope(extra = {}, warnings = [], budgetUsed = null) {
    const pin = this.repo.pinned();
    const idx = this.repo.loadIndex();
    return { ok: true, pin: pin.k, ledger_seq: idx.counters?.seq || 0, warnings, budget_used: budgetUsed ?? null, ...extra };
  }
  reject(code, message, details = null, warnings = []) {
    return { ok: false, error: { code, message, details }, warnings };
  }

  effectiveFlux(pkg) { const idx = this.repo.loadIndex(); return (idx.flux && idx.flux.length ? idx.flux : pkg.flux) || []; }

  fluxWarnings(pkg) {
    const out = [];
    const flux = this.effectiveFlux(pkg);
    for (const m of flux) out.push({ code: 'flux_open', node: m, msg: 'warning: flux_open, guidance void, read raw（该模块得分指引失效，直读源码不信旧分）' });
    const active = S.activeModules(pkg);
    if (active.length && flux.length / active.length >= this.p.flux_void_threshold)
      out.push({ code: 'flux_mass', msg: `flux ≥ ${(this.p.flux_void_threshold * 100) | 0}% 模块：指引价值趋零，整包进入直读模式（裁决②：直读优先于劝拆）` });
    return out;
  }

  t2State() {
    const idx = this.repo.loadIndex(); const p = this.p;
    const since = idx.counters?.dialogs_since_eval || 0;
    const exempt = !!idx.episode;
    return { since, limit: p.N, exempt, due: !exempt && since >= p.N, remaining: Math.max(0, p.N - since) };
  }

  // ============ A 读面（6） ============

  startupBrief(opts = {}) {
    const { k } = this.repo.pinned();
    const pkg = this.repo.readPackage(k);
    const idx = this.repo.loadIndex();
    const p = this.p;
    if (opts.mode && ['discuss', 'modify', 'mixed'].includes(opts.mode))
      this.repo.updateIndex(i => { i.session_mode = opts.mode; });
    const warnings = [...this.fluxWarnings(pkg)];
    // §4.0 会话关闭即抽：未抽旧账先补跑（幂等）——机械检测在 server，抽取解析在模型
    for (const s of DG.listDialogs(this.repo.root)) {
      const meta = DG.loadMeta(this.repo.root, s) || {};
      if (meta.sealed && !meta.extracted)
        warnings.push({ code: 'extraction_backlog', node: `sess-${s}`, msg: `sess-${s} 已物理关闭但未抽取：未抽旧账先补跑（幂等）——对全转写跑四测抽取后 dialog_extract(sess_id)` });
    }
    const t2 = this.t2State();
    if (t2.exempt) warnings.push({ code: 't2_exempt', msg: `清单 ${idx.episode?.checklist || idx.episode?.id} 开放中：T2 豁免（I3），收口 T1 顺带并入期间全部 backlog` });
    else if (t2.due) warnings.push({ code: 't2_due', msg: `距上次评估已满 ${t2.since} 对话：下次对话前必须执行 T2 全评（I3）` });
    if (idx.episode && (idx.counters?.dialogs_since_open || 0) > p.G_max)
      warnings.push({ code: 'gmax_soft_reminder', msg: `清单已跨 ${idx.counters.dialogs_since_open} 轮对话（> G_max=${p.G_max}）：你有义务向使用者报告并建议拆分/收缩——只提醒，不自动触发任何评估（规则5）` });
    if (idx.assess_open) warnings.push({ code: 'assessment_open', msg: `评估工单 ${idx.assess_open.id} 未 publish：读面返回旧版且工单保持 open（I1 原子事务）` });

    // 规则9 decisive 对齐校验：逐条 src_hash_at_claim vs 现状
    const decisive = [];
    for (const c of S.activeClaims(pkg)) {
      if (!c.decisive) continue;
      const refs = (c.code_refs || []).map(S.stripRev);
      const h = hashEvidence(this.repo.projectRoot, refs);
      let status = 'unknown';
      if (h.bad) status = 'unanchored';
      else if (h.anyMissing) status = 'ref_missing';
      else if (c.src_hash_at_claim && h.src_hash !== c.src_hash_at_claim) status = 'stale_suspended';
      else status = 'aligned';
      decisive.push({ id: c.id, sess: c.sess_id, assert: c.assert, status,
        action: (status === 'stale_suspended' || status === 'ref_missing' || status === 'unanchored')
          ? '⚠️ 挂起：先读码裁决；若与现状冲突 → 停止并向使用者报告等待裁决——禁止带着被违反的决定性结论修改代码（规则9）' : null });
      if (status !== 'aligned') warnings.push({ code: 'decisive_misaligned', node: c.id, msg: `decisive ${c.id} 对齐校验=${status}（最高优先级）` });
    }
    const negDec = Object.entries(pkg.archived || {}).filter(([, r]) => r.verdict === 'negated' && r.was_decisive);
    for (const [id] of negDec) warnings.push({ code: 'decisive_negated', node: id, msg: '被证伪的 decisive——§4.6⑤ 最高优先级报告项' });

    const mode = opts.mode || idx.session_mode || 'mixed';
    // 不确定→按修改模式处理（保守侧，规则8）；mixed 即保守侧执行
    const effMode = mode === 'discuss' ? 'discuss' : 'modify';
    const board = this.dialogueBoard(pkg, mode);
    const flux = this.effectiveFlux(pkg);
    const mods = S.activeModules(pkg).map(m => ({ id: m.id, ref: m.ref, sigma: m.sigma, summary: m.summary, flux: flux.includes(m.id) || undefined }))
      .sort((a, b) => b.sigma - a.sigma);

    // 规则8 预算冲突序：讨论模式先截代码长尾；修改模式先截对话榜（decisive 永不截断）
    const headerTok = estTokens(decisive.map(d => d.assert).join('')) + estTokens(board.items.map(b => b.assert).join('')) + 80;
    const sigmaBudget = (effMode === 'discuss' ? Math.max(200, p.budget.overview_tokens - 200) : p.budget.overview_tokens) - headerTok;
    const rows = []; let used = 0; let dropped = [];
    for (const m of mods) {
      const t = estTokens(`${m.id} ${m.summary} ${m.ref}`);
      if (used + t > Math.max(120, sigmaBudget)) { dropped = mods.slice(rows.length); break; }
      rows.push(m); used += t;
    }
    if (dropped.length) warnings.push({ code: 'budget_degrade', msg: `σ 投影超预算：长尾 ${dropped.length} 模块降级为仅给引用路径（规则6）`, refs_only: dropped.map(m => ({ id: m.id, ref: m.ref })) });
    const budgetUsed = { brief_tokens: used + headerTok, cap: p.budget.brief_tokens };
    if (used + headerTok > p.budget.brief_tokens) warnings.push({ code: 'brief_over_budget', msg: `启动卡超 ${p.budget.brief_tokens} tok 软预算（用 rehearse_budget 校准）` });

    const res = {
      version: k, segment: pkg.segment?.s ?? 0, anchor: pkg.segment?.anchor ?? null,
      episode: idx.episode || null,
      close_pending: idx.close_pending ? { ep: idx.close_pending.ep_id, cl: idx.close_pending.cl_id, note: '收口已武装：下个评估 = 全量重锚（唯一入口 episode_close → assess_open T1）' } : null,
      flux, t2, mode, effective_truncation: effMode + '（修改模式保守侧）',
      sigma_table: rows,
      dialogue_board: board,
      decisive,
      backlog_count: this.repo.backlogOpen().length,
      workorders_pending: this.listWorkorders('approved').length + this.listWorkorders('proposed').length,
      n_units: { code: S.activeModules(pkg).length + S.activeContents(pkg).length, claims: S.activeClaims(pkg).length, cap: { code: p.N_cap, claims: p.claim_cap } },
    };
    this.repo.ledgerAppend({ tool: 'startup_brief', action: 'read', target: `v${pad4(k)}`, result: 'ok', args: { mode: opts.mode || null } });
    return this.envelope(res, warnings, budgetUsed);
  }

  dialogueBoard(pkg, mode) {
    const p = this.p; const cap = p.budget.session_board_tokens;
    const claims = S.activeClaims(pkg).filter(c => !c.promoted_to)
      .sort((a, b) => (b.decisive ? 1 : 0) - (a.decisive ? 1 : 0) || (b.score?.tau || 0) - (a.score?.tau || 0));
    const items = []; let used = 0; let dropped = 0;
    for (const c of claims) {
      const t = estTokens(c.assert);
      if (c.decisive) { items.push({ id: c.id, sess: c.sess_id, assert: c.assert, tau: c.score?.tau, decisive: true }); used += t; continue; }
      const budget = mode === 'discuss' ? cap + 150 : Math.max(120, cap - estTokens(claims.filter(x => x.decisive).map(x => x.assert).join('')));
      if (used + t > budget) { dropped++; continue; }
      items.push({ id: c.id, sess: c.sess_id, assert: c.assert, tau: c.score?.tau, validity: c.validity });
      used += t;
    }
    return { items, truncated: dropped ? `${dropped} 条长尾结论未投影（模式=${mode} 截断序，规则8；decisive 永不截断）` : null, budget_used: used };
  }

  sigmaOverview() {
    const { k } = this.repo.pinned();
    const pkg = this.repo.readPackage(k);
    const warnings = [...this.fluxWarnings(pkg)];
    // I3：server 顺手重算全部 src_hash → 静默过期在机械上不可能
    const { dirty, checked } = S.scanDirty(this.repo.projectRoot, pkg);
    const flux = new Set(this.effectiveFlux(pkg));
    const warned = new Set(flux);
    let nWarn = 0;
    for (const d of dirty) if (!warned.has(d.node) && !this.claimNode(pkg, d.node)) {
      warnings.push({ code: 'drift_warning', node: d.node, msg: `非 flux 区 src_hash 已变（${(d.old || '').slice(0, 16)}→${(d.next || '').slice(0, 16)}）：存在包外变更，待收口评估并入（I3 禁静默过期）` });
      warned.add(d.node); nWarn++;
    }
    const staleClaims = dirty.filter(d => d.kind === 'claim-stale').map(d => d.node);
    if (staleClaims.length) warnings.push({ code: 'claims_stale', nodes: staleClaims, msg: `${staleClaims.length} 条 claim 的 code_ref 变脏 → 待裁决态（stale≠否定，§2.6）；该区域直读代码不信旧结论（同义 flux）` });
    const t2 = this.t2State();
    if (t2.due && !t2.exempt) warnings.push({ code: 't2_due', msg: 'T2 兜底评估到期（I3）：下次对话前必须全评' });
    const mods = S.activeModules(pkg).map(m => ({ id: m.id, ref: m.ref, sigma: m.sigma, summary: m.summary, flux: flux.has(m.id) || undefined }))
      .sort((a, b) => b.sigma - a.sigma);
    this.repo.ledgerAppend({ tool: 'sigma_overview', action: 'read', target: `v${pad4(k)}`, result: 'ok' });
    return this.envelope({ version: k, segment: pkg.segment?.s, hash_checked: checked, modules: mods, t2 }, warnings, { tokens: estTokens(mods), cap: this.p.budget.overview_tokens });
  }

  claimNode(pkg, id) { return S.activeClaims(pkg).some(c => c.id === id); }

  tauExpand(moduleId) {
    const { k } = this.repo.pinned();
    const pkg = this.repo.readPackage(k);
    const warnings = [];
    const m = S.allModules(pkg).find(x => x.id === moduleId);
    if (!m) return this.reject('node_not_found', `模块 ${moduleId} 不在当前包`);
    if (m.status && m.status !== 'active') return this.reject('node_void', `模块 ${moduleId} 状态=${m.status}：已退出投影，用 archive_get 查全史（I11）`);
    if (this.effectiveFlux(pkg).includes(m.id)) warnings.push({ code: 'flux_open', msg: `warning: flux_open, guidance void, read raw —— ${m.id} 属在途清单，旧分不可信` });
    const cap = this.p.budget.expand_tokens;
    const units = (m.contents || []).filter(c => !c.status || c.status === 'active').sort((a, b) => b.tau - a.tau);
    const out = []; let used = 0; let degraded = false;
    for (const u of units) {
      const t = estTokens(JSON.stringify(u));
      if (used + t > cap) { degraded = true; used += estTokens(u.id); out.push({ id: u.id, tau: u.tau, refs: u.evidence?.refs, degraded: 'refs-only' }); continue; }
      out.push(u); used += t;
    }
    if (degraded) warnings.push({ code: 'expand_degrade', msg: `超 ${cap} tok：降级发生并已显式声明（规则6：详细内容按分值降序，超预算仅给引用路径）` });
    const band = this.p.tau_band;
    if (units.length > band[1]) warnings.push({ code: 'tau_band_over', msg: `${m.id} 有 ${units.length} 个 τ 单元 > ${band[1]}：下个全评该模块上抬一档（symbol→file，§2.4 爆带）` });
    this.repo.ledgerAppend({ tool: 'tau_expand', action: 'read', target: moduleId, result: 'ok' });
    return this.envelope({ module: moduleId, sigma: m.sigma, tier: pkg.resolution?.tier_by_module?.[m.id] || 'L2', n_units: units.length, band, units, degraded }, warnings, { tokens: used, cap });
  }

  nodeDetail(ref) {
    const { k } = this.repo.pinned();
    const pkg = this.repo.readPackage(k);
    const f = S.findNode(pkg, ref);
    if (!f) return this.reject('node_not_found', `节点 ${ref} 不在当前包（retired/negated 用 archive_get）`);
    if (f.kind === 'archived' || (f.node.status && f.node.status !== 'active'))
      return this.reject('node_void', `${ref} 状态=${f.node.status || 'archived'}：已退出评分与投影，用 archive_get 查墓碑全史（I11）`);
    const n = f.node;
    const refs = n.evidence?.refs || n.code_refs || [];
    const h = refs.length ? hashEvidence(this.repo.projectRoot, refs.map(S.stripRev)) : { src_hash: null };
    const edge = (pkg.edge_state || {})[ref] || null;
    this.repo.ledgerAppend({ tool: 'node_detail', action: 'read', target: ref, result: 'ok' });
    // ★ 返回值结构中无 hist/series 字段 —— I5 由机器保证
    return this.envelope({
      id: ref, kind: f.kind, status: n.status || 'active',
      sigma: n.sigma, tau: n.tau, sess_sigma: n.sess_sigma, score: f.kind === 'claim' ? { tau: n.score?.tau } : undefined,
      summary: n.summary, assert: n.assert, span: n.span, code_refs: n.code_refs,
      evidence: n.evidence, validity: n.validity, decisive: n.decisive, promoted_to: n.promoted_to,
      edge: edge ? { n: edge.n, A: edge.A, note: `入边缘区连续 ${edge.n} 轮：候选，不等于退出（§2.6）` } : null,
      src_hash_now: h.src_hash || null,
      hash_matches: refs.length ? (h.src_hash === (n.evidence?.src_hash || n.src_hash_at_claim)) : null,
    });
  }

  nodeHistory(ref) {
    // I5：漂移序列与现账物理隔离——只有本调用返回序列，打分通道结构里无序列字段
    const { k } = this.repo.pinned();
    const pkg = this.repo.readPackage(k);
    let n = null;
    const f = S.findNode(pkg, ref);
    if (f && f.kind !== 'archived') n = f.node;
    const rec = n?.hist || n?.score?.hist || pkg.archived?.[ref]?.hist || (f?.kind === 'archived' ? f.node.hist : null);
    if (!rec) return this.reject('no_series', `节点 ${ref} 无漂移序列（新入档或不存在）`);
    const series = rec.map(h => (typeof h === 'object' ? h : { v: h }));
    const cls = series.length > 1 ? S.classifySeries(series[0].v, series.slice(1).map(x => x.v)) : { kind: 'single_point' };
    this.repo.ledgerAppend({ tool: 'node_history', action: 'read', target: ref, result: 'ok' });
    return this.envelope({ id: ref, segment: pkg.segment?.s, anchor_value: series[0].v, series, classification: cls,
      note: '序列仅供模型分析阶段与报表、人抽查；绝不作为打分/评估输入（I5）' });
  }

  archiveGet(ref) {
    const idx = this.repo.loadIndex();
    const f = path.join(this.repo.root, 'archive', 'nodes', safe(ref) + '.yaml');
    let tomb = existsSync(f) ? Y.parse(readFileSync(f, 'utf8')) : null;
    if (!tomb) {
      for (let kk = idx.latest; kk >= 1 && !tomb; kk--) {
        const p2 = this.repo.readPackage(kk);
        if (p2.archived?.[ref]) tomb = { id: ref, ...p2.archived[ref], found_in: `v${pad4(kk)}` };
      }
    }
    if (!tomb) {
      const pkg = this.repo.readPackage(idx.latest);
      const cur = S.findNode(pkg, ref);
      if (cur && cur.kind !== 'archived') return this.reject('not_archived', `节点 ${ref} status=${cur.node.status || 'active'} 仍在评分序列（archive_get 仅服务退出节点，I11）`);
      return this.reject('not_found', `archive_get(${ref})：无墓碑记录（账不毁——若从未入档则本无账）`);
    }
    this.repo.ledgerAppend({ tool: 'archive_get', action: 'read', target: ref, result: 'ok' });
    const warnings = tomb.verdict === 'negated'
      ? [{ code: 'failure_library', msg: '钉档墓碑：不带分进任何投影；此查全史+否定理由（防重蹈覆辙）。平反唯一通道=「初评错了」修锚+使用者确认（钉与拔钉都是人的权力）' }]
      : [{ code: 'archived_reversible', msg: '归档可复活：点名引用或 hash 变脏即在下个全评 resumed（误归档无害，轨道一存在意义）' }];
    return this.envelope(tomb, warnings);
  }

  // ============ B 登记面（4） ============

  validateRefs(refs) {
    if (!refs || refs.length === 0) return { ok: false, reason: 'anchor_required（可锚定四测机械前置，I7）：必须携带 code_refs，proj://…@rev 锚不上代码的当场拒收' };
    for (const r of refs) {
      const p = parseProjRef(r);
      if (!p) return { ok: false, reason: `ref 语法非法：${r}（须 proj://<repo>/<path>[:start-end][#symbol][@rev]，§2.3）` };
      if (!p.symbol && p.lineStart != null && (p.lineEnd - p.lineStart) <= 2)
        return { ok: false, reason: `I7/§2.5 行级禁止：${r} 为行级区间且无 symbol/小节锚点。锚到函数/方法（或 ## 小节/顶层键组）级` };
    }
    return { ok: true };
  }

  claimRecord(a) {
    if (!a.assert) { this.repo.ledgerAppend({ tool: 'claim_record', action: 'register', result: 'rejected', msg: 'assert 缺失' }); return this.reject('schema', 'assert 必填：一句完整可验证的断言（断+由一体，不拆，§2.5 决策完整）'); }
    const v = this.validateRefs(a.code_refs);
    if (!v.ok) { this.repo.ledgerAppend({ tool: 'claim_record', action: 'register', target: String(a.assert).slice(0, 40), result: 'rejected', msg: v.reason }); return this.reject('anchor_violation', v.reason); }
    const idx = this.repo.loadIndex();
    const id = 'b-' + pad4((idx.counters?.seq || 0) + 1);
    const h = hashEvidence(this.repo.projectRoot, a.code_refs.map(S.stripRev));
    const entry = {
      id, ts: nowIso(), kind: 'claim', source: a.source || `session:${this.repo.sessionId}`,
      assert: a.assert, code_refs: a.code_refs, span: a.span || null,
      src_hash_at_claim: h.src_hash || 'sha256:unresolved',
      proposed_decisive: !!a.decisive, structural: !!a.structural,
      session_id: this.repo.sessionId,
    };
    this.repo.appendJsonl('backlog/entries.jsonl', entry);
    const warnings = [{ code: 'enqueued_only', msg: '只入 backlog，不触发评估（§4.0 时钟寄生：验证与打分在下一个自然 T1/T2）' }];
    if (a.structural) warnings.push({ code: 't3_backlog', msg: '结构意向已入 backlog：不建议中途扩清单；在收口全评中升格为重锚（T3）——或建议使用者开新清单' });
    if (a.decisive) warnings.push({ code: 'decisive_proposed', msg: 'decisive 为提议态：需 propose_workorder(decisive)+使用者批准（与晋升门同构）' });
    this.repo.ledgerAppend({ tool: 'claim_record', action: 'register', target: id, result: 'ok' });
    return this.envelope({ backlog_id: id, entry }, warnings);
  }

  dialogExtract(a) {
    const sessId = String(a.sess_id || '').replace(/^sess-/, '');
    const file = DG.dialogPath(this.repo.root, sessId);
    if (!existsSync(file)) return this.reject('no_coverage', `dialogs/sess-${sessId}.jsonl 不在盘：R1 裁决①连带义务——转写会话中增量追加，抽取时原文必须已在`);
    const meta = DG.loadMeta(this.repo.root, sessId) || { session_id: sessId };
    const claims = a.claims || [];
    if (meta.extracted && !a.reextract) {
      return this.envelope({ sess: sessId, already_extracted: true, claims_enqueued: 0 }, [{ code: 'idempotent', msg: `补跑幂等（§4.0 未抽旧账先补跑）：sess-${sessId} 已于 ${meta.extracted_ts} 抽取` }]);
    }
    const accepted = []; const rejected = [];
    for (const c of claims) {
      const v = this.validateRefs(c.code_refs);
      if (!v.ok) { rejected.push({ assert: String(c.assert || '').slice(0, 50), reason: v.reason }); continue; }
      const r = this.claimRecord({ ...c, source: `extract:sess-${sessId}`, span: c.span || `dialog://sess-${sessId}#unspecified` });
      if (r.ok) accepted.push(r.backlog_id); else rejected.push({ assert: String(c.assert || ''), reason: r.error.message });
    }
    DG.saveMeta(this.repo.root, sessId, { ...meta, extracted: true, extracted_ts: nowIso(), n_claims: claims.length, mode: meta.mode || 'mixed' });
    const warnings = [{ code: 'no_assessment', msg: '抽取本身不调用评估——只是往队列放话（§4.0）' }];
    if (claims.length > this.p.claim_band[1]) warnings.push({ code: 'claim_band', msg: `本会话 ${claims.length} 条 > ${this.p.claim_band[1]}：会话太杂，抽取时上抬"议题"档（§2.5 爆带）` });
    if (claims.length > 0 && claims.length < this.p.claim_band[0]) warnings.push({ code: 'claim_band_low', msg: `不足 ${this.p.claim_band[0]} 条：纯执行期会话，按规则只留 sess 级一行（已照常入队供裁量）` });
    if (rejected.length) warnings.push({ code: 'anchor_violation_partial', msg: `${rejected.length} 条锚不上代码被拒收——坏一笔不毁一单（R1 裁决②），其余 ${accepted.length} 条照常入队`, rejected: rejected.slice(0, 5) });
    this.repo.ledgerAppend({ tool: 'dialog_extract', action: 'register', target: `sess-${sessId}`, result: 'ok', msg: `${accepted.length}/${claims.length} claims 入 backlog` });
    return this.envelope({ sess: sessId, claims_enqueued: accepted.length, rejected }, warnings);
  }

  proposeChecklist(a) {
    const items = (a.items || []).map(i => ({ op: i.op || 'modify', ref: i.ref, intent: i.intent || '' }));
    if (!items.length) return this.reject('schema', 'items[] 必填：预定结构变化项（增/删/改/合并模块），每项带目标 ref 与意图一句话（§4.4）');
    for (const i of items) if (!i.ref) return this.reject('schema', `清单项缺目标 ref：${JSON.stringify(i)}`);
    const n = this.repo.listYaml('checklists', /^cl-\d+\.yaml$/).length + 1;
    const id = 'cl-' + pad4(n);
    const cl = { id, status: 'draft', kind: a.kind || 'refactor', items, created_ts: nowIso(), created_by: this.repo.sessionId, confirm_quote: null };
    this.repo.writeYamlAtomic(`checklists/${id}.yaml`, cl);
    this.repo.ledgerAppend({ tool: 'propose_checklist', action: 'propose', target: id, result: 'ok' });
    return this.envelope({ checklist: id, status: 'draft', n_items: items.length }, [{ code: 'i2_drafted', msg: '草案不动 flux 不开工——agent 可起草，改变账本结构的事决定权在人：需使用者确认后 checklist_confirm(cl_id, quote) 激活（I2）' }]);
  }

  proposeWorkorder(a) {
    if (!['promote', 'negate', 'decisive'].includes(a.kind)) return this.reject('schema', 'kind ∈ promote|negate|decisive（三出口；归档是全自动轨道不经此处——两端过人手、中间全自动的分界在工具面原样呈现）');
    if (!a.ref) return this.reject('schema', 'ref 必填');
    const idx = this.repo.loadIndex();
    const pkg = this.repo.readPackage(idx.latest);
    const f = S.findNode(pkg, a.ref);
    if (a.kind === 'negate' && (!a.counter_evidence || !a.counter_evidence.length)) {
      this.repo.ledgerAppend({ tool: 'propose_workorder', action: 'propose', target: a.ref, msg: 'negate', result: 'rejected', quote_verdict: null });
      return this.reject('i10_violation', 'I10：negate 缺反证 evidence 直接拒收——注意力衰减只能导致归档；只有事实证伪才能导致钉档');
    }
    if (!f || f.kind === 'archived') return this.reject('node_not_found', `节点 ${a.ref} 不在活跃序列`);
    if (a.kind === 'promote' && !a.canon_target) return this.reject('schema', 'promote 需 canon_target（canon 去处如 docs/adr/0007.md；晋升留双向链，账不毁）');
    const n = this.repo.listYaml('workorders/open', /^w-\d+\.yaml$/).length + 1;
    const id = 'w-' + pad4(n);
    const wo = { id, kind: a.kind, ref: a.ref, canon_target: a.canon_target || null, counter_evidence: a.counter_evidence || [], reason: a.reason || '', state: 'proposed', proposed_ts: nowIso(), proposed_by: this.repo.sessionId, approve_quote: null };
    this.repo.writeYamlAtomic(`workorders/open/${id}.yaml`, wo);
    this.repo.ledgerAppend({ tool: 'propose_workorder', action: 'propose', target: id, msg: a.kind, result: 'ok' });
    const warnings = [{ code: 'human_gate', msg: '人工闸门：propose ≠ 生效。需 workorder_approve(id, quote)，且执行推迟到下次全评并入（重锚类动作，永不即时，I4）' }];
    if (a.kind === 'negate') warnings.push({ code: 'stale_not_negation', msg: '提醒：stale 待裁决 ≠ 证伪；须在全评验证门阅读裁出"否"并有理由（§2.6 轨道二条件a）' });
    return this.envelope({ workorder: id, kind: a.kind, state: 'proposed' }, warnings);
  }

  listWorkorders(state) {
    return this.repo.listYaml('workorders/open', /^w-\d+\.yaml$/).map(x => x.data).filter(w => w.state === state);
  }

  // ============ C 主权面（3，全部强制 quote，I12） ============

  sovereignGate(action, target, quote) {
    if (!quote || !quote.text) return { ok: false, rej: this.reject('i2_violation', '主权动作必须附使用者原话 quote:{text,sess_hint?,span_hint?}——人的主权在 MCP 里的唯一落地形态（I2/I12）') };
    const v = DG.verifyQuote(this.repo.root, quote);
    if (v.verdict === 'no_coverage') {
      this.repo.ledgerAppend({ tool: action, action, target, result: 'rejected', quote_digest: v.digest, quote_verdict: 'no_coverage', msg: v.reason });
      return { ok: false, rej: this.reject('no_coverage', `I12：待补账——该时间窗无转写/链断，动作拒收留痕。补入转写（append-dialog + 验链）后重试同一动作`, { nearest: null }) };
    }
    if (v.verdict !== 'verified') {
      this.repo.ledgerAppend({ tool: action, action, target, result: 'rejected', quote_digest: v.digest, quote_verdict: 'failed', msg: 'quote 无匹配' });
      return { ok: false, rej: this.reject('quote_failed', `I12：failed(no_match)——所引非使用者原话（防误写/记忆漂移/上下文错位，强审计非密码学证明——信任边界申明），当场拒收。附库内最相近三行帮你发现记岔在哪`, { nearest: v.nearest }) };
    }
    const prior = this.repo.ledgerRowsAll().find(r => r.result === 'ok' && r.quote_digest === v.digest && r.action && r.action !== action);
    if (prior) {
      this.repo.ledgerAppend({ tool: action, action, target, result: 'rejected', quote_digest: v.digest, quote_verdict: 'verified', msg: '重放防御' });
      return { ok: false, rej: this.reject('quote_replay', `I12：同一 quote 已消费于 ${prior.action}（复合动作合法=一次；不得为第二个主权动作所用）`, { matched: v.matched }) };
    }
    return { ok: true, v };
  }

  checklistConfirm(clId, quote) {
    const g = this.sovereignGate('checklist_confirm', clId, quote);
    if (!g.ok) return g.rej;
    const idx = this.repo.loadIndex();
    if (idx.episode) return this.reject('episode_open', `已有开放 episode ${idx.episode.id}（执行期暂停一切评估；先收口再开新清单）`, { matched: g.v.matched });
    const cl = this.repo.readYaml(`checklists/${clId}.yaml`);
    if (!cl) return this.reject('not_found', `清单 ${clId} 不存在——agent 可起草但无草案不得确认`);
    if (cl.status !== 'draft') return this.reject('state', `清单 ${clId} status=${cl.status}，仅 draft 可确认`);
    const pkg = this.repo.readPackage(idx.latest);
    const flux = [...new Set(cl.items.map(i => this.moduleOfPkg(pkg, i.ref)).filter(Boolean))];
    const epN = (idx.counters?.episodes || 0) + 1;
    const epId = 'ep-' + pad4(epN);
    this.repo.writeYamlAtomic(`checklists/${clId}.yaml`, { ...cl, status: 'open', episode: epId, opened_ts: nowIso(), confirm_quote: { text: quote.text, verdict: `verified(${g.v.mode})`, digest: g.v.digest, matched: g.v.matched } });
    this.repo.updateIndex(i => {
      i.episode = { id: epId, kind: 'refactor', checklist: clId, status: 'open', started_ts: nowIso() };
      i.flux = flux;
      i.counters.episodes = epN;
      i.counters.dialogs_since_open = 0;
    });
    this.repo.ledgerAppend({ tool: 'checklist_confirm', action: 'checklist_confirm', target: clId, result: 'ok', quote: quote.text, quote_digest: g.v.digest, quote_verdict: 'verified', matched_span: g.v.matched[0] });
    return this.envelope({ episode: epId, checklist: clId, flux, matched: g.v.matched },
      [{ code: 'episode_started', msg: `清单下达即 episode 开始：全部涉及模块标 flux（包投影即时更新）。执行期：T1 不触发、T2 豁免、flux 直读、非清单小改以声称入 backlog、新结构意向只入 backlog 不扩清单（保一轮纯度）` }]);
  }

  moduleOfPkg(pkg, ref) {
    const p = parseProjRef(ref);
    if (!p) return null;
    let best = null;
    for (const m of S.allModules(pkg)) {
      const mrel = (m.ref || '').replace(/^proj:\/\/[^/]+\//, '').replace(/\/$/, '');
      if (!mrel) continue;
      if (p.rel === mrel || p.rel.startsWith(mrel + '/')) { if (!best || mrel.length > best.len) best = { id: m.id, len: mrel.length }; }
    }
    if (best) return best.id;
    const seg = p.rel.split('/').filter(Boolean);
    return seg[0] || p.repo;
  }

  episodeClose(epId, quote) {
    const g = this.sovereignGate('episode_close', epId, quote);
    if (!g.ok) return g.rej;
    const idx = this.repo.loadIndex();
    if (!idx.episode || idx.episode.id !== epId) return this.reject('state', `无开放 episode ${epId}——episode 收口只能由使用者宣告（I2），agent 不得自行收口/触发 T1`, { matched: g.v.matched });
    const cl = idx.episode.checklist ? this.repo.readYaml(`checklists/${idx.episode.checklist}.yaml`) : null;
    if (cl) this.repo.writeYamlAtomic(`checklists/${cl.id}.yaml`, { ...cl, status: 'closed', closed_ts: nowIso(), close_quote: { text: quote.text, digest: g.v.digest, matched: g.v.matched } });
    const crossed = idx.counters?.dialogs_since_eval || 0;
    this.repo.updateIndex(i => {
      i.close_pending = { ep_id: epId, cl_id: idx.episode.checklist || null, quote_digest: g.v.digest, from_ts: idx.episode.started_ts, crossed_dialogs: crossed };
      i.episode = null; i.flux = [];
    });
    this.repo.ledgerAppend({ tool: 'episode_close', action: 'episode_close', target: epId, result: 'ok', quote: quote.text, quote_digest: g.v.digest, quote_verdict: 'verified', matched_span: g.v.matched[0], msg: '收口全评唯一入口（I2/I4）：下次 assess_publish 执行全量重锚' });
    const warnings = [{ code: 'close_armed', msg: `收口已武装：全量重锚（删无主节点/新节点补分/剩余重归一→新锚 B，开新段）+ backlog 期间积累全部并入验证 + flux 清空 + 漂移序列只落 1 点（单轮语义：跨 ${crossed} 对话多少编辑就一个点）。下一步 assess_open('T1')` }];
    const pending = this.listWorkorders('proposed').length;
    if (pending && !this.p.close_ignores_pending_wo) warnings.push({ code: 'wo_pending_block', msg: `存在 ${pending} 张待裁工单（当前参数将阻塞收口）` });
    return this.envelope({ episode: epId, checklist: cl?.id || null, close_pending: true, crossed_dialogs: crossed }, warnings);
  }

  workorderApprove(woId, quote) {
    const g = this.sovereignGate('workorder_approve', woId, quote);
    if (!g.ok) return g.rej;
    const rel = `workorders/open/${woId}.yaml`;
    const wo = this.repo.readYaml(rel);
    if (!wo) return this.reject('not_found', `工单 ${woId} 不在 open/`);
    if (wo.state !== 'proposed') return this.reject('state', `工单 ${woId} state=${wo.state}`);
    this.repo.writeYamlAtomic(rel, { ...wo, state: 'approved', approved_ts: nowIso(), approve_quote: { text: quote.text, verdict: `verified(${g.v.mode})`, digest: g.v.digest, matched: g.v.matched } });
    this.repo.ledgerAppend({ tool: 'workorder_approve', action: 'workorder_approve', target: woId, msg: wo.kind, result: 'ok', quote: quote.text, quote_digest: g.v.digest, quote_verdict: 'verified', matched_span: g.v.matched[0] });
    const name = wo.kind === 'negate' ? '钉档（永久退出，带历史全序列进失败库；平反唯一通道=修锚+人确认）' : wo.kind === 'promote' ? '晋升（canon 出口，双向链，账不毁）' : 'decisive 授予（永不截断 + 会话开始强制对齐校验）';
    return this.envelope({ workorder: woId, kind: wo.kind, state: 'approved' }, [{ code: 'deferred_effect', msg: `${name}：批准 ≠ 生效——在下次全评并入（I4 重锚类永不即时）` }]);
  }

  // ============ D 评估事务面（3） ============

  assessOpen(trigger) {
    const idx = this.repo.loadIndex(); const p = this.p;
    if (idx.assess_open) return this.reject('tx_open', `已有未发布工单 ${idx.assess_open.id}（同一时刻至多一个事务，I1）。先 assess_publish 或补完提交`, { ticket: idx.assess_open.id, scope_left: (idx.assess_open.scope || []).length });
    if (trigger !== 'T1' && trigger !== 'T2') return this.reject('schema', "trigger ∈ T1|T2（T3 不单独触发，在收口全评中升格为重锚）");
    if (idx.episode && !idx.close_pending) return this.reject('episode_open', '开放清单执行期暂停一切评估（§4.4）：T1 不触发、T2 豁免。收口需使用者宣告 → episode_close', { episode: idx.episode.id });
    if (trigger === 'T2' && idx.episode) return this.reject('t2_exempt', 'T2 在清单开放期豁免（I3）：在途变化是已知失效（flux）非静默过期，无需打断');
    void p;
    const { k } = this.repo.pinned();
    const pkg = this.repo.readPackage(k);
    const flux = new Set(this.effectiveFlux(pkg));
    const { dirty } = S.scanDirty(this.repo.projectRoot, pkg);
    const isBootstrap = k === 0;
    const dirtyNodes = dirty.filter(d => !flux.has(d.node) && !this.inFluxModule(pkg, d.node, flux));
    const backlog = this.repo.backlogOpen();
    const approved = this.listWorkorders('approved');
    const A = S.calibrateA(pkg, p);
    const edgeCands = Object.entries(pkg.edge_state || {});
    const structural = backlog.filter(b => b.structural);
    const needsFull = isBootstrap || !!idx.close_pending || trigger === 'T2' || backlog.length > 0 || approved.length > 0
      || edgeCands.some(([, s]) => s.n >= A) || dirtyNodes.some(d => d.kind === 'claim-stale') || structural.length > 0;
    const reasons = [];
    if (isBootstrap) reasons.push('B₀：项目启动全量打分（§4.1）');
    if (idx.close_pending) reasons.push(`清单收口（${idx.close_pending.cl_id || idx.close_pending.ep_id}）→ 一律全评+重锚（§4.4）`);
    if (trigger === 'T2') reasons.push('T2 兜底一律全评（I3）');
    if (backlog.length) reasons.push(`backlog ${backlog.length} 条待验证（快评遇非空 backlog 升全评，§4.3）`);
    if (approved.length) reasons.push(`已批工单 ${approved.length} 张待并入`);
    if (structural.length) reasons.push(`T3 结构声称积压 → 收口全评升格重锚候选`);
    if (edgeCands.some(([, s]) => s.n >= A)) reasons.push('边缘区达归档周期 A → 销账并入');

    // 机械 workset：确定性部分全在这一步
    const scope = new Set();
    for (const d of dirtyNodes) scope.add(d.node);
    for (const w of approved) scope.add(w.ref);
    for (const [id] of edgeCands) scope.add(id);
    const resumes = [];
    const blRefs = new Set(this.repo.backlogOpen().flatMap(b => (b.code_refs || []).map(S.stripRev)));
    for (const [id, rec] of Object.entries(pkg.archived || {})) {
      if (rec.verdict === 'negated') continue; // 钉档不自动复活（唯一例外：修锚+人批准）
      const refs = (rec.evidence?.refs || rec.code_refs || []).map(S.stripRev);
      if (!refs.length) continue;
      if (refs.some(r => blRefs.has(r))) { resumes.push({ id, reason: '未来讨论/声称重新点名引用（§2.6 复活通道二）' }); continue; }
      const h = hashEvidence(this.repo.projectRoot, refs);
      // “其 hash 重新变脏”= 引用存在且内容变；被删除（missing）不是复活信号，是销账（§2.6）
      if (h.src_hash && !h.anyMissing && rec.last_evidence_hash && h.src_hash !== rec.last_evidence_hash) resumes.push({ id, reason: 'hash 重新变脏 → 下全评 resumed（自边缘区回拨）' });
    }
    for (const r of resumes) scope.add(r.id);

    const t = 'a-' + pad4((idx.counters?.seq || 0) + 1);
    mkdirSync(path.join(this.repo.root, 'assess', t), { recursive: true });
    writeFileSync(path.join(this.repo.root, 'assess', t, 'draft.jsonl'), '', 'utf8');
    this.repo.updateIndex(i => {
      i.assess_open = { id: t, trigger, kind: needsFull ? 'full' : 'fast', scope: [...scope], reanchor: !!idx.close_pending || isBootstrap, pinned_k: k, created_ts: nowIso(), resumes: resumes.map(x => x.id) };
    });
    this.repo.ledgerAppend({ tool: 'assess_open', action: 'assess:open', target: t, msg: `${trigger}:${needsFull ? 'full' : 'fast'}:scope=${scope.size}`, result: 'ok' });
    return this.envelope({
      ticket: t, trigger, kind: needsFull ? 'full' : 'fast', needs_full_reasons: reasons,
      reanchor: !!idx.close_pending || isBootstrap,
      hash_hits: dirtyNodes, backlog, workorders_approved: approved.map(w => ({ id: w.id, kind: w.kind, ref: w.ref })),
      edge_candidates: edgeCands.map(([id, s]) => ({ id, n: s.n, A })), archive_candidates: edgeCands.filter(([, s]) => s.n >= s.A).map(([id]) => id),
      resume_candidates: resumes, scope: [...scope],
      scope_note: isBootstrap ? '启动期 scope 为空：以 assess_submit(op:add) 建立 B₀ 全部节点，publish 即锚定 B₁' : 'scope 内每节点必须有 change 或 no_change 之一（§10-D 覆盖率检查：publish 时集合运算，缺一拒发布）',
    }, flux.size ? [{ code: 'flux_scope_note', msg: `${flux.size} 个 flux 模块的脏检查被排除（在途变化已知失效；收口重锚时全量补打分）` }] : []);
  }

  inFluxModule(pkg, nodeId, fluxSet) {
    for (const m of S.allModules(pkg)) if (fluxSet.has(m.id)) {
      if (m.id === nodeId) return true;
      for (const c of m.contents || []) if (c.id === nodeId) return true;
    }
    return false;
  }

  // 逐节点提交（R1 裁决②）：坏一笔不毁一单
  assessSubmit(t, nodeRef, change) {
    const idx = this.repo.loadIndex();
    const ticket = idx.assess_open;
    if (!ticket) return this.reject('no_ticket', '无开放评估工单：先 assess_open');
    if (ticket.id !== t) return this.reject('tx_mismatch', `工单不匹配（当前开放 ${ticket.id}）`);
    if (ticket.pinned_k !== idx.latest) return this.reject('pin_conflict', `工单基于 v${pad4(ticket.pinned_k)} 但 latest 已是 v${pad4(idx.latest)}（并发违例）`);
    if (!nodeRef) return this.reject('schema', 'node_ref 必填（单节点单笔）');
    const draft = this.repo.readJsonl(`assess/${t}/draft.jsonl`).filter(d => d.kind !== 'sealed');
    if (change == null) return this.reject('schema', 'change 必填；无变化用 {no_change:true, reason}（或 no_change 工具）');
    if (change.no_change) {
      if (!change.reason) return this.reject('schema', 'no_change 必须带 reason（防止无阅读划过的评估剧场，I9）');
      if (!ticket.scope.includes(nodeRef) && ticket.scope.length) return this.reject('out_of_scope', `no_change(${nodeRef})：不在工单集合，无需提交`, { scope_size: ticket.scope.length });
      this.repo.appendJsonl(`assess/${t}/draft.jsonl`, { ts: nowIso(), node: nodeRef, kind: 'no_change', reason: change.reason });
      return this.envelope({ accepted: true, node: nodeRef, kind: 'no_change', submitted: draft.length + 1 });
    }
    const isBacklog = String(nodeRef).startsWith('b-');
    if (isBacklog && change.op === 'reject_backlog') {
      this.repo.appendJsonl(`assess/${t}/draft.jsonl`, { ts: nowIso(), node: nodeRef, kind: 'change', change });
      return this.envelope({ accepted: true, node: nodeRef, op: 'reject_backlog', note: '未通过验证门：不改分，留痕供脉冲归因（§4.3 第1步）' });
    }
    if (isBacklog) return this.reject('schema', `backlog 条目 ${nodeRef} 只接受 op:reject_backlog（准入自动在 publish 完成）`);
    // 完备性机械校验（I6/I7 的可判定部分）
    if (change.op !== 'add' || change.kind !== 'claim' || !change.assert) { /* content/module add also need evidence */ }
    if (!change.evidence || !change.evidence.refs?.length) return this.reject('evidence_missing', '每笔必带 evidence.refs——无证据链的分数不合法（§2.3/I7）');
    const v = this.validateRefs(change.evidence.refs);
    if (!v.ok) return this.reject('anchor_violation', v.reason);
    if (!change.src_hash) return this.reject('evidence_missing', '每笔必带 src_hash（验证到的现状哈希）');
    if (!['code_changed', 'attention_moved', 'initial_mistake'].includes(change.cause))
      return this.reject('cause_missing', '验证结论三成因必居其一（§4.3）：code_changed | attention_moved | initial_mistake');
    const h = hashEvidence(this.repo.projectRoot, change.evidence.refs.map(S.stripRev));
    if (h.src_hash && h.src_hash !== change.src_hash)
      return this.reject('src_hash_mismatch', '未经阅读验证的改分非法（I6）：src_hash 与现状不符', { expected: h.src_hash, got: change.src_hash });
    const pkg = this.repo.readPackage(ticket.pinned_k);
    const exists = S.findNode(pkg, nodeRef);
    if (change.op === 'add') {
      if (exists) return this.reject('dup_node', `节点 ${nodeRef} 已存在——update 用无 op 的提交`);
      if (!['module', 'content', 'claim'].includes(change.kind)) return this.reject('schema', 'op:add 需 kind ∈ module|content|claim');
    } else if (!exists || exists.kind === 'archived') {
      if (ticket.scope.includes(nodeRef) && (ticket.resumes || []).includes(nodeRef)) { /* resume补分 */ }
      else return this.reject('node_not_found', `节点 ${nodeRef} 不在包（新节点用 op:add）`);
    } else if (change.sigma != null && change.op === 'remove') {
      return this.reject('schema', 'op:remove 不带分值');
    }
    if (change.op === 'remove' && !change.reason) return this.reject('schema', 'remove 需 reason（区分销账合并 vs 否定候选）');
    this.repo.appendJsonl(`assess/${t}/draft.jsonl`, { ts: nowIso(), node: nodeRef, kind: 'change', change });
    this.repo.ledgerAppend({ tool: 'assess_submit', action: 'assess:submit', target: `${t}:${nodeRef}`, result: 'ok' });
    const warnings = ticket.scope.length && !ticket.scope.includes(nodeRef) && change.op !== 'add'
      ? [{ code: 'out_of_scope_but_allowed', msg: `${nodeRef} 不在 workset 但允许提交（收口全评自由触碰；覆盖率检查只强制 scope 内）` }] : [];
    return this.envelope({ accepted: true, node: nodeRef, op: change.op || 'update', submitted: draft.length + 1, scope_left: ticket.scope.filter(s => !draft.some(d => d.node === s) && s !== nodeRef).length }, warnings);
  }

  assessNoChange(t, nodeRef, reason) {
    return this.assessSubmit(t, nodeRef, { no_change: true, reason });
  }

  assessPublish(t) {
    const repo = this.repo, idx = repo.loadIndex(), p = this.p;
    const ticket = idx.assess_open;
    if (!ticket) return this.reject('no_ticket', '无开放评估工单');
    if (ticket.id !== t) return this.reject('tx_mismatch', `工单不匹配（当前 ${ticket.id}）`);
    if (idx.latest !== ticket.pinned_k) return this.reject('pin_conflict', `latest 已从 v${pad4(ticket.pinned_k)} 前进：整体回滚（工单保持 open）`);
    const draft = repo.readJsonl(`assess/${t}/draft.jsonl`).filter(d => d.kind !== 'sealed');
    // 覆盖率检查 = 集合运算（§10-D）："未闭环变更全部并入"从此不是纪律
    const covered = new Set(draft.map(d => d.node));
    const missing = (ticket.scope || []).filter(id => !covered.has(id));
    if (missing.length)
      return this.reject('coverage_incomplete', `发布拒绝：workset 内 ${missing.length} 节点缺 change/no_change（坏一笔不毁一单——补交后重试本 publish）`, { missing: missing.slice(0, 30) });
    if (ticket.kind === 'fast' && draft.some(d => d.change && ['add', 'remove', 'merge'].includes(d.change.op)))
      return this.reject('needs_full', '结构操作（add/remove/merge）属重锚类，只在全评做（I4）：工单作废重开将自动升格全评', null);

    const pkg = clone(this.repo.readPackage(ticket.pinned_k));
    const applied = []; const structuralOps = [];
    const anchorVal = id => { const f = S.findNode(pkg, id); if (!f || f.kind === 'archived') return null; const n = f.node; return n.sigma ?? n.tau ?? n.sess_sigma ?? n.score?.tau ?? null; };
    // ① 声称验证→打分：逐节点应用（每笔都带验证记录，I9）
    try {
      for (const d of draft) {
        const c = d.change;
        if (d.kind === 'no_change') { applied.push({ node: d.node, op: 'no_change' }); continue; }
        if (c.op === 'add') { applied.push(this.applyAdd(pkg, d.node, c)); structuralOps.push(d.node); continue; }
        if (c.op === 'remove' || c.op === 'merge') {
          const r = this.applyRemove(pkg, d.node, c, idx.latest + 1);
          if (r) applied.push({ node: d.node, op: c.op });
          structuralOps.push(d.node); continue;
        }
        const r = this.applyUpdate(pkg, d.node, c);
        if (!r.ok) throw Object.assign(new Error(`节点 ${d.node}: ${r.reason}`), { code: 'apply_failed' });
        applied.push({ node: d.node, op: 'update', cause: c.cause });
        if (c.cause === 'initial_mistake') this.noteAnchorFix(pkg, d.node, c);
      }
    } catch (e) {
      return this.reject('apply_failed', `整体回滚：${e.message}（包未写、INDEX 未换、读面仍返回旧版，I1）`, null, [{ code: 'tx_aborted', msg: '工单保持 open' }]);
    }
    // ② backlog 声称验证（hash 检查自动兜住不漏账；验证通过节点才参与上面的打分）
    const backlog = repo.backlogOpen();
    const rejectedBacklog = new Set(draft.filter(d => d.change?.op === 'reject_backlog').map(d => d.node)); // 阅读裁决"描述失实"→不改分只留痕
    const backlogVerdicts = [];
    for (const b of backlog) {
      if (rejectedBacklog.has(b.id)) { backlogVerdicts.push({ id: b.id, verdict: 'rejected留痕（未通过验证门：不改分，供脉冲归因，§4.3）' }); continue; }
      const dup = S.allClaimsList(pkg).some(x => x.assert === b.assert);
      if (dup) { backlogVerdicts.push({ id: b.id, verdict: 'already_in_package' }); continue; }
      const nid = this.addClaimNode(pkg, b, idx.latest + 1);
      backlogVerdicts.push({ id: b.id, verdict: 'admitted_new_claim', node: nid, hash_verified: b.src_hash_at_claim });
    }
    // ③ 已批工单并入（三出口的人手端；归档=④ 全自动）
    const woEffects = [];
    for (const w of this.listWorkorders('approved')) {
      const f = S.findNode(pkg, w.ref);
      if (!f || f.kind === 'archived') { woEffects.push({ wo: w.id, kind: w.kind, verdict: 'void_node_gone' }); moveWoClosed(repo, w); continue; }
      if (w.kind === 'negate') { negateNode(pkg, w, idx.latest + 1); woEffects.push({ wo: w.id, verdict: 'negated@r' + (idx.latest + 1), node: w.ref }); }
      else if (w.kind === 'promote') { promoteNode(pkg, w, p, idx.latest + 1); woEffects.push({ wo: w.id, verdict: 'promoted@r' + (idx.latest + 1), node: w.ref, target: w.canon_target }); }
      else if (w.kind === 'decisive') { f.node.decisive = true; woEffects.push({ wo: w.id, verdict: 'decisive_granted', node: w.ref }); }
      moveWoClosed(repo, w);
    }
    // ④ 归一 → 边缘区计数 → 归档销账（全评并入；重锚类）→ 再归一
    S.normalizePkg(pkg);
    const A = S.calibrateA(pkg, p);
    const { archiveCands } = S.edgeSweep(pkg, { ...p, A });
    const archivedNow = [];
    if (ticket.kind === 'full') {
      for (const id of archiveCands) {
        const r = archiveNode(pkg, id, 'retired', idx.latest + 1, `边缘区持续 ≥A=${A} 轮：注意力衰减→归档（轨道一，非证伪，可复活）`);
        if (r) { archivedNow.push(id); delete pkg.edge_state[id]; }
      }
      if (archivedNow.length) S.normalizePkg(pkg);
    }
    // ⑤ 复活（resumed：自边缘区回拨重新归一）
    const resumedNow = [];
    for (const rid of ticket.resumes || []) {
      const rec = pkg.archived?.[rid];
      if (rec && rec.verdict !== 'negated') {
        resumeNode(pkg, rid, rec); resumedNow.push(rid);
        rec.resumed_at_round = idx.latest + 1; // 墓碑保留，标记复活（账不毁但状态可见）
        repo.appendJsonl('drift/events.jsonl', { ts: nowIso(), r: idx.latest + 1, event: 'resumed', id: rid });
      }
    }
    if (resumedNow.length) S.normalizePkg(pkg);
    // ⑥ hash 刷新（发布前全量重算入包，为下轮脏扫描的基线）
    refreshHashes(pkg, repo.projectRoot);
    // ⑦ 漂移点（单轮语义：重构期间只落一点）
    const anchorK = pkg.segment?.anchor;
    const anchorPkg = anchorK ? this.repo.readPackage(anchorK) : null;
    const d = S.driftDistance(pkg, anchorPkg);
    const newK = idx.latest + 1;
    const triggerFinal = (ticket.reanchor && idx.close_pending) ? 'T3' : ticket.trigger;
    const point = { r: newK, d, t: triggerFinal, g: idx.close_pending ? (idx.close_pending.crossed_dialogs ?? 0) : (idx.counters?.dialogs_since_eval || 0), ep: idx.close_pending?.ep_id || null, ts: nowIso() };
    // ⑧ 重锚 or 续段
    let segmentS = pkg.segment?.s || 0;
    if (ticket.reanchor) {
      segmentS = (pkg.segment?.s || 0) + 1;
      pkg.anchor_events = pkg.anchor_events || [];
      pkg.anchor_events.push({
        r: newK, s: segmentS, at: nowIso(),
        kind: idx.close_pending ? 'checklist_reanchor' : (isBootstrapTicket(ticket) ? 'bootstrap_B0' : 'structural_reanchor'),
        checklist: idx.close_pending?.cl_id || null, ep: idx.close_pending?.ep_id || null,
        summary: idx.close_pending?.cl_id ? (repo.readYaml(`checklists/${idx.close_pending.cl_id}.yaml`)?.items || []).map(i => `${i.op}:${i.ref}(${i.intent})`) : ['全量打分'],
        modules_touched: [...new Set(applied.map(a => topModule(pkg, a.node)).filter(Boolean))],
        structure_changes: structuralOps.length,
        crossed_dialogs: point.g,
      });
      pkg.segment = { s: segmentS, anchor: newK };
    }
    // ⑨ 序列记录（每活跃节点 {r,v}）
    recordHist(pkg, newK);
    // ⑩ 自检 + 写不可变快照 + 原子换 INDEX（P1）
    pkg.version = { k: newK, parent: ticket.pinned_k };
    pkg.trigger = triggerFinal;
    pkg.episode = idx.close_pending ? { id: idx.close_pending.ep_id, kind: 'refactor', checklist: idx.close_pending.cl_id, status: 'closed' } : pkg.episode || null;
    pkg.built_at = { rev: headRev(repo.projectRoot), session_count: idx.counters?.dialogs_total || 0, gap_from_prev: point.g };
    pkg.flux = [];
    pkg.resolution = pkg.resolution || { tier_by_module: {}, n_units: 0, cap: p.N_cap };
    pkg.resolution.n_units = countUnits(pkg);
    pkg.corpora.dialogue = pkg.corpora.dialogue || { sessions: [] };
    pkg.corpora.dialogue.resolution = { tier: 'claim', n_claims: S.activeClaims(pkg).length, claim_cap: p.claim_cap, archive_cycle_A: A };
    pkg.created_ts = nowIso();
    pkg.self_check = runSelfCheck(pkg, p);
    if (!pkg.self_check.ok)
      return this.reject('self_check_failed', `自检未过（Σ归一/证据齐全）：${pkg.self_check.problems.join('；')}——整体回滚，工单保持 open`, null, [{ code: 'tx_aborted', msg: '读面仍返回旧版（P1：崩溃在任何时刻要么旧版要么新版）' }]);
    try {
      repo.writePackage(newK, pkg);
    } catch (e) {
      return this.reject('write_conflict', `快照写入冲突：${e.message}（并发/锁违例，回滚）`);
    }
    repo.appendJsonl('drift/points.jsonl', point);
    for (const id of new Set([...archivedNow, ...resumedNow, ...woEffects.map(x => x.node).filter(n => pkg.archived?.[n])])) writeTombIfNeeded(repo, pkg, id);
    this.repo.updateIndex(i => {
      i.latest = newK; i.segment = Math.max(i.segment || 0, segmentS);
      i.anchor = ticket.reanchor ? newK : (i.anchor || newK);
      i.assess_open = null; i.close_pending = null; i.flux = [];
      i.counters.dialogs_since_eval = 0;
      i.published_versions = i.published_versions || [];
      i.published_versions.push({ k: newK, digest: 'sha256:' + sha256(Y.dump(pkg)).slice(0, 16), digest_file: 'sha256:' + sha256(readFileSync(repo.pkgPath(newK))).slice(0, 16), at: nowIso() });
      i.params_overrides = { ...(i.params_overrides || {}), A };
      i.last_publish_ts = nowIso();
      if (idx.episode == null && i.counters) i.counters.dialogs_since_open = 0;
    });
    // 会话钉版（规则1）：钉的是外因换版；本进程自己的 publish 推进 pin，会话内继续评估不被 pin_conflict 锁死
    if (repo.role === 'writer' && repo._pin != null) repo._pin = newK;
    if (backlog.length) repo.markBacklog(backlog.map(b => b.id), newK);
    repo.appendJsonl(`assess/${t}/draft.jsonl`, { kind: 'sealed', package: newK, ts: nowIso(), order: draft.map(x => ({ node: x.node, op: x.kind === 'change' ? (x.change?.op || 'update') : 'no_change' })) }); // 封存保留评估次序（审计材料：先打的分有没有锚定后打的分）
    repo.ledgerAppend({ tool: 'assess_publish', action: 'assess:publish', target: t, msg: `v${pad4(newK)}:${ticket.kind}${ticket.reanchor ? ':reanchor' : ''}`, result: 'ok' });
    let reportFile = null;
    if ((newK - 1) % p.M === 0 && newK > 1) { const r = this.driftReport(); reportFile = r.report; }
    const warnings = [];
    if (ticket.reanchor) warnings.push({ code: 'reanchor_done', msg: `重锚完成：新段 s=${segmentS}、新锚 B_${segmentS}=v${pad4(newK)}；flux 清空、backlog 并入验证（${backlogVerdicts.filter(x => x.verdict === 'admitted_new_claim').length} 条新 claim）` });
    if (archivedNow.length) warnings.push({ code: 'auto_archived', msg: `${archivedNow.length} 节点边缘持续 ≥A 自动归档（轨道一全自动；archive_get 可查、可复活，误归档无害）`, nodes: archivedNow });
    if (reportFile) warnings.push({ code: 'report_exported', msg: `满 M=${p.M} 评估：五段报表已自动导出 ${reportFile}（§4.6）` });
    return this.envelope({
      published: newK, parent: ticket.pinned_k, kind: ticket.kind, reanchor: !!ticket.reanchor, segment: segmentS,
      drift_point: point, coverage: { scope: (ticket.scope || []).length, submitted: draft.length },
      applied: applied.length, structural_ops: structuralOps.length,
      archived: archivedNow, resumed: resumedNow, workorders: woEffects, backlog_verdicts: backlogVerdicts,
      A_effective: A, self_check: pkg.self_check,
    }, warnings, { units: pkg.resolution.n_units, cap: p.N_cap });
  }

  // ---- 逐节点变更应用 ----
  applyAdd(pkg, id, c) {
    const src = c.src_hash;
    if (c.kind === 'module') {
      if (S.allModules(pkg).some(m => m.id === id)) throw Object.assign(new Error(`模块 ${id} 已存在`), { code: 'dup' });
      pkg.corpora.code.modules.push({ id, ref: c.ref || c.evidence.refs[0], sigma: c.sigma ?? 0.01, summary: c.summary || '', status: 'active', evidence: { refs: c.evidence.refs, src_hash: src }, hist: [] });
      pkg.resolution = pkg.resolution || { tier_by_module: {}, n_units: 0, cap: this.p.N_cap };
      pkg.resolution.tier_by_module[id] = c.tier || 'L2';
      if ((c.contents_hint || 0) > this.p.tau_band[1]) warnings_add(pkg, `${id} 单元爆带 → 建议上抬一档`);
      return { node: id, op: 'add', kind: 'module' };
    }
    if (c.kind === 'content') {
      const m = S.allModules(pkg).find(x => x.id === c.module);
      if (!m) throw Object.assign(new Error(`父模块 ${c.module} 不存在`), { code: 'bad_parent' });
      m.contents = m.contents || [];
      if (m.contents.some(x => x.id === id)) throw Object.assign(new Error(`单元 ${id} 已存在`), { code: 'dup' });
      m.contents.push({ id, tau: c.tau ?? 0.01, status: 'active', evidence: { refs: c.evidence.refs, src_hash: src }, hist: [] });
      return { node: id, op: 'add', kind: 'content' };
    }
    if (c.kind === 'claim') {
      if (!c.assert) throw Object.assign(new Error('claim add 需 assert'), { code: 'schema' });
      const sessId = ((c.span || '').match(/dialog:\/\/([^#]+)/) || [])[1] || c.sess || this.repo.sessionId;
      let s = (pkg.corpora.dialogue.sessions = pkg.corpora.dialogue.sessions || []).find(x => x.id === sessId);
      if (!s) { s = { id: sessId, closed: !!DG.loadMeta(this.repo.root, String(sessId).replace(/^sess-/, ''))?.sealed || false, sess_sigma: 0.01, status: 'active', claims: [] }; pkg.corpora.dialogue.sessions.push(s); }
      s.claims = s.claims || [];
      if (s.claims.some(x => x.id === id)) throw Object.assign(new Error(`claim ${id} 已存在`), { code: 'dup' });
      s.claims.push({ id, assert: c.assert, span: c.span || null, code_refs: c.code_refs, src_hash_at_claim: src,
        validity: 'valid', decisive: false, status: 'active', score: { tau: c.tau ?? 0.01, edge: null, hist: [] } });
      return { node: id, op: 'add', kind: 'claim' };
    }
    throw Object.assign(new Error(`未知 add kind: ${c.kind}`), { code: 'schema' });
  }

  applyUpdate(pkg, id, c) {
    const f = S.findNode(pkg, id);
    if (!f || f.kind === 'archived') return { ok: false, reason: '节点不存在或已退出（退出节点回拨用复活通道，勿直接 update）' };
    const n = f.node;
    if (c.sigma != null && (f.kind === 'module')) n.sigma = c.sigma;
    if (c.tau != null) { if (f.kind === 'claim') n.score.tau = c.tau; else if (f.kind === 'content') n.tau = c.tau; else if (f.kind === 'session') n.sess_sigma = c.tau; }
    if (c.sigma != null && f.kind === 'session') n.sess_sigma = c.sigma;
    if (c.summary != null) n.summary = c.summary;
    if (c.assert != null && f.kind === 'claim') n.assert = c.assert;
    if (c.evidence && f.kind !== 'claim') n.evidence = { refs: c.evidence.refs, src_hash: c.src_hash };
    if (f.kind === 'claim') {
      if (c.validity) { if (!['valid', 'stale'].includes(c.validity) && !c.validity.startsWith('superseded→') && c.validity !== 'negated') return { ok: false, reason: `validity 非法: ${c.validity}` }; n.validity = c.validity; }
      if (c.refresh_hash) n.src_hash_at_claim = c.src_hash;
    }
    return { ok: true };
  }

  applyRemove(pkg, id, c, atRound) {
    const f = S.findNode(pkg, id);
    if (!f || f.kind === 'archived') return null;
    if (c.cause === 'code_changed' && /删除|被证明错误|无留存价值/.test(c.reason || '') && !c.archived_as) {
      // 提示：真否定走工单；此处只归档（I10：无批准不得钉档）
    }
    archiveNode(pkg, id, 'retired', atRound, `${c.op === 'merge' ? 'merged/迁移销账' : 'deleted@reanchor'}——销账合并非否定（§2.6），账不毁`);
    return f;
  }

  noteAnchorFix(pkg, id, c) {
    pkg.anchor_fixes = (pkg.anchor_fixes || []);
    pkg.anchor_fixes.push({ ts: nowIso(), node: id, cause: 'initial_mistake（唯一修锚通道，§4.3 成因③——钉档平反唯一入口）', evidence: c.evidence?.refs });
  }

  addClaimNode(pkg, b, atRound) {
    const sessId = ((b.span || '').match(/dialog:\/\/([^#]+)/) || [])[1] || 'inline';
    const sessions = (pkg.corpora.dialogue.sessions = pkg.corpora.dialogue.sessions || []);
    let s = sessions.find(x => x.id === sessId);
    if (!s) { s = { id: sessId, closed: sessId !== 'inline', sess_sigma: 0.01, status: 'active', claims: [] }; sessions.push(s); }
    s.claims = s.claims || [];
    const id = `c-${sessId}-${pad4(s.claims.length + 1)}r${atRound}`;
    s.claims.push({ id, assert: b.assert, span: b.span || null, code_refs: b.code_refs, src_hash_at_claim: b.src_hash_at_claim,
      validity: 'valid', decisive: false, status: 'active', score: { tau: 0.01, edge: null, hist: [] } });
    return id;
  }

  // ============ E 报表面（2） ============

  driftReport() {
    const idx = this.repo.loadIndex(), p = this.p;
    const pkg = this.repo.readPackage(idx.latest);
    const points = this.repo.driftPoints();
    const L = [];
    const rTag = pad4(idx.latest);
    L.push(`# 漂移报表 r${rTag} —— 双包协议 §4.6 五段式`);
    L.push(`生成 ${nowIso()} · 包 v${rTag} · 段 s=${pkg.segment?.s} · 锚 B${pkg.segment?.s}=v${pad4(pkg.segment?.anchor || 0)} · M=${p.M}`);
    L.push('');
    L.push('## ① 节点账表');
    L.push('| 节点 | 现值 | 漂移序列(展开) | 分类 | 工单号/处置 |');
    L.push('|---|---|---|---|---|');
    const rowsFor = [];
    const rowOf = (id, v, hist, disp) => {
      const series = (hist || []).map(x => `${x.r}:${x.v}`).join('→');
      const cls = hist && hist.length > 1 ? S.classifySeries(hist[0].v, hist.slice(1).map(x => x.v)).kind : '—';
      const edge = (pkg.edge_state || {})[id];
      rowsFor.push({ id, cls });
      return `| ${id} | ${v ?? '—'} | ${series || '—'} | ${cls}${edge ? ` ·edge(${edge.n}/${edge.A})` : ''} | ${disp || '—'} |`;
    };
    for (const m of S.activeModules(pkg)) {
      L.push(rowOf(m.id, m.sigma, m.hist, m.status && m.status !== 'active' ? m.status : ''));
      for (const c of m.contents || []) if (!c.status || c.status === 'active') L.push(rowOf(c.id, c.tau, c.hist));
    }
    for (const s of pkg.corpora?.dialogue?.sessions || []) for (const c of s.claims || [])
      if (!c.status || c.status === 'active') L.push(rowOf(c.id, c.score?.tau, c.score?.hist, [c.validity !== 'valid' ? c.validity : '', c.decisive ? 'decisive' : ''].filter(Boolean).join('|')));
    for (const [id, rec] of Object.entries(pkg.archived || {}))
      L.push(`| ${id} | 冻结 ${(rec.last_score ?? '—')}${rec.resumed_at_round ? `（已于 r${rec.resumed_at_round} 复活）` : ''} | ${(rec.hist || []).map(x => `${x.r}:${x.v}`).join('→') || '—'} | ${rec.verdict === 'negated' ? '钉档(失败库)' : rec.verdict === 'promoted' ? '晋升canon' : rec.resumed_at_round ? '复活回归' : '归档(可复活)'} | ${rec.reason || ''} @r${rec.at_round ?? '—'} |`);
    L.push('');
    L.push('## ② 锚事件时间线（B₀→B₁→…）');
    if (!(pkg.anchor_events || []).length) L.push('- （无重锚记录）');
    for (const ev of pkg.anchor_events || [])
      L.push(`- **r${ev.r} → 开段 s=${ev.s}**（${ev.kind}，${ev.at}）${ev.checklist ? ` 清单 ${ev.checklist}:` : ''} ${(ev.summary || []).join('；')} | 涉及模块 [${(ev.modules_touched || []).join(', ')}] | 结构变化 ${ev.structure_changes ?? 0} 处 | 跨 ${ev.crossed_dialogs ?? '—'} 对话`);
    for (const fx of pkg.anchor_fixes || []) L.push(`- 锚定修正（初评错了）：${fx.node} @${fx.ts}`);
    L.push('');
    L.push('## ③ 汇总');
    const counts = { trend: 0, pulse: 0, oscillation: 0 };
    for (const r of rowsFor) if (counts[r.cls] != null) counts[r.cls]++;
    L.push(`- 趋势 ${counts.trend} · 脉冲 ${counts.pulse} · 震荡 ${counts.oscillation}（震荡→§2.4 重划工单；趋势→重锚候选。g 大的点引发趋势权重应更高——校准期观察项 §4.5）`);
    const modSort = [...S.activeModules(pkg)].sort((a, b) => b.sigma - a.sigma);
    L.push(`- top-movers 升幅前5: ${modSort.slice(0, 5).map(m => `${m.id}(σ=${m.sigma})`).join(', ')} ｜ 降幅前5: ${modSort.slice(-5).reverse().map(m => `${m.id}(σ=${m.sigma})`).join(', ')}`);
    L.push(`- 漂移序列: ${points.map(x => `r${x.r}{d:${x.d},t:${x.t},g:${x.g}${x.ep ? ',' + x.ep : ''}}`).join(' ') || '（空）'}`);
    L.push(`- 分辨率演化: ${JSON.stringify(pkg.resolution?.tier_by_module || {})}（n_units=${pkg.resolution?.n_units}/${p.N_cap}）`);
    L.push(`- 未闭环工单: ${this.listWorkorders('proposed').length} proposed + ${this.listWorkorders('approved').length} approved；边缘区在册 ${Object.keys(pkg.edge_state || {}).length}`);
    L.push('');
    L.push('## ④ canon 与出入账（对话侧）');
    const since = lastReportR(this.repo) || 0;
    const evAll = this.repo.readJsonl('drift/events.jsonl');
    const inWindow = (e) => !e.r || e.r > since;
    const promoted = Object.entries(pkg.archived || {}).filter(([, r]) => r.verdict === 'promoted' && inWindow({ r: r.at_round }));
    const retired = Object.entries(pkg.archived || {}).filter(([, r]) => r.verdict === 'retired' && inWindow({ r: r.at_round }) && !r.resumed_at_round);
    const negated = Object.entries(pkg.archived || {}).filter(([, r]) => r.verdict === 'negated' && inWindow({ r: r.at_round }));
    const resumed = evAll.filter(e => e.event === 'resumed' && inWindow(e));
    L.push(`- 本期晋升 ${promoted.length}：${promoted.map(([id, r]) => `${id}→${r.reason}`).join('；') || '—'}（去处链见 canon_links；仓库里只出现晋升产物=P5）`);
    L.push(`- 本期归档 ${retired.length}：${retired.map(([id]) => id).join('，') || '—'}`);
    L.push(`- 本期复活 ${resumed.length}：${resumed.map(e => e.id).join('，') || '—'}（误归档回流率=A 校准数据，§8-1）`);
    L.push(`- 本期钉档 ${negated.length}：${negated.map(([id, r]) => `${id}(${r.reason})`).join('；') || '—'}`);
    L.push('');
    L.push('## ⑤ 决定性集');
    const { dirty } = S.scanDirty(this.repo.projectRoot, pkg);
    const dirtySet = new Set(dirty.map(x => x.node));
    let anyDec = false;
    for (const c of S.activeClaims(pkg)) if (c.decisive) { anyDec = true; L.push(`- ${dirtySet.has(c.id) ? '⚠️脏→挂起待裁决' : '✓ 对齐'} ${c.id}@${c.sess_id}: ${c.assert}`); }
    if (!anyDec) L.push('- （现行 decisive 集为空）');
    const negDec = Object.entries(pkg.archived || {}).filter(([, r]) => r.verdict === 'negated' && r.was_decisive);
    for (const [id, r] of negDec) L.push(`- ★★ 被证伪的 decisive（最高优先级报告）：${id} —— ${r.reason}`);
    L.push('');
    L.push('## 附表：失败库（钉档）—— 此路曾试、不通');
    const allNeg = Object.entries(pkg.archived || {}).filter(([, r]) => r.verdict === 'negated');
    if (!allNeg.length) L.push('- （空）Q 持续>0 且集中于某模块 = 该区域方向性试错过多（诊断输出）');
    for (const [id, r] of allNeg) L.push(`- **${id}**：末值 ${r.last_score ?? '—'}｜否定理由: ${r.reason}｜反证: ${(r.counter_evidence || []).join(' , ') || '—'}｜代价: 入档 ${r.entered_ts || '?'} → r${r.at_round}｜曾 decisive=${r.was_decisive}`);
    const md = L.join('\n') + '\n';
    if (this.repo.role === 'writer') {
      mkdirSync(path.join(this.repo.root, 'drift', 'reports'), { recursive: true });
      const rf = path.join(this.repo.root, 'drift', 'reports', `r${rTag}.md`);
      writeFileSync(rf, md, 'utf8');
      this.repo.ledgerAppend({ tool: 'drift_report', action: 'report', target: `drift/reports/r${rTag}.md`, result: 'ok' });
    }
    return this.envelope({ report: this.repo.role === 'writer' ? `drift/reports/r${rTag}.md` : '(ro 角色不落盘，仅返回文本)', markdown: md });
  }

  rehearseBudget() {
    const idx = this.repo.loadIndex();
    const pkg = this.repo.readPackage(idx.latest);
    const p = this.p;
    const brief = this.startupBrief({ mode: 'mixed' });
    let expandFull = 0;
    for (const m of S.activeModules(pkg)) expandFull += estTokens(JSON.stringify((m.contents || []).map(c => ({ id: c.id, tau: c.tau, refs: c.evidence?.refs }))));
    const claimsTok = estTokens(S.activeClaims(pkg).map(c => c.assert).join('\n'));
    return this.envelope({
      measured: { startup_brief_no_trunc: brief.budget_used?.brief_tokens ?? estTokens(JSON.stringify(brief)), tau_expand_full: expandFull, dialogue_board_full: claimsTok, n_units: countUnits(pkg) },
      configured: { ...p.budget, N_cap: p.N_cap, claim_cap: p.claim_cap },
      verdict: {
        overview_tokens: expandFull > p.budget.overview_tokens * 1.2 ? '建议值偏低（实测>配置 20%+）' : 'ok',
        expand_tokens: expandFull > p.budget.expand_tokens ? '全展开超预算：懒分辨率生效中' : 'ok',
      },
      note: '600/6000 是猜的，校准靠本调用实测（§10-E）。写回 INDEX params_overrides.budget 由使用者决定',
    });
  }

  // ============ P6 replay_audit（CLI 面：重放比对，防评估剧场） ============
  audit() {
    const repo = this.repo, idx = repo.loadIndex(), problems = [];
    const rows = repo.ledgerRowsAll();
    let seq = 0;
    for (const r of rows) { if (r.seq !== ++seq) { problems.push(`ledger 序号断点：${r.seq}（期望 ${seq}）`); seq = r.seq; } }
    for (const pv of idx.published_versions || []) {
      const f = repo.pkgPath(pv.k);
      if (!existsSync(f)) { problems.push(`v${pad4(pv.k)} 快照缺失但 INDEX 声明已发布`); continue; }
      const dig = 'sha256:' + sha256(readFileSync(f)).slice(0, 16);
      if (pv.digest_file && pv.digest_file !== dig) problems.push(`★ v${pad4(pv.k)} 发布后字节漂移（P2 不可变被破坏）：${pv.digest_file} ≠ ${dig}`);
    }
    for (let kk = 1; kk <= idx.latest; kk++) {
      let pkg; try { pkg = repo.readPackage(kk); } catch (e) { problems.push(`v${pad4(kk)} 不可读: ${e.message}`); continue; }
      const mods = S.activeModules(pkg);
      if (mods.length) { const s = mods.reduce((a, m) => a + (m.sigma || 0), 0); if (Math.abs(s - 1) > 0.02) problems.push(`v${pad4(kk)} Σσ=${s.toFixed(4)}≠1`); }
      for (const m of mods) { const cs = (m.contents || []).filter(c => !c.status || c.status === 'active'); if (cs.length) { const t = cs.reduce((a, c) => a + (c.tau || 0), 0); if (Math.abs(t - 1) > 0.02) problems.push(`v${pad4(kk)} ${m.id} Στ=${t.toFixed(4)}≠1`); } }
      for (const c of S.activeClaims(pkg)) if (!c.code_refs?.length) problems.push(`v${pad4(kk)} claim ${c.id} 无锚（I7）`);
      for (const m of mods) for (const c of (m.contents || [])) {
        if ((c.evidence?.refs || []).some(r => { const pr = parseProjRef(r); return pr && !pr.symbol && pr.lineStart != null && (pr.lineEnd - pr.lineStart) <= 2; }))
          problems.push(`v${pad4(kk)} τ 单元 ${c.id} 行级锚（I7/§2.4 违例）`);
      }
      // 账本闭环：包版本必须有对应 publish 事件（"账本里没有但包里有" = 评估剧场实锤）
      if (!rows.some(r => r.action === 'assess:publish' && String(r.msg || '').includes(`v${pad4(kk)}`)))
        problems.push(`★ v${pad4(kk)} 无 ledger publish 事件（评估剧场实锤：包里有但账本里没有）`);
      // draft 封存检查
      const sealed = findDraftFor(repo, kk);
      if (!sealed) problems.push(`v${pad4(kk)} 无 draft.jsonl 封存行（审计链断，§10-D）`);
    }
    // 对话链完整性（P7）
    for (const s of DG.listDialogs(repo.root)) {
      const v = DG.verifyChain(repo.root, s);
      if (!v.ok) problems.push(`dialogs/sess-${s}: ${v.reason || 'chain break'}`);
    }
    return { ok: problems.length === 0, packages: idx.latest, ledger_rows: rows.length, dialogs: DG.listDialogs(repo.root).length, problems: problems.slice(0, 50) };
  }
}

// ---------- 模块级辅助 ----------
function warnings_add(pkg, msg) { (pkg._add_notes = pkg._add_notes || []).push(msg); }
function isBootstrapTicket(t) { return t.pinned_k === 0; }
function headRev(root) { try { return sha256(readFileSync(path.join(root, 'HEAD')) || '').slice(0, 7); } catch { return sha256(String(Date.now())).slice(0, 7); } }
function topModule(pkg, id) {
  for (const m of S.allModules(pkg)) { if (m.id === id) return m.id; for (const c of m.contents || []) if (c.id === id) return m.id; }
  return null;
}
function moveWoClosed(repo, w) {
  const src = path.join(repo.root, 'workorders/open', `${w.id}.yaml`);
  const dst = path.join(repo.root, 'workorders/closed', `${w.id}.yaml`);
  mkdirSync(path.dirname(dst), { recursive: true });
  if (existsSync(src)) renameSync(src, dst);
}
function archiveNode(pkg, id, verdict, atRound, reason) {
  const f = S.findNode(pkg, id);
  if (!f || f.kind === 'archived') return null;
  const n = f.node;
  const last = n.sigma ?? n.tau ?? n.sess_sigma ?? n.score?.tau ?? null;
  const hist = clone(n.hist || n.score?.hist || []);
  pkg.archived = pkg.archived || {};
  pkg.archived[id] = {
    verdict, at_round: atRound, reason, last_score: last, hist, kind: f.kind,
    evidence: clone(n.evidence || null), code_refs: clone(n.code_refs || null), assert: n.assert || null,
    was_decisive: !!n.decisive, counter_evidence: [], entered_ts: nowIso(),
    last_evidence_hash: n.evidence?.src_hash || n.src_hash_at_claim || null,
    canon_target: n.promoted_to || null,
  };
  n.status = verdict === 'negated' ? 'negated' : verdict === 'promoted' ? 'promoted' : 'retired';
  return pkg.archived[id];
}
function negateNode(pkg, w, atRound) {
  const rec = archiveNode(pkg, w.ref, 'negated', atRound, w.reason || '阅读裁决：结论已不成立（§2.6 轨道二）');
  if (rec) rec.counter_evidence = w.counter_evidence;
}
function promoteNode(pkg, w, p, atRound) {
  const f = S.findNode(pkg, w.ref);
  if (!f) return;
  f.node.promoted_to = w.canon_target;
  if (p.decisive_promotion === 'auto_on_promote' && f.kind === 'claim') f.node.decisive = true; // 裁决②
  const rec = archiveNode(pkg, w.ref, 'promoted', atRound, `promoted→${w.canon_target}`); // 晋升留双向链，账不毁
  pkg.canon_links = pkg.canon_links || [];
  pkg.canon_links.push({ claim: w.ref, target: w.canon_target, at: nowIso(), r: atRound });
  if (rec) rec.approve_quote = w.approve_quote?.text || null;
}
function resumeNode(pkg, id, rec) {
  if (rec.kind === 'claim') {
    for (const s of pkg.corpora.dialogue.sessions || []) for (const c of s.claims || [])
      if (c.id === id) { c.status = 'active'; c.score.tau = 0.01; c.score.edge = null; return; }
    return;
  }
  for (const m of S.allModules(pkg)) {
    if (m.id === id) { m.status = 'active'; m.sigma = 0.01; return; }
    for (const c of m.contents || []) if (c.id === id) { c.status = 'active'; c.tau = 0.01; return; }
  }
}
function refreshHashes(pkg, root) {
  const upd = (node, stored) => {
    const refs = node?.evidence?.refs;
    if (!refs?.length) return;
    const h = hashEvidence(root, refs.map(S.stripRev));
    if (h.src_hash) node.evidence.src_hash = h.src_hash;
  };
  for (const m of S.allModules(pkg)) { if (m.status && m.status !== 'active') continue; upd(m); for (const c of m.contents || []) { if (c.status && c.status !== 'active') continue; upd(c); } }
  for (const s of pkg.corpora?.dialogue?.sessions || []) for (const c of s.claims || []) {
    if (c.status && c.status !== 'active') continue;
    const refs = (c.code_refs || []).map(S.stripRev);
    if (!refs.length) continue;
    const h = hashEvidence(root, refs);
    if (h.src_hash && c.src_hash_at_claim && h.src_hash !== c.src_hash_at_claim) c.validity = c.validity === 'valid' ? 'stale' : c.validity;
    // 不静默刷新断言时 hash——那是裁决的事（①真变/②注意力/③初评错 由提交时决定）
  }
}
function recordHist(pkg, r) {
  const push = (node, v) => { const h = node.hist || (node.hist = []); h.push({ r, v: +(v || 0).toFixed(4) }); };
  for (const m of S.activeModules(pkg)) { push(m, m.sigma); for (const c of m.contents || []) if (!c.status || c.status === 'active') push(c, c.tau); }
  for (const s of S.activeSessions(pkg)) for (const c of s.claims || []) if (!c.status || c.status === 'active') { c.score.hist = c.score.hist || []; c.score.hist.push({ r, v: +(c.score.tau || 0).toFixed(4) }); }
}
function countUnits(pkg) { return S.activeModules(pkg).length + S.activeContents(pkg).length; }
function runSelfCheck(pkg, p) {
  const problems = [];
  const mods = S.activeModules(pkg);
  if (mods.length) { const s = mods.reduce((a, m) => a + m.sigma, 0); if (Math.abs(s - 1) > 0.02) problems.push(`Σσ=${s.toFixed(4)}≠1`); }
  for (const m of mods) {
    const cs = (m.contents || []).filter(c => !c.status || c.status === 'active');
    if (cs.length) { const t = cs.reduce((a, c) => a + c.tau, 0); if (Math.abs(t - 1) > 0.02) problems.push(`${m.id}:Στ=${t.toFixed(4)}≠1`); }
    if (!m.evidence?.refs?.length) problems.push(`模块 ${m.id} 无证据链（I7）`);
  }
  for (const c of S.activeClaims(pkg)) {
    if (!c.code_refs?.length) problems.push(`claim ${c.id} 无锚（I7）`);
    if ((c.code_refs || []).some(r => { const pr = parseProjRef(r); return pr && !pr.symbol && pr.lineStart != null && (pr.lineEnd - pr.lineStart) <= 2; })) problems.push(`claim ${c.id} 行级锚（I7）`);
  }
  const units = countUnits(pkg);
  if (units > p.N_cap) problems.push(`代码单元 ${units} 超 N_cap=${p.N_cap}（守定秩比较可信域——懒分辨率应已生效）`);
  const claims = S.activeClaims(pkg).length;
  if (claims > p.claim_cap) problems.push(`claims ${claims} 超 claim_cap=${p.claim_cap}`);
  return { ok: problems.length === 0, problems };
}
function writeTombIfNeeded(repo, pkg, id) {
  const rec = pkg.archived?.[id]; if (!rec) return;
  repo.writeYamlAtomic(`archive/nodes/${safe(id)}.yaml`, { id, ...rec });
}
function lastReportR(repo) {
  const dir = path.join(repo.root, 'drift', 'reports');
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir).filter(f => /^r\d+\.md$/.test(f)).map(f => +f.slice(1, -3));
  return names.length ? Math.max(...names) : 0;
}
function findDraftFor(repo, k) {
  const dir = path.join(repo.root, 'assess');
  if (!existsSync(dir)) return false;
  for (const t of readdirSync(dir)) {
    const f = path.join(dir, t, 'draft.jsonl');
    if (!existsSync(f)) continue;
    const lines = readFileSync(f, 'utf8').split(/\r?\n/).filter(x => x.trim());
    if (lines.some(l => { try { const j = JSON.parse(l); return j.kind === 'sealed' && j.package === k; } catch { return false; } })) return true;
  }
  return false;
}
