/**
 * 透视聚合引擎：纯函数，不做持久化、不做缓存。
 *
 * 聚合规则（明细、汇总行、汇总列、总计共用同一套）：
 * - zero（按零计入）：空值按 0 参与计算。SUM 加 0；AVG 的分母包含空值行；MIN/MAX 把 0 当作候选值；
 *   COUNT 统计全部行。
 * - blank（保留为空）：空值跳过。SUM/AVG/MIN/MAX 只看非空值；COUNT 只统计非空值；
 *   整格没有有效值时结果为 null，界面显示空值而不是 0。
 * - 汇总行 / 汇总列 / 总计都由原始明细重新聚合，绝不对明细聚合值再求和一次，
 *   所以空值口径一致，也不会把汇总行重复累加。
 * - 核验：明细单元格的 sum / rowCount / valueCount 之和必须与汇总行（列）一致，
 *   这是「逐项可核验」的判定依据。
 */

import { PIVOT_SOURCE_BY_ID } from '@/data/pivot-sources'
import type { PivotSourceDefinition, SourceRow, SourceValue } from '@/data/pivot-sources'
import type {
  PivotAggregation,
  PivotCell,
  PivotCheck,
  PivotDataset,
  PivotDefinition,
  PivotFingerprint,
  PivotNullDisplay,
} from '@/data/pivot-types'

export const AGGREGATION_LABELS: Record<PivotAggregation, string> = {
  sum: '求和 SUM',
  avg: '平均值 AVG',
  max: '最大值 MAX',
  min: '最小值 MIN',
  count: '计数 COUNT',
}

export const NULL_DISPLAY_LABELS: Record<PivotNullDisplay, string> = {
  zero: '按零显示',
  blank: '保留为空',
}

export const AGGREGATIONS: PivotAggregation[] = ['sum', 'avg', 'max', 'min', 'count']
export const NULL_DISPLAYS: PivotNullDisplay[] = ['zero', 'blank']

const EPSILON = 1e-9

export function roundValue(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null
  }
  return Math.round(value * 1e6) / 1e6
}

function toNumber(value: SourceValue): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed.toLowerCase() === 'null' || trimmed === '-') {
      return null
    }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function cellKey(rowKey: string, columnKey: string): string {
  return `${rowKey}\u0001${columnKey}`
}

type RawCell = {
  rowKey: string
  columnKey: string
  rowCount: number
  values: (number | null)[]
  invalidValues: string[]
}

function collectCell(raw: RawCell[], rowKey: string, columnKey: string, value: SourceValue): void {
  let cell = raw.find((item) => item.rowKey === rowKey && item.columnKey === columnKey)
  if (!cell) {
    cell = { rowKey, columnKey, rowCount: 0, values: [], invalidValues: [] }
    raw.push(cell)
  }
  cell.rowCount += 1
  const parsed = toNumber(value)
  if (parsed === null && value !== null && String(value).trim() !== '') {
    cell.invalidValues.push(String(value))
  }
  cell.values.push(parsed)
}

/** 按口径把原始值折成可计算的数值序列。 */
function effectiveValues(values: (number | null)[], nullDisplay: PivotNullDisplay): number[] {
  if (nullDisplay === 'zero') {
    return values.map((value) => (value === null ? 0 : value))
  }
  return values.filter((value): value is number => value !== null)
}

function aggregateValues(
  values: (number | null)[],
  aggregation: PivotAggregation,
  nullDisplay: PivotNullDisplay,
): { sum: number; avg: number | null; min: number | null; max: number | null; aggregated: number | null } {
  const effective = effectiveValues(values, nullDisplay)
  const sum = effective.reduce((total, value) => total + value, 0)
  const rowCount = values.length
  const nullCount = values.filter((value) => value === null).length
  const valueCount = rowCount - nullCount

  if (effective.length === 0) {
    // 只在「保留为空」且整格没有有效值时出现。
    return { sum: 0, avg: null, min: null, max: null, aggregated: null }
  }

  const avg = sum / effective.length
  const min = Math.min(...effective)
  const max = Math.max(...effective)
  let aggregated: number
  switch (aggregation) {
    case 'sum':
      aggregated = sum
      break
    case 'avg':
      aggregated = avg
      break
    case 'max':
      aggregated = max
      break
    case 'min':
      aggregated = min
      break
    case 'count':
      // 按零口径下空值也是 0，计为一行；保留为空时只数非空值。
      aggregated = nullDisplay === 'zero' ? rowCount : valueCount
      break
  }
  return { sum, avg, min, max, aggregated }
}

