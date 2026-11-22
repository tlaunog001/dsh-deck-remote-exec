// #4 实测补记回归：自愈改的是磁盘产物，救不回已加载进内存的模块。
//   所以 (a) 汇总行必须说明「需重启才生效」，(b) index.js 没改道就是混合态、要单独说破。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('#4 更正：汇总行不得再断言「必须重启」（下游实测热重载会生效）', () => {
  assert.ok(src.includes('rebootNote'), '应有 rebootNote')
  // 下游实测：热替换目标包后宿主会重新求值 deck 模块、磁盘补丁即生效，全程未重启。
  // 旧文案「需重启 DSH 后才生效」是错的，会把人支去重启（打断所有会话）。
  assert.ok(!/需重启 DSH 后才生效/.test(src), '不得再写「需重启 DSH 后才生效」')
  assert.ok(/宿主通常会热重载 deck 直接生效/.test(src), '应表述为条件性：通常热重载生效')
  assert.ok(/若行为未跟上才需重启/.test(src), '重启只作为兜底')
  // 只在真有 applied 时补这句，避免每轮刷屏
  assert.ok(src.includes('const didApply = results.some((r) => r.outcome === "applied")'), '应以 didApply 为条件')
})

test('混合态检测：index.js 未就绪时置 _patchNotReady 并 warn', () => {
  assert.ok(src.includes('let _patchNotReady = true'), '应有状态位')
  assert.ok(src.includes('const indexRow = results.find((r) => r.label === "index.js")'), '应单看 index.js')
  assert.ok(/远端路由未就绪/.test(src), '应有未就绪的明确日志')
})

test('服务已注册但改道未就绪时，另有一条说清「服务可用 ≠ deck 已用上」', () => {
  assert.ok(/本插件已注册 remoteFs\/remoteExec，但 deck 侧的改道未就绪/.test(src), '应区分两件事')
  assert.ok(/若下一轮自检仍失败，才考虑重启 DSH/.test(src), '重启只作为兜底')
})

test('未就绪判定不把 already 当失败（已打过是健康态）', () => {
  assert.ok(src.includes('indexRow.outcome === "applied" || indexRow.outcome === "already"'), 'already 应算就绪')
})
