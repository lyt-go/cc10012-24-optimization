<template>
  <section class="page" data-module="chartbuilder">
    <header class="page-head">
      <div>
        <h2>图表构建管理</h2>
        <p class="page-desc">
          图表不自行聚合：构建入口读取透视工作台产出的同一份聚合透视数据集，并保留透视配置的来源记录。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/pivotable/workbench">透视聚合工作台</RouterLink>
        <button class="btn primary" type="button" @click="refreshAggregates">核验图表聚合结果</button>
        <button class="btn" type="button" @click="exportRows">导出图表构建清单</button>
      </div>
    </header>

    <p v-if="summaryMessage" class="notice">{{ summaryMessage }}</p>

    <div class="stat-row">
      <article v-for="item in statsView" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>聚合结果</th>
          <th>版本 / 来源</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td class="aggregate-cell">
            <template v-if="payloadFor(row)?.dataset">
              <span class="agg-line">
                {{ payloadFor(row)?.dataset?.rowKeys.length }} × {{ payloadFor(row)?.dataset?.columnKeys.length }} 格 ·
                {{ payloadFor(row)?.dataset?.aggregationLabel }} ·
                {{ payloadFor(row)?.dataset?.nullDisplayLabel }}
              </span>
              <span class="agg-line muted">
                总计 {{ formatTotal(payloadFor(row)!) }}（空值 {{ nullCountFor(row) }} 个）
              </span>
            </template>
            <span v-else class="error-text">无可读聚合结果</span>
          </td>
          <td class="source-cell">
            <span v-if="payloadFor(row)?.sourceRecord">
              v{{ payloadFor(row)?.servedVersion }} · {{ payloadFor(row)?.sourceRecord?.sourceName }} r{{ payloadFor(row)?.sourceRecord?.sourceRevision }}
            </span>
            <span v-else>—</span>
            <span v-if="issuesFor(row).length" class="error-text block">
              对账未通过：{{ issuesFor(row).join('；') }}
            </span>
            <span v-if="payloadFor(row)?.servedFromFallback" class="warn-text block">
              重算失败，展示上一份完整结果
            </span>
            <span v-else-if="payloadFor(row)?.pendingRecompute" class="warn-text block">
              配置已变更，等待重算（当前仍是上一版）
            </span>
            <span v-else-if="payloadFor(row)?.dataset" class="ok-text block">当前版本</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <RouterLink
              v-if="payloadFor(row)?.pivotId"
              class="link"
              :to="{ path: '/pivotable/workbench', query: { pivot: payloadFor(row)?.pivotId } }"
            >
              查看透视来源
            </RouterLink>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无图表构建数据，可先登记图表配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条图表构建记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { chartProjectionIssues, loadChartAggregate, refreshPivot } from '@/api/pivot-service'
import { formatCellValue } from '@/data/pivot-engine'
import type { ChartAggregatePayload } from '@/data/pivot-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('chartbuilder')
const columns = ["配置编号", "图表名称", "图表类型", "数据查询绑定", "X轴字段", "Y轴字段", "分组字段", "配色方案"]
const actions = ["提交构建", "发布图表", "下线图表"]
const statuses = ["草稿", "构建中", "已发布", "已下线"]
const stats = [{"label": "图表配置总数", "value": 0}, {"label": "已发布图表", "value": 0}, {"label": "构建中图表", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const summaryMessage = ref('')
const payloads = ref<Record<string, ChartAggregatePayload>>({})

const statsView = computed(() => {
  const counts: Record<string, number> = { 已发布: 0, 构建中: 0 }
  for (const row of rows.value) {
    counts[String(row.status)] = (counts[String(row.status)] ?? 0) + 1
  }
  return stats.map((item) => {
    if (item.label === '图表配置总数') return { ...item, value: total.value }
    if (item.label === '已发布图表') return { ...item, value: counts['已发布'] ?? 0 }
    return { ...item, value: counts['构建中'] ?? 0 }
  })
})

function payloadFor(row: EntryRow): ChartAggregatePayload | null {
  return payloads.value[String(row['配置编号'])] ?? null
}

function formatTotal(payload: ChartAggregatePayload): string {
  if (!payload.dataset) return '—'
  return formatCellValue(payload.dataset.grandTotal.displayValue, payload.dataset.measureUnit)
}

function nullCountFor(row: EntryRow): number {
  const payload = payloadFor(row)
  if (!payload?.dataset) return 0
  return payload.dataset.cells.reduce((sum, cell) => sum + cell.nullCount, 0)
}

function issuesFor(row: EntryRow): string[] {
  return chartProjectionIssues(String(row['配置编号']))
}

function loadPayloads(): void {
  const next: Record<string, ChartAggregatePayload> = {}
  for (const row of rows.value) {
    const payload = loadChartAggregate(String(row['配置编号']))
    if (payload) next[payload.chartNo] = payload
  }
  payloads.value = next
}

async function refreshAggregates(): Promise<void> {
  errorMessage.value = ''
  summaryMessage.value = ''
  const pivotIds = new Set<string>()
  for (const row of rows.value) {
    const payload = loadChartAggregate(String(row['配置编号']))
    if (payload?.pivotId) pivotIds.add(payload.pivotId)
  }
  let recomputed = 0
  let failed = 0
  for (const pivotId of pivotIds) {
    const outcome = await refreshPivot(pivotId)
    if (outcome.recomputed) recomputed += 1
    if (!outcome.ok) failed += 1
  }
  loadPayloads()
  summaryMessage.value = failed
    ? `有 ${failed} 份透视重算失败，相关图表继续展示上一份完整聚合；其余 ${recomputed} 份已更新。`
    : `已核验 ${pivotIds.size} 份透视配置，其中 ${recomputed} 份完成重算，其余直接复用有效缓存。`
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, {})
    rows.value = payload.items
    total.value = payload.total
    loadPayloads()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '图表构建列表读取失败'
  }
}

onMounted(async () => {
  reload()
  // 进入页面先核验一次：受影响的透视会重算，未受影响的不必等待。
  await refreshAggregates()
})
</script>

<style scoped>
.stats-row { display: flex; }
.notice { background: #eef4ff; border: 1px solid #c7d7fe; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.aggregate-cell { min-width: 220px; }
.agg-line { display: block; font-size: 12px; }
.muted { color: var(--muted); }
.block { display: block; font-size: 12px; }
.source-cell { font-size: 12px; }
.row-actions { flex-wrap: wrap; }
</style>
