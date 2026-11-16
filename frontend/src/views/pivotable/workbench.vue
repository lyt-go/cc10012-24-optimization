<template>
  <section class="page workbench" data-module="pivot-workbench">
    <header class="page-head">
      <div>
        <h2>透视聚合工作台</h2>
        <p class="page-desc">
          从透视配置读取值度量字段、聚合函数与空值显示，按来源明细重算汇总；图表构建只投射这一份聚合透视数据集。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refreshVisible(false)">核验并重算受影响配置</button>
        <button class="btn" type="button" @click="refreshMissing">只补齐缺失结果</button>
        <button class="btn ghost" type="button" @click="resetWorkspace">恢复演示数据</button>
      </div>
    </header>

    <section class="agreement">
      <strong>空值口径最终依据：</strong>
      <span>
        每份透视配置各自决定「按零计入」或「保留为空」，明细、汇总行、汇总列与图例强制使用同一个选择；
        若某配置选择「保留为空」，无有效值的单元格显示空而不是 0。最终依据写在下方「口径说明」里，可逐项复核。
      </span>
    </section>

    <div class="workbench-layout">
      <aside class="pivot-list">
        <h3>透视配置（{{ definitions.length }}）</h3>
        <button
          v-for="item in definitions"
          :key="item.id"
          type="button"
          class="pivot-pick"
          :class="{ active: item.id === selectedId }"
          @click="select(item.id)"
        >
          <span class="pick-id">{{ item.id }}</span>
          <span class="pick-name">{{ item.name }}</span>
          <span class="pick-meta">
            v{{ item.version }} · {{ aggregationLabel(item.aggregation) }} · {{ nullLabel(item.nullDisplay) }}
          </span>
          <span class="pick-state" :class="stateClass(item.id)">{{ stateLabel(item.id) }}</span>
        </button>
      </aside>

      <div v-if="definition" class="pivot-detail">
        <article class="panel">
          <h3>配置与来源</h3>
          <dl class="kv">
            <dt>配置编号</dt><dd>{{ definition.id }}（版本 v{{ definition.version }}）</dd>
            <dt>版本说明</dt><dd>{{ definition.versionNote }}</dd>
            <dt>数据来源</dt>
            <dd>
              {{ sourceName(definition.source) }}（{{ definition.source }}，当前 r{{ sourceRevision }}）
            </dd>
            <dt>行 × 列维度</dt><dd>{{ definition.rowDimension }} × {{ definition.columnDimension }}</dd>
            <dt>值度量字段</dt><dd>{{ definition.measure }}{{ unit ? `（${unit}）` : '' }}</dd>
            <dt>聚合函数</dt><dd>{{ aggregationLabel(definition.aggregation) }}</dd>
            <dt>汇总行开启</dt><dd>{{ definition.totalRow ? '是' : '否' }}</dd>
            <dt>空值显示</dt><dd>{{ nullLabel(definition.nullDisplay) }}</dd>
            <dt>引用图表</dt><dd>{{ chartNames || '—' }}</dd>
            <dt>缓存状态</dt>
            <dd>
              {{ cacheStateText }}
            </dd>
            <dt>缓存指纹</dt><dd class="mono">{{ cache?.fingerprint?.slice(0, 72) || '—' }}</dd>
            <dt>来源批次</dt>
            <dd>
              r{{ sourceRevision }}
              <template v-if="batchCount > 0">（追加 {{ batchCount }} 批：{{ batchLabels }}）</template>
              <template v-else>（初始批次）</template>
            </dd>
            <dt>配置来源记录</dt>
            <dd class="mono">{{ revisionRecord }}</dd>
          </dl>
          <p v-if="failure" class="error-text">
            最近一次重算失败（{{ failure.failedAt }}）：{{ failure.detailedReason }}；当前图表继续读取
            {{ failure.servedVersion ? `v${failure.servedVersion}` : '上一份完整结果' }}。
          </p>
        </article>

        <article class="panel">
          <h3>修改配置（保存即提升版本并触发重算）</h3>          <form class="config-form" @submit.prevent="applyConfig">
            <label>
              <span>值度量字段</span>
              <select v-model="form.measure">
                <option v-for="field in measureFields" :key="field" :value="field">{{ field }}</option>
              </select>
            </label>
            <label>
              <span>聚合函数</span>
              <select v-model="form.aggregation">
                <option v-for="item in aggregationOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </label>
            <label>
              <span>空值显示</span>
              <select v-model="form.nullDisplay">
                <option v-for="item in nullOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </label>
            <label>
              <span>汇总行开启</span>
              <select v-model="form.totalRow">
                <option :value="true">开启</option>
                <option :value="false">关闭</option>
              </select>
            </label>
            <label>
              <span>数据来源</span>
              <select v-model="form.source">
                <option v-for="source in sources" :key="source.id" :value="source.id">{{ source.name }}</option>
              </select>
            </label>
            <label>
              <span>行维度字段</span>
              <select v-model="form.rowDimension">
                <option v-for="field in dimensionFields" :key="field" :value="field">{{ field }}</option>
              </select>
            </label>
            <label>
              <span>列维度字段</span>
              <select v-model="form.columnDimension">
                <option v-for="field in dimensionFields" :key="field" :value="field">{{ field }}</option>
              </select>
            </label>
            <div class="form-actions">
              <button class="btn primary" type="submit">保存配置并重算</button>
              <button class="btn" type="button" @click="publishSource">发布来源新批次（r{{ sourceRevision + 1 }}）</button>
              <button class="btn ghost" type="button" @click="toggleFault">
                {{ fault ? '解除故障演练' : '模拟来源读取失败' }}
              </button>
            </div>
          </form>
          <p class="hint">
            保存只影响本配置引用的图表；其它透视配置的聚合结果不会失效，也不必等待。
          </p>
        </article>

        <article class="panel">
          <h3>重算规则（判定范围、阈值与失败原因）</h3>
          <table class="data-table rules-table">
            <thead>
              <tr><th>触发条件</th><th>判定范围</th><th>阈值 / 比较方式</th><th>不满足时的处理</th></tr>
            </thead>
            <tbody>
              <tr>
                <td>数据来源版本变化</td>
                <td>该配置引用的来源（{{ definition?.source }}）</td>
                <td>来源 r 版本号严格相等，否则重算</td>
                <td>重算失败时保留上一份完整缓存，图表继续可读</td>
              </tr>
              <tr>
                <td>度量字段 / 聚合函数变化</td>
                <td>缓存数据集记录的值度量与聚合函数</td>
                <td>与当前配置逐字段相等，否则重算</td>
                <td>失败时不写入缓存，附失败原因与时间</td>
              </tr>
              <tr>
                <td>空值显示 / 行列维度 / 汇总行变化</td>
                <td>缓存数据集记录的口径与维度</td>
                <td>与当前配置逐字段相等，否则重算</td>
                <td>失败时明细与汇总保持同一旧口径，不会混用</td>
              </tr>
              <tr>
                <td>汇总行正确性</td>
                <td>明细单元格 ↔ 汇总行 ↔ 汇总列 ↔ 总计</td>
                <td>差值 ≤ 1e-9 且明细行数一致</td>
                <td>核验不通过即视为重算失败，绝不把错误结果写入缓存</td>
              </tr>
              <tr>
                <td>重复刷新</td>
                <td>同一配置的连续读取 / 并发读取</td>
                <td>指纹一致则复用；并发共用一次重算</td>
                <td>不重复累加汇总行，不产生两个不同结果</td>
              </tr>
            </tbody>
          </table>
          <p class="hint">
            当前缓存：{{ cacheStateText }}。缺失或过期的配置可点「只补齐缺失结果」，已完成的聚合不会被重算或改写。
          </p>
        </article>

        <p v-if="message" class="notice">{{ message }}</p>

        <article v-if="dataset" class="panel">
          <h3>聚合透视数据集 v{{ dataset.version }}</h3>
          <div class="matrix-wrap">
            <table class="data-table matrix">
              <thead>
                <tr>
                  <th>{{ dataset.rowDimension }} \ {{ dataset.columnDimension }}</th>
                  <th v-for="column in dataset.columnKeys" :key="column">{{ column }}</th>
                  <th v-if="dataset.totalRow">总计</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="rowKey in dataset.rowKeys" :key="rowKey">
                  <th>{{ rowKey }}</th>
                  <td v-for="column in dataset.columnKeys" :key="column" class="num">
                    {{ display(cellOf(rowKey, column)) }}
                  </td>
                  <td v-if="dataset.totalRow" class="num total-cell">
                    {{ display(totalColumnOf(rowKey)) }}
                  </td>
                </tr>
                <tr v-if="dataset.totalRow" class="total-row">
                  <th>总计</th>
                  <td v-for="column in dataset.columnKeys" :key="column" class="num total-cell">
                    {{ display(totalRowOf(column)) }}
                  </td>
                  <td class="num total-cell">{{ display(dataset.grandTotal) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="hint">
            空白格按口径显示：{{ dataset.nullDisplayLabel }}；汇总行与汇总列都由原始明细重新聚合，不是把明细值再相加一次。
          </p>

          <details class="detail-block" open>
            <summary>逐项核验（{{ dataset.verification.filter((item) => item.passed).length }}/{{ dataset.verification.length }} 通过）</summary>
            <table class="data-table">
              <thead>
                <tr><th>核验项</th><th>判定范围</th><th>阈值</th><th>期望</th><th>实际</th><th>结果</th></tr>
              </thead>
              <tbody>
                <tr v-for="check in dataset.verification" :key="check.id">
                  <td>{{ check.label }}</td>
                  <td>{{ check.scope }}</td>
                  <td>{{ check.tolerance }}</td>
                  <td class="mono">{{ check.expected }}</td>
                  <td class="mono">{{ check.actual }}</td>
                  <td :class="check.passed ? 'ok-text' : 'error-text'">{{ check.passed ? '通过' : '不通过' }}</td>
                </tr>
              </tbody>
            </table>
          </details>

          <details class="detail-block">
            <summary>单元格明细（可回查原始值）</summary>
            <table class="data-table">
              <thead>
                <tr>
                  <th>行</th><th>列</th><th>明细行数</th><th>非空值</th><th>空值</th>
                  <th>参与计算的值</th><th>聚合结果</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="cell in dataset.cells" :key="`${cell.rowKey}-${cell.columnKey}`">
                  <td>{{ cell.rowKey }}</td>
                  <td>{{ cell.columnKey }}</td>
                  <td>{{ cell.rowCount }}</td>
                  <td>{{ cell.valueCount }}</td>
                  <td>{{ cell.nullCount }}</td>
                  <td class="mono">{{ cell.values.map((value) => (value === null ? '空' : value)).join(' + ') }}</td>
                  <td class="num">{{ display(cell) }}</td>
                </tr>
                <tr class="total-row">
                  <th>总计</th><th>—</th>
                  <td>{{ dataset.grandTotal.rowCount }}</td>
                  <td>{{ dataset.grandTotal.valueCount }}</td>
                  <td>{{ dataset.grandTotal.nullCount }}</td>
                  <td class="mono">明细合计 {{ dataset.rowSumCheck.detailSum }}</td>
                  <td class="num">{{ display(dataset.grandTotal) }}</td>
                </tr>
              </tbody>
            </table>
          </details>

          <details class="detail-block">
            <summary>口径说明</summary>
            <ul>
              <li v-for="note in dataset.notes" :key="note">{{ note }}</li>
            </ul>
          </details>
        </article>

        <article v-else class="panel empty-panel">
          <h3>暂无可用聚合结果</h3>
          <p class="error-text">{{ failure?.detailedReason || '尚未重算，请点击「核验并重算受影响配置」。' }}</p>
        </article>

        <article class="panel">
          <h3>引用该透视的图表</h3>
          <table class="data-table">
            <thead>
              <tr><th>图表</th><th>投射的聚合结果</th><th>版本</th><th>状态</th></tr>
            </thead>
            <tbody>
              <tr v-for="chart in charts" :key="chart.chartNo">
                <td>{{ chart.chartNo }} · {{ chart.chartName }}</td>
                <td>
                  <span v-if="chart.dataset">
                    {{ chart.dataset.rowKeys.length }} × {{ chart.dataset.columnKeys.length }} 格，
                    {{ chart.dataset.aggregationLabel }} / {{ chart.dataset.nullDisplayLabel }}
                  </span>
                  <span v-else class="error-text">没有可读的聚合结果</span>
                </td>
                <td>{{ chart.servedVersion ? `v${chart.servedVersion}` : '—' }}</td>
                <td>
                  <span v-if="chart.servedFromFallback" class="warn-text">
                    重算失败，展示上一份完整结果
                  </span>
                  <span v-else-if="chart.dataset" class="ok-text">当前版本</span>
                  <span v-else class="error-text">无结果</span>
                </td>
              </tr>
              <tr v-if="!charts.length">
                <td colspan="4" class="empty-state">该透视配置还没有绑定图表</td>
              </tr>
            </tbody>
          </table>
        </article>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import {
  loadChartAggregate,
  pivotCacheSnapshot,
  pivotDefinitions,
  publishSourceBatch,
  refreshMissingPivots,
  refreshPivot,
  resetPivotWorkspace,
  savePivotConfig,
  setSimulatedFault,
  simulatedFaultOf,
  sourceRevisionOf,
  sourceBatches,
} from '@/api/pivot-service'
import { PIVOT_SOURCES } from '@/data/pivot-sources'
import { AGGREGATION_LABELS, NULL_DISPLAY_LABELS, formatCellValue } from '@/data/pivot-engine'
import type {
  ChartAggregatePayload,
  PivotAggregation,
  PivotCell,
  PivotDefinition,
  PivotDataset,
  PivotNullDisplay,
} from '@/data/pivot-types'

const route = useRoute()
const router = useRouter()
const sources = PIVOT_SOURCES
const aggregationOptions = (Object.keys(AGGREGATION_LABELS) as PivotAggregation[]).map((value) => ({
  value,
  label: AGGREGATION_LABELS[value],
}))
const nullOptions = (Object.keys(NULL_DISPLAY_LABELS) as PivotNullDisplay[]).map((value) => ({
  value,
  label: NULL_DISPLAY_LABELS[value],
}))

const definitions = ref<PivotDefinition[]>(pivotDefinitions())
const requested = typeof route.query.pivot === 'string' ? route.query.pivot : ''
const selectedId = ref(
  definitions.value.some((item) => item.id === requested) ? requested : definitions.value[0]?.id ?? '',
)
const message = ref('')
const dataset = ref<PivotDataset | null>(null)
const charts = ref<ChartAggregatePayload[]>([])
const tick = ref(0)

const definition = computed(() => definitions.value.find((item) => item.id === selectedId.value) ?? null)
const cache = computed(() => {
  void tick.value
  return selectedId.value ? pivotCacheSnapshot(selectedId.value) : null
})
const failure = computed(() => cache.value?.failure ?? null)
const sourceRevision = computed(() => {
  void tick.value
  return definition.value ? sourceRevisionOf(definition.value.source) : 0
})
const sourceName = (sourceId: string) => sources.find((source) => source.id === sourceId)?.name ?? sourceId
const aggregationLabel = (aggregation: PivotAggregation) => AGGREGATION_LABELS[aggregation]
const nullLabel = (display: PivotNullDisplay) => NULL_DISPLAY_LABELS[display]
const unit = computed(() => {
  if (!definition.value) return ''
  return (
    sources
      .find((source) => source.id === definition.value?.source)
      ?.fields.find((field) => field.name === definition.value?.measure)?.unit ?? ''
  )
})
const dimensionFields = computed(
  () =>
    sources
      .find((source) => source.id === form.value.source)
      ?.fields.filter((field) => field.role === 'dimension')
      .map((field) => field.name) ?? [],
)
const measureFields = computed(
  () =>
    sources
      .find((source) => source.id === form.value.source)
      ?.fields.filter((field) => field.role === 'measure')
      .map((field) => field.name) ?? [],
)

const chartNames = computed(() => {
  if (!definition.value) return ''
  const names: string[] = []
  for (const chartId of definition.value.chartIds) {
    const chart = loadChartAggregate(`CHAR-${String(chartId).padStart(4, '0')}`)
    if (chart) names.push(`${chart.chartNo} ${chart.chartName}`)
  }
  return names.join('、')
})

const cacheStateText = computed(() => {
  const state = cache.value
  if (!state?.dataset) return '没有缓存结果（下次读取会触发重算）'
  const base = `缓存版本 v${state.dataset.version}，生成于 ${new Date(state.cachedAt ?? '').toLocaleString()}`
  return state.failure ? `${base}；最近一次重算失败，继续供应上一份完整结果` : `${base}，与当前配置一致`
})

const form = ref({
  source: '',
  measure: '',
  aggregation: 'sum' as PivotAggregation,
  nullDisplay: 'zero' as PivotNullDisplay,
  totalRow: true,
  rowDimension: '',
  columnDimension: '',
})

const fault = computed(() => {
  void tick.value
  return selectedId.value ? simulatedFaultOf(selectedId.value) : null
})

const batchCount = computed(() => (definition.value ? Math.max(0, sourceRevision.value - 1) : 0))
const batchLabels = computed(() =>
  definition.value
    ? sourceBatches(definition.value.source)
        .map((row) => String(row['批次'] ?? ''))
        .filter(Boolean)
        .join('、')
    : '',
)
const revisionRecord = computed(() => {
  void tick.value
  if (!dataset.value) return '—'
  return `${dataset.value.pivotId} v${dataset.value.version} / ${dataset.value.sourceId} r${dataset.value.sourceRevision} / ${dataset.value.measure} / ${dataset.value.aggregation} / ${dataset.value.nullDisplay}`
})

function syncForm(): void {
  if (!definition.value) return
  form.value = {
    source: definition.value.source,
    measure: definition.value.measure,
    aggregation: definition.value.aggregation,
    nullDisplay: definition.value.nullDisplay,
    totalRow: definition.value.totalRow,
    rowDimension: definition.value.rowDimension,
    columnDimension: definition.value.columnDimension,
  }
}

function reloadView(): void {
  definitions.value = pivotDefinitions()
  const state = selectedId.value ? pivotCacheSnapshot(selectedId.value) : null
  dataset.value = state?.dataset ?? null
  charts.value =
    definition.value?.chartIds
      .map((chartId) => loadChartAggregate(`CHAR-${String(chartId).padStart(4, '0')}`))
      .filter((item): item is ChartAggregatePayload => item !== null) ?? []
  tick.value += 1
}

function stateLabel(pivotId: string): string {
  const state = pivotCacheSnapshot(pivotId)
  if (!state?.dataset) return '无结果'
  if (state.failure) return `失败回退 v${state.dataset.version}`
  return `v${state.dataset.version}`
}

function stateClass(pivotId: string): string {
  const state = pivotCacheSnapshot(pivotId)
  if (!state?.dataset) return 'state-missing'
  return state.failure ? 'state-fallback' : 'state-ok'
}

async function select(pivotId: string): Promise<void> {
  selectedId.value = pivotId
  syncForm()
  await refreshPivot(pivotId)
  reloadView()
  if (route.query.pivot !== pivotId) {
    await router.replace({ path: '/pivotable/workbench', query: { pivot: pivotId } })
  }
}

async function refreshVisible(force: boolean): Promise<void> {
  message.value = ''
  for (const item of definitions.value) {
    await refreshPivot(item.id, { force })
  }
  reloadView()
  message.value = '已完成受影响配置的核验与重算；未受影响的配置直接复用上一份结果。'
}

async function refreshMissing(): Promise<void> {
  const outcomes = await refreshMissingPivots()
  reloadView()
  message.value = outcomes.length
    ? `补齐了 ${outcomes.length} 份缺失/过期的聚合结果，其余配置保持原结果。`
    : '所有配置都有可用的完整结果，无需补齐。'
}

async function applyConfig(): Promise<void> {
  if (!definition.value) return
  message.value = ''
  const before = definition.value.version
  const updated = savePivotConfig(definition.value.id, {
    source: form.value.source,
    measure: form.value.measure,
    aggregation: form.value.aggregation,
    nullDisplay: form.value.nullDisplay,
    totalRow: form.value.totalRow,
    rowDimension: form.value.rowDimension,
    columnDimension: form.value.columnDimension,
  })
  if (updated.version === before) {
    message.value = '配置没有变化，不触发重算。'
    reloadView()
    return
  }
  syncForm()
  const outcome = await refreshPivot(updated.id)
  reloadView()
  message.value = outcome.ok
    ? `配置已升到 v${updated.version}（${updated.versionNote}），聚合结果已重算到 v${outcome.version}。`
    : `配置已升到 v${updated.version}，但重算失败：${outcome.detailedReason}；图表继续读取上一份完整结果。`
}

async function publishSource(): Promise<void> {
  if (!definition.value) return
  message.value = ''
  const published = publishSourceBatch(definition.value.source)
  const outcome = await refreshPivot(definition.value.id)
  reloadView()
  message.value = outcome.ok
    ? `来源 ${definition.value.source} 已追加批次 ${String(published.appended['批次'] ?? '')}（r${published.revision}），本配置已重算到 v${outcome.version}。`
    : `来源已更新到 r${published.revision}，但重算失败：${outcome.detailedReason}；继续展示上一份完整结果。`
}

function toggleFault(): void {
  if (!selectedId.value) return
  const current = simulatedFaultOf(selectedId.value)
  setSimulatedFault(selectedId.value, current ? null : '数据源连接超时')
  message.value = current ? '已解除故障演练。' : '已开启故障演练：下一次重算会失败，缓存保持不变。'
  reloadView()
}

function resetWorkspace(): void {
  resetPivotWorkspace()
  message.value = '已恢复演示数据：配置回到 v1，缓存清空，追加批次已移除。'
  syncForm()
  reloadView()
}

function cellOf(rowKey: string, columnKey: string): PivotCell | null {
  return dataset.value?.cells.find((cell) => cell.rowKey === rowKey && cell.columnKey === columnKey) ?? null
}

function totalColumnOf(rowKey: string): PivotCell | null {
  return dataset.value?.totalColumnValues.find((cell) => cell.rowKey === rowKey) ?? null
}

function totalRowOf(columnKey: string): PivotCell | null {
  return dataset.value?.totalRowValues.find((cell) => cell.columnKey === columnKey) ?? null
}

function display(cell: PivotCell | null): string {
  if (!cell) return '—'
  return formatCellValue(cell.displayValue, unit.value)
}


watch(selectedId, syncForm)

// 其它入口（图表页、看板页）可能已经重算过；切回来时只刷新视图，不重复累加。
function onFocus(): void {
  reloadView()
}
function onStorage(event: StorageEvent): void {
  if (event.key && event.key.startsWith('data-explore-selfservice:pivot')) {
    reloadView()
  }
}

onMounted(() => {
  window.addEventListener('focus', onFocus)
  window.addEventListener('storage', onStorage)
})

onBeforeUnmount(() => {
  window.removeEventListener('focus', onFocus)
  window.removeEventListener('storage', onStorage)
})

onMounted(async () => {
  syncForm()
  if (selectedId.value) {
    await refreshPivot(selectedId.value)
  }
  reloadView()
})

</script>

<style scoped>
.workbench-layout { display: grid; grid-template-columns: 280px 1fr; gap: 14px; align-items: start; }
.pivot-list { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 10px; max-height: 78vh; overflow: auto; }
.pivot-list h3 { margin: 4px 4px 10px; font-size: 14px; }
.pivot-pick { display: flex; flex-direction: column; gap: 2px; width: 100%; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 8px; cursor: pointer; }
.pivot-pick.active { border-color: var(--brand); background: #eef4ff; }
.pick-id { font-size: 12px; color: var(--muted); }
.pick-name { font-size: 13px; }
.pick-meta { font-size: 12px; color: var(--muted); }
.pick-state { font-size: 11px; margin-top: 2px; }
.state-ok { color: #067647; }
.state-fallback { color: #b54708; }
.state-missing { color: #b42318; }
.pivot-detail { display: flex; flex-direction: column; gap: 12px; }
.panel { background: #fff; border: 1px solid var(--border); border-radius: 8px; padding: 12px; }
.panel h3 { margin: 0 0 8px; font-size: 14px; }
.agreement { background: #fff8e6; border: 1px solid #f5d9a0; border-radius: 8px; padding: 10px 12px; font-size: 13px; margin-bottom: 12px; }
.kv { display: grid; grid-template-columns: 110px 1fr; gap: 4px 10px; font-size: 13px; margin: 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; word-break: break-all; }
.config-form { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.config-form label { display: flex; flex-direction: column; font-size: 12px; color: var(--muted); gap: 3px; }
.config-form select { padding: 5px 6px; border: 1px solid var(--border); border-radius: 5px; font-size: 13px; }
.form-actions { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; }
.matrix-wrap { overflow: auto; }
.matrix th, .matrix td { white-space: nowrap; }
.num { text-align: right; }
.total-row th, .total-row td { background: #f4f6fa; font-weight: 600; }
.total-cell { background: #f7f9fc; }
.detail-block { margin-top: 10px; font-size: 13px; }
.detail-block summary { cursor: pointer; color: var(--muted); margin-bottom: 6px; }
.notice { background: #eef4ff; border: 1px solid #c7d7fe; border-radius: 6px; padding: 8px 10px; margin: 0; font-size: 13px; }
.hint { color: var(--muted); font-size: 12px; margin: 8px 0 0; }
.ok-text { color: #067647; }
.warn-text { color: #b54708; }
@media (max-width: 1080px) {
  .workbench-layout { grid-template-columns: 1fr; }
  .config-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
</style>
