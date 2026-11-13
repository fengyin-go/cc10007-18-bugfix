import type { EntryRow } from './types'

/**
 * 质量校验领域模型。
 *
 * 质量规则一旦启用，当前结论（current=true 的版本）就是应用层发布 / 清洗加工唯一可读取的
 * 放行证明。已启用规则再次提交校验时只能登记「重判」，在形成新的执行证据并完成复核前：
 * - 规则状态不能退回「待校验」；
 * - 旧结论不能被删除，仍然是当前有效的放行证明；
 * - 历史版本可以追溯，但不能参与放行判定。
 */

export type QualityConclusion = '通过' | '阻断'
export type QualityEligibility = '放行' | '阻断' | '待定'
export type SampleStatus = '待执行' | '已完成' | '失败'
export type SampleOutcome = '通过' | '阻断'
export type VerificationRunStatus = '待执行' | '执行中' | '失败' | '已完成'
export type ReviewStatus = '待复核' | '已通过' | '已驳回'
export type ReviewDecision = '' | '通过' | '驳回'

export type QualitySample = {
  id: string
  label: string
  status: SampleStatus
  note: string
  outcome: SampleOutcome
}

export type VerificationRun = {
  id: string
  ruleId: number
  ruleCode: string
  kind: '首次校验' | '重判'
  status: VerificationRunStatus
  samples: QualitySample[]
  createdAt: string
  completedAt: string
  evidenceId: string
}

export type QualityVersion = {
  version: string
  conclusion: QualityConclusion
  reason: string
  evidenceId: string
  effectiveAt: string
  supersededAt: string
  current: boolean
}

export type QualityReview = {
  id: string
  ruleId: number
  runId: string
  proposedVersion: string
  proposedConclusion: QualityConclusion
  reason: string
  status: ReviewStatus
  decision: ReviewDecision
  decidedBy: string
  decidedAt: string
  /**
   * 审核动作的 Compare-And-Set 版本：两个审核动作同时到达时，
   * 只有携带当前 revision 的第一个动作能推进结果，另一个会被拒绝。
   */
  revision: number
}

export type QualityState = {
  currentVersion: string
  conclusion: QualityConclusion | ''
  eligibility: QualityEligibility
  versions: QualityVersion[]
  runs: VerificationRun[]
  reviews: QualityReview[]
  revision: number
  lastEvidenceAt: string
}

/**
 * 质量截面以 JSON 字符串挂在同一条规则记录上，跟业务字段一起持久化、一起重置，
 * 不会出现「列表一套、详情一套」的两份状态。
 */
export const QUALITY_STATE_KEY = 'qState'

export function emptyQualityState(): QualityState {
  return {
    currentVersion: '',
    conclusion: '',
    eligibility: '待定',
    versions: [],
    runs: [],
    reviews: [],
    revision: 0,
    lastEvidenceAt: '',
  }
}

export function cloneQuality<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function readQualityState(row: EntryRow): QualityState {
  const raw = row[QUALITY_STATE_KEY]
  if (typeof raw !== 'string' || raw.trim() === '') {
    return emptyQualityState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<QualityState>
    return {
      currentVersion: String(parsed.currentVersion ?? ''),
      conclusion: (parsed.conclusion ?? '') as QualityState['conclusion'],
      eligibility: (parsed.eligibility ?? '待定') as QualityEligibility,
      versions: cloneQuality(parsed.versions ?? []),
      runs: cloneQuality(parsed.runs ?? []),
      reviews: cloneQuality(parsed.reviews ?? []),
      revision: Number(parsed.revision ?? 0),
      lastEvidenceAt: String(parsed.lastEvidenceAt ?? ''),
    }
  } catch {
    return emptyQualityState()
  }
}

export function writeQualityState(row: EntryRow, state: QualityState): EntryRow {
  return { ...row, [QUALITY_STATE_KEY]: JSON.stringify(state) }
}

export function currentVersionOf(state: QualityState): QualityVersion | undefined {
  return state.versions.find((item) => item.current)
}

export function pendingReviewOf(state: QualityState): QualityReview | undefined {
  return state.reviews.find((item) => item.status === '待复核')
}

