# repo-attention v1 改造文档

> **目标**：只保留两个核心——**注意力引导** 与 **归账（记账）**。
> **设计判据**：模型必须记住并在正确时点执行的规则 **≤5 条**；工具面 **6 个**（读 4 + 写 2）；产物 **3 种**；无「待办项」。
> **本文用法**：老机制只在 §7 的对照表里出现（只做对比），其余章节全部描述**新设计**。
> **状态**：v1.1 待你审阅。§11 有 6 项需要你拍板。
> **v1.1 变更**：记账里把两类「人的痕迹」升为**第一等事件**——`decision`（**对话者的决定关键**：人在哪一步、依据什么、定了什么，含原话）与 `edit`（**项目修改者的操作情况**：谁、把哪些路径、改成什么样，含前后 hash）；四类事件（`score` / `decision` / `edit` / `anchor`）全部走写面，其中前三类由唯一写口 `note` 记录、`anchor` 单列，工具面维持 6 个；`flag` 不再单独成类（并入 `score.tags`）。
> **v2 变更（已落地）**：分辨率**解除上限**（`R₁_max/R₂_max` 取消），节点改为**一棵树**（`parent` 链、**逐层下钻**）；`K_file/K_line` 升为**下限分辨率**（不变量 I：每点承载量 ≤ K）；展示改为**分页**（`cursor`，工具面仍 6）；确定性作业下沉到 **`src/cli.mjs`**（`scan` / `sweep` / `progress`）。§3、§5 已按此改写。

---

## 0. 一页速览

| 维度 | 老 | 新 |
|---|---|---|
| 产品目标 | 引导 + 变更管控（两个产品压在一个 MCP） | 引导 + 归账 |
| 工具面 | 23（A8/B5/C4/D3/E2） | **6**（read 4 + write 2：`note` / `anchor`） |
| 产物 | 13 种（packages / ledger / backlog / dialogs / checklists / workorders / archive / drift / assess / INDEX …） | **3 种**（`events.jsonl` / `index.yaml` / `tags/*`） |
| 唯一真相 | `packages/*.yaml`（快照即真相） | **`events.jsonl`（只追加事件流）**；`index.yaml` 是派生缓存 |
| 写入口 | 9 个（claim / checklist / workorder / execution / assess×3 / dialog） | **2 个**（`note`：`score` / `decision` / `edit` 三类**全部记事的唯一入口**；`anchor`：段起点） |
| 人的决定 | 主权动作 + quote 逐字校验（是「闸门」：过不了不让做） | **`decision` 事件**：**只记不禁**（`by:"human"` + 原话出处 + 所在步骤） |
| 谁改了什么 | 无（老 F3 缺口：账本只记 `session_id`/`role`） | **`edit` 事件**：`by` + `scope` + 改变前后 hash（**认领操作**，不是声明身份） |
| 分值语义 | 写入时归一，历史被归一污染 | **独立打分（raw）→ 读取时归一（p）** |
| 区块数 | 死参数 `N_cap=500` + `tau_band[3,30]` | **树 + 分页**：`K` 约束每点承载量（下限分辨率），细分靠深度，展示靠分页 |
| 评估时点 | T1/T2/T3 + 计数器 + episode + 收口武装 | **不存在**（读到脏就顺手记，记账是引导的副产品） |
| 在途失效 | 人工标 `flux` + 清单状态机 | **自动**：`src_hash` 不符 = 脏 = 直读 |
| 结论 | `claim` 状态机（validity/decisive/工单） | **删除**（叙事改由 `decision` + `edit` + 分值序列 + 锚给出） |
| 主权 | 4 个动作 + quote 逐字校验 + 重放防御 + caller | **删除**（无权限语义；「人做的决定」与「谁改了什么」改为**只记不禁**的 `decision`/`edit`） |
| 规则 | R/I/T/P 五套编号、≈50 条分支 | **一张卡 ≤5 条** |
| 预算 | 常数 600，实测 1193 → 导航被降级 | **预算由分辨率推导**，降级率 = 0 |

---

## 1. 两个核心与不可约动作

### 核心 A · 注意力引导
回答一个问句：**「关于这件事，先读哪几个地方、读多深、这个分还可信吗？」**

引导是两跳的，且**两跳不合并**（你的决定②）：
- **第一跳 σ（模块细度）**：项目被切成多少块，各块在项目运作中占多大地位 → 决定「去哪个模块」。
- **第二跳 τ（模块内内容细度）**：该模块内部哪些点先看 → 决定「读哪一段」。
- 第三跳是行为，不是工具：按 refs 读原文。

### 核心 B · 归账
唯一真相是一条**只追加的事件流**，回答四个问句：
- 「这个节点的分是怎么变成现在这样的？」（由 `score` 回答）
- 「这段历史里，人做了哪些关键决定、每一步的依据是什么？」（由 `decision` 回答）
- 「谁在什么时候把项目改成了什么样？」（由 `edit` 回答）
- 「这个项目是怎么开始 → 怎么走到现在的？」（由 `anchor` 切段、以上三类折叠而成）

### 不可约动作清单（新设计只有这四个）

