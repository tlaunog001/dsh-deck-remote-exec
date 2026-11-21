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

// #3（下游在真机复核时指出）：这条断言原来无条件按 POSIX 语义写，在 Windows 上不是"返回不等"，
//   而是 fileURLToPath(new URL('file:///Users/a/b/index.js')) 直接抛 ERR_INVALID_FILE_URL_PATH
//   （"File URL path must be absolute"）。于是本文件在 Windows 上必红一条——而 Windows 恰是本插件
//   最需要被验证的平台。这里按平台分支：POSIX 验 POSIX 语义，win32 验 win32 语义，两边都真跑、都不空转。
// #3（下游真机复核时指出）：原来的断言无条件按 POSIX 语义写，在 Windows 上不是"返回不等"而是
//   直接抛 ERR_INVALID_FILE_URL_PATH（"File URL path must be absolute"），于是本文件在 Windows 上必红
//   一条——而 Windows 恰是本插件最需要被验证的平台。
//   实测两个方向的语义（macOS/Node 26 与下游 win32/Node 22 一致的地方）：
//     · file:///C:/…   在 POSIX 上**不抛**，返回 '/C:/…'；在 win32 上解出盘符路径且无前导斜杠；
//     · file:///Users/… 在 POSIX 上原样返回；在 win32 上**抛** ERR_INVALID_FILE_URL_PATH。
//   所以这里不跨平台断言"相等"，只断言各平台下的真实不变量。
test('#3 fileURLToPath: 盘符形态在 win32 上解出可用的盘符路径', () => {
  const w = new URL('file:///C:/Users/DELL/x/index.js')
  assert.equal(w.pathname, '/C:/Users/DELL/x/index.js', 'pathname 带前导斜杠（#3 的成因）')
  let decoded = ''
  try { decoded = fileURLToPath(w) } catch (e) { decoded = '' }
  if (process.platform === 'win32') {
    assert.ok(decoded, 'win32 上应能解出路径')
    assert.ok(!decoded.startsWith('\\'), '不能以反斜杠开头（否则 path.join 后成 \\C:\\… 死路径）')
    assert.ok(!decoded.startsWith('/'), '不能以斜杠开头')
  } else {
    // POSIX 上解出的是 '/C:/…' 这种带前导斜杠的串——本插件不在 POSIX 上用它拼盘符路径，
    //   这里只记录事实，不做"应与 win32 相等"的跨平台断言。
    assert.ok(decoded === '' || decoded.startsWith('/'), 'POSIX 上要么抛、要么返回带前导斜杠的串')
  }
})

test('#3 fileURLToPath: POSIX 形态在各平台上的既有语义', () => {
  const u = new URL('file:///Users/a/b/index.js')
  assert.equal(u.pathname, '/Users/a/b/index.js')
  if (process.platform === 'win32') {
    // win32 上这里是"抛"，不是"返回不等"——旧断言正是这样误红的。
    assert.throws(() => fileURLToPath(u), /ERR_INVALID_FILE_URL_PATH|must be absolute/,
      'win32 上解 POSIX 形态应抛 ERR_INVALID_FILE_URL_PATH')
  } else {
    assert.equal(fileURLToPath(u), '/Users/a/b/index.js')
  }
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
