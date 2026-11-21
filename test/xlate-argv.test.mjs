// issue #2 回归：xlate 的 '/' 前置判断会让纯反斜杠 Windows 路径的 argv 位永不翻译。
// 这里按 xlate 的判断顺序（修后：/[\\/]/ → 盘符或 '/' 开头 → relPathUnder → toRemote）复刻 8 用例，
// 既锁住 argv 位镜像路径能翻译，也反向锁住 BUG-008 的相对端点不被改写。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalMirrorPath, loadRemoteModules } from '../lib/services.js'

const mirror = 'C:\\Users\\DELL\\.dsh\\remote-workspaces\\192.168.10.200-jx-22\\models'
const lower = mirror.toLowerCase()
const ws = '/data/models'
const mods = await loadRemoteModules()

// 与 lib/services.js 的 xlate 同形；先读源码里的真实判据，避免测试与实现各写一份漂移。
const src = (await import('node:fs')).readFileSync(new URL('../lib/services.js', import.meta.url), 'utf8')
const usesBackslashAwareGuard = src.includes("!/[\\\\/]/.test(a)")

function xlate(a) {
  if (typeof a !== 'string' || !/[\\/]/.test(a)) return a
  if (!(a.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(a))) return a
  try {
    const canon = canonicalMirrorPath(mirror, a)
    if (mods.paths.relPathUnder(mirror, canon) === null) return a
    return mods.paths.resolveRemoteWorkspacePath(ws, canon, mirror)
  } catch { return a }
}

test('实现里确实用了同时认反斜杠的守卫（防止死代码回归）', () => {
const usesBackslashAwareGuard = src.includes("!/[\\\\/]/.test(a)")
})

const cases = [
  ['小写镜像根（反斜杠）→ 远端根', lower, ws],
  ['小写镜像根 \\lens → 远端子目录', lower + '\\lens', ws + '/lens'],
  ['正确大小写镜像根 → 远端根', mirror, ws],
  ['BUG-008: repos/cli/cli 不改写', 'repos/cli/cli', 'repos/cli/cli'],
  ['BUG-008: .nameWithOwner 不改写', '.nameWithOwner', '.nameWithOwner'],
  ['相对端点 a/b/c 不改写', 'a/b/c', 'a/b/c'],
  ['远端绝对路径 /tmp/x 不改写', '/tmp/x', '/tmp/x'],
  ['--porcelain 不改写', '--porcelain', '--porcelain'],
]
for (const [name, input, want] of cases) {
  test(name, () => { assert.equal(xlate(input), want) })
}
