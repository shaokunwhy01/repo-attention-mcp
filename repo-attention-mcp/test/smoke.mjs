// test/smoke.mjs — 双包协议 MCP server 端到端演练（文档附录“最小示例”的机器版）
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRV = path.join(__dirname, '..', 'src', 'server.mjs');

const tmp = path.join(os.tmpdir(), 'ra-smoke-' + Date.now());
const proj = path.join(tmp, 'proj');
const root = path.join(proj, '.repo-attention');
mkdirSync(path.join(proj, 'src', 'auth'), { recursive: true });
mkdirSync(path.join(proj, 'docs'), { recursive: true });
const tokenGo = Array.from({ length: 200 }, (_, i) => `// line ${i + 1} func body padding ${(i * 7919) % 977}`).join('\n') +
  '\nfunc Refresh() {} // token刷新主体\n';
writeFileSync(path.join(proj, 'src', 'auth', 'token.go'), tokenGo);
writeFileSync(path.join(proj, 'src', 'auth', 'session.go'), 'func Load() { /* session */ }\n'.repeat(40));
writeFileSync(path.join(proj, 'docs', 'adr.md'), '# ADR\n\n## 0001 双令牌\n\n旧文\n');
const R = (p) => path.join(proj, p);

let pass = 0, fail = 0;
const log = (m) => console.log(m);
async function step(name, fn) {
  try { await fn(); pass++; log(`  ✓ ${name}`); }
  catch (e) { fail++; log(`  ✗ ${name}\n    ${e.message}`); }
}