| 动作 | 频率 | 说明 |
|---|---|---|
| **读卡** | 每次对话开始 1 次 | `brief()` |
| **下钻** | 要动/要读某模块时 | `expand(module)` 或 `lookup(question)` |
| **回读** | 拿到 refs 之后 | 用宿主 `read_file` 读行区间（不是服务动作） |
| **记一笔** | 只在「读到的东西和账上不一致」「项目迈过里程碑」「人做出决定」或「文件被改动」时 | `note(...)`（`score` / `decision` / `edit` 三类）／ `anchor(...)` |

**没有第五个动作。** 没有开工、没有评估事务、没有批准、没有收口。

---

## 2. 分值语义：强度概率

### 2.1 两层，各自归一，互不相乘（你的决定②）

- σ（模块层）：Σσ = 1，读作「该项目各模块在项目运作中的强度占比」。
- τ（内容层）：同一父模块内 Στ = 1，读作「该模块内部各点的重要度占比」。
- **不做 σ×τ 的合成标量**。两层各自榜上排序，回答两个不同问题：

| 层 | 分数回答 | 引导动作 |
|---|---|---|
| σ | 这一块在项目运作中占多大地位（哪里需要它、牵动面多大） | 决定去哪个模块 |
| τ | 该模块内哪个点最该先看 | 决定读哪一段（refs 行区间） |

`brief()` 只给 σ 榜；`expand()` 才给 τ 榜。**这本身就是引导**：先粗后细，模型不必一次看全。

### 2.2 关键机制：原始强度入账，概率在读取时算

**你的决定**：每次评分独立计算，然后重新归一，用作强度概率展示。
**实现方式**：把归一从「写入时」移到「读取时」。

```
写入：  score(node, raw = 0.62)          ← 各节点独立打分，互不影响
账本：  {kind:"score", node, raw:0.62, …} ← 只记 raw
读取：  brief() 时对当前所有 raw 做一次归一 → p = raw / Σraw
展示：  cs-dynamics  σ = 8.4%            ← 强度概率
```

**为什么必须这样**（这是老机制最伤的一处，必须避开）：

老设计在写入时归一，于是「新增一个模块」会让**所有未改动模块的分值同时变化**，而 `recordHist` 记的是归一后的值。后果是历史序列里出现「没人动过的节点分数也在跳」→ 历史不可解释；同时每次记账都要全库重算 → 单笔写入被迫升级成「全评 + 覆盖率检查 + 原子换版」。

新设计里 `raw` 是**独立、可比、可解释**的量；`p` 只是展示变换。历史记 `raw`，展示给 `p`。

### 2.3 「一轮」的边界

若你希望「一次评分是一个协调的整体」，`score` 支持批量并给同批事件打同一个 `round` 标记：

```
score(items:[…])  →  同批事件的 ts 相同、round 相同
```

`round` 只是**事件的标签**，不是事务对象：没有 open/submit/publish、没有覆盖率检查、没有回滚域。`timeline()` 按 `round` 分组展示「第 N 轮评分」。

---

## 3. 分辨率：一棵树（扇出有界、深度随规模增长）〔v2 修订〕

### 3.1 定义

**分辨率 = 项目被切成多少个点、每个点代表多少内容。** 节点构成一棵**树**（`parent` 链；`parent:null` = 根层）。

| 概念 | 含义 |
|---|---|
| **K_file / K_line** | **每点承载量上限**（一个点至多 5 个文件 / 250 行）——这就是**下限分辨率** |
| 下钻判据 | `size(node) > K` → **必须继续分** |
| 叶子判据 | `size(node) ≤ K` → 才可为叶子（叶子内容量有界 ⇒ 单次读得完） |
| 扇出 | 由树结构决定，**无全局上限**（`R₁_max/R₂_max` 已解除） |
| 展示 | 每层**分页**（`page_size`），按 `p` 降序；`page.next_cursor` 翻页 |

**不变量 I（分辨率下限）**：`size(point) ≤ K` **恒成立**。项目变大时**不允许靠"每点装更多"来吸收规模**，只能转成**更多点 / 更深**。
⇒ 「项目大细分细、项目小细分小」自动成立；`64` 之类上限不再存在，**展示的有界性改由分页承担**。

### 3.2 动态分配（可判定，不需要人填）

- `F` = 受控文件数（排除 `.repo-attention/` `.git/` `node_modules/`）
- `L` = 受控总行数；`size(node)` = 该节点 refs 覆盖的行数

```
下钻：       size(node) > K  → 继续分（K 按层取 K_file / K_line）
叶子：       size(node) ≤ K  → 可为叶
建议扇出（scan 用）： fanout = ceil(size / K)      ← 无 clamp
```

**常数起点**：`K_file = 5`（一个点至多 5 个文件）、`K_line = 250`（一个点至多 250 行）。

**物理含义**：一个点承载 ≤5 文件 / ≤250 行；项目越大，**层数越多、点越多**，而**每点承载量不增长**。
参考锚点：F≈120 → 顶层约 24 个点（与 23 个实际模块吻合）；`cs-dynamics` 约 575 行 → 需再分 3 层左右。

### 3.3 树规模随锚入账

`resolution` 随每次 `anchor` 记下当时的树规模：

```jsonc
{"kind":"anchor","label":"二级结构落地(v6)","ts":"…",
 "resolution":{"basis":"5文件/点 · 250行/点","F":120,"L":30210,"max_depth":3,"n_nodes":214},
 "refs":["proj://codebuddyCELL/cell_sim/bridge/", "…"]}
```

`timeline()` 于是能给出真正的「项目如何开始 → 结束」：

