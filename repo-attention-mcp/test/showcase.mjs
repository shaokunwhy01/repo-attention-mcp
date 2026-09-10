// test/showcase.mjs — 打印一份「会话醒来即持有旧窗口」的启动卡实例（复用 smoke 的仓）
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __ = path.dirname(fileURLToPath(import.meta.url));
const SRV = path.join(__, '..', 'src', 'server.mjs');

// 用上次 smoke 留下的 tmp 仓（找最新 ra-smoke-*）
import { readdirSync, statSync } from 'node:fs';
import os from 'node:os';
const cands = readdirSync(os.tmpdir()).filter(d => /^ra-smoke-/.test(d))
  .map(d => ({ d, t: statSync(path.join(os.tmpdir(), d)).mtimeMs })).sort((a, b) => b.t - a.t);
if (!cands.length) { console.log('no smoke repo found'); process.exit(0); }
const proj = path.join(os.tmpdir(), cands[0].d, 'proj');

const p = spawn(process.execPath, [SRV, 'serve', '--repo', proj, '--role', 'ro', '--session', 'sess-showcase'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pend = new Map(); let id = 0;
p.stdout.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id != null && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
const send = (method, params) => new Promise(r => { const j = ++id; pend.set(j, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: j, method, params }) + '\n'); });
await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'showcase' } });
const res = await send('tools/call', { name: 'startup_brief', arguments: { mode: 'modify' } });
console.log(res.result.content[0].text);
p.kill();