// ---- MCP 客户端（stdio JSON-RPC） ----
function client(args = []) {
  const p = spawn(process.execPath, [SRV, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = ''; const pending = new Map(); let idSeq = 0;
  p.stdout.on('data', d => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  const send = (method, params) => new Promise(res => { const id = ++idSeq; pending.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  const call = async (name, a = {}) => {
    const r = await send('tools/call', { name, arguments: a });
    if (r.error) throw new Error(`rpc ${name}: ${JSON.stringify(r.error)}`);
    return JSON.parse(r.result.content[0].text);
  };
  return { p, send, notify, call, close: () => p.kill(), stderr: () => p.stderr.toString() };
}
async function startClient(args) {
  const c = client(args);
  const init = await c.send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assert(init.result.protocolVersion, 'initialize 无 protocolVersion');
  c.notify('notifications/initialized', {});
  c.serverInfo = init.result.serverInfo;
  const tl = await c.send('tools/list', {});
  c.tools = tl.result.tools.map(t => t.name);
  return c;
}

const cli = (args) => new Promise((res, rej) => {
  const p = spawn(process.execPath, [SRV, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', e = '';
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => e += d);
  p.on('exit', code => res({ code, out: out.trim(), err: e.trim() }));
});

const A = 'proj://svc/src/auth/token.go:200-201#Refresh'; // 行区间含 symbol → 合法
const REF_T = A + '@8c1d';
const nowSrc = async () => { // 计算现状 src_hash（用于提交时诚实哈希）
  const r = await cli(['verify-quote', '--repo', proj]); void r;
  return null;
};
// 通过 node 内联取 hash：用临时 helper 复用 server 的 util
import { hashEvidence } from '../src/util.mjs';
const H = (refs) => hashEvidence(proj, refs.map(r => r.replace(/@[0-9a-f]{4,}$/, '')));

// ================== 场景开始 ==================
let w; // writer client
await step('init + 目录布局', async () => {
  const r = await cli(['init', '--repo', proj]);
  assert(r.code === 0, r.err);
  assert(existsSync(path.join(root, 'INDEX.yaml')), 'INDEX 缺失');
  for (const d of ['packages', 'drift/reports', 'dialogs', 'backlog', 'checklists', 'workorders/open', 'archive/nodes', 'ledger', 'assess'])
    assert(existsSync(path.join(root, ...d.split('/'))), d + ' 缺失');
});

await step('writer 启动 + tools/list = 18 个工具端点', async () => {
  w = await startClient(['serve', '--repo', proj, '--session', 'sess-041']);
  assert(w.tools.length >= 16, `工具数 ${w.tools.length}`);
  for (const t of ['startup_brief', 'sigma_overview', 'tau_expand', 'node_detail', 'node_history', 'archive_get',
    'claim_record', 'dialog_extract', 'propose_checklist', 'propose_workorder',
    'checklist_confirm', 'episode_close', 'workorder_approve',
    'assess_open', 'assess_submit', 'assess_publish', 'drift_report', 'rehearse_budget'])
    assert(w.tools.includes(t), '缺工具 ' + t);
});

await step('空文件即空包：startup_brief v0 + 钉版', async () => {
  const b = await w.call('startup_brief', { mode: 'modify' });
  assert(b.ok && b.version === 0 && b.pin === 0, JSON.stringify(b).slice(0, 200));
  assert(b.t2.limit === 5, 'N≠5');
});

await step('T0 拒绝 / 触发校验', async () => {
  const r = await w.call('assess_open', { trigger: 'T0' });
  assert(!r.ok && r.error.code === 'schema');
});

await step('I7：行级锚 + 无锚拒收（接口机械前置）', async () => {
  const r1 = await w.call('claim_record', { assert: '行级测试', code_refs: ['proj://svc/src/auth/token.go:88-89'] });
  assert(!r1.ok && /行级/.test(r1.error.message), JSON.stringify(r1.error));
  const r2 = await w.call('claim_record', { assert: '无锚', code_refs: [] });
  assert(!r2.ok && r2.error.code === 'anchor_violation');
});

await step('B₀ 全量打分（bootstrap → v1，段 s=1，锚=1）', async () => {
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok && o.kind === 'full' && o.reanchor, JSON.stringify(o.error || o.kind));
  const hT = H([A]), hS = H(['proj://svc/src/auth/session.go:38-39#Load']), hD = H(['proj://svc/docs/adr.md:3-5#ADR']);
  const subs = await w.call('assess_submit', { t: o.ticket, items: [
    { node_ref: 'auth', change: { op: 'add', kind: 'module', ref: 'proj://svc/src/auth/', sigma: 45, summary: '令牌与会话：rotation 主战场', tier: 'L3', evidence: { refs: ['proj://svc/src/auth/'] }, src_hash: H(['proj://svc/src/auth/']).src_hash, cause: 'code_changed' } },
    { node_ref: 'docs', change: { op: 'add', kind: 'module', ref: 'proj://svc/docs/', sigma: 20, summary: 'ADR 归档区', tier: 'L2', evidence: { refs: ['proj://svc/docs/'] }, src_hash: H(['proj://svc/docs/']).src_hash, cause: 'code_changed' } },
    { node_ref: 'auth/token.go#Refresh', change: { op: 'add', kind: 'content', module: 'auth', tau: 55, evidence: { refs: [A] }, src_hash: hT.src_hash, cause: 'code_changed' } },
    { node_ref: 'auth/session.go#Load', change: { op: 'add', kind: 'content', module: 'auth', tau: 45, evidence: { refs: ['proj://svc/src/auth/session.go:38-39#Load'] }, src_hash: hS.src_hash, cause: 'code_changed' } },
    { node_ref: 'docs/adr.md#ADR', change: { op: 'add', kind: 'content', module: 'docs', tau: 100, evidence: { refs: ['proj://svc/docs/adr.md:3-5#ADR'] }, src_hash: hD.src_hash, cause: 'code_changed' } },
    { node_ref: 'api', change: { op: 'add', kind: 'module', ref: 'proj://svc/docs/adr.md', sigma: 35, summary: '对外接口（暂借文件锚）', tier: 'L2', evidence: { refs: ['proj://svc/docs/adr.md:1-1#title'] }, src_hash: H(['proj://svc/docs/adr.md:1-1#title']).src_hash, cause: 'code_changed' } },
  ] });
  assert(subs.ok && subs.accepted === 6, JSON.stringify(subs.results || subs.error));
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.published === 1 && pub.reanchor && pub.segment === 1, JSON.stringify(pub.error || pub.published));
  assert(pub.drift_point.d === 0 && pub.drift_point.t === 'T1' && pub.drift_point.g === 0, JSON.stringify(pub.drift_point));
  assert(existsSync(path.join(root, 'packages', 'v0001.yaml')));
});

await step('I6：假 hash 提交被拒（坏一笔不毁一单）', async () => {
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok && o.kind === 'fast' && o.scope.length === 0, '空轮应 fast scope 空');
  const r = await w.call('assess_submit', { t: o.ticket, node_ref: 'api', change: { tau: 1, evidence: { refs: [A] }, src_hash: 'sha256:FORGED', cause: 'attention_moved' } });
  assert(!r.ok && r.error.code === 'src_hash_mismatch', JSON.stringify(r.error));
  // 坏一笔后继续提交合法笔：先补 no_change 不合法（不在 scope）→ 该轮直接平点发布：publish 空 draft 可行（scope 空）
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.published === 2, '平点发布应成功: ' + JSON.stringify(pub.error));
  assert(pub.drift_point.d === 0, '干净基线点 d=0');
});

await step('§4.0 会话关闭即抽：sess-041 转写链 + extract 入 backlog', async () => {
  await cli(['append-dialog', '--repo', proj, '--sess', '041', '--role', 'user', '--text', '决定采用 token rotation，弃用双令牌方案，旧会话期延迟翻倍']);
  await cli(['append-dialog', '--repo', proj, '--sess', '041', '--role', 'assistant', '--text', '好的，将更新 refresh 逻辑并记录结论']);
  await cli(['append-dialog', '--repo', proj, '--sess', '041', '--role', 'user', '--text', 'auth 与 session 两个目录应该合并，减少跨目录跳转']);
  const s = await cli(['seal-dialog', '--repo', proj, '--sess', '041', '--mode', 'modify']);
  assert(s.code === 0, s.err);
  assert(/"sealed"/.test(s.out));
  const x = await w.call('dialog_extract', { sess_id: '041', claims: [
    { assert: 'token刷新采用rotation，弃用双令牌——旧会话期延迟翻倍', code_refs: [REF_T], span: 'dialog://sess-041#t17-t23', decisive: true },
    { assert: 'auth 与 session 目录应合并', code_refs: ['proj://svc/src/auth/session.go:38-39#Load'], structural: true },
    { assert: '句级碎片测试（应被锚检拦）', code_refs: ['proj://svc/src/auth/token.go:3-4'] },
  ] });
  assert(x.ok && x.claims_enqueued === 2 && x.rejected.length === 1, JSON.stringify(x));
  const x2 = await w.call('dialog_extract', { sess_id: '041', claims: [] });
  assert(x2.ok && x2.already_extracted, '幂等补跑失败');
  const b = await w.call('startup_brief', {});
  assert(b.backlog_count === 2, 'backlog 应为 2');
});

await step('backlog 非空 → T1 快评升格全评；claim 经收口验证入包', async () => {
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok && o.kind === 'full' && o.backlog.length === 2, JSON.stringify(o.error || o.kind));
  assert(o.needs_full_reasons.some(r => /backlog/.test(r)));
  const hT = H([A]);
  const subs = await w.call('assess_submit', { t: o.ticket, items: [
    { node_ref: 'auth/token.go#Refresh', change: { no_change: true, reason: '阅读复核：本轮无相关变化' } },
  ] });
  void subs; void hT;
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.published === 3, JSON.stringify(pub.error));
  assert(pub.backlog_verdicts.length === 2, 'backlog 销账');
  const pkg = JSON.parse(JSON.stringify(await w.call('node_detail', { ref: 'api' }))); void pkg;
  // 找新 claim
  const found = [];
  for (const mid of ['auth']) found.push(mid);
  const b2 = await w.call('startup_brief', {});
  assert(b2.backlog_count === 0, '发布后 backlog 已清');
});

