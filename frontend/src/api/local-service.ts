import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  createSamples,
  currentVersionOf,
  nextVersionLabel,
  pendingReviewOf,
  pendingRunOf,
  qualitySnapshot,
  readQualityState,
  unfinishedSamples,
  writeQualityState,
  type QualityConclusion,
  type QualityEligibility,
  type QualityReview,
  type QualityState,
  type QualityVersion,
  type VerificationRun,
} from '@/data/quality'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

/** 应用层发布 / 清洗加工读取质量截面的入口：只认「已启用」且 current=true 的规则版本。 */
export const QUALITY_GATE_FIELD = '质量校验表'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function nowLabel(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function ruleCodeOf(row: EntryRow): string {
  return String(row['规则编号'] ?? row.id)
}

function replaceQualityRow(rows: EntryRow[], index: number, row: EntryRow): void {
  rows[index] = row
}

// ---------------------------------------------------------------------------
// 质量截面：规则侧
// ---------------------------------------------------------------------------

export type QualityRuleView = {
  id: number
  code: string
  row: EntryRow
  status: string
  /** 只有「已启用」的规则参与下游放行判定。 */
  active: boolean
  state: QualityState
  snapshot: ReturnType<typeof qualitySnapshot>
  gateTables: string[]
}

export function listQualityRules(): QualityRuleView[] {
  return listRows('quality').map((row) => {
    const state = readQualityState(row)
    return {
      id: Number(row.id),
      code: ruleCodeOf(row),
      row,
      status: String(row.status),
      active: String(row.status) === '已启用',
      state,
      snapshot: qualitySnapshot(state),
      gateTables: [String(row['校验表名'] ?? '')].filter(Boolean),
    }
  })
}

export function qualityRuleView(id: number): QualityRuleView | undefined {
  return listQualityRules().find((item) => item.id === id)
}
function saveQualityState(index: number, state: QualityState): void {
  const rows = listRows('quality')
  replaceQualityRow(rows, index, writeQualityState(rows[index], state))
  saveRows('quality', rows)
}

function findQualityIndex(id: number): number {
  return listRows('quality').findIndex((row) => Number(row.id) === id)
}

function enqueueReview(state: QualityState, run: VerificationRun): QualityReview {
  state.revision += 1
  const review: QualityReview = {
    id: uniqueId('QR'),
    ruleId: run.ruleId,
    runId: run.id,
    proposedVersion: nextVersionLabel(state),
    proposedConclusion: conclusionOfRun(run),
    reason: conclusionOfRun(run) === '通过' ? '重判通过：全部校验样本达标' : '重判阻断：存在越界样本',
    status: '待复核',
    decision: '',
    decidedBy: '',
    decidedAt: '',
    revision: state.revision,
  }
  state.reviews.push(review)
  return review
}

function conclusionOfRun(run: VerificationRun): QualityConclusion {
  // 只按已完成样本判定：失败 / 待执行的样本不构成执行证据。
  return run.samples.some((sample) => sample.status === '已完成' && sample.outcome === '阻断')
    ? '阻断'
    : '通过'
}

/** 提交校验：已启用的规则只登记重判，绝不退回「待校验」，旧结论保持为当前版本。 */
function submitQualityVerification(id: number): ActionResult {
  const index = findQualityIndex(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的质量规则` }
  }
  const rows = listRows('quality')
  const row = rows[index]
  const state = readQualityState(row)
  const snapshot = qualitySnapshot(state)
  const code = ruleCodeOf(row)

  if (snapshot.run || snapshot.review) {
    const pendingLabel = snapshot.run
      ? `${snapshot.run.kind}${snapshot.run.status}`
      : '待复核结论'
    return {
      ok: false,
      message: `${code} 已有未完成的${pendingLabel}，请先继续样本或完成复核`,
    }
  }

  const hasCurrent = Boolean(currentVersionOf(state))
  const kind = hasCurrent ? '重判' : '首次校验'
  const run: VerificationRun = {
    id: uniqueId(`RUN-${code}`),
    ruleId: Number(row.id),
    ruleCode: code,
    kind,
    status: '待执行',
    samples: createSamples(code, kind),
    createdAt: nowLabel(),
    completedAt: '',
    evidenceId: '',
  }
  state.runs.push(run)
  state.revision += 1

  const next: EntryRow = {
    ...row,
    // 已启用规则保持已启用；只有从未有当前结论的规则才停在待校验。
    status: hasCurrent ? String(row.status) : '待校验',
    pending: !hasCurrent,
    abnormal: hasCurrent ? Boolean(row.abnormal) : false,
  }
  replaceQualityRow(rows, index, writeQualityState(next, state))
  saveRows('quality', rows)

  if (hasCurrent) {
    return {
      ok: true,
      message: `${code} 已登记${kind}，规则仍为「${row.status}」，当前结论 ${state.currentVersion}（${state.conclusion}）继续有效，重判完成前不会删除`,
    }
  }
  return { ok: true, message: `${code} 已提交校验，等待执行样本` }
}

/** 执行校验 / 继续校验：只补齐尚未完成的样本，失败后可以从断点继续。 */
/**
 * 执行全部样本；「继续校验」只补齐尚未完成的样本，已完成的样本原样保留。
 * QUAL-0001 的首次重判会模拟一次执行中断，用来演示「失败后从断点继续」；
 * 中断后规则不会退回待校验，旧结论继续有效。
 */
const INTERRUPTIBLE_RULES = ['QUAL-0001']

function shouldInterrupt(code: string, state: QualityState, resume: boolean): boolean {
  if (resume) return false
  if (!INTERRUPTIBLE_RULES.includes(code)) return false
  return !state.runs.some((item) => item.status === '失败')
}

function advanceQualityRun(id: number, resume: boolean): ActionResult {
  const index = findQualityIndex(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的质量规则` }
  }
  const rows = listRows('quality')
  const state = readQualityState(rows[index])
  const run = pendingRunOf(state)
  if (!run) {
    if (pendingReviewOf(state)) {
      return { ok: false, message: `${ruleCodeOf(rows[index])} 的样本已全部完成，等待复核结论` }
    }
    return { ok: false, message: `${ruleCodeOf(rows[index])} 没有待执行的校验样本` }
  }
  if (run.status === '失败' && !resume) {
    return {
      ok: false,
      message: `${ruleCodeOf(rows[index])} 上次校验已中断，请使用「继续校验」从尚未完成的 ${unfinishedSamples(run).length} 个样本继续`,
    }
  }
  const unfinished = unfinishedSamples(run)
  if (unfinished.length === 0) {
    return { ok: false, message: `${ruleCodeOf(rows[index])} 的样本已全部完成，等待复核结论` }
  }

  const code = ruleCodeOf(rows[index])
  const shouldBreak = shouldInterrupt(code, state, resume)
  if (shouldBreak) {
    // 执行本轮能跑通的样本，留一个失败样本作为断点。
    const interruptAt = unfinished.find((sample) => sample.status === '待执行' && sample.outcome !== '阻断')
      ?.id ?? unfinished[0].id
    for (const sample of run.samples) {
      if (sample.status !== '待执行' || sample.id === interruptAt) continue
      sample.status = '已完成'
      sample.note = '样本执行完成'
    }
    const failed = run.samples.find((sample) => sample.id === interruptAt)!
    failed.status = '失败'
    failed.note = '样本执行中断，可继续'
    run.status = '失败'
    replaceQualityRow(rows, index, writeQualityState(rows[index], state))
    saveRows('quality', rows)
    return {
      ok: false,
      message: `${code} 校验执行中断（${failed.label} 失败），已完成 ${run.samples.filter((sample) => sample.status === '已完成').length}/${run.samples.length} 个样本；规则仍为「${rows[index].status}」，可从断点继续`,
    }
  }

  const resumed = resume || run.status === '失败'
  const completedNote = resume ? '续跑完成' : '样本执行完成'
  for (const sample of run.samples) {
    if (sample.status === '已完成') continue
    sample.status = '已完成'
    sample.note = completedNote
  }
  run.status = '已完成'
  run.completedAt = nowLabel()
  if (!run.evidenceId) {
    run.evidenceId = uniqueId(`EV-${run.ruleCode}`)
  }
  state.lastEvidenceAt = run.completedAt
  const review = enqueueReview(state, run)
  replaceQualityRow(rows, index, writeQualityState(rows[index], state))
  saveRows('quality', rows)
  return {
    ok: true,
    message: `${code} 校验${resumed ? '续跑' : '执行'}完成，证据 ${run.evidenceId}，已提交复核（拟改为 ${review.proposedVersion} ${review.proposedConclusion}）`,
  }
}

