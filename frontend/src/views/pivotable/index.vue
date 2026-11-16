<template>
  <section class="page" data-module="pivotable">
    <header class="page-head">
      <div>
        <h2>透视分析管理</h2>
        <p class="page-desc">
          管理数据透视分析配置，支持行列维度交叉和多种聚合计算；配置改动后到工作台核验重算结果与汇总口径。
        </p>
      </div>
      <div class="page-actions">
        <RouterLink class="btn primary" to="/pivotable/workbench">打开透视聚合工作台</RouterLink>
        <button class="btn" type="button" @click="exportRows">导出透视分析清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无透视分析数据，可先登记透视配置</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条透视分析记录</span>
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
import { syncDefinitionStatus } from '@/api/pivot-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('pivotable')
const columns = ["配置编号", "数据来源", "行维度字段", "列维度字段", "值度量字段", "聚合函数", "汇总行开启", "空值显示", "配置版本"]
const actions = ["提交配置评审", "保存配置", "删除配置"]
const statuses = ["草稿", "配置评审中", "已保存", "已删除"]
const stats = [{"label": "透视配置总数", "value": 0}, {"label": "已保存配置", "value": 0}, {"label": "评审中配置", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  // 状态流转只同步配置记录，不提升配置版本，因此不会触发聚合重算。
  syncDefinitionStatus(String(row["配置编号"]), String(meta.actionTargets[action]))
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '透视分析列表读取失败'
  }
}

onMounted(reload)
</script>