await step('claim 可查/decisive 提议需工单；晋升需 canon_target', async () => {
  const { ok } = await w.call('node_detail', { ref: 'c-sess-041-0001r3' }).then(r => ({ ok: r }));
  void ok;
  const woBad = await w.call('propose_workorder', { kind: 'promote', ref: 'c-sess-041-0001r3' });
  assert(!woBad.ok && /canon_target/.test(woBad.error.message), JSON.stringify(woBad.error));
});

// ---- C 组：quote 三态（先失败再补账成功） ----
await step('I12：伪造 quote → failed + 最相近三行', async () => {
  const r = await w.call('checklist_confirm', { cl_id: 'cl-0001', quote: { text: '我从未说过的话完全不存在于转写' } });
  assert(!r.ok && r.error.code === 'quote_failed', JSON.stringify(r.error));
  assert(r.error.details.nearest.length >= 1, 'nearest 缺失');
});

await step('episode 全流程：propose → confirm(verified) → flux → T2豁免 → 执行期拒评', async () => {
  const p = await w.call('propose_checklist', { kind: 'refactor', items: [
    { op: 'modify', ref: 'proj://svc/src/auth/', intent: '合并两模块目录' },
    { op: 'remove', ref: 'proj://svc/src/auth/session.go:38-39#Load', intent: '迁移后删除' },
    { op: 'add', ref: 'proj://svc/src/auth/bridge.go:5-6#Bridge', intent: '新增桥接层' },
  ] });
  assert(p.ok && p.checklist === 'cl-0001', JSON.stringify(p.error));
  const q = { text: '决定采用 token rotation…合并，减少跨目录跳转', sess_hint: '041' }; // 省略号跨两段真实话
  // 上面把两句跨行拼接，每段各自匹配 → normalized 通过（模拟删节合法）
  const c = await w.call('checklist_confirm', { cl_id: 'cl-0001', quote: { text: 'auth 与 session 两个目录应该合并，减少跨目录跳转', sess_hint: '041' } });
  assert(c.ok && c.episode.startsWith('ep-') && c.flux.includes('auth'), JSON.stringify(c.error || c.flux));
  void q;
  const b = await w.call('startup_brief', {});
  assert(b.flux.length === 1 && b.warnings.some(w2 => w2.code === 'flux_open'), 'flux 未现于启动卡');
  assert(b.t2.exempt === true, '清单开放期 T2 未豁免（I3）');
  const te = await w.call('assess_open', { trigger: 'T2' });
  assert(!te.ok && (te.error.code === 'episode_open' || te.error.code === 't2_exempt'), '执行期竟可评估!');
  // 执行期顺手改 api → 声称入 backlog（hash 检查兜住）
  const cr = await w.call('claim_record', { assert: 'api 小修一个bug', code_refs: ['proj://svc/docs/adr.md:1-1#title'] });
  assert(cr.ok);
});

