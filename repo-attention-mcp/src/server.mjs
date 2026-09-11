#!/usr/bin/env node
// server.mjs — MCP stdio 适配层（工具面 = 6：brief / expand / lookup / timeline / note / anchor）
// 确定性作业（init / audit / migrate / scan / sweep / progress）全部在 cli.mjs —— **不进 MCP 工具面**。
import { createInterface } from 'node:readline';
import { Repo } from './repo.mjs';
import { Core } from './core.mjs';
import { TOOL_DEFS, dispatch } from './tools.mjs';
import { runCli } from './cli.mjs';

const PROTOCOL_FALLBACK = '2025-03-26';

function getArg(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
}

// ---------------- MCP stdio ----------------
async function serve(argv) {
  const repoPath = getArg(argv, 'repo');
  if (!repoPath) fatal('需要 --repo <项目根路径>（参数只有 repo 根路径，§9）');
  const repo = new Repo(repoPath);
  repo.ensureLayout();
  const core = new Core(repo);

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
          serverInfo: { name: 'repo-attention-mcp', version: '2.0.0' },
          instructions: '注意力引导 + 归账。开局先 brief()（根层榜 + 树规模）；逐层 expand(node) 下钻（超一页用 cursor 翻页）；问「某功能在哪」用 lookup(question)；读到与账不一致就 note(kind="score")，人做了决定就 note(kind="decision")，改了文件就 note(kind="edit")，迈过里程碑就 anchor(label)。标 dirty 的节点读原文、不信旧分；标 unscored 的是 scan 建出的骨架、还没评。节点构成一棵树（parent 链），单次响应有界、分辨率无上限。全部工具返回统一信封 {version, latest_ts, warnings, budget_used}，违例走 warnings/error 数据不走异常。',
        }));
      }
      if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
      if (method === 'ping') return send(res(id, {}));
      if (method === 'tools/list') {
        return send(res(id, { tools: TOOL_DEFS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }));
      }
      if (method === 'tools/call') {
        const name = params?.name, args = params?.arguments || {};
        if (!TOOL_DEFS.some(t => t.name === name))
          return send(res(id, { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code: 'unknown_tool', message: `未注册工具 ${name}（工具面共 6 个：brief/expand/lookup/timeline/note/anchor）` }, warnings: [] }, null, 2) }], isError: true }));
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

const argv = process.argv.slice(2);
const first = argv[0];
// §9 部署形态：MCP stdio 启动时参数可以只有 repo 根路径（--repo <根>），无需显式 serve。
if (first === 'serve') await serve(argv.slice(1));
else if (argv.includes('--stdio') || (first && first.startsWith('--')) || !first) await serve(argv);
else await runCli(argv);
