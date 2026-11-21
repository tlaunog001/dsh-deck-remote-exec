// issue #3 / #4 回归：
//   #3 locatTargets 的第 2 候选在 win32 上曾用 URL.pathname（得到 \C:\… 的死路径），
//      这里验证 fileURLToPath 的解码语义，以及源码里确实不再用 URL.pathname 拼路径。
//   #4 patch* 返回原串有两种含义（已打过 / 锚点失配），apply 必须能区分并出声，
//      否则热升级后改道静默失效。这里验证「签名在 → 返回原串」「签名不在且锚点不在 → 返回原串」
//      两种情形，以及源码里确实按签名区分。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { patchSource, patchPlatform, patchPredicate } from '../lib/index.js'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('#3 源码不再用 URL.pathname 拼目标路径', () => {
  assert.ok(src.includes('fileURLToPath(import.meta.url)'), '应使用 fileURLToPath')
  assert.ok(!/new URL\(import\.meta\.url\)\.pathname/.test(src), '不应再用 URL.pathname')
})

test('#3 fileURLToPath 在 POSIX 上给出真实路径（与 pathname 一致）', () => {
  const u = new URL('file:///Users/a/b/index.js')
  assert.equal(fileURLToPath(u), '/Users/a/b/index.js')
  assert.equal(u.pathname, '/Users/a/b/index.js')
})

test('#3 win32 形态：pathname 带前导斜杠、fileURLToPath 不带（平台无关地验证差异）', () => {
  // Node 在 POSIX 上 fileURLToPath 会拒绝 file:///C: 形态，这里只验证 pathname 的形状，
  // 说明「带前导斜杠」确实存在，正是 #3 的成因。
  const u = new URL('file:///C:/Users/DELL/x/index.js')
  assert.equal(u.pathname, '/C:/Users/DELL/x/index.js')
  assert.ok(u.pathname.startsWith('/C:'), 'pathname 带前导斜杠 → path.join 后成 \\C:\\… 死路径')
})

test('#4 已打过签名时，patch* 返回原串（表示 already，不是失败）', () => {
  const already = 'const x = "__rdeFsFacade"; const y = "__rdeExecFor"; const z = "__rdeResolve";'
  assert.equal(patchSource(already), already)
  const plat = 'const a = "__rdeResolve";'
  assert.equal(patchPlatform(plat), plat)
  const pred = 'const b = "__rdePcCwd";'
  assert.equal(patchPredicate(pred), pred)
})

test('#4 签名不在、锚点也不在时，patch* 返回原串（表示 skipped，需出声）', () => {
  const noAnchor = '// totally unrelated file with no anchors\nconst z = 1;\n'
  assert.equal(patchSource(noAnchor), noAnchor)
  assert.equal(patchPlatform(noAnchor), noAnchor)
  assert.equal(patchPredicate(noAnchor), noAnchor)
})

test('#4 apply 用签名区分 already 与 skipped，并打出汇总行', () => {
  assert.ok(src.includes('signList.every((x) => src.includes(x))'), '应按签名判断 already')
  assert.ok(src.includes('outcome: "skipped"'), '锚点失配应标记 skipped')
  assert.ok(src.includes('本次对 deck 的三处改道结果'), '应打一行固定汇总')
  assert.ok(src.includes('ensurePatched'), '应有自愈入口')
  assert.ok(src.includes('setInterval'), '应有定时自检')
})