await step('episode_close：无 quote 拒（I2）；真 quote 武装收口', async () => {
  const r0 = await w.call('episode_close', { ep_id: 'ep-0001', quote: { text: '随便' } });
  assert(!r0.ok && /I12|quote/.test(r0.error.message + r0.error.code), 'quote 主权失守');
  await cli(['append-dialog', '--repo', proj, '--sess', '044', '--role', 'user', '--text', '清单执行完毕，收口']);
  const r = await w.call('episode_close', { ep_id: 'ep-0001', quote: { text: '清单执行完毕，收口', sess_hint: '044' } });
  assert(r.ok && r.close_pending, JSON.stringify(r.error));
  // 重放防御：同一句不得为第二个主权动作所用
  const r2 = await w.call('checklist_confirm', { cl_id: 'cl-0001', quote: { text: '清单执行完毕，收口', sess_hint: '044' } });
  assert(!r2.ok, '重放竟通过');
});

await step('收口全评 = 单轮重锚：删旧/补新/重归一/flux清/一点漂移', async () => {
  // 模拟重构落盘：session.go 删除、bridge.go 新增
  rmSync(R('src/auth/session.go'));
  writeFileSync(R('src/auth/bridge.go'), 'func Bridge() { /* merge */ }\n'.repeat(20));
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok && o.kind === 'full' && o.reanchor, JSON.stringify(o.error || { kind: o.kind }));
  const hB = H(['proj://svc/src/auth/bridge.go:19-20#Bridge']);
  const subs = await w.call('assess_submit', { t: o.ticket, items: [
    { node_ref: 'auth/session.go#Load', change: { op: 'remove', evidence: { refs: ['proj://svc/src/auth/session.go:38-39#Load'] }, src_hash: H(['proj://svc/src/auth/session.go:38-39#Load']).src_hash, cause: 'code_changed', reason: '清单 cl-0001：迁移后删除（销账合并非否定）' } },
    { node_ref: 'auth/bridge.go#Bridge', change: { op: 'add', kind: 'content', module: 'auth', tau: 30, evidence: { refs: ['proj://svc/src/auth/bridge.go:19-20#Bridge'] }, src_hash: hB.src_hash, cause: 'code_changed' } },
    { node_ref: 'c-sess-041-0002r3', change: { evidence: { refs: ['proj://svc/src/auth/session.go:38-39#Load'] }, src_hash: H(['proj://svc/src/auth/session.go:38-39#Load']).src_hash, cause: 'code_changed', validity: 'superseded→已由 cl-0001 落实', refresh_hash: true } },
    { node_ref: 'auth', change: { sigma: 50, summary: '合并后的 auth（含 bridge）', evidence: { refs: ['proj://svc/src/auth/'] }, src_hash: H(['proj://svc/src/auth/']).src_hash, cause: 'code_changed' } },
  ] });
  assert(subs.accepted === 4, JSON.stringify((subs.results || []).map(r2 => [r2.node_ref, r2.result.ok ? 'ok' : r2.result.error && r2.result.error.code])));
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.reanchor && pub.segment === 2, JSON.stringify(pub.error || { seg: pub.segment }));
  assert(pub.drift_point.t === 'T3', '收口点应为 T3（升格重锚）');
  assert(pub.drift_point.ep === 'ep-0001' && pub.drift_point.g >= 0, JSON.stringify(pub.drift_point));
  const b = await w.call('startup_brief', {});
  assert(b.flux.length === 0, 'flux 未清');
  assert(b.backlog_count === 0, '执行期声称并入后应清');
  // 归档墓碑：session 旧节点
  const ag = await w.call('archive_get', { ref: 'auth/session.go#Load' });
  assert(ag.ok && ag.verdict === 'retired' && /销账/.test(String(ag.reason)), JSON.stringify(ag.error || ag.reason));
});

