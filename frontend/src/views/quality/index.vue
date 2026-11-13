<template>
  <section class="page" data-module="quality">
    <header class="page-head">
      <div>
        <h2>质量校验管理</h2>
        <p class="page-desc">
          维护数据质量规则的输入、执行约束与结果记录。已启用规则的当前结论是应用层发布与清洗加工读取的唯一放行证明；
          再次提交校验只会登记重判，旧结论在复核完成前不会被删除。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出质量校验清单</button>
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

    <p class="notice" :class="messageOk ? 'notice-ok' : 'notice-error'">
      {{ message || '列表与详情读取同一质量截面，重判未完成时旧结论仍有效。' }}
    </p>

    <div class="split-layout">
      <!-- 侧栏列表：状态与资格直接来自质量截面，不再读持久化的旧章字段 -->
      <aside class="rule-list" aria-label="质量规则列表">
        <h3 class="panel-title">质量规则（{{ rules.length }}）</h3>
        <button
          v-for="item in rules"
          :key="item.id"
          class="rule-list-item"
          :class="{ active: item.id === selectedId }"
          type="button"
          @click="selectRule(item.id)"
        >
          <span class="rule-code">{{ item.code }}</span>
          <span class="rule-state">
            <span class="tag" :class="statusTag(item.status)">{{ item.status }}</span>
            <span class="tag" :class="eligibilityTag(displayEligibility(item))">
              {{ displayEligibility(item) }}
            </span>
          </span>
          <span class="rule-sub">
            当前 {{ item.snapshot.currentVersion || '无当前结论' }}
            <template v-if="item.snapshot.conclusion"> / {{ item.snapshot.conclusion }}</template>
            <template v-if="item.snapshot.rejudging"> / 重判中 {{ item.snapshot.progressLabel }}</template>
          </span>
        </button>
      </aside>

      <!-- 详情：同一截面展开，含样本、复核、历史版本与影响面 -->
      <div class="rule-detail" v-if="selected">
        <h3 class="panel-title">{{ selected.code }} 详情</h3>
        <dl class="detail-grid">
          <div><dt>规则状态</dt><dd>{{ selected.status }}</dd></div>
          <div><dt>当前资格</dt><dd>{{ displayEligibility(selected) }}</dd></div>
          <div><dt>参与放行判定</dt><dd>{{ selected.active ? '是（已启用）' : '否（未启用）' }}</dd></div>
          <div><dt>当前版本</dt><dd>{{ selected.snapshot.currentVersion || '—' }}</dd></div>
          <div><dt>当前结论</dt><dd>{{ selected.snapshot.conclusion || '—' }}</dd></div>
          <div><dt>校验表</dt><dd>{{ selected.gateTables[0] || '—' }}</dd></div>
          <div><dt>最近证据</dt><dd>{{ selected.snapshot.lastEvidenceAt || '—' }}</dd></div>
        </dl>

        <div class="detail-section">
          <h4>动作</h4>
          <div class="action-row">
            <button
              v-for="action in actions"
              :key="action"
              class="btn"
              type="button"
              @click="runAction(action, selected, '')"
            >
              {{ action }}
            </button>
          </div>
          <p class="hint">
            已启用规则点击「提交校验」只登记重判；「执行校验」补齐全部样本，「继续校验」只续跑未完成样本。
            复核动作会带上当前 revision，两个动作同时到达时只有一个能推进。
          </p>
        </div>

        <div class="detail-section" v-if="selected.snapshot.latestRun">
          <h4>
            校验样本（{{ selected.snapshot.latestRun.kind }} · {{ selected.snapshot.latestRun.status }}）
          </h4>
          <table class="data-table compact">
            <thead>
              <tr><th>样本</th><th>状态</th><th>结论</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="sample in selected.snapshot.latestRun.samples" :key="sample.id">
                <td>{{ sample.label }}</td>
                <td>{{ sample.status }}</td>
                <td>{{ sample.status === '已完成' ? sample.outcome : '—' }}</td>
                <td>{{ sample.note || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <p class="hint">
            进度 {{ selected.snapshot.progressLabel }}；执行失败后从尚未完成的样本继续，已完成的样本不会被丢弃，
            只有完整执行证据才能进入复核。
          </p>
        </div>

        <div class="detail-section" v-if="selected.snapshot.review">
          <h4>待复核结论</h4>
          <dl class="detail-grid">
            <div><dt>拟生效版本</dt><dd>{{ selected.snapshot.review.proposedVersion }}</dd></div>
            <div><dt>拟生效结论</dt><dd>{{ selected.snapshot.review.proposedConclusion }}</dd></div>
            <div><dt>依据证据</dt><dd>{{ evidenceOf(selected.snapshot.review.runId) }}</dd></div>
            <div><dt>复核 revision</dt><dd>{{ selected.state.revision }}</dd></div>
          </dl>
          <p class="hint">{{ selected.snapshot.review.reason }}</p>
          <div class="action-row">
            <button class="btn primary" type="button" @click="runAction('复核通过', selected, selected.state.revision)">
              以 revision {{ selected.state.revision }} 复核通过
            </button>
            <button class="btn" type="button" @click="runAction('复核驳回', selected, selected.state.revision)">
              以 revision {{ selected.state.revision }} 复核驳回
            </button>
            <button class="btn ghost" type="button" @click="simulateConcurrentReview(selected)">
              模拟两个审核动作同时到达
            </button>
          </div>
        </div>

        <div class="detail-section">
          <h4>版本追溯</h4>
          <table class="data-table compact">
            <thead>
              <tr><th>版本</th><th>结论</th><th>证据</th><th>生效时间</th><th>失效时间</th><th>当前放行证明</th></tr>
            </thead>
            <tbody>
              <tr v-for="version in selected.state.versions" :key="version.version">
                <td>{{ version.version }}</td>
                <td>{{ version.conclusion }}</td>
                <td>{{ version.evidenceId }}</td>
                <td>{{ version.effectiveAt }}</td>
                <td>{{ version.supersededAt || '—' }}</td>
                <td>
                  <span class="tag" :class="version.current ? 'tag-ok' : 'tag-muted'">
                    {{ version.current ? '是' : '仅追溯' }}
                  </span>
                </td>
              </tr>
              <tr v-if="!selected.state.versions.length">
                <td colspan="6" class="empty-state">尚无版本，先执行校验形成执行证据</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="detail-section">
          <h4>读取此质量截面的下游对象</h4>
          <table class="data-table compact">
            <thead><tr><th>模块</th><th>对象</th><th>当前状态</th><th>质量资格</th><th>依据</th></tr></thead>
            <tbody>
              <tr v-for="consumer in consumersOf(selected)" :key="`${consumer.moduleKey}-${consumer.id}`">
                <td>{{ consumer.moduleName }}</td>
                <td>{{ consumer.code }}</td>
                <td>{{ consumer.status }}</td>
                <td>
                  <span class="tag" :class="eligibilityTag(consumer.gate.eligibility)">
                    {{ consumer.gate.eligibility }}
                  </span>
                </td>
                <td>{{ consumer.gate.reasons.join('；') }}</td>
              </tr>
              <tr v-if="!consumersOf(selected).length">
                <td colspan="5" class="empty-state">暂无下游对象引用这张校验表</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="rule-detail" v-else>
        <p class="empty-state">请选择左侧质量规则</p>
      </div>
    </div>

    <section class="detail-section">
      <h3 class="panel-title">阻断结论回看（以质量校验为主对象）</h3>
      <table class="data-table">
        <thead>
          <tr><th>质量规则</th><th>校验表</th><th>当前版本</th><th>阻断原因</th><th>证据</th><th>影响面</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in blocking" :key="item.ruleCode">
            <td><strong>{{ item.ruleCode }}</strong></td>
            <td>{{ item.table }}</td>
            <td>{{ item.version }}</td>
            <td>{{ item.reason }}</td>
            <td>{{ item.evidenceId }}</td>
            <td>
              <span v-for="consumer in item.consumers" :key="consumer.code" class="tag tag-muted">
                {{ consumer.moduleName }}·{{ consumer.code }}
              </span>
              <span v-for="audit in item.audits" :key="audit.code" class="tag tag-muted">
                审计·{{ audit.code }}
              </span>
              <span v-if="!item.consumers.length && !item.audits.length">—</span>
            </td>
          </tr>
          <tr v-if="!blocking.length">
            <td colspan="6" class="empty-state">当前没有阻断结论</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section class="detail-section">
      <h3 class="panel-title">修复对照（按场景分组）</h3>
      <div class="scenario-grid">
        <article v-for="scenario in scenarios" :key="scenario.key" class="scenario-card">
          <header>
            <span class="tag tag-muted">{{ scenario.scene }}</span>
            <h4>{{ scenario.title }}</h4>
          </header>
          <div class="scenario-columns">
            <div class="scenario-col before">
              <h5>修复前对象</h5>
              <ul>
                <li v-for="item in scenario.before" :key="item.name">
                  <strong>{{ item.name }}</strong>
                  <span>{{ item.state }}</span>
                </li>
              </ul>
            </div>
            <div class="scenario-col after">
              <h5>修复后对象</h5>
              <ul>
                <li v-for="item in scenario.after" :key="item.name">
                  <strong>{{ item.name }}</strong>
                  <span>{{ item.state }}</span>
                </li>
              </ul>
            </div>
          </div>
          <div class="scenario-impact">
            <h5>影响</h5>
            <ul>
              <li v-for="line in scenario.impact" :key="line">{{ line }}</li>
            </ul>
          </div>
        </article>
      </div>
    </section>

    <footer class="page-foot">
      <span>共 {{ total }} 条质量校验记录</span>
      <span class="text-muted">历史版本仅用于追溯，不作为当前放行证明。</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listBlockingConclusions,
  listQualityConsumers,
  listQualityRules,
  moduleMeta,
  runAction as applyAction,
  type BlockingConclusion,
  type QualityConsumer,
  type QualityRuleView,
} from '@/api/local-service'
import { QUALITY_FIX_SCENARIOS } from '@/data/quality-scenarios'

const meta = moduleMeta('quality')
const actions = ["提交校验", "执行校验", "继续校验", "启用规则", "停用规则"]
const statuses = ["草稿", "待校验", "已启用", "已停用"]
const scenarios = QUALITY_FIX_SCENARIOS

const rules = ref<QualityRuleView[]>([])
const consumers = ref<QualityConsumer[]>([])
const blocking = ref<BlockingConclusion[]>([])
const selectedId = ref<number | null>(null)
const message = ref('')
const messageOk = ref(true)

const total = computed(() => rules.value.length)
const selected = computed(() => rules.value.find((item) => item.id === selectedId.value) ?? null)

const stats = computed(() => [
  { label: '质量规则总数', value: rules.value.length },
  { label: '已启用规则', value: rules.value.filter((item) => item.status === '已启用').length },
  {
    label: '待处理（无当前结论）',
    value: rules.value.filter((item) => item.snapshot.pending).length,
  },
  { label: '重判中（旧结论仍有效）', value: rules.value.filter((item) => item.snapshot.rejudging).length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rules.value.filter((row) => row.status === status).length,
  })),
)