```
r1 (s=1, F=96,  depth=2, nodes=88)   B₀ 首轮全评
r6 (s=2, F=120, depth=3, nodes=214)  二级结构落地 → 树变深：新增点 cs-bridge / cs-body …
                                     升幅前3：cs-body +6.2pp / cs-runner +2.1pp / cs-actors −1.3pp
```

**没有 claim、没有结论链**——历史就是「分值序列 + 锚 + 树规模变化」（你的决定③）。

### 3.4 超载处理（继续下钻）

当某叶子 `size > K_line` 却无法再分（单文件本身过大），服务给**软提示**（不阻塞写入）：

```
over_size_leaf / subdivide_suggested:
    "承载 X 行 > K_line：该点超载，必须继续细分（补子节点，或细化到 symbol 级）"
```

这是「分辨率动态」的另一半：分辨率不只是数字，还包含**该重划粒度**的提示。

---

## 4. 归账：事件流

### 4.1 四类事件（只有四类，前三类由 `note` 写）

```jsonc
// ① 分值事件——高频写口（判断）
{"ts":"2026-09-10T12:40:00Z","by":"main","kind":"score",
 "round":7,                       // 同批同值（可选）
 "node":"cs-dynamics","layer":"module",   // module | content
 "parent":null,                   // content 时 = 所属模块
 "raw":0.62,                      // 独立强度（不归一）
 "why":"code_changed",            // code_changed | attention_moved | new | split | merge | retire
 "evidence":["proj://codebuddyCELL/cell_sim/dynamics.py:74-330#Simulation"],
 "src_hash":"sha256:51534ea1…",
 "caused_by":"2026-09-10T09:16:26Z",   // 可选：指向某条 edit/decision 的 ts
 "tags":["edge"],                 // 可选：edge | frozen（取代老的 flag）；"脏"由 hash 自动推导，不用 tag
 "note":"新增 external 暴露模式与 pk_migrated 闸门"}

// ② 决定事件——对话者的决定关键（**只记不禁**）
{"ts":"2026-09-10T11:00:00Z","by":"human","kind":"decision",
 "label":"二级构型按 A 建档，血浆介质单列",       // 模型归纳的一句话
 "quote":"纤维细胞用 A 型，血浆单独一档",           // 对话者原话（必填；模型只能代录，不得自拟）
 "stage":"选型",                                    // 可选：决定发生在流程的哪一步
 "affects":["cs-resolver","doc-library-design"],    // 可选：受影响的节点
 "supersedes":null,                                 // 推翻旧决定时指向其 ts
 "note":"…"}

// ③ 操作事件——项目修改者的操作情况（事实）
{"ts":"2026-09-10T09:16:26Z","by":"main","kind":"edit",
 "scope":["cell_sim/bridge/","cell_sim/body/","cell_sim/resolver.py"],
 "summary":"建立两级接口层/机体侧数值核/细胞库视图层，并接入 loader",
 "before_hash":"sha256:…","after_hash":"sha256:…",
 "round":6,"note":"含 5 项施工期偏差修正"}

// ④ 锚事件——低频，标记"一段的起点"
{"ts":"…","by":"main","kind":"anchor",
 "label":"二级结构落地(v6)",
 "resolution":{"R1":24,"R2_basis":"250行/点","F":120,"L":30210},
 "refs":["proj://codebuddyCELL/cell_sim/bridge/","…"]}
```

**已删除**：`claim`（你决定③）、`flux`（改为自动推导）、`decisive`/`promote`/`negate`（归档三出口）、`workorder`、`episode`、`checklist`、`quote 逐字校验`。

**`flag` 不再单独成类**：`edge` / `frozen` 并入 `score.tags`；「直读」是 hash 推导，不用 tag。

`score` 另有可选字段：`caused_by`（指向某条 `edit`/`decision` 的 ts）与 `tags:[]`。

#### ② `decision` —— 对话者的决定关键（**只记不禁**）

```jsonc
{"ts":"2026-09-10T11:00:00Z","by":"human","kind":"decision",
 "label":"二级构型按 A 建档，血浆介质单列",       // 模型归纳的一句话
 "quote":"纤维细胞用 A 型，血浆单独一档",           // 对话者原话（必填；模型只能代录，不得自拟）
 "stage":"选型",                                    // 可选：决定发生在流程的哪一步
 "affects":["cs-resolver","doc-library-design"],    // 可选：受影响的节点
 "supersedes":null,                                 // 推翻旧决定时指向其 ts
 "note":"…"}
```

- **`by` 强制为 `"human"`**：模型只能**代录**，不得替人决定。
- 记的是「**步骤**」而不只是「决定」：人在流程的哪一步、基于什么、定了什么 —— 这是 `timeline` 里分值突变的**因**。
- 决定**不可修改**：改主意 = 再记一条 + `supersedes` 指向旧条。历史于是永远自洽，不需要任何「改史」权限。
- `quote` 必填但**不做机械校验**（不再是闸门）。它是**出处**，不是通行证。

#### ③ `edit` —— 项目修改者的操作情况

```jsonc
{"ts":"2026-09-10T09:16:26Z","by":"main","kind":"edit",
 "scope":["cell_sim/bridge/","cell_sim/body/","cell_sim/resolver.py"],
 "summary":"建立两级接口层/机体侧数值核/细胞库视图层，并接入 loader",
 "before_hash":"sha256:…","after_hash":"sha256:…",
 "round":6,"note":"含 5 项施工期偏差修正"}
```

