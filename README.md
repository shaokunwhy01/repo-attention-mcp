# repo-attention-mcp

**记忆力-注意力聚焦 MCP 服务** —— 「双包协议」（组合包 B / 漂移包 D）v0.3 → v0.4 → 三面嵌入 §9–§13 → R1 修订的完整实现。

> 把大项目的全部可锚内容（代码 + 对话）折算成两级"内容读取有效强度"分值包作为读取指引；
> 评估由事件驱动、周期兜底；重构类变更由清单定义轮次；每 10 次评估产出漂移报表，持续给出直至项目结束。

## 三条总架构决断（如何体现在代码里）

| 裁决 | 落地 |
|---|---|
| **Server 从不调用模型** | 全部为确定性 Node.js：hash 比对 / schema 校验 / 归一 / 预算 / 快照 / 账本。打分判断由消费端 agent 经 `assess_submit` 提交（src `core.mjs` 无任何网络/模型调用） |
| **文件是契约，工具是看门人** | 全部状态住在 `<项目根>/.repo-attention/` 纯文本仓（YAML/JSONL/MD，P3 零依赖）。删掉 server，文件协议原样成立——每个工具的返回值都能在某个文件里找到原文（`test/smoke.mjs` 最后一步在验证这条） |
| **人的主权只有一种形态：quote** | 三个主权工具（C 组）强制 `quote:{text,sess_hint?,span_hint?}`，调用瞬间对 `dialogs/*.jsonl` 做三态验证（verified/failed/no_coverage），digest 唯一消费防重放（I12） |

## 部署（§9）

每个项目一个 server，stdio 启动，参数只有 repo 根路径。进程生命周期 ≈ 会话生命周期 → **会话钉版由进程天然实现**（首次读自动 pin latest）。多项目 = 多进程，互不感知。

```jsonc
// 项目根 .mcp.json
{
  "mcpServers": {
    "repo-attention": {
      "command": "node",
      "args": ["<路径>/repo-attention-mcp/src/server.mjs", "serve",
               "--repo", "<项目根>", "--role", "writer", "--session", "sess-001"]
    }
  }
}
```

### 双模式（R1 裁决③）

- `--role=writer`（默认）：全工具面。启动持 `writer.lock`（INDEX 内嵌 pid+session+心跳戳，60s 刷新），第二个 writer 见未失效锁**拒绝启动**；锁失效可接管，接管事件记入账本不许无声换主。
- `--role=ro`（CI/后台整理）：向宿主注册的工具清单**只有 A 组 6 + E 组 2**——权限边界做在工具名单上而非调用拒绝上，ro 的模型根本看不到 B/C/D 组。无状态读，不落盘。
- 派生后果：ro 角色的有价值声称必须以文本形式经对话会话转手入账（`claim_record` 可带 `source: 'relayed_by:ci-xxx'`）——摩擦是故意的，入账入口收敛到人开着的窗口。

## 三面

```
注入面   startup_brief —— 唯一进 system context 的东西（≤900 tok 软预算）
工具面   五组工具（文档名义"16 个"，逐项列举实为 18 端点，本实现全部落地 + audit 走 CLI）
仓库面   .repo-attention/ 纯文本 —— 三面中唯一的状态持有者
```

