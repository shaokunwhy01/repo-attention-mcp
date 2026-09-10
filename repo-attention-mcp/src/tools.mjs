// tools.mjs — 工具面 schema 与分发（§10 五组工具；ro 角色只注册 A+E）
// I11 机制注：以下全部工具里没有 delete。I10：negate 缺反证在 propose 层即拒。
import { Core } from './core.mjs';

const quoteSchema = {
  type: 'object', required: ['text'],
  properties: {
    text: { type: 'string', description: '使用者原话（可删节不可增删实词；…为通配分段）。server 在调用瞬间对 dialogs/*.jsonl 验证——verified 是动作生效的合法条件（I12）' },
    sess_hint: { type: 'string', description: '优先检索的会话 id' },
    span_hint: { type: 'string' },
  },
};

const changeSchema = {
  type: 'object',
  description: '单节点打分提交。op 缺省=update；add 需 kind:{module|content|claim}',
  properties: {
    op: { type: 'string', enum: ['add', 'update', 'remove', 'merge'] },
    kind: { type: 'string', enum: ['module', 'content', 'claim'] },
    sigma: { type: 'number' }, tau: { type: 'number' },
    summary: { type: 'string' }, assert: { type: 'string' },
    ref: { type: 'string' }, module: { type: 'string' }, sess: { type: 'string' }, span: { type: 'string' },
    code_refs: { type: 'array', items: { type: 'string' } },
    tier: { type: 'string', enum: ['L1', 'L2', 'L3'] },
    evidence: { type: 'object', required: ['refs'], properties: { refs: { type: 'array', items: { type: 'string' }, description: 'proj://<repo>/<path>:<s>-<e>#<symbol>@<rev>（行区间仅作局部定位，禁行级锚，I7）' }, src_hash: { type: 'string' } } },
    src_hash: { type: 'string', description: '阅读验证到的现状哈希（server 与实况比对，不符拒收——I6）' },
    cause: { type: 'string', enum: ['code_changed', 'attention_moved', 'initial_mistake'], description: '三成因必居其一（§4.3）：代码真变/注意力挪了(回落产生脉冲属正常)/初评错了(唯一修锚通道)' },
    validity: { type: 'string', description: 'claim 裁决：valid|stale|superseded→<id>（stale≠否定）' },
    refresh_hash: { type: 'boolean', description: '阅读裁决"结论仍成立"→刷新断言时 hash（规则9 对齐动作）' },
    reason: { type: 'string' },
    no_change: { type: 'boolean' },
  },
};