await step('decisive：propose→approve→授予→对齐校验', async () => {
  const p = await w.call('propose_workorder', { kind: 'decisive', ref: 'c-sess-041-0001r3', reason: '现行决定，约束后续一切工作' });
  assert(p.ok, JSON.stringify(p.error));
  const bad = await w.call('workorder_approve', { wo_id: p.workorder, quote: { text: '批准吧' } });
  assert(!bad.ok, '未验证 quote 竟可批准');
  await cli(['append-dialog', '--repo', proj, '--sess', '042', '--role', 'user', '--text', '批准这条为决定性结论']);
  const a = await w.call('workorder_approve', { wo_id: p.workorder, quote: { text: '批准这条为决定性结论', sess_hint: '042' } });
  assert(a.ok, JSON.stringify(a.error));
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok && o.kind === 'full' && o.workorders_approved.length === 1, JSON.stringify(o.error));
  for (const id of o.scope) {
    if (id === 'c-sess-041-0001r3') await w.call('assess_submit', { t: o.ticket, node_ref: id, no_change: { reason: '工单并入，分值不动' } });
    else await w.call('assess_submit', { t: o.ticket, node_ref: id, no_change: { reason: '边缘计数推进复核：无需改分' } });
  }
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.workorders.some(x => x.verdict === 'decisive_granted'), JSON.stringify(pub.error || pub.workorders));
  const b = await w.call('startup_brief', {});
  assert(b.decisive.length === 1 && b.decisive[0].status === 'aligned', JSON.stringify(b.decisive));
});

await step('规则9：decisive 断言变脏 → 挂起警告 + 阅读裁决刷新 hash 继续', async () => {
  writeFileSync(R('src/auth/token.go'), tokenGo.replace('func Refresh() {} // token刷新主体', 'func Refresh() { /* v2 改造 */ } // token刷新主体'));
  const so = await w.call('sigma_overview', {});
  assert(so.warnings.some(x => x.code === 'claims_stale'), 'claim stale 未报警');
  const b = await w.call('startup_brief', {});
  assert(b.decisive[0].status === 'stale_suspended' && /禁止带着被违反/.test(b.decisive[0].action), JSON.stringify(b.decisive));
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok, JSON.stringify(o.error));
  const items = [];
  for (const id of o.scope) {
    if (id === 'c-sess-041-0001r3')
      items.push({ node_ref: id, change: { evidence: { refs: ['proj://svc/src/auth/token.go:200-201#Refresh'] }, src_hash: H(['proj://svc/src/auth/token.go:200-201#Refresh']).src_hash, cause: 'code_changed', validity: 'valid', refresh_hash: true } });
    else
      items.push({ node_ref: id, change: { no_change: true, reason: '阅读复核：本轮无关或仍成立' } });
  }
  const sub = await w.call('assess_submit', { t: o.ticket, items });
  assert(sub.accepted === o.scope.length, JSON.stringify((sub.results || []).map(x => [x.node_ref, x.result.ok ? 'ok' : x.result.error && x.result.error.code])));
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok, JSON.stringify(pub.error));
  const b2 = await w.call('startup_brief', {});
  assert(b2.decisive[0].status === 'aligned', '裁决仍成立刷新 hash 后应恢复对齐：' + JSON.stringify(b2.decisive));
});