| 组 | 工具 | 编码的不变量 |
|---|---|---|
| A 读 | `startup_brief` σ全表+flux+T2倒计时+decisive对齐校验（规则2/9一步完成）· `sigma_overview` 调用瞬间重算 hash 挂 drift_warning（I3）· `tau_expand` 超预算显式声明降级（规则6）· `node_detail` **无序列字段**（I5）· `node_history` 序列独立通道（I5）· `archive_get` 墓碑全史（I11） |
| B 登记 | `claim_record` 锚不上代码/行级锚当场拒收（I7 机械前置）· `dialog_extract` 收口即抽幂等补跑，**不触发评估**（§4.0 时钟寄生固化在接口层）· `propose_checklist` draft 态不动 flux（I2）· `propose_workorder` negate 缺反证直接拒收（I10） |
| C 主权 | `checklist_confirm` / `episode_close` / `workorder_approve`——全部强制 quote（I12）。`episode_close` 是收口全评唯一入口：没有它，publish 的重锚动作被拒绝（I2/I4）。**没有 delete 工具**（I11） |
| D 评估事务 | `assess_open` 确定性 workset（hash命中∪backlog∪待裁工单∪edge计数推进）· `assess_submit` **逐节点**，每笔即时校验、坏一笔不毁一单；支持 `items[]` 批量包装（server 拆开逐笔，回滚域仍是笔级——§13 观察项①的解已内置）· `assess_publish` 覆盖率=集合运算、自检失败整体回滚、P1 原子换 INDEX |
| E 报表 | `drift_report` §4.6 五段式+失败库附表（满 M=10 轮自动导出）· `rehearse_budget` 实测校准 600/6000 |

CLI（非 MCP 工具，保住工具面纯度）：

```
node src/server.mjs init --repo <根>                      # 建 .repo-attention 布局
node src/server.mjs append-dialog --repo <根> --sess 041 --role user --text "原话"
                                                          # R1：转写会话中增量追加（行级 digest 链 P7）
node src/server.mjs seal-dialog --repo <根> --sess 041 --mode modify   # 关闭=追加 seal 行+文件级 sha；T2 计数在此
node src/server.mjs audit --repo <根>                      # P6 replay_audit：包字节漂移/Σ归一/无锚/行级锚/账本闭环/链完整
node src/server.mjs verify-quote --repo <根> --text "..."  # quote 校验调试
```

## 文件仓（§11 + R1 §11 修订）

```
.repo-attention/          # 整树 .gitignore；zip 此目录 = 搬走项目全部记忆
  INDEX.yaml              # ★唯一可变点：latest/段/episode/counters/params 生效值/writer_lock 快照
  packages/vNNNN.yaml     # 不可变快照（代码+对话两语料同在；claims 住包里，无独立 claims/ 双写）
  drift/points.jsonl  drift/reports/rNNNN.md  drift/events.jsonl(小锚事件)
  dialogs/sess-NNN.jsonl  # append-only {ts,role,text,sess,seq,prev_hash} 行链；关闭追加 seal + .sha256
  backlog/entries.jsonl   # publish 标 consumed 不删行
  checklists/cl-NNN.yaml  # draft→open→closed + confirm/close quote 原文
  workorders/open/ closed/
  archive/nodes/<id>.yaml # 墓碑 retired/negated/promoted/resumed 标记
  assess/<t>/draft.jsonl  # 逐笔工作集，发布 sealed@rK 封存保留评估次序（审计材料）
  ledger/rNNNN.jsonl      # I9 算子账本：{seq,ts,tool,args_digest,quote?,quote_digest,quote_verdict,matched_span,result}
  canon_links.yaml
```

**六条存储原则 + P7**：唯一可变点（崩溃任何时刻要么旧版要么新版）· 不可变或 append-only · 纯文本三格式 · 原文与结论分离 · canon 边界（仓库只出现晋升产物）· 可重放（audit 检出"账本里没有但包里有"=评估剧场实锤）· 转写行哈希链（插行删行即断链可检）。

## 不变量 → 机制速查（v0.4 I1–I11 + R1 I12）