/**
 * 复核动作：Compare-And-Set。
 * expectedRevision 由调用方在读取详情时带下来；两个动作同时到达时，
 * 只有携带当前 revision 的第一个动作能推进资格，另一个会被拒绝。
 */
export function decideQualityReview(
  id: number,
  decision: '通过' | '驳回',
  expectedRevision?: number,
  operator = '值班管理员',
): ActionResult {
  const index = findQualityIndex(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的质量规则` }
  }
  const rows = listRows('quality')
  const row = rows[index]
  const state = readQualityState(row)
  if (expectedRevision !== undefined && expectedRevision !== state.revision) {
    return {
      ok: false,
      message: `${ruleCodeOf(row)} 的复核结论已被其他动作推进（期望 revision ${expectedRevision}，当前 ${state.revision}），本次动作不生效`,
    }
  }
  const review = pendingReviewOf(state)
  if (!review) {
    return { ok: false, message: `${ruleCodeOf(row)} 没有待复核的结论` }
  }

  const run = state.runs.find((item) => item.id === review.runId)
  review.status = decision === '通过' ? '已通过' : '已驳回'
  review.decision = decision
  review.decidedBy = operator
  review.decidedAt = nowLabel()
  state.revision += 1

  let message = ''
  if (decision === '通过') {
    if (!run || run.status !== '已完成') {
      return { ok: false, message: `${ruleCodeOf(row)} 还没有形成完整的执行证据，不能通过复核` }
    }
    const previous = currentVersionOf(state)
    if (previous) {
      previous.current = false
      previous.supersededAt = review.decidedAt
    }
    const nextVersion: QualityVersion = {
      version: review.proposedVersion,
      conclusion: review.proposedConclusion,
      reason: review.reason,
      evidenceId: run.evidenceId,
      effectiveAt: review.decidedAt,
      supersededAt: '',
      current: true,
    }
    state.versions.push(nextVersion)
    state.currentVersion = nextVersion.version
    state.conclusion = nextVersion.conclusion
    state.eligibility = nextVersion.conclusion === '通过' ? '放行' : '阻断'
    // 复核只改变「当前结论」，不改变规则是否启用：已启用规则仍参与放行判定，
    // 阻断结论会直接阻断下游，而不会把规则退回待校验。
    row.abnormal = nextVersion.conclusion === '阻断'
    row.pending = false
    message = `${ruleCodeOf(row)} 复核通过，当前版本 ${nextVersion.version}（${nextVersion.conclusion}），资格「${state.eligibility}」${
      previous ? `；旧版本 ${previous.version} 已转入历史，仅可追溯` : ''
    }`
  } else {
    const current = currentVersionOf(state)
    message = `${ruleCodeOf(row)} 复核已驳回，${
      current ? `当前结论 ${current.version}（${current.conclusion}）继续有效` : '当前没有放行结论'
    }`
  }

  replaceQualityRow(rows, index, writeQualityState(row, state))
  saveRows('quality', rows)
  return { ok: true, message }
}

function enableQualityRule(id: number): ActionResult {
  const index = findQualityIndex(id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的质量规则` }
  }
  const rows = listRows('quality')
  const state = readQualityState(rows[index])
  const current = currentVersionOf(state)
  if (!current) {
    return { ok: false, message: `${ruleCodeOf(rows[index])} 尚未形成执行证据，不能启用` }
  }
  rows[index] = {
    ...rows[index],
    status: '已启用',
    pending: false,
    abnormal: current.conclusion === '阻断',
  }
  saveRows('quality', rows)
  return {
    ok: true,
    message:
      current.conclusion === '通过'
        ? `${ruleCodeOf(rows[index])} 已启用，当前放行依据 ${current.version}（${current.evidenceId}）`
        : `${ruleCodeOf(rows[index])} 已启用，但当前结论为「阻断」（${current.version}），下游发布与清洗启用会被拦截`,
  }
}