/** 失败 / 待执行 / 执行中的校验都还没完成，可以从尚未完成的样本继续。 */
export function pendingRunOf(state: QualityState): VerificationRun | undefined {
  return [...state.runs].reverse().find((item) => item.status !== '已完成')
}

export function unfinishedSamples(run: VerificationRun): QualitySample[] {
  return run.samples.filter((item) => item.status !== '已完成')
}

export function completedSamples(run: VerificationRun): QualitySample[] {
  return run.samples.filter((item) => item.status === '已完成')
}

/**
 * 派生质量截面。资格只看 current=true 的版本；历史版本仅用于追溯。
 * 重判未完成时旧结论仍然有效，因此不计入「待处理」。
 */
export function qualitySnapshot(state: QualityState) {
  const current = currentVersionOf(state)
  const review = pendingReviewOf(state)
  const run = pendingRunOf(state)
  const latestRun = [...state.runs].reverse()[0]
  const hasCurrent = Boolean(current)
  return {
    current,
    review,
    run,
    latestRun,
    runProgress: run ? `${completedSamples(run).length}/${run.samples.length}` : '',
    /** 执行完等复核时同样给出进度，避免样本区突然消失。 */
    progressLabel: (run ?? latestRun)
      ? `${completedSamples((run ?? latestRun) as VerificationRun).length}/${(run ?? latestRun)!.samples.length}`
      : '',
    eligibility: state.eligibility,
    conclusion: state.conclusion,
    currentVersion: state.currentVersion,
    revision: state.revision,
    /** 没有当前结论就无法放行，计入「待处理」；重判中的规则有旧结论，不重复计入。 */
    pending: !hasCurrent,
    rejudging: Boolean(current) && (Boolean(run) || Boolean(review)),
    history: state.versions.filter((item) => !item.current),
    lastEvidenceAt: state.lastEvidenceAt,
  }
}

export function nextVersionLabel(state: QualityState): string {
  const latest = state.versions.reduce((max, item) => {
    const matched = /^v(\d+)$/.exec(item.version)
    return matched ? Math.max(max, Number(matched[1])) : max
  }, 0)
  return `v${latest + 1}`
}

/** 新校验样本：QUAL-0002 / QUAL-0003 的阈值样本会给出阻断结论，其余全部通过。 */
export function createSamples(ruleCode: string, kind: '首次校验' | '重判'): QualitySample[] {
  const blocking = ruleCode === 'QUAL-0002' || ruleCode === 'QUAL-0003'
  const prefix = `${ruleCode}-${kind === '重判' ? 'R' : 'I'}${Date.now().toString(36)}`
  return [
    { id: `${prefix}-1`, label: '主键唯一性样本', status: '待执行', note: '', outcome: '通过' },
    { id: `${prefix}-2`, label: '阈值区间样本', status: '待执行', note: '', outcome: blocking ? '阻断' : '通过' },
    { id: `${prefix}-3`, label: '空值比例样本', status: '待执行', note: '', outcome: '通过' },
  ]
}