export const TOOL_DEFS = [
  // ---- A 读面（6）：ro 可用 ----
  { group: 'A', name: 'startup_brief', ro: true, description: '会话启动卡（全协议唯一进入 system context 的东西，≤900 tok）：版本k+段s+σ全表+flux清单+T2倒计时+decisive集及逐条hash对齐校验+backlog计数。规则2/9由此一次调用完成。首次调用自动钉版（规则1，进程生命周期≈会话）。', inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['discuss', 'modify', 'mixed'], description: '使用者开场指令判定的会话模式；缺省沿用上次/保守侧' } } } },
  { group: 'A', name: 'sigma_overview', ro: true, description: '仅σ层全扫。server 调用瞬间重算全部 src_hash，对 flux 之外的变动节点挂 drift_warning——静默过期在机械上不可能（I3）。', inputSchema: { type: 'object', properties: {} } },
  { group: 'A', name: 'tau_expand', ro: true, description: 'τ 层按分降序投影命中模块；超预算降级为仅 refs 且显式声明降级（规则6）。flux 模块调用 → warning: flux_open, guidance void, read raw。', inputSchema: { type: 'object', required: ['module'], properties: { module: { type: 'string' } } } },
  { group: 'A', name: 'node_detail', ro: true, description: '单节点现账：evidence/hash/edge 计数/状态。返回值结构中不含漂移序列（I5——与 node_history 强制分开，机器级保证序列数据不顺流进打分上下文）。', inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } } },
  { group: 'A', name: 'node_history', ro: true, description: '漂移序列（仅供报表/分析，绝不作为打分输入，I5）。', inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } } },
  { group: 'A', name: 'archive_get', ro: true, description: '归档/钉档墓碑全史（含否定理由）：账不毁，永远可按引用检索（I11）；钉档=失败库可查防重蹈覆辙。', inputSchema: { type: 'object', required: ['ref'], properties: { ref: { type: 'string' } } } },
  // ---- B 登记面（4）：只入队不动账 ----
  { group: 'B', name: 'claim_record', ro: false, description: '声称入 backlog（不触发评估，§4.0 时钟寄生）。schema 强制可锚定：code_refs 锚不上代码/行级锚当场拒收（I7 机械前置）。结构意向加 structural:true → T3 backlog，在收口全评升格重锚。', inputSchema: { type: 'object', required: ['assert', 'code_refs'], properties: { assert: { type: 'string', description: '一句完整可验证断言（断+由一体）' }, code_refs: { type: 'array', items: { type: 'string' } }, span: { type: 'string', description: 'dialog://<sess>#<range>' }, decisive: { type: 'boolean', description: '提议态，需工单批准' }, structural: { type: 'boolean' } } } },
  { group: 'B', name: 'dialog_extract', ro: false, description: '收口即抽的入账口（幂等，新会话前未抽则补跑）：转写由模型解析，claims 经此提交入 backlog。不触发评估。原文必须已在盘（R1：会话中增量追加）。', inputSchema: { type: 'object', required: ['sess_id'], properties: { sess_id: { type: 'string' }, reextract: { type: 'boolean' }, claims: { type: 'array', items: { type: 'object', required: ['assert', 'code_refs'], properties: { assert: { type: 'string' }, code_refs: { type: 'array', items: { type: 'string' } }, span: { type: 'string' }, decisive: { type: 'boolean' } } } } } } },
  { group: 'B', name: 'propose_checklist', ro: false, description: '重构清单草案（draft 态不动 flux 不开工）——"agent 可起草，使用者确认后才动工"（I2）。items: 增/删/改/合并模块，每项带目标 ref+意图一句话。', inputSchema: { type: 'object', required: ['items'], properties: { kind: { type: 'string', enum: ['refactor', 'minor'] }, items: { type: 'array', items: { type: 'object', required: ['ref'], properties: { op: { type: 'string', enum: ['add', 'remove', 'modify', 'merge'] }, ref: { type: 'string' }, intent: { type: 'string' } } } } } } },
  { group: 'B', name: 'propose_workorder', ro: false, description: '三种出口的人工闸门提案：promote（晋升canon，需canon_target）| negate（钉档——缺反证 evidence 直接拒收，I10）| decisive（授予决定性）。生效仍需 approve+全评并入。', inputSchema: { type: 'object', required: ['kind', 'ref'], properties: { kind: { type: 'string', enum: ['promote', 'negate', 'decisive'] }, ref: { type: 'string' }, canon_target: { type: 'string' }, counter_evidence: { type: 'array', items: { type: 'string' } }, reason: { type: 'string' } } } },
  // ---- C 主权面（3）：全部强制 quote ----
  { group: 'C', name: 'checklist_confirm', ro: false, description: '使用者确认清单→激活+标flux+episode开始（I2）。quote 当场对转写验证（I12）。', inputSchema: { type: 'object', required: ['cl_id', 'quote'], properties: { cl_id: { type: 'string' }, quote: quoteSchema } } },
  { group: 'C', name: 'episode_close', ro: false, description: '收口全评的唯一入口：没有这个调用，publish 的重锚动作被拒绝（I2/I4）。agent 不得自行宣告收口。', inputSchema: { type: 'object', required: ['ep_id', 'quote'], properties: { ep_id: { type: 'string' }, quote: quoteSchema } } },
  { group: 'C', name: 'workorder_approve', ro: false, description: '晋升/钉档/decisive 的人手批准（归档全自动不经此处——两端过人手、中间全自动）。批准≠生效：下次全评并入（I4）。', inputSchema: { type: 'object', required: ['wo_id', 'quote'], properties: { wo_id: { type: 'string' }, quote: quoteSchema } } },
  // ---- D 评估事务面（3）：I1 原子性落点 ----
  { group: 'D', name: 'assess_open', ro: false, description: '发评估工单：确定性部分全在这步——hash命中表(backlog/待裁工单/edge推进并入)、快评是否升格全评、收口重锚标记。开放清单执行期拒绝（episode_close 后允许）。', inputSchema: { type: 'object', required: ['trigger'], properties: { trigger: { type: 'string', enum: ['T1', 'T2'] } } } },
  { group: 'D', name: 'assess_submit', ro: false, description: '逐节点提交打分（R1裁决②）：每笔即时校验（工单集合内/evidence+src_hash+三成因完备/pin一致），坏一笔不毁一单。items[] 为调用包装便利，server 拆开逐笔校验，回滚域仍是笔级。', inputSchema: { type: 'object', required: ['t'], properties: { t: { type: 'string', description: '工单 id' }, node_ref: { type: 'string' }, change: changeSchema, no_change: { type: 'object', properties: { reason: { type: 'string' } } }, items: { type: 'array', description: '批量包装：[{node_ref, change|no_change}]', items: { type: 'object', required: ['node_ref'], properties: { node_ref: { type: 'string' }, change: changeSchema, no_change: { type: 'object', properties: { reason: { type: 'string' } } } } } } } } },
  { group: 'D', name: 'assess_publish', ro: false, description: '原子发布：覆盖率检查（workset 每节点必有 change/no_change，缺一拒发）→ 重归一 → 并入归档/晋升/钉档 → 写不可变 v(k+1) → 落漂移点 → rename 换 INDEX → 清 backlog/flux（收口时）→ 账本闭环。自检失败=整体回滚，工单保持 open。', inputSchema: { type: 'object', required: ['t'], properties: { t: { type: 'string' } } } },
  // ---- E 报表面（2）：ro 可用 ----
  { group: 'E', name: 'drift_report', ro: true, description: '§4.6 五段式报表（节点账表/锚事件时间线/汇总/canon出入账/决定性集+失败库附表）。满 M 轮自动导出，此调用可再生成。读者仅模型分析阶段与人，绝不进打分输入（I5）。', inputSchema: { type: 'object', properties: {} } },
  { group: 'E', name: 'rehearse_budget', ro: true, description: '实测启动卡/全展开 token 数（600/6000 是猜的，校准靠它）。', inputSchema: { type: 'object', properties: {} } },
];

