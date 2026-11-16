/**
 * 透视聚合的协调层：判断缓存是否过期、执行重算、失败时回退到上一份完整结果。
 *
 * 判定规则（任一成立才重算，否则直接复用缓存）：
 * - 没有缓存（missing）
 * - 数据来源版本变化（source-changed）
 * - 度量字段 / 聚合函数 / 空值显示 / 行维度 / 列维度 / 汇总行开关变化（对应 reason）
 * - 配置版本号提升（配置改动时由 savePivotConfig 提升版本号）
 *
 * 失败标准的判定顺序：
 * 1. 配置校验（来源未登记、字段不属于该来源、维度相同等）→ 立即失败；
 * 2. 聚合计算过程中的非法值 → 失败；
 * 3. 核验项（明细↔汇总行/列/总计、空值口径一致、无重复累加）任一不通过 → 失败。
 * 失败时绝不覆盖缓存，图表继续读上一份完整数据集；成功后才写缓存并清空失败记录。
 *
 * 并发保护：同一 pivotId 的重算串行执行（inflight 复用一个 Promise），
 * 避免「两个入口同时生成不同结果」；每个 pivotId 独立，未受影响的图表不用等待。
 */

import {
  AGGREGATION_LABELS,
  NULL_DISPLAY_LABELS,
  computePivotDataset,
  fingerprintOf,
  validatePivotDefinition,
} from '@/data/pivot-engine'
import { CHART_PIVOT_BINDINGS, pivotIdForChart } from '@/data/pivot-bindings'
import {
  appendBatch,
  cachedDataset,
  loadBatches,
  findDefinition,
  loadCache,
  loadDefinitions,
  mirrorDefinitionsToModule,
  readCache,
  resetBatches,
  resetDefinitions,
  saveDefinition,
  sourceOfId,
  sourceRevisionOf,
  sourceRowsOf,
  writeCache,
} from '@/data/pivot-store'
import { listRows, saveRows } from '@/data/local-store'
import type { SourceRow } from '@/data/pivot-sources'
import type {
  ChartAggregatePayload,
  PivotAggregation,
  PivotCacheState,
  PivotDataset,
  PivotDefinition,
  PivotNullDisplay,
  PivotRecomputeReason,
  PivotRefreshOutcome,
} from '@/data/pivot-types'

const inflight = new Map<string, Promise<PivotRefreshOutcome>>()
const SEEDED_KEY = 'data-explore-selfservice:pivot-seeded'

// 故障演练开关：只影响本机浏览器，用来验证「重算失败后上一份结果仍可读」。
const FAULT_KEY = 'data-explore-selfservice:pivot-faults'