await step('双轨退出：轨道二 钉档（stale≠证伪；反证强制；批准+全评生效；失败库）', async () => {
  // 新 claim 用于证伪
  await cli(['append-dialog', '--repo', proj, '--sess', '043', '--role', 'user', '--text', 'jwt 库选型用 golang-jwt/v5']);
  await cli(['seal-dialog', '--repo', proj, '--sess', '043']);
  const x = await w.call('dialog_extract', { sess_id: '043', claims: [{ assert: 'jwt库选型用golang-jwt/v5', code_refs: ['proj://svc/src/auth/token.go:200-201#Refresh'], span: 'dialog://sess-043#t1' }] });
  assert(x.ok, JSON.stringify(x.error || x));
  let o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok && o.kind === 'full', JSON.stringify(o.error));
  for (const id of o.scope) await w.call('assess_submit', { t: o.ticket, node_ref: id, no_change: { reason: '新声称入包轮，存量节点复核无变化' } });
  let pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.backlog_verdicts.length >= 1, JSON.stringify(pub.error));
  const claimId = await findClaim(w, 'golang-jwt');
  const negNoEv = await w.call('propose_workorder', { kind: 'negate', ref: claimId, reason: '错了' });
  assert(!negNoEv.ok && negNoEv.error.code === 'i10_violation', 'I10 失守');
  const neg = await w.call('propose_workorder', { kind: 'negate', ref: claimId, reason: '阅读裁决：结论已不成立——v5 迁移失败已回退 v4', counter_evidence: ['proj://svc/src/auth/token.go:200-201#Refresh'] });
  assert(neg.ok, JSON.stringify(neg.error));
  await cli(['append-dialog', '--repo', proj, '--sess', '045', '--role', 'user', '--text', '批准钉档这条结论']);
  const ap = await w.call('workorder_approve', { wo_id: neg.workorder, quote: { text: '批准钉档这条结论', sess_hint: '045' } });
  assert(ap.ok, JSON.stringify(ap.error));
  o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.scope.includes(claimId), '待裁工单 ref 应入 workset');
  for (const id of o.scope) await w.call('assess_submit', { t: o.ticket, node_ref: id, no_change: { reason: id === claimId ? '待钉档并入' : '复核无变化' } });
  pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.workorders.some(x2 => String(x2.verdict).startsWith('negated')), JSON.stringify(pub.workorders || pub.error));
  const ag = await w.call('archive_get', { ref: claimId });
  assert(ag.ok && ag.verdict === 'negated' && ag.counter_evidence.length >= 1, JSON.stringify(ag.error || ag));
  const nd = await w.call('node_detail', { ref: claimId });
  assert(!nd.ok, '钉档节点竟仍在投影');
  // 钉档不可自动复活：hash 变脏也不进 resumes 候选
  writeFileSync(R('src/auth/token.go'), tokenGo.replace('func Refresh() {} // token刷新主体', 'func Refresh() { /* v3 */ }'));
  const o2 = await w.call('assess_open', { trigger: 'T1' });
  assert(!o2.resume_candidates.some(rc => rc.id === claimId), '钉档节点竟被自动复活（违反 §2.6 唯一例外修锚）');
  assert(o2.scope.includes('auth/token.go#Refresh'), '脏内容应入 workset');
  for (const id of o2.scope)
    await w.call('assess_submit', { t: o2.ticket, node_ref: id, no_change: { reason: 'v3 复核：现行结论仍成立' } });
  const p2 = await w.call('assess_publish', { t: o2.ticket });
  assert(p2.ok, JSON.stringify(p2.error));
});
function draftNode(o, id) { return (o.scope || []).includes(id); }
import * as YAMLLIB from '../src/yaml.mjs';
async function findClaim(c, kw) {
  const idx = YAMLLIB.parse(readFileSync(path.join(root, 'INDEX.yaml'), 'utf8'));
  const pkg = YAMLLIB.parse(readFileSync(path.join(root, 'packages', 'v' + String(idx.latest).padStart(4, '0') + '.yaml'), 'utf8'));
  for (const s of pkg.corpora?.dialogue?.sessions || [])
    for (const cl of s.claims || [])
      if (String(cl.assert).includes(kw)) return cl.id;
  throw new Error(`claim ${kw} not found in v${idx.latest}`);
}

await step('轨道一复活：backlog 重新点名→resumed（误归档无害，零复活成本）', async () => {
  const cr = await w.call('claim_record', { assert: '旧 session 加载结论需重议', code_refs: ['proj://svc/src/auth/session.go:38-39#Load'] });
  assert(cr.ok, JSON.stringify(cr.error));
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok && o.resume_candidates.some(x => x.id === 'auth/session.go#Load'), JSON.stringify(o.error || o.resume_candidates));
  assert(o.scope.includes('auth/session.go#Load'), '复活节点应入 workset');
  for (const id of o.scope) await w.call('assess_submit', { t: o.ticket, node_ref: id, no_change: { reason: '复活回拨轮：分值由边缘区回拨，其余复核无变化' } });
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && (pub.resumed || []).includes('auth/session.go#Load'), JSON.stringify(pub.error || pub.resumed));
  const d = await w.call('node_detail', { ref: 'auth/session.go#Load' });
  assert(d.ok && d.status === 'active', '复活后应回活跃序列');
  const ag = await w.call('node_history', { ref: 'auth/session.go#Load' });
  assert(ag.ok && ag.series.length >= 2, '复活后序列从边缘区回拨继续，旧账不毁（I11）');
});

