// 01/06/07 的 5 Whys 结论落地后的回归：写方法成功、返回 undefined 时**不得**被判失败。
//
// 之前 fs 代理的成功判据是 `r !== null && r !== undefined`，于是 undefined 落进
// 失败分支、抛 RDE_REMOTE_WRITE_FAILED —— 文件其实已经写进远端，纯属误报。
// 现在：写方法的 undefined 视为成功（void 是合法返回），只有 null 才算「没写成」。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { patchSource } from '../lib/index.js'

const DECK = '/Users/admin/.dsh/profiles/desktop/node_modules/dsh-mattpocock-skills-deck/lib/index.js'
const MIRROR = '/Users/admin/.dsh/remote-workspaces/192.168.10.201-jx-22/qqq'

/** 取出 patchSource 注入的 fs 代理块，在沙箱里装配成一个可调用的 facade。 */
function buildFacade(remoteWriteResult) {
  const out = patchSource(readFileSync(DECK, 'utf8'))
  const start = out.indexOf('const __rdeLocalFs = ctx.get("fs");')
  assert.ok(start > 0, '没取到注入块起点')
  // 从 locals 声明到 `const __rdeFsFacadeN = new Proxy({...});` 这条语句结束，按括号配平切片，
  // 不依赖注释文本（注释一改测试就碎，那是脆断言）。
  const declAt = out.indexOf(' = new Proxy({}, {', start)
  const blockStart = out.lastIndexOf('const ', declAt)
  let depth = 0, started = false, end = -1
  for (let p = declAt; p < out.length; p += 1) {
    const c = out[p]
    if (c === '{' || c === '(' || c === '[') { depth += 1; started = true }
    else if (c === '}' || c === ')' || c === ']') {
      depth -= 1
      if (started && depth === 0 && c === '}') { end = out.indexOf(';', p); if (end > 0) { end += 1; break } }
    }
  }
  assert.ok(end > blockStart, 'Proxy 语句没有闭合')
  const block = out.slice(start, end)
  const writes = []
  const remoteFs = {
    writeText: async () => { writes.push(1); return remoteWriteResult() },
    isRemotePath: (p) => String(p).includes('remote-workspaces'),
  }
  const ctx = { get: (k) => ({ 'fs': { writeText: async () => 'LOCAL' }, 'remoteFs': { fs: remoteFs, isRemotePath: remoteFs.isRemotePath }, 'logCtx': { fire() {}, isEnabled: () => true } })[k] }
  const name = (block.match(/const (__rdeFsFacade\w*) = new Proxy/) || [])[1]
  assert.ok(name, '注入块里应定义 fs 代理')
  return { facade: new Function('ctx', block + '\n return ' + name + ';')(ctx), writes }
}

test('写方法成功但返回 undefined → 视为成功，不抛 RDE_REMOTE_WRITE_FAILED', async () => {
  const { facade, writes } = buildFacade(() => undefined)
  const r = await facade.writeText(MIRROR + '/.scratch/x.md', 'hello')
  assert.equal(writes.length, 1, '远端写入应被调用一次')
  assert.equal(r, undefined, '成功时原样返回远端结果')
})

test('写方法返回 null（明确没写成）→ 仍然抛错，绝不静默回落本地', async () => {
  const { facade } = buildFacade(() => null)
  await assert.rejects(
    () => facade.writeText(MIRROR + '/.scratch/x.md', 'hello'),
    (e) => e && e.code === 'RDE_REMOTE_WRITE_FAILED',
  )
})

test('写方法抛异常 → 仍然抛 RDE_REMOTE_WRITE_FAILED（失败不能被吞）', async () => {
  const { facade } = buildFacade(() => { throw new Error('disk full') })
  await assert.rejects(
    () => facade.writeText(MIRROR + '/.scratch/x.md', 'hello'),
    (e) => e && e.code === 'RDE_REMOTE_WRITE_FAILED',
  )
})
