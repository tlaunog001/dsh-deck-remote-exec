// issue #7 ③ 回归：路径定位（locate）要能吃下各种书写形态，且绝不误匹配到别的镜像。
//
// 事故背景：deck 在 win32 上递反斜杠盘符路径；若前缀比对因「分隔符/尾随斜杠/大小写」失配，
//   locate 返回 null → 写操作走「写不进远端」那条路 → 文件落到本地 git 仓库。
// 同时必须防止反向风险：宽松前缀比对可能匹配到**另一个**镜像，那会把写入送到错误的机器。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../lib/services.js', import.meta.url), 'utf8')
const iN = src.indexOf('function normPathForMatch')
const iU = src.indexOf('function locate(p)')
const { normPathForMatch, isUnderLoose } = new Function(src.slice(iN, iU) + '; return { normPathForMatch, isUnderLoose }')()

test('#7 ③ 分隔符与尾随斜杠归一', () => {
  assert.equal(normPathForMatch('C:\\Users\\DELL\\.dsh\\remote-workspaces\\h\\m'), 'C:/Users/DELL/.dsh/remote-workspaces/h/m')
  assert.equal(normPathForMatch('/data/models/'), '/data/models')
  assert.equal(normPathForMatch('/data/models//'), '/data/models')
  assert.equal(normPathForMatch('/'), '/', '根不能变成空')
  assert.equal(normPathForMatch('C:/'), 'C:/', '盘符根不能掉斜杠')
})

test('#7 ③ 前缀判定：父子成立、相似不误判、无关不误判', () => {
  assert.ok(isUnderLoose('/a/b', '/a/b/c'), '子路径应成立')
  assert.ok(isUnderLoose('/a/b', '/a/b'), '自身应成立')
  assert.ok(!isUnderLoose('/a/b', '/a/bb'), '相似目录不得误判')
  assert.ok(!isUnderLoose('/a/b', '/x/y'), '无关路径不得误判')
})

test('#7 ③ locate 里加了「镜像前缀必须真的是入参前缀」的校验', () => {
  const i = src.indexOf('function locate(p)')
  const body = src.slice(i, src.indexOf('const toRemote'))
  assert.ok(body.includes('credible'), '应有可信性校验')
  assert.ok(body.includes('isUnderLoose(hit.mirrorDir'), '校验镜像前缀与入参的关系')
  // 不可信时必须落到 return null，而不是拿它去写
  assert.ok(/if \(credible\)/.test(body), '不可信分支不得直接返回')
})

test('#7 ③ 归一形态会兜第二次（纯字面差异时仍能定位）', () => {
  const i = src.indexOf('function locate(p)')
  const body = src.slice(i, src.indexOf('const toRemote'))
  const n = (body.match(/binding\.resolveMirror\(/g) || []).length
  assert.ok(n >= 2, '应先用原样、再用归一形态各问一次，实际 ' + n + ' 次')
})