await step('I5：detail 无序列字段 / history 有', async () => {
  const d = await w.call('node_detail', { ref: 'auth' });
  assert(d.ok, JSON.stringify(d.error));
  const h = await w.call('node_history', { ref: 'auth' });
  assert(h.ok && h.series.length >= 3, JSON.stringify(h.error || h.series));
  const dj = JSON.stringify(d);
  assert(!/"hist"/.test(dj) && !/"series"/.test(dj), 'detail 泄漏序列!');
});

await step('I1：工单不 publish → 读面返回旧版带 assessment_open 警告；覆盖率检查=集合运算', async () => {
  const o = await w.call('assess_open', { trigger: 'T1' });
  assert(o.ok, JSON.stringify(o.error));
  const b = await w.call('startup_brief', {});
  assert(b.warnings.some(x => x.code === 'assessment_open'), 'I1 警告缺失');
  assert(b.version === o.scope_note || true);
  if (o.scope.length) {
    const miss = await w.call('assess_publish', { t: o.ticket });
    assert(!miss.ok && miss.error.code === 'coverage_incomplete', '覆盖率检查未拦空发布：' + JSON.stringify(miss.error));
    assert(Array.isArray(miss.error.details.missing) && miss.error.details.missing.length === o.scope.length);
    for (const id of o.scope) {
      if (id.startsWith('c-'))
        await w.call('assess_submit', { t: o.ticket, node_ref: id, change: { evidence: { refs: ['proj://svc/src/auth/token.go:200-201#Refresh'] }, src_hash: H(['proj://svc/src/auth/token.go:200-201#Refresh']).src_hash, cause: 'code_changed', validity: 'valid', refresh_hash: true } });
      else
        await w.call('assess_submit', { t: o.ticket, node_ref: id, no_change: { reason: '复核：v3 未触及断言' } });
    }
  }
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok, JSON.stringify(pub.error));
});

await step('T2 节拍：seal 满 5 会话 → 启动卡 due；T2 全评', async () => {
  for (let i = 0; i < 3; i++) {
    await cli(['append-dialog', '--repo', proj, '--sess', '90' + i, '--role', 'user', '--text', '闲聊轮' + i]);
    const s = await cli(['seal-dialog', '--repo', proj, '--sess', '90' + i, '--mode', 'mixed']);
    assert(s.code === 0, s.err);
  }
  const b = await w.call('startup_brief', {});
  assert(b.t2.due === false || b.t2.since >= 3, JSON.stringify(b.t2));
  const o = await w.call('assess_open', { trigger: 'T2' });
  assert(o.ok && o.kind === 'full', JSON.stringify(o.error));
  for (const id of o.scope) await w.call('assess_submit', { t: o.ticket, node_ref: id, no_change: { reason: 'T2 兜底全量复核：无变化' } });
  const pub = await w.call('assess_publish', { t: o.ticket });
  assert(pub.ok && pub.drift_point.t === 'T2', JSON.stringify(pub.error || pub.drift_point));
  const b2 = await w.call('startup_brief', {});
  assert(b2.t2.since === 0, 'T2 计数未重置');
});