function makeCell(raw: RawCell, aggregation: PivotAggregation, nullDisplay: PivotNullDisplay): PivotCell {
  const result = aggregateValues(raw.values, aggregation, nullDisplay)
  const nullCount = raw.values.filter((value) => value === null).length
  const displayValue = result.aggregated === null ? null : roundValue(result.aggregated)
  return {
    rowKey: raw.rowKey,
    columnKey: raw.columnKey,
    rowCount: raw.rowCount,
    valueCount: raw.values.length - nullCount,
    nullCount,
    sum: roundValue(result.sum) ?? 0,
    avg: roundValue(result.avg),
    min: roundValue(result.min),
    max: roundValue(result.max),
    values: raw.values,
    aggregated: displayValue,
    displayValue,
    invalidValues: [...raw.invalidValues],
  }
}

/** 维度组合在来源里没有任何明细：按零口径显示 0，保留为空显示空值。 */
function emptyCell(
  rowKey: string,
  columnKey: string,
  aggregation: PivotAggregation,
  nullDisplay: PivotNullDisplay,
): PivotCell {
  const zero = nullDisplay === 'zero'
  return {
    rowKey,
    columnKey,
    rowCount: 0,
    valueCount: 0,
    nullCount: 0,
    sum: 0,
    avg: zero ? 0 : null,
    min: zero ? 0 : null,
    max: zero ? 0 : null,
    values: [],
    aggregated: zero ? 0 : null,
    displayValue: zero ? 0 : null,
    invalidValues: [],
  }
}

export function fingerprintOf(definition: PivotDefinition, sourceRevision: number): string {
  const fingerprint: PivotFingerprint & { configVersion: number } = {
    configVersion: definition.version,
    sourceId: definition.source,
    sourceRevision,
    measure: definition.measure,
    aggregation: definition.aggregation,
    nullDisplay: definition.nullDisplay,
    totalRow: definition.totalRow,
    rowDimension: definition.rowDimension,
    columnDimension: definition.columnDimension,
  }
  return JSON.stringify(fingerprint)
}

/** 找出配置里不能参与计算的地方；返回空数组表示可以重算。 */
export function validatePivotDefinition(
  definition: PivotDefinition,
  source: PivotSourceDefinition | undefined,
): string[] {
  const problems: string[] = []
  if (!source) {
    problems.push(`数据来源「${definition.source}」未登记，无法读取明细`)
    return problems
  }
  const fieldNames = source.fields.map((field) => field.name)
  const dimensions = source.fields.filter((field) => field.role === 'dimension').map((field) => field.name)
  const measures = source.fields.filter((field) => field.role === 'measure').map((field) => field.name)
  if (!dimensions.includes(definition.rowDimension)) {
    problems.push(
      `行维度字段「${definition.rowDimension}」不在来源「${source.name}」的维度字段中（可选：${dimensions.join('、')}）`,
    )
  }
  if (!dimensions.includes(definition.columnDimension)) {
    problems.push(
      `列维度字段「${definition.columnDimension}」不在来源「${source.name}」的维度字段中（可选：${dimensions.join('、')}）`,
    )
  }
  if (!fieldNames.includes(definition.measure)) {
    problems.push(`值度量字段「${definition.measure}」不在来源「${source.name}」的字段中`)
  } else if (!measures.includes(definition.measure)) {
    problems.push(`值度量字段「${definition.measure}」不是数值度量（可选的度量：${measures.join('、')}）`)
  }
  if (!AGGREGATIONS.includes(definition.aggregation)) {
    problems.push(`聚合函数「${definition.aggregation}」未登记，可选：${AGGREGATIONS.join('、')}`)
  }
  if (!NULL_DISPLAYS.includes(definition.nullDisplay)) {
    problems.push(`空值显示「${definition.nullDisplay}」未登记，可选：${NULL_DISPLAY_LABELS.zero}、${NULL_DISPLAY_LABELS.blank}`)
  }
  if (typeof definition.totalRow !== 'boolean') {
    problems.push('汇总行开启必须是布尔值')
  }
  if (definition.rowDimension === definition.columnDimension) {
    problems.push('行维度字段与列维度字段不能相同')
  }
  return problems
}

