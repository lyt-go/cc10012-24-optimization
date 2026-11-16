<template>
  <section class="page" data-module="dashboardboard">
    <header class="page-head">
      <div>
        <h2>自助看板管理</h2>
        <p class="page-desc">
          看板里的图表与透视聚合数据集联动：只核验看板引用到的透视，未受影响的图表不等待。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn" to="/pivotable/workbench">透视聚合工作台</RouterLink>
        <button class="btn primary" type="button" @click="refreshVisible">核验看板图表</button>
        <button class="btn" type="button" @click="exportRows">导出自助看板清单</button>
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
          <th>图表聚合投射</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td class="projection-cell">
            <div v-for="item in projectionsFor(row)" :key="item.chartNo" class="projection-item">
              <span class="chart-no">{{ item.chartNo }}</span>
              <span v-if="item.dataset">
                v{{ item.servedVersion }} · {{ item.dataset.aggregationLabel }} · {{ item.dataset.nullDisplayLabel }} ·
                总计 {{ formatTotal(item) }}
              </span>
              <span v-else class="error-text">无可读聚合结果</span>
              <span v-if="item.servedFromFallback" class="warn-text">（重算失败，展示上一份完整结果）</span>
            </div>
            <span v-if="!projectionsFor(row).length" class="muted">该看板未包含可解析图表</span>
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
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无自助看板数据，可先登记看板布局</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条自助看板记录</span>
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
import { chartsOfDashboard, loadChartAggregate, refreshPivot } from '@/api/pivot-service'
import { formatCellValue } from '@/data/pivot-engine'
import type { ChartAggregatePayload } from '@/data/pivot-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('dashboardboard')
const columns = ["布局编号", "看板名称", "包含图表组", "布局列数", "自动刷新秒", "全屏模式", "分享链接", "背景主题"]
const actions = ["提交构建", "发布看板", "下线看板"]
const statuses = ["草稿", "看板构建中", "已发布", "已下线"]
const stats = [{"label": "看板布局总数", "value": 0}, {"label": "已发布看板", "value": 0}, {"label": "构建中看板", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const summaryMessage = ref('')
const payloads = ref<Record<string, ChartAggregatePayload>>({})

const statsView = computed(() => {
  const counts: Record<string, number> = { 已发布: 0, 看板构建中: 0 }
  for (const row of rows.value) {
    counts[String(row.status)] = (counts[String(row.status)] ?? 0) + 1
  }
  return stats.map((item) => {
    if (item.label === '看板布局总数') return { ...item, value: total.value }
    if (item.label === '已发布看板') return { ...item, value: counts['已发布'] ?? 0 }
    return { ...item, value: counts['看板构建中'] ?? 0 }
  })
})

function projectionsFor(row: EntryRow): ChartAggregatePayload[] {
  return chartsOfDashboard(String(row['布局编号']))
    .map((chartNo) => payloads.value[chartNo])
    .filter((item): item is ChartAggregatePayload => Boolean(item))
}

function formatTotal(payload: ChartAggregatePayload): string {
  if (!payload.dataset) return '—'
  return formatCellValue(payload.dataset.grandTotal.displayValue, payload.dataset.measureUnit)
}

function loadPayloads(): void {
  const next: Record<string, ChartAggregatePayload> = {}
  for (const row of rows.value) {
    for (const chartNo of chartsOfDashboard(String(row['布局编号']))) {
      const payload = loadChartAggregate(chartNo)
      if (payload) next[chartNo] = payload
    }
  }
  payloads.value = next
}

async function refreshVisible(): Promise<void> {
  errorMessage.value = ''
  summaryMessage.value = ''
  const pivotIds = new Set<string>()
  for (const payload of Object.values(payloads.value)) {
    if (payload.pivotId) pivotIds.add(payload.pivotId)
  }
  let failed = 0
  for (const pivotId of pivotIds) {
    const outcome = await refreshPivot(pivotId)
    if (!outcome.ok) failed += 1
  }
  loadPayloads()
  summaryMessage.value = failed
    ? `有 ${failed} 份透视重算失败，相关图表继续展示上一份完整聚合。`
    : `已核验当前看板引用的 ${pivotIds.size} 份透视配置，其余未引用图表没有触发重算。`
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
    errorMessage.value = error instanceof Error ? error.message : '自助看板列表读取失败'
  }
}

onMounted(() => {
  reload()
})
</script>

<style scoped>
.notice { background: #eef4ff; border: 1px solid #c7d7fe; border-radius: 6px; padding: 8px 10px; font-size: 13px; }
.projection-cell { font-size: 12px; min-width: 260px; }
.projection-item { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 0; }
.chart-no { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
.muted { color: var(--muted); }
</style>
