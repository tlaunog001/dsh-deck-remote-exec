// #5 回归（跨函数一致性）：already 判据用的签名，必须是**该函数自己会写进那个文件**的签名。
// 上一版给 index.js 多要求了 SIGN_RESOLVE（那是 patchPlatform 注入 platform/index.js 的），
// 于 index 永远判不成 already → 改道成功后每 30 秒误报 skipped。
// 单测 patch 函数本身抓不到这类错（它只看单文件输出），所以这里做两件事：
//   ① 真跑 patchSource / patchPlatform / patchPredicate，比对"输出里实际出现的签名"与代码里要求的 signList；
//   ② 幂等：同一份输出再 patch 一次必须原样返回（== already 分支的前提）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchSource, patchPlatform, patchPredicate } from '../lib/index.js'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const deckLib = path.join(repoRoot, '..', 'dsh-mattpocock-skills-deck', 'package', 'lib')

// 签名带版本戳（issue #8），测试不硬编码版本号，直接从源码取常量值。
function signOf(name) {
  const m = src.match(new RegExp('const ' + name + ' = "([^"]+)"'))
  assert.ok(m, '源码里找不到常量 ' + name)
  return m[1]
}
const SIGNS = { fs: signOf('SIGN_FS'), exec: signOf('SIGN_EXEC'), resolve: signOf('SIGN_RESOLVE'), pc: '__rdePcCwd' }

test('#5 index.js 的 signList 不含 SIGN_RESOLVE（patchSource 不写它）', () => {
  assert.ok(
    src.includes('patchOne(t.index, patchSource, "index.js", [SIGN_FS, SIGN_EXEC])'),
    'index 的 signList 应只有 SIGN_FS / SIGN_EXEC',
  )
  assert.ok(
    !/patchOne\(t\.index, patchSource, "index\.js", \[[^\]]*SIGN_RESOLVE/.test(src),
    'index 的 signList 不得含 SIGN_RESOLVE',
  )
})

test('#5 index 的 ensurePatched 自检签名与 patchOne 保持一致', () => {
  assert.ok(
    src.includes('{ file: t.index, signs: [SIGN_FS, SIGN_EXEC] }'),
    'ensurePatched 对 index 的签名清单应与 patchOne 一致',
  )
})

test('#5 跨文件一致性：每个 patch 输出的签名集合，正好覆盖它被要求的那组', () => {
  // 用真实 deck 产物（有就用，没有就跳过端到端部分，仍保留静态断言）。
  const files = {
    index: path.join(deckLib, 'index.js'),
    platform: path.join(deckLib, 'platform', 'index.js'),
    predicate: path.join(deckLib, 'tracker', 'predicatePrimitives.js'),
  }
  if (!existsSync(files.index)) { console.log('（跳过：本机未装 deck）'); return }
  // 每个文件"自己该拿到"的签名（与 lib/index.js 里 patchOne 的 signList 对齐）
  const expected = {
    index: [SIGNS.fs, SIGNS.exec],
    platform: [SIGNS.resolve],
    predicate: [SIGNS.pc],
  }
 const plan = [
    ['index', patchSource],
    ['platform', patchPlatform],
    ['predicate', patchPredicate],
  ]
  for (const [name, fn] of plan) {
    const original = readFileSync(files[name], 'utf8')
    const out = fn(original)
    const idem = fn(out) === out
    assert.ok(idem, name + '：对已改道输出再 patch 必须原样返回（else 每轮都会误报 skipped）')
    // 该拿到的签名要在
    const want = expected[name]
    for (const sig of want) assert.ok(out.includes(sig), name + ' 缺少自己应写的签名 ' + sig)
    // 不该由它负责的签名，不应成为 already 的前提（这部分已由上面两条静态断言覆盖）；
    // 这里只断言：如果它没写某签名，那该签名在输出里不因此被"欠账"。
  }
})
