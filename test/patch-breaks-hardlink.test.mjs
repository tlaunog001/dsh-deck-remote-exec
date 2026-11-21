// #6 回归：就地改写会透过硬链接写穿 pnpm store，必须「写临时文件 + rename 覆盖」切断链接。
// 真造一对硬链接来验：改完后 store 侧内容必须原样、node_modules 侧必须是新内容，且 nlink 归 1。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, linkSync, statSync, rmSync, unlinkSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 复刻 lib/index.js 里 patchOne 的写回动作（同一份逻辑，避免为测试导出内部函数）。
function writeBack(file, next) {
  const tmp = file + '.dsh-deck-remote-exec.tmp'
  writeFileSync(tmp, next, 'utf8')
  renameSync(tmp, file)
}

const STORE_CONTENT = '// store original\nconst a = 1;\n'
const PATCHED = '// store original\nconst a = 1;\n// __rdeFsFacade injected\n'

test('#6 就地写会写穿硬链接（反证：说明为什么不能就地写）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hl-'))
  try {
    const store = path.join(dir, 'store-file')
    const inst = path.join(dir, 'installed.js')
    writeFileSync(store, STORE_CONTENT)
    linkSync(store, inst)
    assert.ok(statSync(inst).nlink > 1, '前置：确实是硬链接')
    writeFileSync(inst, PATCHED)   // 就地写
    assert.equal(readFileSync(store, 'utf8'), PATCHED, '就地写确实改掉了 store 侧（这就是 #6）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('#6 rename 覆盖会切断硬链接，store 保持原样', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hl-'))
  try {
    const store = path.join(dir, 'store-file')
    const inst = path.join(dir, 'installed.js')
    writeFileSync(store, STORE_CONTENT)
    linkSync(store, inst)
    assert.ok(statSync(inst).nlink > 1, '前置：确实是硬链接')

    writeBack(inst, PATCHED)

    assert.equal(readFileSync(store, 'utf8'), STORE_CONTENT, 'store 侧必须原样不动')
    assert.equal(readFileSync(inst, 'utf8'), PATCHED, '装机侧必须是新内容')
    assert.equal(statSync(inst).nlink, 1, '装机侧已脱离硬链接')
    assert.equal(statSync(store).nlink, 1, 'store 侧链接数归 1')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('#6 源码必须用 rename 覆盖，不得有就地 writeFileSync(file, …)', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(src.includes('renameSync(tmp, file)'), '应写临时文件后 rename')
  assert.ok(!/writeFileSync\(file, next/.test(src), '不得就地写目标文件')
  assert.ok(src.includes('nlink > 1'), '应检测硬链接并在日志里注明')
})