export function runQualityAction(
  id: number,
  action: string,
  expectedRevision?: number,
): ActionResult {
  switch (action) {
    case '提交校验':
      return submitQualityVerification(id)
    case '执行校验':
      return advanceQualityRun(id, false)
    case '继续校验':
      return advanceQualityRun(id, true)
    case '复核通过':
      return decideQualityReview(id, '通过', expectedRevision)
    case '复核驳回':
      return decideQualityReview(id, '驳回', expectedRevision)
    case '启用规则':
      return enableQualityRule(id)
    case '停用规则': {
      const index = findQualityIndex(id)
      if (index < 0) {
        return { ok: false, message: `没有找到编号为 ${id} 的质量规则` }
      }
      const rows = listRows('quality')
      rows[index] = { ...rows[index], status: '已停用', pending: false, abnormal: true }
      saveRows('quality', rows)
      return { ok: true, message: `${ruleCodeOf(rows[index])} 已停用，不再参与下游放行判定` }
    }
    default:
      return { ok: false, message: `质量规则没有登记「${action}」这个动作` }
  }
}

// ---------------------------------------------------------------------------
// 质量截面：消费侧（应用层发布 / 清洗加工）
// ---------------------------------------------------------------------------

export type QualityGateRule = {
  code: string
  status: string
  conclusion: QualityConclusion | ''
  eligibility: QualityEligibility
  currentVersion: string
  rejudging: boolean
}