| # | 机制（全部 server 可判定，无需"理解"协议） |
|---|---|
| I1 | assess 三连，发布只经 publish；工单未 publish 时读面返回旧版 + `assessment_open` 警告 |
| I2 | 只有 C 组能动轮次/账结构，quote 必附且经验证；`episode_close` 缺席则重锚被拒 |
| I3 | 读面每次重算 hash 挂 drift_warning；T2 倒计时在启动卡；清单开放期豁免（flux 显式声明失效范围，禁静默过期） |
| I4 | 工具面无即时改分口子；结构操作（add/remove/merge）在快评中 publish 直接拒绝 |
| I5 | `node_detail` 与 `node_history` 两个调用、打分通道返回结构中无序列字段（数据结构本身守住） |
| I6 | 每笔提交强制 evidence+src_hash+三成因；src_hash 与实况比对不符拒收 |
| I7 | schema 拒无锚、拒行级（无 symbol 且 ≤2 行区间即行级）；自检再兜一层 |
| I8 | INDEX rename 原子换；快照全可读；writer 进程钉版 |
| I9 | 每次调用一行账本（含 quote 原文），audit 重放比对 |
| I10 | negate 强制反证 + approve 通道；纯分数衰减只能归档（边缘区持续触发的是 archive 不是 negate） |
| I11 | 全工具面无 delete；退出节点走墓碑，`archive_get` 永远可查 |
| I12 | quote 三态验证 + digest 唯一消费（重放拒收）+ no_coverage 待补账。**信任边界申明：防误写/记忆漂移/上下文错位，是强审计不是密码学证明；伪造面由级 3 宿主签名收口** |

## 关键规则落地摘要

- **清单制/单轮语义（§4.4）**：确认瞬间标 flux、episode 开始；执行期 `assess_open` 被拒（T1 不触发 T2 豁免）；`episode_close` 武装收口 → 下一次 publish 强制全量重锚、旧段漂移序列只落 **1 点**（`t:'T3', g:所跨对话数`）。软提醒：开放超 G_max → `gmax_soft_reminder` 警告（只提醒不触发）。
- **flux 大面积化（裁决②）**：flux ≥50% 模块 → `flux_mass` 警告，整包进入直读模式（`flux_void_threshold` 参数可调）。
- **边缘区双轨（§2.6）**：publish 后机械入区（<θ_edge 且秩末 L）；连续 ≥A 轮 → 全评自动归档（轨道一，可复活：hash 变脏**且存在**或 backlog 点名→resumed 回拨）；钉档只能经反证工单+人批准+全评验证门（轨道二，进失败库）。**复活触发器排除引用缺失**——删除是销账不是复活信号。
- **三裁决（R1）**：① quote 结构化验证已实现，`decisive_promotion:'auto_on_promote'`（晋升自动继承 decisive，防标记通胀由观察验证）；② `assess_submit` 逐节点 + `items[]` 拆分包装；③ writer/ro 双模式 + 锁。参数表加行：`close_ignores_pending_wo: true`（收口不因待裁工单阻塞，可关）。
- **参数动态校准**：A 按占用率闭环 clamp[6,24]（>80%→8，<40%→16），每次 publish 写回 `INDEX.params_overrides.A`。
- **三成因合法通道**：`cause ∈ {code_changed, attention_moved, initial_mistake}`；`initial_mistake` 自动记入 `anchor_fixes`（唯一修锚通道，也是钉档平反唯一入口）。

## 三级演进路径（§12）

```
级1 零代码演练：node scripts/level1-skeleton.mjs --repo <演练项目>
   生成布局+空包+AGENTS.md 读规则+dialogs 行格式模板（链哈希从第一天就写）。
   人肉充当 server：startup_brief=手看 INDEX+包；publish=手改文件+rename。
级2 server 接管：同一目录零数据改制（本仓库即级 2）——serve 独占写权。
级3 宿主集成：startup_brief 挂宿主自动注入槽；quote 验证源切换为宿主签名（R1 收口件，优先级最高）。
```

```
这是一个测试版本，不保证与正式版的兼容性。以及测试版存在一大堆问题。因为数学端还没决定，也就是没想好，所以集成进入大模型或者更深接入还不现实。还有，这是AI写的代码，bug等异常不会少。

```
邵昆（shaokun） 2894670027@qq.com  辅助工具：AI大模型、agent。