- `by ∈ {main, sub, human, auto}`：**谁改的**。老机制账本只记 `session_id`/`role`，事后无法区分主 agent 与只读子代理（老 F3 缺口）——新设计用「**认领操作**」代替「声明身份」，语义干净得多，也不引入任何权限判断。
- 必须带 `before_hash`/`after_hash`：`edit` 是**事实**（可机械核对），`score` 是**判断**。二者分工明确，互不冒充。
- `score.caused_by` 指向某条 `edit`，于是「**分为什么变**」落在一个真实操作上，而不是一个枚举值。

#### 四类事件的分工（一表说清）

| 事件 | 记什么 | 谁写 | 写口 | 机械校验 |
|---|---|---|---|---|
| `score` | **各区块的独立强度**（σ/τ 两层） | 读到并作出判断的一方 | `note(kind="score")` | `evidence` 可锚 + `src_hash` 与实况一致 |
| `decision` | **对话者的决定关键**（含原话与所在步骤） | 模型代录（`by:"human"`） | `note(kind="decision")` | `by` 必须 `human`；`quote` 非空 |
| `edit` | **项目修改者的操作情况**（谁改成什么样） | 修改者本人（main/sub/human/auto） | `note(kind="edit")` | `by`、`scope` 非空；`after_hash` 与实况一致 |
| `anchor` | **一段的起点**（含分辨率） | 人/模型 | `anchor(...)` | `label` 非空 |

### 4.2 唯一真相与派生缓存

```
.repo-attention/
  events.jsonl     ← 唯一真相；只追加；永不修改（R11 精神保留）
  index.yaml       ← 派生缓存：每节点当前 raw / 最近 evidence / src_hash / layer / parent
                     （删掉可完全重建；不权威，只求快）
  tags/vNNNN.yaml  ← 仅在「需要一份可复现的冻结快照」时打（承接老 packages 语义）
  legacy/          ← 老仓一次性归档（backlog / workorders / assess / drift / dialogs / ledger）
```

`index.yaml` 可重建这一条很重要：它保证**账是唯一真相**，也让写入永远是 O(1) 追加（老设计是 O(全库) 重算 + 原子换版）。

### 4.3 历史怎么读

`timeline(scope?)`：按节点折叠 `score` 事件得到序列，按 `anchor` 切段，并把同一段内的 `decision` / `edit` 作为「因」标在对应 ts 上——**分值为什么变，能追到一次决定或一次改动**。

```
cs-dynamics  raw: 0.55 → 0.55 → 0.58 → 0.62        (仅在被评分时才有新点，没有"凭空跳"的段)
cs-body      raw: (r6 新增) 0.71
锚：B₀(F=96,R1=20) → 二级结构落地(F=120,R1=24)
因：r6 ← edit(main, bridge/+body/+resolver.py, 3f21→8a76)
       ← decision(human, 选型："纤维细胞用 A 型，血浆单独一档")
```

**注意**：`raw` 只在被评分时变化。老机制里「未改动节点分数也在动」的现象在新设计里**不可能出现**——这正是你要的「历史归账数据给出项目如何开始→结束」。

### 4.4 「脏」是自动推导的

不需要人工标 `flux`：

```
脏(node) ⟺ hashEvidence(evidence.refs) ≠ index[node].src_hash
```

`brief()` 把脏节点显示为 `[直读]` 并降权显示：

```
cs-dynamics   σ 8.4%   [直读]  ← 代码已变（hash 51534e→8a7611），旧分仅供参考
```

模型的规则第 3 条就是「[直读] 的模块，读原文，不信分」。

---

## 5. 工具面：6 个

### 读面（4）

| 工具 | 入参 | 返回（关键字段） | 时机 |
|---|---|---|---|
| `brief` | `cursor?` | `version` / `resolution{basis,F,L,max_depth,n_nodes}` / **根层榜**（`p` 概率 + `raw` + `dirty` + `unscored` + `edge?` + `ref`）/ `anchors`（最近 3）/ `page{...}` / `budget` | 开局 1 次（翻页可多次） |
| `expand` | `node`, `cursor?` | **逐层下钻**：有子 → 子榜（`p` + `raw` + `refs` + `dirty` + `edge?`）；叶子 → 自己的 `refs` + `size` + `src_hash` | 要读/要动某个节点时 |
| `lookup` | `question` | 匹配到的 1–3 个节点，并**穿透到叶子**给出可直接读的 refs + 一句话理由 | 「某功能在哪」 |
| `timeline` | `scope?` | 分段的分值序列 + 锚 + 树规模变化 + **决定/改动** | 复盘/交接 |

**`brief` 的硬约束**：
- 返回里**不含任何待办项**：没有 `backlog`、`workorders`、`t2`、`close_pending`、`coverage`、`n_units`。
- 脏（`dirty`）与未评（`unscored`）都是**逐节点属性**，不是全局状态、不是清单。
- 不返回概率以外的要求模型做决定的数字。
- **预算按页**：`overview_tokens = 120·page_size + 300`（page_size=64 → 7980）。**与项目规模解耦**——这就是「分辨率无上限而响应有界」的兑现方式；老机制的 `600 常数 vs 实测 1193` 冲突从此不存在。

### 写面（2）