export type QualityGate = {
  table: string
  eligibility: QualityEligibility
  conclusion: QualityConclusion | ''
  currentVersion: string
  rules: QualityGateRule[]
  blockers: string[]
  reasons: string[]
}

/**
 * 同一个质量截面：应用层发布与清洗加工都调用这里，只读取已启用规则的 current 版本。
 * 正在重判但旧结论仍 current 的规则按旧结论计，不会被误判成待处理或阻断。
 */
export function evaluateQualityGate(table: string): QualityGate {
  const enabled = listQualityRules().filter(
    (item) => item.active && item.gateTables.includes(table),
  )
  const rules: QualityGateRule[] = enabled.map((item) => ({
    code: item.code,
    status: item.status,
    conclusion: item.snapshot.conclusion,
    eligibility: item.snapshot.eligibility,
    currentVersion: item.snapshot.currentVersion,
    rejudging: item.snapshot.rejudging,
  }))
  const blockers = rules.filter((item) => item.conclusion === '阻断').map((item) => item.code)
  const unnamed = rules.filter((item) => !item.currentVersion).map((item) => item.code)
  const reasons: string[] = []

  let eligibility: QualityEligibility = '放行'
  let conclusion: QualityConclusion | '' = '通过'
  if (rules.length === 0) {
    eligibility = '待定'
    conclusion = ''
    reasons.push(`表 ${table} 没有已启用的质量规则，不能作为放行证明`)
  } else if (blockers.length > 0) {
    eligibility = '阻断'
    conclusion = '阻断'
    reasons.push(`质量规则 ${blockers.join('、')} 的当前结论为阻断`)
  } else if (unnamed.length > 0) {
    eligibility = '待定'
    conclusion = ''
    reasons.push(`质量规则 ${unnamed.join('、')} 尚未形成当前结论`)
  } else {
    reasons.push(`表 ${table} 的已启用质量规则全部放行`)
  }
  const currentVersion = rules
    .map((item) => item.currentVersion)
    .filter(Boolean)
    .sort()
    .pop() ?? ''

  return { table, eligibility, conclusion, currentVersion, rules, blockers, reasons }
}

export type QualityConsumer = {
  moduleKey: string
  moduleName: string
  id: number
  code: string
  status: string
  action: string
  table: string
  gate: QualityGate
}

/** 当前所有引用质量截面的下游对象。 */
export function listQualityConsumers(): QualityConsumer[] {
  const consumers: QualityConsumer[] = []
  for (const [moduleKey, action, codeField] of [
    ['ads', '发布上线', '数据集编号'],
    ['cleanse', '启用规则', '规则编号'],
  ] as const) {
    const meta = moduleMeta(moduleKey)
    for (const row of listRows(moduleKey)) {
      const table = String(row[QUALITY_GATE_FIELD] ?? '')
      if (!table) continue
      consumers.push({
        moduleKey,
        moduleName: meta.name,
        id: Number(row.id),
        code: String(row[codeField] ?? row.id),
        status: String(row.status),
        action,
        table,
        gate: evaluateQualityGate(table),
      })
    }
  }
  return consumers
}

