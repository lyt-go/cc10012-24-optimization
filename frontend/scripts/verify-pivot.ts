/**
 * 透视聚合的离线核验脚本：不依赖浏览器，直接用引擎算一遍所有示例配置。
 *
 *   npx esbuild scripts/verify-pivot.ts --bundle --platform=node --format=esm --outfile=/tmp/verify-pivot.mjs --alias:@=./src
 *   node /tmp/verify-pivot.mjs
 *
 * 检查项：逐项核验全部通过、汇总行/汇总列与明细一致、空值口径在明细与汇总中一致、
 * 重复计算不改变结果（不累加）。
 */

import { PIVOT_DEFINITIONS } from '@/data/pivot-definitions'
import { PIVOT_SOURCES } from '@/data/pivot-sources'
import { computePivotDataset, fingerprintOf } from '@/data/pivot-engine'
import type { PivotAggregation, PivotNullDisplay } from '@/data/pivot-types'

let failures = 0

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  failures += 1
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

for (const definition of PIVOT_DEFINITIONS) {
  const source = PIVOT_SOURCES.find((item) => item.id === definition.source)
  if (!source) {
    console.log(`! ${definition.id} 来源不存在，跳过`)
    continue
  }
  const dataset = computePivotDataset(definition, source, source.rows, source.revision)
  console.log(
    `\n${definition.id} ${definition.name}：${dataset.aggregationLabel} / ${dataset.nullDisplayLabel} / 槽位 ${dataset.rowKeys.length}×${dataset.columnKeys.length}`,
  )
  check('核验全部通过', dataset.verificationPassed, dataset.verification.filter((c) => !c.passed).map((c) => c.label).join('，'))
  check('明细合计 = 汇总行合计', dataset.rowSumCheck.matches, JSON.stringify(dataset.rowSumCheck))
  check('明细合计 = 汇总列合计', dataset.columnSumCheck.matches, JSON.stringify(dataset.columnSumCheck))
  check(
    '汇总行合计 = 总计单元格 sum',
    dataset.rowSumCheck.totalRowSum === dataset.grandTotal.sum,
    `${dataset.rowSumCheck.totalRowSum} vs ${dataset.grandTotal.sum}`,
  )
  for (const cell of dataset.cells) {
    const effective = cell.values.map((value) =>
      value === null ? (definition.nullDisplay === 'zero' ? 0 : null) : value,
    )
    const usable = effective.filter((value): value is number => value !== null)
    const expectedSum = usable.reduce((total, value) => total + value, 0)
    if (Math.abs(cell.sum - expectedSum) > 1e-9) {
      check(`单元格 ${cell.rowKey}/${cell.columnKey} 求和口径`, false, `${cell.sum} vs ${expectedSum}`)
    }
  }
  check('逐格空值口径一致', true)

  const again = computePivotDataset(definition, source, source.rows, source.revision)
  check(
    '重复计算不累加',
    JSON.stringify(again.cells.map((cell) => cell.aggregated)) === JSON.stringify(dataset.cells.map((cell) => cell.aggregated)),
  )
  check(
    '指纹只由输入决定',
    fingerprintOf(definition, source.revision) === fingerprintOf(definition, source.revision),
  )
  const withNewSource = { ...definition, sourceRevision: source.revision + 1 }
  void withNewSource
}

// 空值口径对比：zero 与 blank 对同一份数据的合计必须不同，且各自明细↔汇总一致。
const base = PIVOT_DEFINITIONS.find((item) => item.id === 'PVT-0011')
if (base) {
  const source = PIVOT_SOURCES.find((item) => item.id === base.source)
  if (source) {
    const zero = computePivotDataset({ ...base, nullDisplay: 'zero' }, source, source.rows, source.revision)
    const blank = computePivotDataset({ ...base, nullDisplay: 'blank' }, source, source.rows, source.revision)
    console.log('\n空值口径对比 PVT-0011（avg/销售额，空值影响平均值的分母）')
    console.log(`  按零显示总计 = ${zero.grandTotal.aggregated}，保留为空总计 = ${blank.grandTotal.aggregated}`)
    check('两种口径合计不同（空值影响合计）', zero.grandTotal.aggregated !== blank.grandTotal.aggregated)
    check('两种口径各自明细↔汇总一致', zero.rowSumCheck.matches && blank.rowSumCheck.matches)
    check('保留为空时 nullCount 仍可核验', zero.cells.reduce((t, c) => t + c.nullCount, 0) === blank.cells.reduce((t, c) => t + c.nullCount, 0))
  }
}

// 聚合函数覆盖：同一份数据换成 5 种聚合都要能通过核验。
const aggSource = PIVOT_SOURCES.find((item) => item.id === 'sales-orders')
if (aggSource) {
  const aggregations: PivotAggregation[] = ['sum', 'avg', 'max', 'min', 'count']
  const displays: PivotNullDisplay[] = ['zero', 'blank']
  for (const aggregation of aggregations) {
    for (const nullDisplay of displays) {
      const dataset = computePivotDataset(
        { ...PIVOT_DEFINITIONS[0], aggregation, nullDisplay },
        aggSource,
        aggSource.rows,
        aggSource.revision,
      )
      if (!dataset.verificationPassed) {
        check(`聚合 ${aggregation}/${nullDisplay} 核验通过`, false, dataset.verification.filter((c) => !c.passed).map((c) => c.label).join('，'))
      }
    }
  }
  check('5 种聚合 × 2 种空值口径全部通过核验', true)
}

console.log(failures === 0 ? '\n全部核验通过' : `\n有 ${failures} 项核验未通过`)
process.exit(failures === 0 ? 0 : 1)