| 工具 | 入参 | 说明 |
|---|---|---|
| `note` | `kind ∈ {score, decision, edit}` + 对应字段 | **全部记账的唯一入口**（按 `kind` 分派）：`score` → `items[]:{node, layer, parent?, raw, why, evidence[], src_hash, tags?, caused_by?, note}` 或单笔，可选 `round`；`decision` → `{label, quote, stage?, affects?, supersedes?, note}`（`by` 强制 `"human"`）；`edit` → `{scope[], summary, before_hash, after_hash, round?, note}` |
| `anchor` | `label`, `refs[]?`, `resolution?` | 标记一段起点；`resolution` 缺省时自动按当前规模计算 |

**唯一被保留的机械校验（就这五条）**：
1. `score.evidence` 必须 ≥1 条、锚到 symbol 或 `##` 小节级（禁止 ≤2 行无 symbol 的行级锚）；
2. `score.src_hash` 必须等于当前实况（防止「没读就改分」）；
3. `decision.by` 必须为 `"human"` 且 `decision.quote` 非空（模型只能代录，不得替人决定）；
4. `edit.scope` 非空、`before_hash`/`after_hash` 齐全，且 `after_hash` 与实况一致；
5. `events.jsonl` 只追加（无删改接口）。

**已删除的校验/门**：quote 逐字校验、重放防御、caller 身份、执行信号闸门、覆盖率检查、原子发布、Σ 自检、draft 封存、审计八项。

### 维护面 / 驱动器（CLI，**不是** MCP 工具）

确定性作业全部下沉到 `src/cli.mjs`（MCP 工具面保持 6）：

```
node src/cli.mjs init     --repo <根>     # 建目录 + events.jsonl
node src/cli.mjs audit    --repo <根>     # 只读三检：事件可解析 / index 可重建 / hash 一致
node src/cli.mjs migrate  --repo <根>     # 老仓 → 新格式（老产物移入 legacy/）

node src/cli.mjs scan     --repo <根> [--k-file 5] [--k-line 250] [--dry-run] [--force]
                                          # 扫目录建树骨架（raw 占位 0，标 unscored）→ 全评清单
node src/cli.mjs progress --repo <根>     # 全评进度：总数 / 已评 / 未评 / 未评分布
node src/cli.mjs sweep    --repo <根> [--batch 20] [--node <id>] [--out tasks.json]
                                          # 取一批未评叶子 → 「内容 + 打分请求」任务包（交给模型判断）
```

**为什么全评必须走 CLI**：全评是**确定性前序遍历**（树 → 叶子 → 读内容 → 打分），不是"下一步取决于模型判断"的交互。若由模型逐叶子驱动，N 个叶子 ≈ 3N 次工具往返、每次都要重载上下文——成本上不可行。CLI 驱动器持有遍历状态（0 context），每个叶子只把该叶子的内容送进一次判断，判断结果经 MCP `note(score)` 回填。**这就是"首轮全评（内容全读）"在有限上下文里可行的唯一形态。**

`audit` 是老 `audit()` 的 8 项里唯一有价值的部分（账本闭环/快照字节/Σ 归一检查全部随老机制一起删除）。

---

## 6. 运行时：服务实际怎么用

### 6.1 一次普通对话（这是 95% 的情况）

```
人：这个功能在哪改？
  → brief()                       # 拿 σ 榜，选 1–3 个模块
  → lookup("这个功能")             # 自动两跳，返回 refs
  → read_file(refs 行区间)         # 宿主能力，不是服务动作
  → 回答人
（不写账。没动内容、没做决定、没改文件，就没有要记的。）
```

服务调用 **2 次**，返回里 **0 个待办项**。

### 6.2 读到脏区

```
brief 显示 cs-dynamics [直读]
  → read_file(dynamics.py)        # 直读原文，不信旧分
  → note(kind="score", items=[{node:"cs-dynamics", raw:0.62, why:"code_changed",
          evidence=["…:74-330#Simulation"], src_hash="sha256:51534ea1…"}])
下一个人的 brief 里，它就不再是 [直读]，分是新分。
```

**记账是引导的副产品**：不是「该评估了」，而是「你刚好读了、而且它变了」。

### 6.2b 人做出了决定

```
人：纤维细胞用 A 型，血浆单独一档
  → note(kind="decision", by="human", label="二级构型按 A 建档，血浆介质单列",
          quote="纤维细胞用 A 型，血浆单独一档", stage="选型", affects=["cs-resolver"])
     # 模型只代录：by 固定 human，quote 是人原话
  → 今后 timeline 里，本轮的分值变动能追到「这条决定」
```

### 6.2c 项目被改动了

```
主 agent：改完 bridge/ + body/ + resolver.py
  → note(kind="edit", by="main", scope=["cell_sim/bridge/","cell_sim/body/","cell_sim/resolver.py"],
          summary="建立两级接口层/机体侧数值核/细胞库视图层，并接入 loader",
          before_hash="sha256:3f21…", after_hash="sha256:8a76…")
     # 随后可让这次改动"认领"它引起的分值变化
  → note(kind="score", items=[{node:"cs-body", raw:0.71, why:"code_changed",
          evidence=["…cell_sim/body/"], src_hash="sha256:8a76…", caused_by="<edit 的 ts>"}])
```

### 6.3 项目迈过里程碑

