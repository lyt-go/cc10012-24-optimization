/**
 * 透视配置、数据来源版本与聚合缓存的本地持久化。
 *
 * 三个 key 分开存放，是因为它们的失效条件不同：
 * - pivot-definitions：透视配置（含版本号）。改配置只让引用它的图表失效，不碰别的配置。
 * - pivot-cache：聚合透视数据集。只有来源版本 / 度量 / 聚合函数 / 空值口径 / 维度变化才需要重算。
 * - pivot-source-batches：数据来源的追加批次，用于演示「来源变化」触发重算。
 */

import { PIVOT_DEFINITIONS } from '@/data/pivot-definitions'
import { PIVOT_SOURCES } from '@/data/pivot-sources'
import type { PivotSourceDefinition, SourceRow } from '@/data/pivot-sources'
import type { PivotCacheState, PivotDataset, PivotDefinition } from '@/data/pivot-types'
import { saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

const DEFINITION_KEY = 'data-explore-selfservice:pivot-definitions'
const CACHE_KEY = 'data-explore-selfservice:pivot-cache'
const BATCH_KEY = 'data-explore-selfservice:pivot-source-batches'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined' || !window.localStorage) {
    return clone(fallback)
  }
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return clone(fallback)
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    return clone(fallback)
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
}

let definitionCache: PivotDefinition[] | null = null
let cacheState: Record<string, PivotCacheState> | null = null
let batchState: Record<string, SourceRow[]> | null = null

export function seedDefinition(): PivotDefinition[] {
  return clone(PIVOT_DEFINITIONS)
}

export function loadDefinitions(): PivotDefinition[] {
  if (definitionCache === null) {
    const stored = readJson<PivotDefinition[]>(DEFINITION_KEY, [])
    const known = new Set(stored.map((item) => item.id))
    // 新增的示例配置在旧浏览器里也要补齐，已有配置以本地版本为准。
    definitionCache = [...stored, ...seedDefinition().filter((item) => !known.has(item.id))]
  }
  return definitionCache
}

export function findDefinition(pivotId: string): PivotDefinition | undefined {
  return loadDefinitions().find((item) => item.id === pivotId)
}

export function saveDefinition(updated: PivotDefinition): PivotDefinition[] {
  const next = loadDefinitions().map((item) => (item.id === updated.id ? clone(updated) : item))
  definitionCache = next
  writeJson(DEFINITION_KEY, next)
  return next
}

export function resetDefinitions(): PivotDefinition[] {
  definitionCache = seedDefinition()
  writeJson(DEFINITION_KEY, definitionCache)
  return definitionCache
}

export function loadCache(): Record<string, PivotCacheState> {
  if (cacheState === null) {
    cacheState = readJson<Record<string, PivotCacheState>>(CACHE_KEY, {})
  }
  return cacheState
}

export function readCache(pivotId: string): PivotCacheState | null {
  return loadCache()[pivotId] ?? null
}

export function writeCache(state: PivotCacheState): void {
  const next = { ...loadCache(), [state.pivotId]: clone(state) }
  cacheState = next
  writeJson(CACHE_KEY, next)
}

export function clearCache(pivotId?: string): void {
  if (pivotId) {
    const next = { ...loadCache() }
    delete next[pivotId]
    cacheState = next
  } else {
    cacheState = {}
  }
  writeJson(CACHE_KEY, cacheState)
}

export function cachedDataset(pivotId: string): PivotDataset | null {
  return readCache(pivotId)?.dataset ?? null
}

export function loadBatches(): Record<string, SourceRow[]> {
  if (batchState === null) {
    batchState = readJson<Record<string, SourceRow[]>>(BATCH_KEY, {})
  }
  return batchState
}

export function appendBatch(sourceId: string, row: SourceRow): number {
  const batches = { ...loadBatches() }
  batches[sourceId] = [...(batches[sourceId] ?? []), clone(row)]
  batchState = batches
  writeJson(BATCH_KEY, batches)
  return batches[sourceId].length
}

export function resetBatches(): void {
  batchState = {}
  writeJson(BATCH_KEY, batchState)
}

export function sourceBatches(sourceId: string): SourceRow[] {
  return loadBatches()[sourceId] ?? []
}

/** 来源的当前版本 = 内置版本 + 追加批次数。 */
export function sourceRevisionOf(sourceId: string): number {
  const base = PIVOT_SOURCES.find((source) => source.id === sourceId)?.revision ?? 0
  return base + (loadBatches()[sourceId]?.length ?? 0)
}

export function sourceRowsOf(sourceId: string): SourceRow[] {
  const base = PIVOT_SOURCES.find((source) => source.id === sourceId)
  if (!base) {
    return []
  }
  return [...base.rows, ...(loadBatches()[sourceId] ?? [])].map((row) => clone(row))
}

export function sourceOfId(sourceId: string): PivotSourceDefinition | undefined {
  return PIVOT_SOURCES.find((source) => source.id === sourceId)
}

/**
 * 把透视配置镜像回 pivotable 模块清单，运营概览和导出看到的字段与配置工作台一致。
 * 状态、待办标记沿用模块清单里的记录，避免两处各算一套。
 */
export function mirrorDefinitionsToModule(previous: EntryRow[] = []): void {
  const definitions = loadDefinitions()
  const rows: EntryRow[] = definitions.map((definition, index) => {
    const existing = previous.find((row) => String(row['配置编号']) === definition.id)
    return {
      id: existing?.id ?? index + 1,
      status: definition.status,
      pending: existing?.pending ?? (definition.status === '草稿' || definition.status === '配置评审中'),
      abnormal: existing?.abnormal ?? definition.status === '已删除',
      配置编号: definition.id,
      数据来源: `${sourceOfId(definition.source)?.name ?? definition.source}（${definition.source}）`,
      数据来源标识: definition.source,
      行维度字段: definition.rowDimension,
      列维度字段: definition.columnDimension,
      值度量字段: definition.measure,
      聚合函数:
        { sum: '求和 SUM', avg: '平均值 AVG', max: '最大值 MAX', min: '最小值 MIN', count: '计数 COUNT' }[
          definition.aggregation
        ],
      汇总行开启: definition.totalRow ? '是' : '否',
      空值显示: { zero: '按零显示', blank: '保留为空' }[definition.nullDisplay],
      配置版本: `v${definition.version}`,
      版本说明: definition.versionNote,
    }
  })
  saveRows('pivotable', rows)
}
