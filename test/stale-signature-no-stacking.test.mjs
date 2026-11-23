// 实测踩到的坑回归：签名升版后，旧版本注入的块会让新补丁**再叠一份**，
// 于是产物里并存两个 fs 代理，旧块（带旧判据）在后，行为不生效也不报错。
// deck 产物因此从 1792 行涨到 2120 行。
//
// 现在 patchSource 遇到任何旧版本签名直接不注入（返回原串），由 patchOne 走 .bak 恢复路径。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchSource } from '../lib/index.js'

// 一份“已被旧版本改道过”的最小产物：含旧签名、不含新签名。
const STALE = [
  'class Deck {',
  '  apply(ctx) {',
  '    const __rdeFsFacade = new Proxy({}, { get() { return 1 } });',
  '    const __rdeExecFor = () => null;',
  '    const __rdeResolve = () => null;',
  '  }',
  '}',
].join('\n')

test('产物含旧版本签名时不再叠加第二份补丁', () => {
  const out = patchSource(STALE)
  assert.equal(out, STALE, '含旧签名应原样返回（交给 patchOne 走 .bak 恢复），不得再插一遍')
  const proxies = (out.match(/new Proxy\(\{\}, \{/g) || []).length
  assert.equal(proxies, 1, '不得出现两个 fs 代理并存')
})

test('干净产物仍然正常注入 v2 签名与新判据', () => {
  const clean = 'class Deck {\n  apply(ctx) {\n    void 0;\n  }\n}'
  const out = patchSource(clean)
  assert.notEqual(out, clean, '干净产物应被注入')
  assert.ok(out.includes('__rdeFsFacade2'), '应写 v2 签名')
  assert.ok(out.includes('r !== void 0 || isWrite'), '应带新判据（写方法的 undefined 视为成功）')
  assert.equal((out.match(/new Proxy\(\{\}, \{/g) || []).length, 1, '只应有一个 fs 代理')
})