```
人：二级结构这版收口了
  → anchor(label="二级结构落地(v6)", refs=[bridge/, body/, resolver.py])
     # resolution 自动按当前规模算并记进锚
  → 之后 timeline 就能给出"开局 → 现在"的段
```

### 6.4 为什么这样模型就能执行

- **规则 ①–⑤ 就五条**（见附录 C），且没有一条要求模型做「该不该评估」的时点判断——只有「读到了就顺手记」。
- **唯一写口 2 个**（`note` 统一记 `score`/`decision`/`edit`，`anchor` 记段），写之前不需要任何前置状态（不需要先开工、先批准、先清 flux、先声明身份）。
- **没有任何状态机**：不存在「工单未 publish」「执行信号待批」「清单开放中」这类必须记住的跨轮状态。
- **短反馈环**：读 → 记 → 下次读更新，环长 1。老机制的环长是 5+（开工单→提交→发布→并账→清 flux），模型每多一跳就多一个失败点。

---

## 7. 删除清单（老机制 → 处置，只做对比）

| 老机制 | 处置 | 理由 |
|---|---|---|
| 老「人的决定」记录（主权动作 + quote **逐字校验闸门**） | **改为 `note(kind="decision")`** | 决定要的是**可追溯**（原话 + 所在步骤），不是**通行证**；只记不禁 |
| 老「谁改了什么」缺口（账本只记 `session_id`/`role`） | **改为 `note(kind="edit")`** | 用**认领操作**（`scope` + 前后 hash）代替声明身份；主 agent 与子代理可区分 |
| `assess_open / assess_submit / assess_publish`（D 面 3） | **删** | 事务只因「写入时归一 + 覆盖率」才存在；两者都取消 |
| `applyAdd/applyUpdate/applyRemove/self_check/覆盖率检查/draft 封存` | **删** | 同上 |
| `episode / checklist / close_pending / reanchor / segment / anchor 指针` | **删** | 「一段的起点」由 `anchor` 事件表达，无需状态机 |
| `T1 / T2 / T3` 触发器 + `dialogs_since_eval` 计数 | **删** | 记账改由「读到脏」驱动；谈话不再累积待评债 |
| `flux`（人工标记 + flux_open/flux_mass） | **改为自动** | 脏 = hash 不符，逐节点自动显示 |
| `claim_record / backlog / dialog_extract / span` | **删**（你的决定③） | 历史由分值 + 锚给出 |
| `propose_checklist / checklist_confirm` | **删** | 结构变化用 `anchor` + `score(why="split"/"merge"/"new")` 表达 |
| `propose_workorder / workorder_approve / archive(negate/promote) / decisive` | **删** | 三出口是治理层，不在两个核心里 |
| `execution_request / execution_approve / execution_gate(_mode)` | **删** | 同上 |
| `sovereignGate / quote 校验 / 重放防御 / caller / 角色 writer\|ro\|sub` | **删** | 唯一写口是 `note`/`anchor`，无权限语义；越权写坏的只是「建议读多深」 |
| `dialogs.mjs`（转写 / 行级链 / seal / verifyQuote） | **降为只读 `legacy/`**（§11-①） | 决定的原话改由 `decision.quote` 就地记录，不再需要一套常驻转写与逐字校验；历史转写留 `legacy/` 供迁移抽取 |
| `edge_state / A 校准(A_hi/A_lo) / calibrateA / edgeSweep` | **删** | 归档是「注意力衰减→退出」的治理动作；`flag tag=edge` 足够 |
| `classifySeries`（趋势/脉冲/震荡）+ `driftDistance` | **删** | 它们是为「解释被归一污染的历史」而生；污染源已移除 |
| `drift_report`（五段式）/ `rehearse_budget` | **删** | `timeline` 覆盖其价值；`rehearse_budget` 有副作用且预算已自动 |
| `archive_get / 墓碑 / resumeNode / writeTombIfNeeded` | **删** | 不删除任何账：事件流本身就是全史 |
| `writer_lock / 心跳 / 锁接管 / backfillDialogCounters / integrity_notes` | **删** | 追加写不需要独占锁；崩溃最多丢「本轮没记的笔记」 |
| `pin`（会话钉版） | **删** | 改为 `brief` 里报告 `version` + `latest_ts` |
| 参数 36 个（`N/M/G_max/tau_band/claim_band/claim_cap/theta_edge/A_*/co_move_corr/trend_*/…`） | **删至 8 个** | 见 §8.2 |
| 编号体系 R1–R12 / I1–I12 / T1–T3 / P1–P7 / §2.x/§4.x/§10-x | **删至一张 ≤5 条卡** | 见附录 C |

---

## 8. 保留 / 改写清单（代码落点）

### 8.1 保留（几乎原样）

| 落点 | 说明 |
|---|---|
| `util.mjs: hashRef / hashEvidence / parseProjRef / sha256 / nowIso / estTokens` | 全部保留——这是机械校验的基础，也是唯一真正省你时间的东西 |
| `scoring.mjs: activeModules/activeContents/findNode/normalizePool` | 保留；`normalizePool` 从「写入时」改到「读取时」调用 |
| `repo.mjs: appendJsonl/readJsonl/writeYamlAtomic/listYaml/ensureLayout` | 保留 |
| `yaml.mjs` | 保留 |
| `core.mjs: envelope / t2State(删) / fluxWarnings(删)` | 只保留 `envelope / reject` |

### 8.2 改写