export function computePivotDataset(
  definition: PivotDefinition,
  source: PivotSourceDefinition,
  rows: SourceRow[],
  sourceRevision: number,
): PivotDataset {
  const problems = validatePivotDefinition(definition, source)
  if (problems.length > 0) {
    throw new Error(problems.join('；'))
  }
  for (const row of rows) {
    if (row[definition.rowDimension] === undefined && row[definition.columnDimension] === undefined) {
      throw new Error(`数据来源「${source.name}」的明细缺少维度字段 ${definition.rowDimension}/${definition.columnDimension}`)
    }
  }

  const measureField = source.fields.find((field) => field.name === definition.measure)
  const raw: RawCell[] = []
  const rowKeys: string[] = []
  const columnKeys: string[] = []
  const rowRaw: RawCell[] = []
  const columnRaw: RawCell[] = []
  const grandRaw: RawCell[] = []

  for (const row of rows) {
    const rowKey = String(row[definition.rowDimension] ?? '')
    const columnKey = String(row[definition.columnDimension] ?? '')
    if (!rowKeys.includes(rowKey)) rowKeys.push(rowKey)
    if (!columnKeys.includes(columnKey)) columnKeys.push(columnKey)
    const value = row[definition.measure] ?? null
    collectCell(raw, rowKey, columnKey, value)
    collectCell(rowRaw, rowKey, '__ALL__', value)
    collectCell(columnRaw, '__ALL__', columnKey, value)
    collectCell(grandRaw, '__ALL__', '__ALL__', value)
  }

  rowKeys.sort((a, b) => a.localeCompare(b, 'zh-CN'))
  columnKeys.sort((a, b) => a.localeCompare(b, 'zh-CN'))

  const byKey = new Map<string, RawCell>()
  for (const cell of raw) {
    byKey.set(cellKey(cell.rowKey, cell.columnKey), cell)
  }
  const cells: PivotCell[] = []
  for (const rowKey of rowKeys) {
    for (const columnKey of columnKeys) {
      const cell = byKey.get(cellKey(rowKey, columnKey))
      cells.push(
        cell
          ? makeCell(cell, definition.aggregation, definition.nullDisplay)
          : emptyCell(rowKey, columnKey, definition.aggregation, definition.nullDisplay),
      )
    }
  }

  const totalRowValues = columnKeys.map((columnKey) => {
    const cell = columnRaw.find((item) => item.columnKey === columnKey)
    const made = cell ? makeCell(cell, definition.aggregation, definition.nullDisplay) : emptyCell('总计', columnKey, definition.aggregation, definition.nullDisplay)
    return { ...made, rowKey: '总计' }
  })
  const totalColumnValues = rowKeys.map((rowKey) => {
    const cell = rowRaw.find((item) => item.rowKey === rowKey)
    const made = cell ? makeCell(cell, definition.aggregation, definition.nullDisplay) : emptyCell(rowKey, '总计', definition.aggregation, definition.nullDisplay)
    return { ...made, columnKey: '总计' }
  })
  const grandRawCell = grandRaw[0] ?? {
    rowKey: '总计',
    columnKey: '总计',
    rowCount: 0,
    values: [],
    invalidValues: [],
  }
  const grandTotal = makeCell(grandRawCell, definition.aggregation, definition.nullDisplay)

  const detailSum = cells.reduce((total, cell) => total + cell.sum, 0)
  const totalRowSum = totalRowValues.reduce((total, cell) => total + cell.sum, 0)
  const totalColumnSum = totalColumnValues.reduce((total, cell) => total + cell.sum, 0)
  const detailRowCount = cells.reduce((total, cell) => total + cell.rowCount, 0)
  const totalRowCount = totalRowValues.reduce((total, cell) => total + cell.rowCount, 0)
  const totalColumnCount = totalColumnValues.reduce((total, cell) => total + cell.rowCount, 0)

  const measureUnit = measureField?.unit ?? ''
  const verification = buildVerification({
    definition,
    cells,
    rowKeys,
    columnKeys,
    totalRowValues,
    totalColumnValues,
    grandTotal,
    detailSum,
    totalRowSum,
    totalColumnSum,
    detailRowCount,
    totalRowCount,
    totalColumnCount,
    grandSum: grandRawCell.values.length,
    sourceRows: rows.length,
  })
  const verificationPassed = verification.every((check) => check.passed)
  const notes = [
    `空值口径：${NULL_DISPLAY_LABELS[definition.nullDisplay]}${
      definition.nullDisplay === 'zero'
        ? '（空值按 0 参与 SUM/AVG/MIN/MAX，COUNT 统计全部行）'
        : '（空值跳过，COUNT 只统计非空值，整格无有效值时显示空）'
    }`,
    `聚合函数：${AGGREGATION_LABELS[definition.aggregation]}；明细、汇总行、汇总列与总计使用同一口径。`,
    '汇总行/列由原始明细重新聚合，不对明细聚合值二次汇总，因此不会重复累加。',
    `来源 ${source.name} 版本 r${sourceRevision}，共 ${rows.length} 行明细。`,
  ]

  return {
    pivotId: definition.id,
    version: definition.version,
    sourceId: source.id,
    sourceName: source.name,
    sourceRevision,
    measure: definition.measure,
    measureUnit,
    aggregation: definition.aggregation,
    aggregationLabel: AGGREGATION_LABELS[definition.aggregation],
    nullDisplay: definition.nullDisplay,
    nullDisplayLabel: NULL_DISPLAY_LABELS[definition.nullDisplay],
    totalRow: definition.totalRow,
    rowDimension: definition.rowDimension,
    columnDimension: definition.columnDimension,
    fingerprint: fingerprintOf(definition, sourceRevision),
    generatedAt: new Date().toISOString(),
    cells,
    rowKeys,
    columnKeys,
    totalRowValues,
    totalColumnValues,
    grandTotal,
    rowSumCheck: {
      detailSum: roundValue(detailSum),
      totalRowSum: roundValue(totalRowSum),
      matches: Math.abs(detailSum - totalRowSum) < EPSILON && detailRowCount === totalRowCount,
    },
    verification,
    verificationPassed,
    columnSumCheck: {
      detailSum: roundValue(detailSum),
      totalColumnSum: roundValue(totalColumnSum),
      matches: Math.abs(detailSum - totalColumnSum) < EPSILON && detailRowCount === totalColumnCount,
    },
    notes,
  }
}

