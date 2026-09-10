#!/usr/bin/env node
// server.mjs — MCP stdio 服务 + 宿主 CLI（§9 部署形态：每项目一 server，stdio 启动，参数只有 repo 根路径）
// 进程生命周期 ≈ 会话生命周期 → 会话钉版由进程天然实现（首次读自动 pin latest，全程不换）。
// CLI 子命令（非 MCP 工具，保住 §10 工具面纯度）：
//   init | serve | append-dialog | seal-dialog | audit | verify-quote | heartbeat
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { Repo } from './repo.mjs';
import { Core } from './core.mjs';
import { toolsForRole, dispatch } from './tools.mjs';
import * as DG from './dialogs.mjs';

const PROTOCOL_FALLBACK = '2025-03-26';

function getArg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

// ---------------- MCP stdio ----------------
async function serve(argv) {
  const repoPath = getArg(argv, 'repo');
  const role = getArg(argv, 'role', 'writer');
  const sessionId = getArg(argv, 'session', `sess-${Date.now()}`);
  if (!repoPath) { fatal('需要 --repo <项目根路径>（参数只有 repo 根路径，§9）'); }
  const repo = new Repo(repoPath, { role, sessionId });
  repo.ensureLayout();
  if (role === 'writer') {
    const lock = repo.acquireOrRenewLock();
    if (!lock.ok) fatal(`拒绝启动：${lock.reason}（R1 裁决③：第二个 writer 见未失效锁 → 拒绝启动）`);
    // 心跳：writer.lock 持有时每 60s 刷新 INDEX 内嵌心跳戳
    const hb = setInterval(() => { try { repo.heartbeat(); } catch { /* ignore */ } }, 60_000);
    hb.unref?.();
    process.on('exit', () => { try { repo.releaseLock(); } catch { /* ignore */ } });
  }
  const core = new Core(repo);
  const defs = toolsForRole(role);
  repo.ledgerAppend({ tool: 'system:session_start', action: 'session', target: sessionId, msg: `role=${role} tools=${defs.length}`, result: 'ok' });

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let msg; try { msg = JSON.parse(line); } catch { return send(err(null, -32700, 'parse error')); }
    const { id, method, params } = msg;
    const isNotif = id === undefined || id === null;
    try {
      if (method === 'initialize') {
        return send(res(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_FALLBACK,
          capabilities: { tools: {} },
          serverInfo: { name: 'repo-attention-mcp', version: '1.0.0' },
          instructions: `双包协议（组合包/漂移包）注意力服务，role=${role}。会话开始先 startup_brief（自动钉版+规则2/9一步完成）；修改+评估=原子事务：episode_close(需quote)→assess_open(T1)→逐节点 assess_submit→assess_publish。所有工具返回统一信封 {pin, ledger_seq, warnings, budget_used}，违例走 warnings 数据不走异常。flux 模块直读不信旧分。`,
        }));
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
      if (method === 'ping') return send(res(id, {}));
      if (method === 'tools/list') {
        return send(res(id, { tools: defs.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }));
      }
      if (method === 'tools/call') {
        const name = params?.name, args = params?.arguments || {};
        const def = defs.find(t => t.name === name);
        if (!def) {
          // 权限边界做在工具名单上：ro 的模型根本看不到 B/C/D 组（R1 裁决③）
          repo.ledgerAppend({ tool: name || '?', action: 'call_denied', target: 'ro_boundary', result: 'rejected', msg: `role=${role} 无此工具` });
          return send(res(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'role_denied', message: `role=${role} 未注册工具 ${name}（只读角色仅 A/E 组，无法"试着写一下看看"）` }, warnings: [] }, null, 2) }], isError: true }));
        }
        const result = await dispatch(core, name, args);
        return send(res(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: result.ok === false }));
      }
      if (!isNotif) return send(err(id, -32601, `method not found: ${method}`));
    } catch (e) {
      if (!isNotif) send(err(id, -32603, String(e?.message || e)));
    }
  });
  rl.on('close', () => process.exit(0));
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
const res = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
function fatal(m) { process.stderr.write(`[repo-attention-mcp] ${m}\n`); process.exit(2); }

