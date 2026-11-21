// BUG-009 回归：deck 在 win32 下把盘符路径小写折叠，toRemote 的大小写敏感前缀比对失效。
// 验证 canonicalMirrorPath 只把「大小写不敏感等价」的镜像前缀换回真实大小写，且 toRemote 端到端能剥前缀。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalMirrorPath, loadRemoteModules } from '../lib/services.js'

const mirror = 'C:\\Users\\DELL\\.dsh\\remote-workspaces\\192.168.10.200-jx-22\\models'
const lower = mirror.toLowerCase()

test('全小写盘符路径：前缀换回真实大小写（issue #1 的 E2/E3 根因）', () => {
  const got = canonicalMirrorPath(mirror, lower)
  assert.equal(got, mirror)
})

test('全小写 + 子路径：只归一前缀，尾部保持原样', () => {
  const raw = lower + '\\docs\\agents\\workspace.yaml'
  assert.equal(canonicalMirrorPath(mirror, raw), mirror + '\\docs\\agents\\workspace.yaml')
})

test('正确大小写：原样返回（不制造变化）', () => {
  assert.equal(canonicalMirrorPath(mirror, mirror + '\\x'), mirror + '\\x')
})

test('不同卷 / 不相干路径：不改写', () => {
  assert.equal(canonicalMirrorPath(mirror, 'D:\\other\\x'), 'D:\\other\\x')
  assert.equal(canonicalMirrorPath(mirror, '/data/models/x'), '/data/models/x')
})

test('非盘符镜像前缀（POSIX）：不改写', () => {
  assert.equal(canonicalMirrorPath('/home/jx/.dsh/mirror', '/HOME/JX/.DSH/MIRROR/x'), '/HOME/JX/.DSH/MIRROR/x')
})

test('非字符串入参：原样返回', () => {
  assert.equal(canonicalMirrorPath(mirror, null), null)
  assert.equal(canonicalMirrorPath(null, lower), lower)
})

test('端到端：归一后 relPathUnder 能剥前缀、resolveRemoteWorkspacePath 得到 /data/models', async () => {
  const mods = await loadRemoteModules()
  if (!mods) { console.log('（跳过：本机未装 dsh-remote）'); return }
  assert.equal(mods.paths.relPathUnder(mirror, lower), null, '前置：未归一时确实剥不下')
  const canon = canonicalMirrorPath(mirror, lower)
  assert.notEqual(mods.paths.relPathUnder(mirror, canon), null, '归一后能剥前缀')
  assert.equal(mods.paths.resolveRemoteWorkspacePath('/data/models', canon, mirror), '/data/models')
})
