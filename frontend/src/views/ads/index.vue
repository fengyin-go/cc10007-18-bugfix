<template>
  <section class="page" data-module="ads">
    <header class="page-head">
      <div>
        <h2>应用层发布管理</h2>
        <p class="page-desc">维护应用层数据发布的输入、执行约束与结果记录，为应用层发布提供可验证的数据工程流程。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记应用数据集</button>
        <button class="btn" type="button" @click="exportRows">导出应用层发布清单</button>
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
      <span class="legend-item">质量资格：{{ gateSummary }}</span>
    </p>

    <p class="notice" :class="messageOk ? 'notice-ok' : 'notice-error'">
      {{ message || '发布上线前读取质量截面：只认已启用质量规则的当前结论，历史版本不作为放行证明。' }}
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
          <th>质量资格</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            <span v-if="gateOf(row)" class="tag" :class="gateTag(gateOf(row)!.eligibility)">
              {{ gateOf(row)!.eligibility }}
            </span>
            <span v-else>—</span>
          </td>
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
          <td :colspan="columns.length + 3" class="empty-state">暂无应用层发布数据，可先登记应用数据集</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条应用层发布记录</span>
      <span v-if="message" :class="messageOk ? 'text-muted' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  evaluateQualityGate,
  listEntries,
  moduleMeta,
  runAction as applyAction,
  type QualityGate,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ads')
const columns = ["数据集编号", "业务应用", "输出表名", "查询模板", "下游消费方", "接口协议", "刷新策略", "版本号", "质量校验表"]
const actions = ["提交发布", "发布上线", "服务下线"]
const statuses = ["草稿", "待发布", "已发布", "已下线"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(true)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)
const gateSummary = computed(() => {
  const gates = rows.value.map((row) => gateOf(row)).filter((gate): gate is QualityGate => Boolean(gate))
  const count = (value: string) => gates.filter((gate) => gate.eligibility === value).length
  return `放行 ${count('放行')} / 阻断 ${count('阻断')} / 待定 ${count('待定')}`
})
const stats = computed(() => [
  { label: '应用数据集总数', value: total.value },
  { label: '已发布数据集', value: rows.value.filter((row) => String(row.status) === '已发布').length },
  { label: '待发布数据集', value: rows.value.filter((row) => String(row.status) === '待发布').length },
])

function gateOf(row: EntryRow): QualityGate | null {
  const table = String(row['质量校验表'] ?? '')
  return table ? evaluateQualityGate(table) : null
}

function gateTag(eligibility: string) {
  if (eligibility === '放行') return 'tag-ok'
  if (eligibility === '阻断') return 'tag-error'
  return 'tag-warn'
}

function setMessage(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  setMessage('应用数据集登记入口尚未接入审批流', false)
}

function runAction(action: string, row: EntryRow) {
  const result = applyAction(meta.key, Number(row.id), action)
  setMessage(result.message, result.ok)
  if (!result.ok) return
  reload()
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '应用层发布列表读取失败', false)
  }
}

onMounted(reload)
</script>