function statusTag(status: string) {
  if (status === '已启用') return 'tag-ok'
  if (status === '待校验') return 'tag-warn'
  if (status === '已停用') return 'tag-muted'
  return 'tag-muted'
}

function eligibilityTag(eligibility: string) {
  if (eligibility === '放行') return 'tag-ok'
  if (eligibility === '阻断') return 'tag-error'
  if (eligibility === '待定') return 'tag-warn'
  return 'tag-muted'
}

/** 未启用的规则不参与放行判定，展示成「未启用」而不是它自己的历史结论。 */
function displayEligibility(rule: QualityRuleView): string {
  return rule.active ? rule.snapshot.eligibility : '未启用'
}

function consumersOf(rule: QualityRuleView): QualityConsumer[] {
  const table = rule.gateTables[0]
  return consumers.value.filter((item) => item.table === table)
}

function evidenceOf(runId: string): string {
  return selected.value?.state.runs.find((run) => run.id === runId)?.evidenceId || '—'
}

function selectRule(id: number) {
  selectedId.value = id
}

function setMessage(text: string, ok: boolean) {
  message.value = text
  messageOk.value = ok
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, rule: QualityRuleView, expectedRevision: string | number) {
  const revision = expectedRevision === '' ? rule.state.revision : Number(expectedRevision)
  const result = applyAction(meta.key, rule.id, action, revision)
  setMessage(result.message, result.ok)
  reloadPreservingSelection()
}

/** 模拟两个审核动作同时到达：两个动作都拿同一 revision，第二个必须被拒绝。 */
function simulateConcurrentReview(rule: QualityRuleView) {
  const revision = rule.state.revision
  const first = applyAction(meta.key, rule.id, '复核通过', revision)
  const second = applyAction(meta.key, rule.id, '复核驳回', revision)
  const accepted = [first, second].filter((item) => item.ok).length
  setMessage(
    `并发复核：动作 A ${first.ok ? '推进' : '被拒'}（${first.message}）；` +
      `动作 B ${second.ok ? '推进' : '被拒'}（${second.message}）；` +
      `本次只允许 ${accepted} 个推进结果。`,
    accepted === 1,
  )
  reloadPreservingSelection()
}

function reloadPreservingSelection() {
  rules.value = listQualityRules()
  consumers.value = listQualityConsumers()
  blocking.value = listBlockingConclusions()
  if (selectedId.value === null || !rules.value.some((item) => item.id === selectedId.value)) {
    selectedId.value = rules.value[0]?.id ?? null
  }
}

onMounted(() => {
  reloadPreservingSelection()
})
</script>
