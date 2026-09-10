# AGENTS.md — 双包协议·级 1 零代码演练读规则（人肉 server）

> 本文件适用于**没有 server 的演练项目**（§12 级 1）。布局原样上盘（`.repo-attention/`），
> 读规则写在这里，人肉充当 server：`startup_brief` = 手动打开 INDEX+当前包；
> `publish` = 手动写新快照文件 + 手改 INDEX 的 latest（模拟 rename）。
> 验证四件事：评估成本、打分质量、收口遗忘行为、文件格式本身。
> 级 2 后本文件的规则全部转为 server 机械执行，**目录零改制**。

## 硬规则（不可协商）

1. **会话开始**：先读 `.repo-attention/INDEX.yaml` 记下 `latest`，全程只用 `packages/v{latest}.yaml`（钉版）；不要中途换。
2. **两跳定位**：σ 层全扫（模块少）→ 命中模块展开 τ → 依 `evidence.refs` 回项目读详细内容。包不装内容，只装"去哪读、读多强"。
3. **flux 模块跳过评分指引直读**；flux 面积 ≥50% 模块时整包按直读模式处理。
4. **episode 主权在人**：agent 不得自行宣告收口/触发评估/无指令改码；重构动工前必须有使用者确认的清单（`checklists/cl-*.yaml` draft→使用者确认→open+标 flux）。
5. **清单开放期间暂停一切评估**；期间小改以声称记 `backlog/entries.jsonl`；新结构意向只入 backlog 不扩清单。
6. **修改+评估=原子事务**：代码改完后，评估 publish 之前不得进入依赖新包的讨论。
7. **每笔打分必带** `evidence.refs`（`proj://<repo>/<path>:<s>-<e>#<symbol>@<rev>`）+ 实测 `src_hash` + 三成因之一（code_changed / attention_moved / initial_mistake）。无证据链的分数不合法；**禁止行级锚**（无 symbol 的 ≤2 行区间）。
8. **漂移序列不回流**：读 `drift/points.jsonl` 或节点 hist 只用于报表/复盘，绝不作为打分输入。
9. **记忆的三个出口**：晋升（写 ADR/canon + 双向链，人批准）、归档（边缘区持续 ≥A 轮，自动）、钉档（反证工单 + 人批准 + 阅读裁决）。**低分≠错误；stale≠否定**。账不毁——任何"删除"都只是墓碑。
10. **转写实时落盘**：对话发生时往 `dialogs/sess-NNN.jsonl` 逐行追加，每行带 `prev_hash`（上一行 JSON 的 sha256；首行 `sha256:GENESIS`）。引用使用者原话（quote）做主权动作前，先核对转写里有这句话。
11. **追加不删**：`backlog/`、`drift/points.jsonl`、`ledger/` 只尾部追加；销账用标记 `consumed_at`，不删行。
12. **每次操作在 `ledger/r{段号}.jsonl` 记一行**：`{seq, ts, who, tool(手执动作名), args_digest, quote?, result}`。

## 评估节拍（读 INDEX.counters 判断）

- `close_pending` 非空 → 本次必须**全评+重锚**（§4.4 七步：声称验证→重打分→注意力调整→重锚→分辨率工单→发布自检→落漂移点）。
- 清单未开且 `dialogs_since_eval ≥ 5` → 下次对话前 T2 全评。
- 清单开放超 10 对话 → 向使用者报告"建议拆分或收缩"（只提醒）。
- 快评=只重打 hash 命中节点；backlog 非空或有结构声称 → 升全评。
- 满 10 次评估 → 手写五段报表到 `drift/reports/`（节点账表/锚时间线/汇总/canon出入账/决定性集 + 失败库附表）。

## 打分与归一

5 档量规 + 同档两两比较定秩、秩归一；同段 Σσ=1、同模块 Στ=1（改分/删节点后整池重新归一）。跨段比秩不比值。每模块 τ 单元带 [3,30]：爆带上抬一档（symbol→file）、不足 3 并入 σ 直读；大项目只对 top-K 高 σ 模块懒细化到 L3；总单元 ≤500，claims ≤400。

## 预算（写入前自检）

启动卡（σ 全表+flux+T2+decisive+backlog 计数）≤900 token；τ 展开 ≤6000；对话榜 ≤300（decisive 永不截断）。超预算：详细内容降级为仅引用路径，并在返回处显式声明"降级已发生"。修改模式先截对话榜、讨论模式先截代码长尾；不确定按修改模式。

## 会话关闭即抽（对话语料）

窗口结束（新窗开启被感知）→ 对全转写跑抽取，只收"带锚断言"（四测：可锚定 / 可独立回读 / 决策完整 / 预算匹配 [3,30] 条），产出 claims 并入 backlog——**抽取不调用评估**，验证与打分在下一个自然 T1/T2。decisive 断言变脏：先读码裁决"仍成立→刷新 hash"或"冲突→停下来报告"，禁止带着被违反的决定性结论改码。