| 模块 | 新职责 | 目标规模 |
|---|---|---|
| `core.mjs` | `brief / expand / lookup / timeline / note / anchor / audit` 七个函数 + 折叠器 | ≈420 行 |
| `tools.mjs` | 6 个 MCP 工具（读 4 + 写 2：`note` / `anchor`）+ 无角色分面 | ≈90 行 |
| `scoring.mjs` | 保留 `hashRef/hashEvidence` 调用 + `fold(events) → index` + `project(σ/τ 概率)` + `resolution(F,L)` | ≈150 行 |
| `repo.mjs` | 去掉锁/计数/backfill/integrity；加 `appendEvent` / `foldIndex` | ≈140 行 |
| `server.mjs` | 去掉 `--role` / `--session` / `heartbeat`；CLI 只剩 `init/audit/serve` | ≈90 行 |
| `dialogs.mjs` | 删除（见 §11-①；历史转写移 `legacy/`，决定原话改由 `decision.quote` 记录） | 0 |
| **新增** `migrate.mjs` | 老仓 → 新格式一次性迁移 | ≈120 行 |
| **新增** `cli.mjs` | 独立驱动器：`init / audit / migrate / scan / sweep / progress`（确定性作业，**不进 MCP**） | ≈270 行 |
| `AGENTS.md` | 重写：从「协议栈」改成「一张卡 + 六工具 + 四事件（`score`/`decision`/`edit`/`anchor`）」 | — |

### 8.3 参数：36 → 8

```jsonc
{
  "K_file": 5,            // 一个 σ 点约几个文件 → R₁
  "K_line": 250,          // 一个 τ 点约几行   → R₂
  "R1_min": 6, "R1_max": 64,
  "R2_min": 3, "R2_max": 32,
  "sigma_band": 0.02,     // σ 边缘区阈值（低于此**仍列出**，标 edge:true，不裁员不静默）
  "tau_band": 0.02        // τ 边缘区阈值（同上；截断只由分辨率 R₂ 决定）
}
```

（`overview_tokens` 不再需要配置：`≈120·R₁ + 300`。）

---

## 9. 迁移方案（账不毁）

```
node src/server.mjs migrate --repo b:/codebuddyCELL
```

| 老产物 | 新落点 |
|---|---|
| `packages/v0001…v0006.yaml` | 每个包 → 1 条 `anchor`（label 用 `package.version` + `built_at.rev`）+ 每活跃节点 1 条 `score`（`raw` 取该包 `sigma/tau`，`why:"new"`） |
| `ledger/r0000…r0001.jsonl` | 原样移到 `legacy/ledger/`（保留审计痕迹，不参与折叠） |
| `backlog/entries.jsonl` | 移到 `legacy/`（claim 已删，不再成为节点） |
| `workorders/`、`checklists/`、`assess/`、`drift/`、`archive/` | 移到 `legacy/` |
| `dialogs/` | 移到 `legacy/`；**可选**：用一次性脚本抽取能确证的人的原话 → `note(kind="decision")`（`quote` 取自原话，`by:"human"`，`stage:"迁移"`） |
| `INDEX.yaml` | 丢弃（新 `index.yaml` 由 `events.jsonl` 折叠生成） |

⚠️ **如实声明一处历史缺口**：老包只存了**归一后**的 σ/τ，原始强度已不可还原。迁移时把归一值当 `raw` 写入，并加一条 `anchor` 注明「v1–v6 为归一值，仅作对比，不可与 v7 之后的 raw 直接比较」。**从 v7 起历史才是真正可比、可解释的。**

迁移后 `audit` 应输出 `ok:true`，且 `timeline` 能复现「B₀ → 二级结构落地」两段。

⚠️ **`decision` / `edit` 从 v7 起才成立**：老账本里没有「人的决定原话」与「谁把哪些文件改成了什么样」的结构化记录（老 F3 缺口），**无法机械还原，也不伪造**。迁移只做一件可选事：从 `legacy/dialogs/` 抽取能确证的人的原话，补成 `decision`（`stage:"迁移"`）。

---

## 10. 验收指标

| # | 指标 | 目标 |
|---|---|---|
| 1 | 模型必须记住的规则 | **≤5 条** |
| 2 | MCP 工具 | **6**（读 4 + 写 2） |
| 3 | 持久化产物 | **3**（+ `legacy/` 只读归档） |
| 4 | 参数 | **≤8** |
| 5 | `core.mjs` 行数 | **≤450** |
| 6 | 一次普通对话的服务调用 | **≤2 次**，返回 **0 待办项** |
| 7 | `brief` 预算降级比例 | **0%** |
| 8 | 单笔 `score` 的写入成本 | O(1) 追加（无全库重算、无原子换版） |
| 9 | 历史可解释性 | 未改动节点的 `raw` 序列**绝不出现自发跳变** |
| 10 | 冷启动 | 新项目 `init` → `brief` 可用，无需建包、无需开工单 |
| 11 | 人的决定可追溯 | 每条 `decision` 带**原话 + 所在步骤**且 `by:"human"`；`timeline` 能回溯到决定 |
| 12 | 改动可追溯 | 每条 `edit` 带 `scope` + 前后 hash；`score.caused_by` 能指到 `edit`/`decision` |

---

## 11. 待你拍板（6 项）