function readFaults(): Record<string, string> {
  if (typeof window === 'undefined' || !window.localStorage) {
    return {}
  }
  try {
    return JSON.parse(window.localStorage.getItem(FAULT_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function simulatedFault(pivotId: string): string | null {
  return readFaults()[pivotId] ?? null
}

export function setSimulatedFault(pivotId: string, message: string | null): void {
  const faults = readFaults()
  if (message) {
    faults[pivotId] = message
  } else {
    delete faults[pivotId]
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(FAULT_KEY, JSON.stringify(faults))
  }
}

export function simulatedFaultOf(pivotId: string): string | null {
  return simulatedFault(pivotId)
}

function now(): string {
  return new Date().toISOString()
}

function ensureSeeded(): void {
  // 只迁移一次：把上次会话遗留的 pivotable 清单（没有「数据来源标识」字段）补齐，
  // 之后状态流转与清单同步都以 pivot-definitions 为准。
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  if (window.localStorage.getItem(SEEDED_KEY)) {
    return
  }
  const rows = listRows('pivotable')
  const stale = rows.length > 0 && rows.some((row) => row['数据来源标识'] === undefined)
  if (stale || rows.length === 0) {
    mirrorDefinitionsToModule()
  }
  void loadBatches()
  window.localStorage.setItem(SEEDED_KEY, '1')
}

function failure(
  pivotId: string,
  reason: PivotRecomputeReason,
  detailedReason: string,
  servedVersion: number | null,
): PivotRefreshOutcome {
  return {
    pivotId,
    ok: false,
    recomputed: false,
    reason,
    detailedReason,
    version: servedVersion,
    failure: { ok: false, reason, detailedReason, failedAt: now(), servedVersion },
    previousVersion: servedVersion,
    dataset: cachedDataset(pivotId),
  }
}

/** 只判断缓存是否需要重算，不执行计算；返回 reason 为 null 表示可复用。 */
export function inspectPivot(pivotId: string): {
  definition: PivotDefinition | null
  reason: PivotRecomputeReason | null
  detailedReason: string
  cached: PivotDataset | null
  state: PivotCacheState | null
} {
  const definition = findDefinition(pivotId) ?? null
  const state = readCache(pivotId)
  const cached = state?.dataset ?? null
  if (!definition) {
    return { definition, reason: 'missing', detailedReason: `透视配置 ${pivotId} 不存在`, cached, state }
  }
  if (!cached) {
    return {
      definition,
      reason: 'missing',
      detailedReason: `透视配置 ${pivotId} 还没有可用聚合结果`,
      cached,
      state,
    }
  }
  const revision = sourceRevisionOf(definition.source)
  if (cached.sourceRevision !== revision) {
    return {
      definition,
      reason: 'source-changed',
      detailedReason: `数据来源 ${definition.source} 从 r${cached.sourceRevision} 变为 r${revision}`,
      cached,
      state,
    }
  }
  if (cached.measure !== definition.measure) {
    return {
      definition,
      reason: 'measure-changed',
      detailedReason: `值度量字段从「${cached.measure}」变为「${definition.measure}」`,
      cached,
      state,
    }
  }
  if (cached.aggregation !== definition.aggregation) {
    return {
      definition,
      reason: 'aggregation-changed',
      detailedReason: `聚合函数从「${cached.aggregationLabel}」变为「${AGGREGATION_LABELS[definition.aggregation]}」`,
      cached,
      state,
    }
  }
  if (cached.nullDisplay !== definition.nullDisplay) {
    return {
      definition,
      reason: 'null-display-changed',
      detailedReason: `空值显示从「${cached.nullDisplayLabel}」变为「${NULL_DISPLAY_LABELS[definition.nullDisplay]}」`,
      cached,
      state,
    }
  }
  if (cached.rowDimension !== definition.rowDimension || cached.columnDimension !== definition.columnDimension) {
    return {
      definition,
      reason: 'dimension-changed',
      detailedReason: `行列维度从「${cached.rowDimension}×${cached.columnDimension}」变为「${definition.rowDimension}×${definition.columnDimension}」`,
      cached,
      state,
    }
  }
  if (cached.totalRow !== definition.totalRow) {
    return {
      definition,
      reason: 'total-row-changed',
      detailedReason: `汇总行开启从「${cached.totalRow ? '是' : '否'}」变为「${definition.totalRow ? '是' : '否'}」`,
      cached,
      state,
    }
  }
  if (state?.failure) {
    return {
      definition,
      reason: 'manual',
      detailedReason: `上次重算失败（${state.failure.detailedReason}），本次读取重试`,
      cached,
      state,
    }
  }
  const expected = fingerprintOf(definition, revision)
  if (state?.fingerprint && state.fingerprint !== expected) {
    return {
      definition,
      reason: 'manual',
      detailedReason: `配置 v${definition.version} 的输入指纹与缓存不一致`,
      cached,
      state,
    }
  }
  return { definition, reason: null, detailedReason: '', cached, state }
}

function performRefresh(pivotId: string, force: boolean): PivotRefreshOutcome {
  const inspected = inspectPivot(pivotId)
  const { definition, cached, state } = inspected
  if (!definition) {
    return failure(pivotId, 'missing', inspected.detailedReason, null)
  }
  const previousVersion = cached?.version ?? null

  if (!force && inspected.reason === null && cached) {
    return {
      pivotId,
      ok: true,
      recomputed: false,
      reason: 'manual',
      detailedReason: `配置 v${definition.version} 的聚合结果仍有效，直接复用`,
      version: cached.version,
      failure: null,
      previousVersion,
      dataset: cached,
    }
  }

  const reason: PivotRecomputeReason = force ? 'manual' : inspected.reason ?? 'manual'
  const detailedReason = force ? `手动触发重算（配置 v${definition.version}）` : inspected.detailedReason

  const source = sourceOfId(definition.source)
  const problems = validatePivotDefinition(definition, source)
  if (problems.length > 0) {
    const outcome = failure(pivotId, reason, problems.join('；'), previousVersion)
    writeCache({
      pivotId,
      dataset: cached,
      cachedAt: state?.cachedAt ?? null,
      fingerprint: state?.fingerprint ?? null,
      failure: outcome.failure,
      lastReason: reason,
    })
    return outcome
  }
  if (!source) {
    return failure(pivotId, reason, `数据来源「${definition.source}」未登记`, previousVersion)
  }

  const fault = simulatedFault(pivotId)
  if (fault) {
    const outcome = failure(pivotId, reason, `来源读取失败（演练）：${fault}`, previousVersion)
    writeCache({
      pivotId,
      dataset: cached,
      cachedAt: state?.cachedAt ?? null,
      fingerprint: state?.fingerprint ?? null,
      failure: outcome.failure,
      lastReason: reason,
    })
    return outcome
  }

  const rows = sourceRowsOf(definition.source)
  let dataset: PivotDataset
  try {
    dataset = computePivotDataset(definition, source, rows, sourceRevisionOf(definition.source))
  } catch (error) {
    const outcome = failure(
      pivotId,
      reason,
      error instanceof Error ? error.message : '聚合计算失败',
      previousVersion,
    )
    writeCache({
      pivotId,
      dataset: cached,
      cachedAt: state?.cachedAt ?? null,
      fingerprint: state?.fingerprint ?? null,
      failure: outcome.failure,
      lastReason: reason,
    })
    return outcome
  }

  if (!dataset.verificationPassed) {
    const failedChecks = dataset.verification.filter((check) => !check.passed)
    const failed = failedChecks.map((check) => `${check.label}（${check.scope}，${check.tolerance}）`).join('；')
    const outcome = failure(pivotId, reason, `核验未通过：${failed}`, previousVersion)
    writeCache({
      pivotId,
      dataset: cached,
      cachedAt: state?.cachedAt ?? null,
      fingerprint: state?.fingerprint ?? null,
      failure: outcome.failure,
      lastReason: reason,
    })
    return outcome
  }

  const next: PivotCacheState = {
    pivotId,
    dataset,
    cachedAt: now(),
    fingerprint: dataset.fingerprint,
    failure: null,
    lastReason: reason,
  }
  writeCache(next)
  return {
    pivotId,
    ok: true,
    recomputed: true,
    reason,
    detailedReason,
    version: dataset.version,
    failure: null,
    previousVersion,
    dataset,
  }
}

/** 重算单个透视配置；同 id 的并发调用复用同一个 Promise。 */
export function refreshPivot(pivotId: string, options: { force?: boolean } = {}): Promise<PivotRefreshOutcome> {
  ensureSeeded()
  const running = inflight.get(pivotId)
  if (running) {
    return running
  }
  const task = new Promise<PivotRefreshOutcome>((resolve) => {
    try {
      resolve(performRefresh(pivotId, options.force ?? false))
    } catch (error) {
      resolve(
        failure(
          pivotId,
          'manual',
          error instanceof Error ? error.message : '重算时发生未知错误',
          cachedDataset(pivotId)?.version ?? null,
        ),
      )
    }
  }).finally(() => {
    inflight.delete(pivotId)
  })
  inflight.set(pivotId, task)
  return task
}

/** 批量重算：每个配置独立判断，未受影响的配置直接复用缓存。 */
export async function refreshAllPivots(options: { force?: boolean } = {}): Promise<PivotRefreshOutcome[]> {
  const definitions = loadDefinitions()
  return Promise.all(definitions.map((definition) => refreshPivot(definition.id, options)))
}

export { sourceRevisionOf, sourceBatches } from '@/data/pivot-store'
export { PIVOT_SOURCES } from '@/data/pivot-sources'

/** 当前缓存状态快照：不触发重算，供页面渲染「当前版本 / 上一份结果 / 失败原因」。 */
export function pivotCacheSnapshot(pivotId: string): PivotCacheState | null {
  ensureSeeded()
  return readCache(pivotId)
}

export function pivotDefinitions(): PivotDefinition[] {
  ensureSeeded()
  return loadDefinitions()
}

export function pivotCacheStates(): Record<string, PivotCacheState> {
  return loadCache()
}

export type PivotConfigPatch = {
  source?: string
  rowDimension?: string
  columnDimension?: string
  measure?: string
  aggregation?: PivotAggregation
  totalRow?: boolean
  nullDisplay?: PivotNullDisplay
  versionNote?: string
  status?: string
}

/**
 * 保存透视配置：只把真正改动的字段写回，并提升配置版本号。
 * 版本号提升后，引用该配置的图表下一次读取时会发现指纹不一致并重算；
 * 其他配置的缓存不受影响。
 */
export function savePivotConfig(pivotId: string, patch: PivotConfigPatch): PivotDefinition {
  const current = findDefinition(pivotId)
  if (!current) {
    throw new Error(`透视配置 ${pivotId} 不存在`)
  }
  const next: PivotDefinition = { ...current }
  const changed: string[] = []
  if (patch.source !== undefined && patch.source !== current.source) {
    next.source = patch.source
    changed.push(`数据来源 → ${sourceOfId(patch.source)?.name ?? patch.source}`)
  }
  if (patch.rowDimension !== undefined && patch.rowDimension !== current.rowDimension) {
    next.rowDimension = patch.rowDimension
    changed.push(`行维度 → ${patch.rowDimension}`)
  }
  if (patch.columnDimension !== undefined && patch.columnDimension !== current.columnDimension) {
    next.columnDimension = patch.columnDimension
    changed.push(`列维度 → ${patch.columnDimension}`)
  }
  if (patch.measure !== undefined && patch.measure !== current.measure) {
    next.measure = patch.measure
    changed.push(`度量字段 → ${patch.measure}`)
  }
  if (patch.aggregation !== undefined && patch.aggregation !== current.aggregation) {
    next.aggregation = patch.aggregation
    changed.push(`聚合函数 → ${AGGREGATION_LABELS[patch.aggregation]}`)
  }
  if (patch.totalRow !== undefined && patch.totalRow !== current.totalRow) {
    next.totalRow = patch.totalRow
    changed.push(`汇总行 → ${patch.totalRow ? '开启' : '关闭'}`)
  }
  if (patch.nullDisplay !== undefined && patch.nullDisplay !== current.nullDisplay) {
    next.nullDisplay = patch.nullDisplay
    changed.push(`空值显示 → ${NULL_DISPLAY_LABELS[patch.nullDisplay]}`)
  }
  if (patch.status !== undefined && patch.status !== current.status) {
    next.status = patch.status
  }
  if (changed.length === 0 && patch.versionNote === undefined) {
    return current
  }
  next.version = current.version + 1
  next.versionNote = patch.versionNote ?? changed.join('；')
  saveDefinition(next)
  mirrorDefinitionsToModule(listRows('pivotable'))
  return next
}

/** 只同步状态，不提升版本号：模块清单里的状态流转不应触发聚合重算。 */
export function syncDefinitionStatus(pivotId: string, status: string): void {
  const current = findDefinition(pivotId)
  if (!current || current.status === status) {
    return
  }
  saveDefinition({ ...current, status })
  mirrorDefinitionsToModule(listRows('pivotable'))
}

/** 发布数据来源的新批次：来源版本 +1，所有引用该来源的透视配置下次读取时重算。 */
export function publishSourceBatch(sourceId: string): { revision: number; appended: SourceRow } {
  const source = sourceOfId(sourceId)
  if (!source) {
    throw new Error(`数据来源 ${sourceId} 未登记`)
  }
  const appended: SourceRow = { ...source.revisionRow, 批次: `BATCH-${sourceRevisionOf(sourceId) + 1}` }
  const batches = appendBatch(sourceId, appended)
  return { revision: source.revision + batches, appended }
}

/** 恢复演示数据：清空追加批次和聚合缓存，配置回到初始版本。 */
export function resetPivotWorkspace(): void {
  resetDefinitions()
  resetBatches()
  const cache = loadCache()
  for (const pivotId of Object.keys(cache)) {
    writeCache({
      pivotId,
      dataset: null,
      cachedAt: null,
      fingerprint: null,
      failure: null,
      lastReason: null,
    })
  }
  mirrorDefinitionsToModule(listRows('pivotable'))
}

/**
 * 图表投射前的对账：确认图表绑定、透视配置与聚合数据集三者一致。
 * 图表页只展示对账通过的聚合结果，避免图表标着 A 配置却渲染 B 数据集。
 */
export function chartProjectionIssues(chartNo: string): string[] {
  const binding = CHART_PIVOT_BINDINGS.find((item) => item.chartNo === chartNo)
  if (!binding) {
    return [`图表 ${chartNo} 没有登记透视绑定`]
  }
  if (!binding.pivotId) {
    return []
  }
  const definition = findDefinition(binding.pivotId)
  if (!definition) {
    return [`图表绑定的透视配置 ${binding.pivotId} 不存在`]
  }
  const dataset = cachedDataset(binding.pivotId)
  if (!dataset) {
    return []
  }
  const issues: string[] = []
  if (dataset.pivotId !== definition.id) {
    issues.push(`聚合数据集来自 ${dataset.pivotId}，与绑定 ${definition.id} 不一致`)
  }
  if (dataset.measure !== definition.measure) {
    issues.push(`聚合度量 ${dataset.measure} 与当前配置 ${definition.measure} 不一致`)
  }
  if (dataset.aggregation !== definition.aggregation) {
    issues.push(`聚合函数 ${dataset.aggregation} 与当前配置 ${definition.aggregation} 不一致`)
  }
  if (dataset.nullDisplay !== definition.nullDisplay) {
    issues.push(`空值口径 ${dataset.nullDisplay} 与当前配置 ${definition.nullDisplay} 不一致`)
  }
  return issues
}

/** 图表投射所需的聚合数据集版本引用，写进图表页面「来源记录」一栏。 */
export function chartSourceRecord(chartNo: string): string {
  const payload = loadChartAggregate(chartNo)
  if (!payload?.sourceRecord) {
    return ''
  }
  const record = payload.sourceRecord
  return `${record.pivotId} v${record.pivotVersion} · ${record.sourceName} r${record.sourceRevision} · ${record.measure} · ${record.aggregation} · ${record.nullDisplay} · ${record.fingerprint.slice(0, 48)}`
}

/** 图表构建读取聚合结果：当前版本可用就用当前版本，重算失败则回退上一份完整结果。 */
export function loadChartAggregate(chartNo: string): ChartAggregatePayload | null {
  ensureSeeded()
  const binding = CHART_PIVOT_BINDINGS.find((item) => item.chartNo === chartNo)
  if (!binding) {
    return null
  }
  const pivotId = binding.pivotId
  if (!pivotId) {
    return {
      chartNo: binding.chartNo,
      chartName: binding.chartName,
      pivotId: '',
      pivotName: '',
      dataset: null,
      servedVersion: null,
      servedFromFallback: false,
      pendingRecompute: false,
      pendingReason: null,
      failure: null,
      sourceRecord: null,
    }
  }
  const definition = findDefinition(pivotId) ?? null
  const state = readCache(pivotId)
  const dataset = state?.dataset ?? null
  const failureRecord = state?.failure ?? null
  const inspected = inspectPivot(pivotId)
  return {
    chartNo: binding.chartNo,
    chartName: binding.chartName,
    pivotId,
    pivotName: definition?.name ?? pivotId,
    dataset,
    servedVersion: dataset?.version ?? null,
    servedFromFallback: Boolean(failureRecord && dataset),
    pendingRecompute: inspected.reason !== null,
    pendingReason: inspected.reason,
    failure: failureRecord,
    sourceRecord: dataset
      ? {
          pivotId,
          pivotVersion: dataset.version,
          sourceId: dataset.sourceId,
          sourceName: dataset.sourceName,
          sourceRevision: dataset.sourceRevision,
          measure: dataset.measure,
          aggregation: dataset.aggregation,
          nullDisplay: dataset.nullDisplay,
          fingerprint: dataset.fingerprint,
        }
      : null,
  }
}

/** 图表对应的透视配置编号，页面里用来跳回透视工作台。 */
export function pivotOfChart(chartNo: string): string {
  return pivotIdForChart(chartNo)
}

/** 看板包含的图表编号列表。 */
export function chartsOfDashboard(dashboardNo: string): string[] {
  const row = listRows('dashboardboard').find((item) => String(item['布局编号']) === dashboardNo)
  const groups = String(row?.['包含图表组'] ?? '')
  return groups
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export function saveChartBinding(chartNo: string, patch: Record<string, string>): void {
  const rows = listRows('chartbuilder')
  const index = rows.findIndex((row) => String(row['配置编号']) === chartNo)
  if (index < 0) {
    return
  }
  const next = [...rows]
  next[index] = { ...rows[index], ...patch }
  saveRows('chartbuilder', next)
}

/** 清空某个透视的聚合缓存，用来演示「重算失败后的恢复」与「中断后补齐缺失聚合」。 */
export function dropPivotCache(pivotId: string): void {
  const state = readCache(pivotId)
  writeCache({
    pivotId,
    dataset: null,
    cachedAt: null,
    fingerprint: null,
    failure: state?.failure ?? null,
    lastReason: state?.lastReason ?? null,
  })
}

/** 只补齐缺失/过期的聚合结果，已有完整结果的配置保持不动。 */
export async function refreshMissingPivots(): Promise<PivotRefreshOutcome[]> {
  const outcomes: PivotRefreshOutcome[] = []
  for (const definition of loadDefinitions()) {
    const inspected = inspectPivot(definition.id)
    if (inspected.reason === null) {
      continue
    }
    outcomes.push(await refreshPivot(definition.id))
  }
  return outcomes
}
