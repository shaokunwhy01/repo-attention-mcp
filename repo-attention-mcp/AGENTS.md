# AGENTS.md — repo-attention v2（REFACTOR）读规则

> 两个核心：**注意力引导**（先读哪儿、读多深、这个分还可信吗）与 **归账**（分怎么变成现在这样、人做了哪些决定、谁把项目改成了什么样）。
> 判据：规则 ≤5 条 / MCP 工具 6 个 / 产物 3 种 / **无待办项**。
> Server 从不调用模型；它只解析、校验 hash、折叠事件流、算概率。

## 规则卡（给模型的全部内容，就这 5 条）

```
1. 会话开始读 brief()：它是唯一入口，给**根层榜**（强度概率 p）与树规模（F/L/max_depth/n_nodes）。
   一页不够时用返回的 page.next_cursor 翻页（brief({cursor})）。
2. **逐层下钻**：expand(node) 拿下一层；已经是叶子就直接得到可读的 refs 行区间。
   问「某功能在哪」：lookup(question)（会穿透到叶子）。
3. 标了 dirty 的节点读原文、不信旧分；标了 unscored 的只是扫描出的骨架、还没评。
4. 只有在这四种情形才写：
   - 你读到的和账上不一致 → note(kind="score", 带 evidence + src_hash)
   - 人做出了决定           → note(kind="decision", by 固定 human, quote 必填，只代录)
   - 文件被改动             → note(kind="edit", 带 scope + 前后 hash)
   - 项目迈过里程碑         → anchor(...)
5. 历史用 timeline()：分值序列 + 锚 + 树规模变化 + 决定/改动。没有其它动作，也没有待办项。
```

## 六个工具（MCP 工具面，就这 6 个）

| 面 | 工具 | 入参 | 返回（关键字段） | 时机 |
|---|---|---|---|---|
| 读 | `brief` | `cursor?` | `version` / `resolution{basis,F,L,max_depth,n_nodes}` / **根层榜**（`p` + `raw` + `dirty` + `unscored` + `edge?` + `ref`）/ `anchors`（最近 3）/ `page{...}` / `budget` | 开局 1 次（可翻页） |
| 读 | `expand` | `node`, `cursor?` | 有子 → 子榜（`p` + `raw` + `refs` + `dirty` + `edge?`）；叶子 → `refs` + `size` + `src_hash` | 逐层下钻 |
| 读 | `lookup` | `question` | 命中 1–3 个节点并**穿透到叶子**给出 refs + 理由 | 「某功能在哪」 |
| 读 | `timeline` | `scope?` | 分段分值序列 + 锚 + 树规模变化 + 决定/改动 | 复盘/交接 |
| 写 | `note` | `kind ∈ {score, decision, edit}` + 字段 | 记账结果（`round` / `accepted` / `ts`） | 见规则 4 |
| 写 | `anchor` | `label`, `refs[]?`, `resolution?` | 段起点（`round` + 树规模） | 迈过里程碑 |

### `note` 三类 payload

```jsonc
// score —— 判断：各点的独立强度（raw 不归一，概率在**同一父下**读取时算）
{ "kind":"score", "items":[{ "node":"cell_sim/bridge", "layer":"module", "parent":"cell_sim",
  "raw":0.62, "why":"new", "evidence":["proj://codebuddyCELL/cell_sim/bridge/"],
  "src_hash":"sha256:51534ea1…", "caused_by":"2026-09-10T09:16:26Z", "tags":["edge"] }] }

// decision —— 对话者的决定关键（只记不禁；by 恒为 human）
{ "kind":"decision", "label":"二级构型按 A 建档，血浆介质单列",
  "quote":"纤维细胞用 A 型，血浆单独一档", "stage":"选型", "affects":["cell_sim/resolver"] }

// edit —— 项目修改者的操作情况（事实，可机械核对）
{ "kind":"edit", "by":"main", "scope":["cell_sim/bridge/","cell_sim/resolver.py"],
  "summary":"建立两级接口层并接入 loader", "before_hash":"sha256:…", "after_hash":"sha256:…" }
```

## 四类事件（events.jsonl，只追加）