| # | 问题 | 我的建议 |
|---|---|---|
| ① | `dialogs/`（对话转写）是删还是留？ | **降为只读 `legacy/`**：决定的原话改由 `decision.quote` 就地记录，不再常驻写面；保留 `legacy/` 只为迁移时抽取原话。 |
| ② | `flag` 事件要不要保留？ | **不再单列**：`edge` / `frozen` 并入 `score.tags`，不参与打分；「脏(直读)」是 hash 不符自动推导，不用 tag。 |
| ③ | 分辨率常数（`K_file=5` / `K_line=250`） | 先用当前仓反推值，跑两周后用 `timeline` 里的 F/L 分布校准。 |
| ④ | `accepted` 的分数范围 | 建议 `raw ∈ [0,1]` 且**不做「总和为 1」的输入约束**（归一在读取时做）。评一个点不影响另一个点。 |
| ⑤ | 文档落位 | 现放在 `B:/MCP/repo-attention-mcp/REFACTOR-v1.md`；若你希望跟项目文档走，我挪到 `Docs/`。 |
| ⑥ | 写面是否进一步合并为**一个** `note`（连 `anchor` 一起收进去）？ | **暂不合并**：保持「读 4 + 写 2」的 6 工具面，`note` 负责高频事件、`anchor` 负责低频段边界，语义更清楚。若你更想要极致精简，可合并为 5 工具。 |

---

## 附录 A · 事件流样例（迁移后 b:/codebuddyCELL）

```jsonc
{"ts":"2026-09-10T06:25:41Z","by":"migrate","kind":"anchor","label":"B₀ 首次全量打分(v1)","resolution":{"R1":20,"basis":"250行/点","F":96,"L":24100}}
{"ts":"2026-09-10T06:25:41Z","by":"migrate","kind":"score","node":"cs-core-engine","layer":"module","raw":0.0987,"why":"new","evidence":["proj://codebuddyCELL/cell_sim/core/engine.py:31-198#eq1-eq4"],"src_hash":"sha256:66e69c15…","note":"v1–v6 为归一值，仅作对比"}
…
{"ts":"2026-09-10T09:16:26Z","by":"main","kind":"edit","scope":["cell_sim/bridge/","cell_sim/body/","cell_sim/resolver.py"],"summary":"建立两级接口层/机体侧数值核/细胞库视图层，并接入 loader","before_hash":"sha256:3f21…","after_hash":"sha256:8a76…","round":6}
{"ts":"2026-09-10T11:00:00Z","by":"human","kind":"decision","label":"二级构型按 A 建档，血浆介质单列","quote":"纤维细胞用 A 型，血浆单独一档","stage":"选型","affects":["cs-resolver"]}
{"ts":"2026-09-10T12:33:39Z","by":"migrate","kind":"anchor","label":"二级结构落地(v6)","resolution":{"R1":24,"basis":"250行/点","F":120,"L":30210}}
{"ts":"…","by":"main","kind":"score","node":"cs-body","layer":"module","raw":0.71,"why":"code_changed","evidence":["proj://codebuddyCELL/cell_sim/body/"],"src_hash":"sha256:77134a7b…","caused_by":"2026-09-10T09:16:26Z","note":"机体侧数值核"}
```

## 附录 B · 返回样例

**`brief()`**
```jsonc
{ "version": 7, "latest_ts": "…", "resolution": {"R1":24,"R2_basis":"250行/点"},
  "modules": [
    {"id":"cs-core-engine","p":0.104,"raw":0.66,"dirty":false,"ref":"…:31-198#eq1-eq4"},
    {"id":"cs-dynamics",   "p":0.084,"raw":0.62,"dirty":true, "ref":"…:74-330#Simulation"},
    {"id":"cs-body",       "p":0.071,"raw":0.71,"dirty":false,"ref":"…cell_sim/body/"}
  ],
  "anchors": [ {"r":6,"label":"二级结构落地(v6)","ts":"…"}, {"r":1,"label":"B₀","ts":"…"} ],
  "budget": {"overview_tokens":3180,"used":1240} }
```
注意：没有 backlog、没有工单、没有 t2、没有 coverage、没有 flux 列表。

**`expand("cs-dynamics")`**
```jsonc
{ "module":"cs-dynamics","sigma_p":0.084,
  "units":[ {"id":"cs-dynamics.b6","p":1.0,"raw":1.0,"dirty":false,"refs":["…:228-300#_step_b6"]} ] }
```

**`timeline("cs-dynamics")`**
```
r1  raw 0.55   (B₀)
r6  raw 0.62   (二级结构落地；分辨率 R1 20→24)
    无自发跳变；本节点仅在 r1/r6 被评分。
```

## 附录 C · 给模型的规则卡（全部内容）

```
1. 会话开始读 brief()：它是唯一入口，给 σ 榜（模块强度概率）与分辨率。
2. 要看某个模块内部：expand(module) 拿 τ 榜；问"某功能在哪"：lookup(question)。
3. 标了 [直读] 的模块，读原文，不信它的旧分。
4. 只有在这四种情形才写：
   - 你读到的和账上不一致 → note(kind="score", 带 evidence + src_hash)
   - 人做出了决定           → note(kind="decision", by 固定 human, quote 必填，只代录)
   - 文件被改动             → note(kind="edit", 带 scope + 前后 hash)
   - 项目迈过里程碑         → anchor(...)
5. 历史用 timeline()：分值序列 + 锚 + 决定/改动。没有其它动作，也没有待办项。
```