/** 示例质量截面：与 seed.ts 中的 QUAL-0001 / 0002 / 0003 一一对应。 */
export const SEED_QUALITY_STATES: Record<number, QualityState> = {
  1: {
    currentVersion: 'v2',
    conclusion: '通过',
    eligibility: '放行',
    versions: [
      {
        version: 'v1',
        conclusion: '阻断',
        reason: '阈值下界越界，阻断发布',
        evidenceId: 'EV-QUAL-0001-01',
        effectiveAt: '2026-09-01 09:00',
        supersededAt: '2026-09-12 15:20',
        current: false,
      },
      {
        version: 'v2',
        conclusion: '通过',
        reason: '重判通过：3 个校验样本全部达标',
        evidenceId: 'EV-QUAL-0001-02',
        effectiveAt: '2026-09-12 15:20',
        supersededAt: '',
        current: true,
      },
    ],
    runs: [
      {
        id: 'RUN-QUAL-0001-1',
        ruleId: 1,
        ruleCode: 'QUAL-0001',
        kind: '重判',
        status: '已完成',
        samples: [
          { id: 'RUN-QUAL-0001-1-s1', label: '主键唯一性样本', status: '已完成', note: '样本通过', outcome: '通过' },
          { id: 'RUN-QUAL-0001-1-s2', label: '阈值区间样本', status: '已完成', note: '样本通过', outcome: '通过' },
          { id: 'RUN-QUAL-0001-1-s3', label: '空值比例样本', status: '已完成', note: '样本通过', outcome: '通过' },
        ],
        createdAt: '2026-09-12 15:10',
        completedAt: '2026-09-12 15:20',
        evidenceId: 'EV-QUAL-0001-02',
      },
    ],
    reviews: [
      {
        id: 'QR-1-1',
        ruleId: 1,
        runId: 'RUN-QUAL-0001-1',
        proposedVersion: 'v2',
        proposedConclusion: '通过',
        reason: '重判通过：3 个校验样本全部达标',
        status: '已通过',
        decision: '通过',
        decidedBy: '质量管理员',
        decidedAt: '2026-09-12 15:20',
        revision: 2,
      },
    ],
    revision: 2,
    lastEvidenceAt: '2026-09-12 15:20',
  },
  2: {
    currentVersion: '',
    conclusion: '',
    eligibility: '待定',
    versions: [
      {
        version: 'v1',
        conclusion: '通过',
        reason: '历史版本曾通过，已被重判取代；仅可追溯，不能作为当前放行证明',
        evidenceId: 'EV-QUAL-0002-01',
        effectiveAt: '2026-09-05 10:00',
        supersededAt: '2026-09-15 11:00',
        current: false,
      },
    ],
    runs: [
      {
        id: 'RUN-QUAL-0002-1',
        ruleId: 2,
        ruleCode: 'QUAL-0002',
        kind: '首次校验',
        status: '失败',
        samples: [
          { id: 'RUN-QUAL-0002-1-s1', label: '主键唯一性样本', status: '已完成', note: '样本通过', outcome: '通过' },
          { id: 'RUN-QUAL-0002-1-s2', label: '阈值区间样本', status: '失败', note: '执行中断，可继续', outcome: '阻断' },
          { id: 'RUN-QUAL-0002-1-s3', label: '空值比例样本', status: '待执行', note: '尚未执行', outcome: '通过' },
        ],
        createdAt: '2026-09-15 10:40',
        completedAt: '',
        evidenceId: '',
      },
    ],
    reviews: [],
    revision: 1,
    lastEvidenceAt: '',
  },
  3: {
    currentVersion: 'v2',
    conclusion: '阻断',
    eligibility: '阻断',
    versions: [
      {
        version: 'v1',
        conclusion: '通过',
        reason: '初次校验通过',
        evidenceId: 'EV-QUAL-0003-01',
        effectiveAt: '2026-09-08 09:30',
        supersededAt: '2026-10-01 14:00',
        current: false,
      },
      {
        version: 'v2',
        conclusion: '阻断',
        reason: '阈值上界越界，阻断下游发布',
        evidenceId: 'EV-QUAL-0003-02',
        effectiveAt: '2026-10-01 14:00',
        supersededAt: '',
        current: true,
      },
    ],
    runs: [
      {
        id: 'RUN-QUAL-0003-1',
        ruleId: 3,
        ruleCode: 'QUAL-0003',
        kind: '重判',
        status: '已完成',
        samples: [
          { id: 'RUN-QUAL-0003-1-s1', label: '主键唯一性样本', status: '已完成', note: '样本通过', outcome: '通过' },
          { id: 'RUN-QUAL-0003-1-s2', label: '阈值区间样本', status: '已完成', note: '样本越界，阻断', outcome: '阻断' },
          { id: 'RUN-QUAL-0003-1-s3', label: '空值比例样本', status: '已完成', note: '样本通过', outcome: '通过' },
        ],
        createdAt: '2026-10-01 13:40',
        completedAt: '2026-10-01 14:00',
        evidenceId: 'EV-QUAL-0003-02',
      },
    ],
    reviews: [
      {
        id: 'QR-3-1',
        ruleId: 3,
        runId: 'RUN-QUAL-0003-1',
        proposedVersion: 'v2',
        proposedConclusion: '阻断',
        reason: '阈值上界越界，阻断下游发布',
        status: '已通过',
        decision: '通过',
        decidedBy: '质量管理员',
        decidedAt: '2026-10-01 14:00',
        revision: 2,
      },
    ],
    revision: 2,
    lastEvidenceAt: '2026-10-01 14:00',
  },
}
