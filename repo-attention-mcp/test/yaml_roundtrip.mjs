// test/yaml_roundtrip.mjs — YAML 子集往返测试
import { dump, parse } from '../src/yaml.mjs';
import assert from 'node:assert';

const obj = {
  schema: 'index/v1',
  latest: 7,
  segment: 2,
  anchor: 5,
  counters: { dialogs_total: 35, dialogs_since_eval: 3, seq: 1234 },
  writer_lock: { pid: 4321, session_id: 'sess-042', ts: '2026-09-10T02:00:00Z' },
  params_overrides: { A: 12, theta_edge: 0.01, budget: { overview_tokens: 600, expand_tokens: 6000 } },
  episode: null,
  flux: [],
  modules: [
    { id: 'auth', ref: 'proj://svc/src/auth/', sigma: 0.31, summary: '令牌与登录：≤100 token 模块核心总结——含中文、冒号: 和 #井号',
      evidence: { refs: ['proj://svc/src/auth/token.go:88-140#Refresh@8c1d', 'proj://svc/src/auth/login.go#Login'], src_hash: 'sha256:9f2c' },
      contents: [
        { id: 'auth/token.go#Refresh', tau: 0.42, evidence: { refs: ['proj://svc/src/auth/token.go:88-140#Refresh'], src_hash: 'sha256:1a7d' } },
        { id: 'auth/login.go#Login', tau: 0.58, evidence: { refs: ['proj://svc/src/auth/login.go:10-77#Login'], src_hash: 'sha256:bb' } },
      ] },
    { id: 'docs', sigma: 0.2, summary: '多行：\n第二行含缩进\n', contents: [] },
  ],
  archived: {
    'auth/legacy.go#Old': { verdict: 'negated', at_round: 14, reason: '阅读裁决：结论已不成立', hist: [{ r: 10, v: 0.11 }, { r: 12, v: 0.02 }], was_decisive: true },
  },
  map_by_key: { 'auth': 'L3', 'docs': 'L2' },
  flags: { reanchor: true, exempt: false },
  nums: { d: 0.04, g: 8, big: 1234567 },
  claim_assert: 'token刷新采用rotation，弃用双令牌——旧会话期延迟翻倍',
  nested: { deep: { deeper: [{ x: 1 }, { x: 2 }] } },
};

const text = dump(obj);
const back = parse(text);
assert.deepStrictEqual(back, obj, 'roundtrip mismatch:\n' + text + '\nGOT:\n' + JSON.stringify(back, null, 1));

// 人工风格宽容度：同层序列、注释、流式数组
const human = `
# 注释行
a: 1
list:
- x
- y
b: [1, 2]
c: {k: v}
flow: ["s1", "s2"]
`;
const h = parse(human);
assert.deepStrictEqual(h.list, ['x', 'y']);
assert.strictEqual(h.a, 1);
assert.deepStrictEqual(h.b, [1, 2]);
assert.deepStrictEqual(h.flow, ['s1', 's2']);

// 块字面量
const bl = dump({ note: 'line1\nline2' });
assert.strictEqual(parse(bl).note, 'line1\nline2');

console.log('yaml roundtrip OK\n----- 样例 dump -----\n' + text.split('\n').slice(0, 24).join('\n') + '\n...');