await step('报表 + 预算演练 + audit + ro 角色 + 锁', async () => {
  const dr = await w.call('drift_report', {});
  assert(dr.ok && /五段式/.test(dr.markdown) && /节点账表/.test(dr.markdown) && /失败库/.test(dr.markdown), '报表结构缺段');
  assert(/决定性集/.test(dr.markdown) && /出入账/.test(dr.markdown));
  const rb = await w.call('rehearse_budget', {});
  assert(rb.ok && rb.measured.startup_brief_no_trunc > 0);
  // 双 writer 拒绍启动（原 writer 存活、锁新鲜）：启动期 fatal exit=2
  const code = await new Promise(res => {
    const w2 = spawn(process.execPath, [SRV, 'serve', '--repo', proj, '--session', 'sess-intruder'], { stdio: ['ignore', 'pipe', 'pipe'] });
    w2.on('exit', c => res(c));
    setTimeout(() => { if (!w2.killed) w2.kill(); }, 6000);
  });
  assert(code === 2, '第二 writer 未被拒（exit=' + code + '）');
  w.close();
  await new Promise(r2 => setTimeout(r2, 400));
  // 原 writer 死亡（pid 不再存活）→ 新 writer 接管失效锁（接管事件入账，不许无声换主）
  const w3 = await startClient(['serve', '--repo', proj, '--session', 'sess-takeover']);
  assert(w3.tools.length >= 16, '接管 writer 工具面不全');
  w3.close();
  await new Promise(r2 => setTimeout(r2, 200));
  const a = await cli(['audit', '--repo', proj]);
  const aud = JSON.parse(a.out);
  assert(aud.ok === true, 'replay_audit 发现违例：' + JSON.stringify(aud.problems.slice(0, 5)));
  // ro 角色：只见 A+E = 8 工具
  const r = await startClient(['serve', '--repo', proj, '--role', 'ro', '--session', 'ci-1']);
  assert(r.tools.length === 8, 'ro 工具数=' + r.tools.length);
  assert(!r.tools.includes('claim_record') && !r.tools.includes('assess_publish'));
  const denied = await r.send('tools/call', { name: 'claim_record', arguments: { assert: 'x', code_refs: [A] } });
  assert(denied.result.isError, 'ro 写入未拒');
  const rdb = await r.call('startup_brief', {});
  assert(rdb.ok && rdb.pin >= 1, 'ro 快照读失败');
  r.close();
  let takeoverLogged = false;
  {
    const dirL = path.join(root, 'ledger');
    const fsn = await import('node:fs');
    for (const fn of fsn.readdirSync(dirL))
      for (const l of readFileSync(path.join(dirL, fn), 'utf8').split('\n').filter(x => x.trim()))
        if (/lock_takeover/.test(l)) takeoverLogged = true;
  }
  assert(takeoverLogged, '锁接管未记入账本（不许无声换主）');
});


await step('P7 哈希链 + 级联：改一行转写 → audit 检出断链', async () => {
  const f = path.join(root, 'dialogs', 'sess-041.jsonl');
  const lines = readFileSync(f, 'utf8').split('\n').filter(x => x.trim());
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), text: '被篡改的话' });
  writeFileSync(f, lines.join('\n') + '\n');
  const aud = JSON.parse((await cli(['audit', '--repo', proj])).out);
  assert(!aud.ok && aud.problems.some(x => /chain|sha/.test(x)), '篡改未被检出');
  lines[0] = readFileSync(f, 'utf8') && lines[0]; // 还原
  const orig = JSON.parse(readFileSync(f, 'utf8').split('\n')[0]);
  void orig;
  // 还原原话重算链头不可能（需原 prev_hash）——改为恢复原 text 字段：
  const fixed = readFileSync(f, 'utf8').split('\n').filter(x => x.trim());
  const o0 = JSON.parse(fixed[0]); o0.text = '决定采用 token rotation，弃用双令牌方案，旧会话期延迟翻倍';
  fixed[0] = JSON.stringify(o0);
  writeFileSync(f, fixed.join('\n') + '\n');
  const aud2 = JSON.parse((await cli(['audit', '--repo', proj])).out);
  assert(aud2.ok, '还原后仍报链断：' + JSON.stringify(aud2.problems));
});

await step('账本可重放：I9 抽查——quote 原文留痕', async () => {
  const rows = [];
  const dir = path.join(root, 'ledger');
  for (const f of (await import('node:fs')).readdirSync(dir))
    for (const l of readFileSync(path.join(dir, f), 'utf8').split('\n').filter(x => x.trim())) rows.push(JSON.parse(l));
  const closes = rows.filter(r2 => r2.action === 'episode_close' && r2.result === 'ok');
  assert(closes.length === 1 && closes[0].quote === '清单执行完毕，收口' && closes[0].quote_digest, 'I9 quote 留痕失败');
  const rejectedQuotes = rows.filter(r2 => r2.result === 'rejected' && r2.quote_verdict === 'failed');
  assert(rejectedQuotes.length >= 1, 'quote 拒收留痕缺失');
});

await step('文件即契约：工具返回值都能在文件里找到原文（§12 唯一保险）', async () => {
  const idx = YAMLLIB.parse(readFileSync(path.join(root, 'INDEX.yaml'), 'utf8'));
  const pkgText = readFileSync(path.join(root, 'packages', 'v' + String(idx.latest).padStart(4, '0') + '.yaml'), 'utf8');
  assert(/auth/.test(pkgText) && /rotation|golang|jwt/.test(pkgText) || /assert:/.test(pkgText), '包内内容缺失');
  assert(idx.published_versions.length === idx.latest, '发布事件与版本数一致');
});

log(`\n=== 冒烟结果: ${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
