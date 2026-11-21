// #4 实测补记回归：自愈改的是磁盘产物，救不回已加载进内存的模块。
//   所以 (a) 汇总行必须说明「需重启才生效」，(b) index.js 没改道就是混合态、要单独说破。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

test('汇总行带「需重启 DSH 才生效」的说明（applied 时）', () => {
  assert.ok(src.includes('rebootNote'), '应有 rebootNote')
  assert.ok(/需重启 DSH 后才生效/.test(src), '文案应明确需重启')
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
  assert.ok(/需重启 DSH 才会被 deck 用上/.test(src), '应指出重启')
})

test('未就绪判定不把 already 当失败（已打过是健康态）', () => {
  assert.ok(src.includes('indexRow.outcome === "applied" || indexRow.outcome === "already"'), 'already 应算就绪')
})