function gateOnRow(key: string, row: EntryRow): QualityGate | null {
  if (key !== 'ads' && key !== 'cleanse') return null
  const table = String(row[QUALITY_GATE_FIELD] ?? '')
  if (!table) return null
  return evaluateQualityGate(table)
}

// ---------------------------------------------------------------------------
// 通用动作
// ---------------------------------------------------------------------------

export function runAction(
  key: string,
  id: number,
  action: string,
  expectedRevision?: number,
): ActionResult {
  if (key === 'quality') {
    return runQualityAction(id, action, expectedRevision)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]

  // 应用层发布 / 清洗加工启用前读取同一质量截面，阻断或待定时不允许推进。
  const gate = gateOnRow(key, current)
  if (gate && (action === '发布上线' || action === '启用规则') && gate.eligibility !== '放行') {
    return {
      ok: false,
      message: `${meta.entity} ${current['数据集编号'] ?? current['规则编号'] ?? id} 不能${action}：${gate.reasons.join('；')}`,
    }
  }

  const currentStatus = String(current.status)
  if (currentStatus === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...current,
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  const gateNote = gate && (action === '发布上线' || action === '启用规则') ? `，质量截面「${gate.eligibility}」` : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${gateNote}` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 质量模块的「待处理」以质量截面为准：重判未完成但旧结论仍有效时不计入。 */
function pendingCount(moduleKey: string, rows: EntryRow[]): number {
  if (moduleKey !== 'quality') {
    return rows.filter((row) => row.pending).length
  }
  return rows.filter((row) => qualitySnapshot(readQualityState(row)).pending).length
}

function rejudgingCount(moduleKey: string, rows: EntryRow[]): number {
  if (moduleKey !== 'quality') return 0
  return rows.filter((row) => qualitySnapshot(readQualityState(row)).rejudging).length
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: pendingCount(meta.key, entries),
      abnormal: entries.filter((row) => row.abnormal).length,
      rejudging: rejudgingCount(meta.key, entries),
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '重判中（旧结论仍有效）', value: modules.reduce((sum, item) => sum + item.rejudging, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}

// ---------------------------------------------------------------------------
// 回看：阻断结论仍以质量校验为主对象
// ---------------------------------------------------------------------------

export type QualityAuditView = {
  auditId: number
  code: string
  ruleCode: string
  changeType: string
  before: string
  after: string
  at: string
  source: string
  ruleId: number
}

/** 审计记录按“质量规则”归集；即使记录里提到下游表，主对象仍是质量校验。 */
export function listQualityAudits(): QualityAuditView[] {
  const rules = listQualityRules()
  const views: QualityAuditView[] = []
  for (const row of listRows('audit')) {
    const target = String(row['操作表名'] ?? '')
    const matched = rules.find((rule) => target.includes(rule.code))
    if (!matched) continue
    views.push({
      auditId: Number(row.id),
      code: String(row['记录编号'] ?? row.id),
      ruleCode: matched.code,
      changeType: String(row['变更类型'] ?? ''),
      before: String(row['变更前值'] ?? ''),
      after: String(row['变更后值'] ?? ''),
      at: String(row['操作时间'] ?? ''),
      source: String(row['操作来源'] ?? ''),
      ruleId: matched.id,
    })
  }
  return views
}

export type BlockingConclusion = {
  ruleId: number
  ruleCode: string
  table: string
  version: string
  reason: string
  evidenceId: string
  consumers: QualityConsumer[]
  audits: QualityAuditView[]
}

/** 回看阻断结论：以质量规则为主对象，下游对象只作为影响面列在后面。 */
export function listBlockingConclusions(): BlockingConclusion[] {
  const consumers = listQualityConsumers()
  const audits = listQualityAudits()
  return listQualityRules()
    .filter((item) => item.snapshot.current?.conclusion === '阻断')
    .map((item) => {
      const current = item.snapshot.current as QualityVersion
      return {
        ruleId: item.id,
        ruleCode: item.code,
        table: item.gateTables[0] ?? '',
        version: current.version,
        reason: current.reason,
        evidenceId: current.evidenceId,
        consumers: consumers.filter((consumer) => consumer.table === item.gateTables[0]),
        audits: audits.filter((audit) => audit.ruleCode === item.code),
      }
    })
}