type VerificationInput = {
  definition: PivotDefinition
  cells: PivotCell[]
  rowKeys: string[]
  columnKeys: string[]
  totalRowValues: PivotCell[]
  totalColumnValues: PivotCell[]
  grandTotal: PivotCell
  detailSum: number
  totalRowSum: number
  totalColumnSum: number
  detailRowCount: number
  totalRowCount: number
  totalColumnCount: number
  grandSum: number
  sourceRows: number
}

/**
 * 逐项核验：阈值 1e-9（浮点累计误差），判定范围写进每一条 check。
 * 任何一条不通过都视为本次重算失败，缓存不会被覆盖。
 */
function buildVerification(input: VerificationInput): PivotCheck[] {
  const {
    definition,
    cells,
    rowKeys,
    columnKeys,
    totalRowValues,
    totalColumnValues,
    grandTotal,
    detailSum,
    totalRowSum,
    totalColumnSum,
    detailRowCount,
    totalRowCount,
    totalColumnCount,
    grandSum,
    sourceRows,
  } = input
  const checks: PivotCheck[] = []
  const toleranceText = '差值 ≤ 1e-9'
  const push = (
    id: string,
    label: string,
    scope: string,
    expected: string,
    actual: string,
    passed: boolean,
    tolerance = toleranceText,
  ) => {
    checks.push({ id, label, scope, tolerance, expected, actual, passed })
  }

  push(
    'detail-count',
    '明细单元格数量与维度组合一致',
    `${rowKeys.length} 行维度 × ${columnKeys.length} 列维度`,
    String(rowKeys.length * columnKeys.length),
    String(cells.length),
    cells.length === rowKeys.length * columnKeys.length,
    '数量必须相等',
  )
  push(
    'source-rows',
    '明细行数覆盖全部来源行',
    `来源 ${definition.source} 全部明细`,
    String(sourceRows),
    String(detailRowCount),
    detailRowCount === sourceRows,
    '数量必须相等',
  )
  push(
    'total-row',
    '汇总行按明细重新聚合后合计一致',
    '明细单元格 ↔ 汇总行',
    String(roundValue(detailSum)),
    String(roundValue(totalRowSum)),
    Math.abs(detailSum - totalRowSum) < EPSILON && detailRowCount === totalRowCount,
  )
  push(
    'total-column',
    '汇总列按明细重新聚合后合计一致',
    '明细单元格 ↔ 汇总列',
    String(roundValue(detailSum)),
    String(roundValue(totalColumnSum)),
    Math.abs(detailSum - totalColumnSum) < EPSILON && detailRowCount === totalColumnCount,
  )
  push(
    'grand-total',
    '总计单元格与汇总行合计一致',
    '汇总行 + 汇总列 ↔ 总计单元格',
    `${roundValue(detailSum)} / 行数 ${detailRowCount}`,
    `${grandTotal.sum} / 行数 ${grandSum}`,
    Math.abs(grandTotal.sum - detailSum) < EPSILON && grandSum === detailRowCount,
  )
  push(
    'no-double-count',
    '汇总行没有把明细重复累加',
    '总计 ≠ 明细合计 + 汇总行合计',
    `总计行合计 ${roundValue(detailSum)}`,
    `明细 + 汇总行 = ${roundValue(detailSum + totalRowSum)}`,
    Math.abs(detailSum - totalRowSum) < EPSILON,
    '两者应相等，而不是倍数关系',
  )
  push(
    'null-policy',
    '明细与汇总采用同一空值口径',
    `空值显示「${NULL_DISPLAY_LABELS[definition.nullDisplay]}」作用于明细、汇总行、汇总列、总计`,
    definition.nullDisplay === 'zero' ? '空值参与计算（按 0）' : '空值跳过，不补 0',
    cells
      .map((cell) => `${cell.rowKey}/${cell.columnKey}: 空值 ${cell.nullCount}`)
      .slice(0, 3)
      .join('；') + (cells.length > 3 ? ` 等 ${cells.length} 格` : ''),
    cells.every((cell) => (definition.nullDisplay === 'zero' ? cell.aggregated !== null : true)),
    '口径一致',
  )
  push(
    'measure-coverage',
    '度量字段全部可转为数值',
    '来源明细的度量字段',
    '无非法值',
    cells.some((cell) => cell.invalidValues.length > 0)
      ? cells
          .filter((cell) => cell.invalidValues.length > 0)
          .map((cell) => `${cell.rowKey}/${cell.columnKey}: ${cell.invalidValues.join(',')}`)
          .join('；')
      : '无非法值',
    cells.every((cell) => cell.invalidValues.length === 0),
    '非法值数量为 0',
  )
  const rowTotalOk = totalRowValues.every((cell) => cell.rowKey === '总计')
  const columnTotalOk = totalColumnValues.every((cell) => cell.columnKey === '总计')
  push(
    'summary-shape',
    '汇总行/汇总列结构与维度一致',
    `汇总行 ${columnKeys.length} 格、汇总列 ${rowKeys.length} 格`,
    `汇总行 ${columnKeys.length} / 汇总列 ${rowKeys.length}`,
    `汇总行 ${totalRowValues.length} / 汇总列 ${totalColumnValues.length}`,
    rowTotalOk && columnTotalOk && totalRowValues.length === columnKeys.length && totalColumnValues.length === rowKeys.length,
    '数量与标记必须一致',
  )
  return checks
}

export function sourceOf(definition: PivotDefinition): PivotSourceDefinition | undefined {
  return PIVOT_SOURCE_BY_ID.get(definition.source)
}

export function formatCellValue(value: number | null, unit = ''): string {
  if (value === null) {
    return '—（空值）'
  }
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2)
  return unit ? `${text} ${unit}` : text
}
