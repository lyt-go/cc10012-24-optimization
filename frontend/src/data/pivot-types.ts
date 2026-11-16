/** 透视配置与聚合结果的公共类型：聚合逻辑、配置读写和图表消费都以这里的结构为准。 */

/** 聚合函数集合：与透视配置里的「聚合函数」字段一一对应。 */
export type PivotAggregation = 'sum' | 'avg' | 'max' | 'min' | 'count'

/** 空值口径：按零计入，或保留为空（只跳过空值，不补零）。明细、汇总行与图例共用同一个选择。 */
export type PivotNullDisplay = 'zero' | 'blank'

/** 透视配置的完整定义（含版本与来源记录）。 */
export type PivotDefinition = {
  id: string
  name: string
  status: string
  /** 数据来源 id，对应 pivot-sources.ts 里的 PIVOT_SOURCES。 */
  source: string
  rowDimension: string
  columnDimension: string
  measure: string
  aggregation: PivotAggregation
  /** 汇总行开启：开启后总计行与明细行走同一套聚合函数与空值口径。 */
  totalRow: boolean
  nullDisplay: PivotNullDisplay
  chartIds: number[]
  dashboardIds: number[]
  version: number
  versionNote: string
  /** 生成当前版本聚合时使用的输入指纹，用于判断缓存是否还能复用。 */
  revisionToken: string
}

/** 一次聚合计算的输入快照：任意一项变化都需要重算。 */
export type PivotFingerprint = {
  sourceId: string
  sourceRevision: number
  measure: string
  aggregation: PivotAggregation
  nullDisplay: PivotNullDisplay
  totalRow: boolean
  rowDimension: string
  columnDimension: string
}

/** 明细单元格：保存聚合前后的原始输入，便于逐项核验。 */
export type PivotCell = {
  rowKey: string
  columnKey: string
  /** 参与聚合的原始行数。 */
  rowCount: number
  /** 非空值个数。 */
  valueCount: number
  /** 空值（null / 无法转成数字）个数。 */
  nullCount: number
  /** 按当前空值口径参与计算的数值之和（空值按零或保留为空都会体现在这里）。 */
  sum: number
  /** 非空值的平均值；没有非空值时为空，按口径决定是否补零。 */
  avg: number | null
  min: number | null
  max: number | null
  /** 原始值序列，用于逐项核对。 */
  values: (number | null)[]
  /** 聚合函数对应的最终值；空值口径为 blank 且无有效值时为 null。 */
  aggregated: number | null
  /** 汇总行口径下的值（仅当该单元格属于总计行/列时有意义，等于 aggregateRows 的结果）。 */
  displayValue: number | null
  /** 不能自动转为数值而被当作空值的原始字符串。 */
  invalidValues: string[]
}

/** 一条核验项：阈值、判定范围与实际值都写清楚，失败时可直接定位。 */
export type PivotCheck = {
  id: string
  label: string
  /** 判定范围，例如「明细单元格 ↔ 汇总行」。 */
  scope: string
  /** 判定阈值，例如「差值 ≤ 1e-9」。 */
  tolerance: string
  expected: string
  actual: string
  passed: boolean
}

/** 聚合透视数据集：图表构建只读这一份结果。 */
export type PivotDataset = {
  pivotId: string
  version: number
  sourceId: string
  sourceName: string
  sourceRevision: number
  measure: string
  measureUnit: string
  aggregation: PivotAggregation
  aggregationLabel: string
  nullDisplay: PivotNullDisplay
  nullDisplayLabel: string
  totalRow: boolean
  rowDimension: string
  columnDimension: string
  fingerprint: string
  generatedAt: string
  /** 明细单元格（不含汇总行/汇总列）。 */
  cells: PivotCell[]
  rowKeys: string[]
  columnKeys: string[]
  /** 汇总行：按列维度求总计。 */
  totalRowValues: PivotCell[]
  /** 汇总列：按行维度求总计。 */
  totalColumnValues: PivotCell[]
  /** 总计单元格。 */
  grandTotal: PivotCell
  /** 核验过的汇总行合计（明细聚合之和，防止重复累加）。 */
  rowSumCheck: { detailSum: number | null; totalRowSum: number | null; matches: boolean }
  columnSumCheck: { detailSum: number | null; totalColumnSum: number | null; matches: boolean }
  /** 逐项核验结果：全部通过才允许提交缓存；任一失败按重算失败处理。 */
  verification: PivotCheck[]
  verificationPassed: boolean
  notes: string[]
}

export type PivotRecomputeReason =
  | 'missing'
  | 'source-changed'
  | 'measure-changed'
  | 'aggregation-changed'
  | 'null-display-changed'
  | 'dimension-changed'
  | 'total-row-changed'
  | 'manual'

export type PivotRecomputeFailure = {
  ok: false
  reason: PivotRecomputeReason
  detailedReason: string
  failedAt: string
  /** 失败时保留的上一版完整结果版本号；没有可用结果时为 null。 */
  servedVersion: number | null
}

export type PivotCacheState = {
  pivotId: string
  dataset: PivotDataset | null
  /** 最近一次成功计算的时间。 */
  cachedAt: string | null
  fingerprint: string | null
  /** 最近一次失败记录，成功重算后清空。 */
  failure: PivotRecomputeFailure | null
  /** 最近一次触发的重算原因。 */
  lastReason: PivotRecomputeReason | null
}

export type PivotRefreshOutcome = {
  pivotId: string
  ok: boolean
  /** 本次是否真正执行了聚合；没有变化时复用缓存，recomputed=false。 */
  recomputed: boolean
  reason: PivotRecomputeReason
  detailedReason: string
  version: number | null
  /** 本次尝试是否失败；失败时图表继续读 previousVersion 对应的完整结果。 */
  failure: PivotRecomputeFailure | null
  previousVersion: number | null
  dataset: PivotDataset | null
}

/** 图表构建读取聚合结果的载荷：图表不自行计算，只投射数据集。 */
export type ChartAggregatePayload = {
  chartNo: string
  chartName: string
  pivotId: string
  pivotName: string
  dataset: PivotDataset | null
  /** 当前展示的是哪一版结果。 */
  servedVersion: number | null
  /** 结果是否来自上一份完整缓存（重算失败时）。 */
  servedFromFallback: boolean
  /** 缓存是否已落后于配置（进入页面后应先重算再展示当前版本）。 */
  pendingRecompute: boolean
  pendingReason: PivotRecomputeReason | null
  failure: PivotRecomputeFailure | null
  /** 透视图表所用的透视配置来源记录，图表页面需要显示。 */
  sourceRecord: {
    pivotId: string
    pivotVersion: number
    sourceId: string
    sourceName: string
    sourceRevision: number
    measure: string
    aggregation: PivotAggregation
    nullDisplay: PivotNullDisplay
    fingerprint: string
  } | null
}
