<template>
  <section class="page">
    <header class="page-head">
      <div>
        <h2>运营概览</h2>
        <p class="page-desc">
          汇总各业务模块的关键指标。质量校验按质量截面统计：重判未完成但旧结论仍有效时只计入「重判中」，不重复计入「待处理」。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="refresh">重新统计</button>
      </div>
    </header>
    <div class="stat-row">
      <article v-for="card in cards" :key="card.label" class="stat-card">
        <span class="stat-label">{{ card.label }}</span>
        <strong class="stat-value">{{ card.value }}</strong>
      </article>
    </div>
    <table class="data-table">
      <thead>
        <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>重判中</th><th>异常量</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in moduleRows" :key="row.name">
          <td>{{ row.name }}</td>
          <td>{{ row.created }}</td>
          <td>{{ row.pending }}</td>
          <td>{{ row.rejudging }}</td>
          <td>{{ row.abnormal }}</td>
        </tr>
      </tbody>
    </table>
    <section class="detail-section">
      <h3 class="panel-title">质量截面（与质量校验页同源）</h3>
      <table class="data-table">
        <thead>
          <tr><th>质量规则</th><th>规则状态</th><th>当前版本</th><th>当前结论</th><th>资格</th><th>重判</th></tr>
        </thead>
        <tbody>
          <tr v-for="rule in qualityRules" :key="rule.code">
            <td>{{ rule.code }}</td>
            <td>{{ rule.status }}</td>
            <td>{{ rule.snapshot.currentVersion || '—' }}</td>
            <td>{{ rule.snapshot.conclusion || '—' }}</td>
            <td>
              <span class="tag" :class="eligibilityTag(rule.active ? rule.snapshot.eligibility : '未启用')">
                {{ rule.active ? rule.snapshot.eligibility : '未启用' }}
              </span>
            </td>
            <td>{{ rule.snapshot.rejudging ? `重判中 ${rule.snapshot.progressLabel}` : '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <footer class="page-foot">
      <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
      <RouterLink to="/quality" class="link">查看质量校验明细</RouterLink>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

import { listQualityRules, loadOverview, type QualityRuleView } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

const cards = ref<OverviewResult['cards']>([])
const moduleRows = ref<OverviewResult['modules']>([])
const qualityRules = ref<QualityRuleView[]>([])

function eligibilityTag(eligibility: string) {
  if (eligibility === '放行') return 'tag-ok'
  if (eligibility === '阻断') return 'tag-error'
  if (eligibility === '待定') return 'tag-warn'
  return 'tag-muted'
}

function refresh() {
  const payload = loadOverview()
  cards.value = payload.cards
  moduleRows.value = payload.modules
  qualityRules.value = listQualityRules()
}

onMounted(refresh)
</script>