| 事件 | 记什么 | 谁写 | 写口 | 机械校验 |
|---|---|---|---|---|
| `score` | 各点的独立强度（逐层归一） | 读到并作出判断的一方 | `note(kind="score")` | `evidence` 可锚且 ≥1 条 + `src_hash` 与实况一致 |
| `decision` | 对话者的决定关键（含原话与所在步骤） | 模型代录（`by:"human"`） | `note(kind="decision")` | `by` 必须 `human`；`quote` 非空 |
| `edit` | 项目修改者的操作情况（谁改成什么样） | 修改者本人（main/sub/human/auto） | `note(kind="edit")` | `scope` 非空、前后 hash 齐全且 `after_hash` 与实况一致 |
| `anchor` | 一段的起点（含当时的树规模） | 人/模型 | `anchor(...)` | `label` 非空 |

**唯一被保留的机械校验（就这五条）**：
1. `score.evidence` ≥1 条、锚到 symbol 或 `##` 小节级（禁 ≤2 行无 symbol 的行级锚）；
2. `score.src_hash` = 当前实况；
3. `decision.by` 必须 `"human"` 且 `quote` 非空；
4. `edit.scope` 非空、`before_hash`/`after_hash` 齐全、`after_hash` 与实况一致；
5. `events.jsonl` 只追加（无删改接口）。

## 树与分辨率

```
定义：  节点构成一棵树（parent 链；parent:null = 根层）
不变量 I： size(point) ≤ K        ← 这就是"下限分辨率"，不可突破
           K_file = 5 文件/点   K_line = 250 行/点
下钻判据： size(node) > K  → 必须继续分
叶子判据： size(node) ≤ K  → 才可为叶（叶子内容量有界 ⇒ 单次读得完）
归一：     每个父节点之下独立归一（组内 Σp = 1）
扇出：     无全局上限（项目越大 → 越多的点 / 越深）
展示：     分层 + 分页（page_size），按 p 降序；page.next_cursor 翻页
预算：     120·page_size + 300（与项目规模解耦）
```

## 边缘区（是标记，不是过滤器）

`sigma_band` / `tau_band` **不是**「低于此就不列」——低于阈值的节点**照常返回**，只是多一个 `edge: true`。
边缘区 = 注意力衰减，**不是错误、不是否定**（不裁员、不静默）。退出序列只能靠归档语义，不靠隐藏。

## 两个逐节点状态

- `dirty: true` —— `hashEvidence(evidence) ≠ index[node].src_hash`（内容已变）：**读原文，不信旧分**。
- `unscored: true` —— 该节点只是 `scan` 建出的**骨架**（`raw` 占位 0），还没真正评分。

两者都是**节点属性**，不是全局状态、不是待办清单。

## 产物与布局

```
.repo-attention/
  events.jsonl     ← 唯一真相；只追加；永不修改
  index.yaml       ← 派生缓存：每节点 raw / evidence / src_hash / parent / depth / is_branch / scaffold
                     （删掉可完全重建；不权威，只求快）
  tags/vNNNN.yaml  ← 仅在需要一份可复现的冻结快照时打
  legacy/          ← 老仓一次性归档（packages / ledger / backlog / dialogs / INDEX.yaml …）
```

## CLI 驱动器（**不是** MCP 工具）

确定性作业全部在 `src/cli.mjs`：

```
node src/cli.mjs init     --repo <根>
node src/cli.mjs audit    --repo <根>            # 只读三检
node src/cli.mjs migrate  --repo <根>            # 老仓 → 新格式
node src/cli.mjs scan     --repo <根> [--k-file 5] [--k-line 250] [--dry-run] [--force]
                                                 # 扫目录建树骨架（raw=0, unscored=true）
node src/cli.mjs progress --repo <根>            # 全评进度：总数/已评/未评/分布
node src/cli.mjs sweep    --repo <根> [--batch 20] [--node <id>] [--out tasks.json]
                                                 # 取一批未评叶子 → 「内容 + 打分请求」任务包
```

### 首轮全评（内容全读）的形态

```
ra scan                       # ① 建骨架：树 + unscored 清单
ra progress                   # ② 看进度：还差哪些
ra sweep --batch 20           # ③ 取一批未评叶子（含内容正文）
   → 模型逐点判断强度        # ④ 只有这一步经过模型
   → note(kind="score", ...)  # ⑤ 经 MCP 回填
ra progress                   # ⑥ 回到 ②，直到未评归零
anchor(label="B₀ 首轮全评")   # ⑦ 收官：树规模随锚入账
```

**为什么全评必须由 CLI 驱动**：它是**确定性前序遍历**，不是"下一步取决于模型判断"的交互。模型逐叶子驱动 = N 个叶子约 3N 次工具往返、每次重载上下文 → 成本不可行。CLI 持有遍历状态（0 context），每个叶子只把该叶子的内容送进一次判断。
