/**
 * 透视重算协调层的离线核验：用内存版 localStorage 模拟浏览器，验证
 * 触发条件、失败回退、重复刷新不累加、并发去重与「只补缺口」。
 *
 *   npx esbuild scripts/verify-pivot-service.ts --bundle --platform=node --format=esm --outfile=/tmp/verify-svc.mjs --alias:@=./src
 *   node /tmp/verify-svc.mjs
 */

type Store = Record<string, string>

const memory: Store = {}
const fakeWindow = {
  localStorage: {
    getItem: (key: string) => (key in memory ? memory[key] : null),
    setItem: (key: string, value: string) => {
      memory[key] = String(value)
    },
    removeItem: (key: string) => {
      delete memory[key]
    },
  },
}
;(globalThis as unknown as { window: unknown }).window = fakeWindow
;(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ click: () => undefined }),
  body: { appendChild: () => undefined, removeChild: () => undefined },
}
;(globalThis as unknown as { URL: unknown }).URL = { createObjectURL: () => '', revokeObjectURL: () => undefined }

const {
  savePivotConfig,
  publishSourceBatch,
  refreshPivot,
  refreshMissingPivots,
  loadChartAggregate,
  pivotCacheSnapshot,
  setSimulatedFault,
  pivotDefinitions,
} = await import('@/api/pivot-service')
const { computePivotDataset } = await import('@/data/pivot-engine')
const { PIVOT_SOURCES } = await import('@/data/pivot-sources')

let failures = 0
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    failures += 1
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const pivotId = 'PVT-0001'
const otherId = 'PVT-0005'

console.log('\n1. 首次重算与重复刷新')
const first = await refreshPivot(pivotId)
check('首次重算成功', first.ok && first.recomputed, first.detailedReason)
const firstTotal = first.dataset?.grandTotal.displayValue ?? null
const second = await refreshPivot(pivotId)
check('无变化时复用缓存', second.ok && !second.recomputed)
check('重复刷新不累加（总计不变）', second.dataset?.grandTotal.displayValue === firstTotal, `${second.dataset?.grandTotal.displayValue} vs ${firstTotal}`)
const manual = await refreshPivot(pivotId, { force: true })
check('强制重算结果与首次一致', manual.dataset?.grandTotal.displayValue === firstTotal)

console.log('\n2. 来源变化触发重算，其他配置不受影响')
const beforeOther = await refreshPivot(otherId)
const published = publishSourceBatch('sales-orders')
const afterSource = await refreshPivot(pivotId)
check('来源版本变化触发重算', afterSource.recomputed && afterSource.reason === 'source-changed', afterSource.detailedReason)
check('重算结果与引擎直接计算一致', (() => {
  const def = pivotDefinitions().find((item) => item.id === pivotId)!
  const source = PIVOT_SOURCES.find((item) => item.id === def.source)!
  const expected = computePivotDataset(def, source, [...source.rows, published.appended], published.revision)
  return afterSource.dataset?.grandTotal.displayValue === expected.grandTotal.displayValue
})())
const otherAgain = await refreshPivot(otherId)
check('未受影响的配置不重算', otherAgain.ok && !otherAgain.recomputed)
check('未受影响配置版本仍是上一份', otherAgain.version === beforeOther.version)

console.log('\n3. 聚合函数 / 空值显示变化分别触发重算，汇总与明细同口径')
const beforeAgg = pivotCacheSnapshot(pivotId)?.dataset
savePivotConfig(pivotId, { aggregation: 'avg' })
const afterAgg = await refreshPivot(pivotId)
check('聚合函数变化触发重算', afterAgg.recomputed && afterAgg.reason === 'aggregation-changed', afterAgg.detailedReason)
const afterAggNull = pivotCacheSnapshot(pivotId)?.dataset
check('明细与汇总行采用同一聚合函数', Boolean(afterAggNull?.verificationPassed))
savePivotConfig(pivotId, { nullDisplay: 'blank' })
const afterNull = await refreshPivot(pivotId)
check('空值显示变化触发重算', afterNull.recomputed && afterNull.reason === 'null-display-changed', afterNull.detailedReason)
check('两种口径合计不同', afterAggNull?.grandTotal.displayValue !== afterNull.dataset?.grandTotal.displayValue, `${afterAggNull?.grandTotal.displayValue} vs ${afterNull.dataset?.grandTotal.displayValue}`)
check('空值口径在汇总行与明细一致', Boolean(afterNull.dataset?.verificationPassed))
check('版本号随配置提升', (afterNull.dataset?.version ?? 0) > (beforeAgg?.version ?? 0))
savePivotConfig(pivotId, { aggregation: 'sum', nullDisplay: 'zero' })
await refreshPivot(pivotId)

console.log('\n4. 重算失败时继续供应上一份完整结果')
const stable = pivotCacheSnapshot(pivotId)?.dataset
setSimulatedFault(pivotId, '连接被重置')
const faulty = await refreshPivot(pivotId, { force: true })
check('重算失败被记录', !faulty.ok && faulty.failure !== null)
check('失败不覆盖缓存', pivotCacheSnapshot(pivotId)?.dataset?.version === stable?.version)
const chart = loadChartAggregate('CHAR-0001')
check('图表仍能读到上一份完整结果', chart?.dataset?.grandTotal.displayValue === stable?.grandTotal.displayValue)
check('图表标记为回退供应', chart?.servedFromFallback === true && chart?.failure !== null)
check('图表保留透视来源记录', chart?.sourceRecord?.pivotId === pivotId && Boolean(chart?.sourceRecord?.fingerprint))
setSimulatedFault(pivotId, null)
const recovered = await refreshPivot(pivotId)
check('解除故障后恢复成功', recovered.ok)
check('成功重算与稳定版本数值一致', recovered.dataset?.grandTotal.displayValue === stable?.grandTotal.displayValue)

console.log('\n5. 只补齐缺失聚合')
await refreshMissingPivots()
const complete = pivotCacheSnapshot(pivotId)?.dataset?.version
const dropped = await (async () => {
  // 直接清掉一个配置的缓存，模拟中断后缺口。
  const { dropPivotCache } = await import('@/api/pivot-service')
  dropPivotCache('PVT-0003')
  return refreshMissingPivots()
})()
check('只补齐缺失/过期配置', dropped.length === 1 && dropped[0].pivotId === 'PVT-0003', dropped.map((item) => item.pivotId).join(','))
check('已完成的聚合结果保持不变', pivotCacheSnapshot(pivotId)?.dataset?.version === complete)

console.log('\n6. 并发读取只有一个重算入口')
const [, concurrent] = await Promise.all([refreshPivot(pivotId, { force: true }), refreshPivot(pivotId, { force: true })])
check('同一配置并发共用一次重算结果', concurrent.ok && concurrent.dataset?.grandTotal.displayValue === stable?.grandTotal.displayValue)

console.log('\n7. 失败重试只补缺口，原结果继续有效')
setSimulatedFault(pivotId, '超时')
const failedPivot = await (async () => {
  savePivotConfig(pivotId, { measure: '折扣额' })
  return refreshPivot(pivotId)
})()
check('度量变化后重算失败', !failedPivot.ok)
check('失败后仍可读上一份结果', loadChartAggregate('CHAR-0001')?.dataset?.measure === '销售额')
setSimulatedFault(pivotId, null)
const retry = await refreshPivot(pivotId)
check('重试后补齐到新度量', retry.ok && retry.dataset?.measure === '折扣额')

console.log(failures === 0 ? '\n全部服务层核验通过' : `\n有 ${failures} 项未通过`)
process.exit(failures === 0 ? 0 : 1)