// ---------------- CLI 子命令 ----------------
function cli(argv) {
  const cmd = argv[0];
  const repoPath = getArg(argv, 'repo', process.cwd());
  const repo = new Repo(repoPath, { role: 'writer', sessionId: getArg(argv, 'session', 'cli') });
  switch (cmd) {
    case 'init': {
      repo.ensureLayout();
      writeFileSync(path.join(repo.projectRoot, '.repo-attention', 'README.txt'),
        '本目录 = 项目全部记忆。zip 此目录 = 搬走记忆（§11.1）。整树 .gitignore。\n空文件即空包；B₀ 打分是第一个写进 packages/v0001.yaml 的东西。\n', 'utf8');
      ensureGitignore(repo.projectRoot);
      repo.ledgerAppend({ tool: 'system:init', action: 'init', target: repo.root, result: 'ok' });
      console.log(`initialized ${path.join(repoPath, '.repo-attention')}`);
      return;
    }
    case 'append-dialog': {
      const sess = getArg(argv, 'sess'); const role = getArg(argv, 'role', 'user');
      let text = getArg(argv, 'text');
      if (!sess) fatal('append-dialog 需要 --sess');
      if (text == null) { // 也支持 --json '{"ts":...,"role":...,"text":...}'
        const j = getArg(argv, 'json');
        if (j) { const o = JSON.parse(j); text = o.text; }
      }
      if (text == null) fatal('需要 --text 或 --json');
      const r = DG.appendDialog(repo.root, String(sess).replace(/^sess-/, ''), { role, text });
      console.log(JSON.stringify({ appended: `sess-${sess}`, line: r.num, hash: r.hash.slice(0, 16) }));
      return;
    }
    case 'seal-dialog': {
      const sess = String(getArg(argv, 'sess') || '').replace(/^sess-/, '');
      const mode = getArg(argv, 'mode', 'mixed');
      const r = DG.sealDialog(repo.root, sess, { mode });
      const c = repo.registerDialogClosed(); // T2 节拍：会话关闭 = 一次对话计数
      console.log(JSON.stringify({ sealed: `sess-${sess}`, file_sha256: r.file_sha256.slice(0, 22), counters: c }));
      return;
    }
    case 'audit': {
      repo.ensureLayout();
      const a = new Core(repo).audit();
      console.log(JSON.stringify(a, null, 2));
      process.exitCode = a.ok ? 0 : 1;
      return;
    }
    case 'verify-quote': {
      const v = DG.verifyQuote(repo.root, { text: getArg(argv, 'text', ''), sess_hint: getArg(argv, 'sess') });
      console.log(JSON.stringify(v, null, 2));
      return;
    }
    default:
      console.log(`用法:
  node src/server.mjs init --repo <项目根>
  node src/server.mjs serve --repo <项目根> [--role writer|ro] [--session id]   # MCP stdio
  node src/server.mjs append-dialog --repo <根> --sess <id> --role user|assistant --text "<原话>"
  node src/server.mjs seal-dialog --repo <根> --sess <id> [--mode discuss|modify|mixed]
  node src/server.mjs audit --repo <根>          # P6 replay_audit（防评估剧场）
  node src/server.mjs verify-quote --repo <根> --text "..." [--sess id]`);
  }
}

function ensureGitignore(root) {
  const f = path.join(root, '.gitignore');
  try {
    const cur = require_read(f);
    if (!cur.includes('.repo-attention')) writeFileSync(f, (cur ? cur.replace(/\n?$/, '\n') : '') + '.repo-attention/\n', 'utf8');
  } catch { writeFileSync(f, '.repo-attention/\n', 'utf8'); }
}
function require_read(f) { try { return require('node:fs').readFileSync(f, 'utf8'); } catch { return ''; } }
const require = (await import('node:module')).createRequire(import.meta.url);

const argv = process.argv.slice(2);
if (argv[0] === 'serve' || argv.includes('--stdio') || (!argv[0] && !process.env.RA_CLI)) await serve(argv[0] === 'serve' ? argv.slice(1) : argv);
else if (argv[0]) cli(argv);
else fatal('无 stdin 交互且无子命令：node src/server.mjs serve --repo <根>');
