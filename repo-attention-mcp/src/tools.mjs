// tools.mjs — 工具面（§5）：读 4 + 写 2 = 6 个。没有角色分面，没有权限语义。
// I11 机制注：以下全部工具里没有 delete —— 事件流只追加。
// REFACTOR-v2 §3：节点构成一棵树 → 引导是「逐层下钻」（先粗后细），不再是固定两跳。
import { Core } from './core.mjs';

const projRef = { type: 'string', description: 'proj://<repo>/<path>[:<start>-<end>][#<symbol>][@<rev>]（禁 ≤2 行无 symbol 的行级锚）' };

export const TOOL_DEFS = [
  // ---- 读面（4）----
  {
    name: 'brief',
    description: '开局唯一入口（每次对话开始 1 次）：**根层榜**（强度概率 p + raw + 是否脏 + 引用；低于 sigma_band 的仍列出并标 edge:true）+ 树/分辨率元信息（F/L/max_depth/节点数）+ 最近 3 个锚 + 按页预算。分辨率无上限，响应有界——超一页时返回 page.next_cursor，翻页再来一次。返回里没有任何待办项。',
    inputSchema: { type: 'object', properties: { cursor: { type: 'string', description: '翻页游标（取上一页 page.next_cursor；缺省=第一页）' } } },
  },
  {
    name: 'expand',
    description: '**逐层下钻**：有子节点 → 给该层的子榜（p + raw + refs + 是否脏；低于 tau_band 的仍列出并标 edge:true），按 page_size 分页；已是叶子 → 直接给它自己的 refs 行区间 + size。承载量超 K（文件/行双维）的点会提示继续细分。',
    inputSchema: {
      type: 'object', required: ['node'],
      properties: {
        node: { type: 'string', description: '节点 id（brief / expand 返回的 id 列）' },
        cursor: { type: 'string', description: '翻页游标（取上一页 page.next_cursor；缺省=第一页）' },
      },
    },
  },
  {
    name: 'lookup',
    description: '「某功能在哪」：关键词匹配 1–3 个节点，并**穿透到叶子**给出可直接读的 refs 行区间 + 一句话理由。',
    inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string', description: '自然语言问题或关键词（中文按二字词组匹配）' } } },
  },
  {
    name: 'timeline',
    description: '复盘/交接：按节点折叠 score 事件得到 raw 序列，按 anchor 切段，并把同段内的 decision / edit 作为「因」标出。',
    inputSchema: { type: 'object', properties: { scope: { type: 'string', description: '可选：只看某个节点（缺省=全账）' } } },
  },
  // ---- 写面（2）----
  {
    name: 'note',
    description: '全部记账的唯一入口，按 kind 分派：score（读到的东西与账上不一致）、decision（人做出了决定，只记不禁）、edit（文件被改动）。',
    inputSchema: {
      type: 'object', required: ['kind'],
      properties: {
        kind: { type: 'string', enum: ['score', 'decision', 'edit'] },
        by: { type: 'string', enum: ['main', 'sub', 'human', 'auto'], description: '谁写的（decision 恒为 human）' },
        round: { type: 'number', description: '可选：批次标记；缺省自动新开一轮' },
        // score
        node: { type: 'string', description: '[score] 节点 id（建议用相对路径）' },
        layer: { type: 'string', enum: ['module', 'content'], description: '[score] 仅作标注；树由 parent 链定义（缺省 module）' },
        parent: { type: 'string', description: '[score] 可选：父节点 id（决定树的层级）；缺省=根层' },
        raw: { type: 'number', description: '[score] 独立强度（不归一，读取时才变概率）' },
        why: { type: 'string', enum: ['code_changed', 'attention_moved', 'new', 'split', 'merge', 'retire'], description: '[score] 为什么变' },
        evidence: { type: 'array', items: projRef, description: '[score] 必填 ≥1 条' },
        src_hash: { type: 'string', description: '[score] 必填：实测现状 hash（与实况不符当场拒收）' },
        tags: { type: 'array', items: { type: 'string' }, description: '[score] 可选：edge | frozen' },
        caused_by: { type: 'string', description: '[score] 可选：指向某条 edit/decision 的 ts' },
        summary: { type: 'string', description: '[score] 可选：一句话摘要（lookup / 人读用）' },
        note: { type: 'string' },
        items: { type: 'array', description: '[score] 批量：与单笔同字段的数组；同批打同一个 round', items: { type: 'object' } },
        // decision
        label: { type: 'string', description: '[decision] 模型归纳的一句话' },
        quote: { type: 'string', description: '[decision] 必填：对话者原话（模型只能代录，不得自拟）' },
        stage: { type: 'string', description: '[decision] 可选：决定发生在流程的哪一步' },
        affects: { type: 'array', items: { type: 'string' }, description: '[decision] 可选：受影响的节点' },
        supersedes: { type: 'string', description: '[decision] 可选：推翻旧决定时指向其 ts' },
        // edit
        scope: { type: 'array', items: { type: 'string' }, description: '[edit] 必填：改了哪些路径（文件/目录混排，相对项目根）' },
        before_hash: { type: 'string', description: '[edit] 必填：改动前 hash' },
        after_hash: { type: 'string', description: '[edit] 必填：改动后 hash（与实况不符当场拒收）' },
      },
    },
  },
  {
    name: 'anchor',
    description: '标记「一段的起点」（项目迈过里程碑时）：label + 可选 refs；resolution 缺省时按当前树规模自动算并记进锚。',
    inputSchema: {
      type: 'object', required: ['label'],
      properties: {
        label: { type: 'string', description: '给这一段起个名，如「二级结构落地(v6)」' },
        refs: { type: 'array', items: projRef, description: '可选：这段的代表性引用' },
        resolution: { type: 'object', description: '可选：{basis,F,L,max_depth,n_nodes}；缺省自动按当前树规模计算' },
        round: { type: 'number' },
        note: { type: 'string' },
      },
    },
  },
];

// 分发：统一信封（违例走 warnings/error 数据，不走异常堆栈）
export async function dispatch(core, name, args = {}) {
  try {
    switch (name) {
      case 'brief': return core.brief(args);
      case 'expand': return core.expand(args.node, args);
      case 'lookup': return core.lookup(args.question);
      case 'timeline': return core.timeline(args.scope);
      case 'note': return core.note(args);
      case 'anchor': return core.anchor(args);
      default: return { ok: false, error: { code: 'unknown_tool', message: `未知工具 ${name}` }, warnings: [] };
    }
  } catch (e) {
    return { ok: false, error: { code: 'internal', message: String((e && e.message) || e) }, warnings: [] };
  }
}

export { Core };