export function toolsForRole(role) {
  return role === 'ro' ? TOOL_DEFS.filter(t => t.ro) : TOOL_DEFS;
}

// 分发；返回统一信封（违例走 warnings/error 数据，不走异常堆栈）
export async function dispatch(core, name, args = {}) {
  try {
    switch (name) {
      case 'startup_brief': return core.startupBrief(args);
      case 'sigma_overview': return core.sigmaOverview();
      case 'tau_expand': return core.tauExpand(args.module);
      case 'node_detail': return core.nodeDetail(args.ref);
      case 'node_history': return core.nodeHistory(args.ref);
      case 'archive_get': return core.archiveGet(args.ref);
      case 'claim_record': return core.claimRecord(args);
      case 'dialog_extract': return core.dialogExtract(args);
      case 'propose_checklist': return core.proposeChecklist(args);
      case 'propose_workorder': return core.proposeWorkorder(args);
      case 'checklist_confirm': return core.checklistConfirm(args.cl_id, args.quote);
      case 'episode_close': return core.episodeClose(args.ep_id, args.quote);
      case 'workorder_approve': return core.workorderApprove(args.wo_id, args.quote);
      case 'assess_open': return core.assessOpen(args.trigger);
      case 'assess_submit': return submitDispatcher(core, args);
      case 'assess_publish': return core.assessPublish(args.t);
      case 'drift_report': return core.driftReport();
      case 'rehearse_budget': return core.rehearseBudget();
      default: return { ok: false, error: { code: 'unknown_tool', message: `未知工具 ${name}` }, warnings: [] };
    }
  } catch (e) {
    return { ok: false, error: { code: 'internal', message: String(e && e.message || e) }, warnings: [] };
  }
}

// R1 观察项①的实现：单次调用携带多笔、server 拆开逐笔校验，回滚域仍是笔级
function submitDispatcher(core, args) {
  if (Array.isArray(args.items) && args.items.length) {
    const results = [];
    for (const it of args.items) {
      const ch = it.change || (it.no_change ? { no_change: true, reason: it.no_change.reason } : null);
      results.push({ node_ref: it.node_ref, result: core.assessSubmit(args.t, it.node_ref, ch) });
    }
    const okN = results.filter(r => r.result.ok).length;
    return core.envelope({ batch: true, accepted: okN, rejected: results.length - okN, results });
  }
  const ch = args.change || (args.no_change ? { no_change: true, reason: args.no_change.reason } : null);
  return core.assessSubmit(args.t, args.node_ref, ch);
}
