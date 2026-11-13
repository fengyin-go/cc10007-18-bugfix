import { QUALITY_STATE_KEY, emptyQualityState } from './quality'
import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'data-layer-studio:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 老版本存档里没有质量截面字段：按规则自身状态推导一个最小截面，
// 避免已启用规则被当成「没有结论」而在应用层误放行。
// 只有已启用的规则才回填「通过」当前结论；草稿 / 待校验保持空截面，等待真实执行证据。
function normalizeQualityRows(rows: EntryRow[]): EntryRow[] {
  return rows.map((row) => {
    if (typeof row[QUALITY_STATE_KEY] !== 'string' || row[QUALITY_STATE_KEY] === '') {
      if (String(row.status) !== '已启用') {
        return { ...row, [QUALITY_STATE_KEY]: JSON.stringify(emptyQualityState()) }
      }
      const migrated = {
        ...emptyQualityState(),
        currentVersion: 'v1',
        conclusion: '通过' as const,
        eligibility: '放行' as const,
        versions: [
          {
            version: 'v1',
            conclusion: '通过' as const,
            reason: '历史存档回填：启用时已形成的放行结论',
            evidenceId: 'EV-MIGRATED',
            effectiveAt: '2026-09-01 00:00',
            supersededAt: '',
            current: true,
          },
        ],
        revision: 1,
      }
      return { ...row, [QUALITY_STATE_KEY]: JSON.stringify(migrated) }
    }
    // 已被旧版本回退成「待校验」、但仍有当前结论的规则：恢复已启用，
    // 否则一个有效结论会以「待校验」的身份列出，列表与详情再次对不上。
    try {
      const state = JSON.parse(row[QUALITY_STATE_KEY]) as { versions?: { current?: boolean }[] }
      const hasCurrent = (state.versions ?? []).some((item) => item.current)
      if (hasCurrent && String(row.status) === '待校验') {
        return { ...row, status: '已启用', pending: false }
      }
    } catch {
      return { ...row, [QUALITY_STATE_KEY]: JSON.stringify(emptyQualityState()) }
    }
    return row
  })
}

// 下游模块新增的「质量校验表」字段也要回填，否则老存档没有质量截面引用。
function fillDownstreamFields(moduleKey: string, rows: EntryRow[]): EntryRow[] {
  if (moduleKey !== 'ads' && moduleKey !== 'cleanse') return rows
  const seedById = new Map((SEED_ROWS[moduleKey] ?? []).map((row) => [Number(row.id), row]))
  return rows.map((row) => {
    const seed = seedById.get(Number(row.id))
    if (!seed || typeof row['质量校验表'] === 'string') return row
    return { ...row, 质量校验表: seed['质量校验表'] ?? '' }
  })
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    const merged = { ...fallback, ...parsed }
    return {
      ...merged,
      quality: normalizeQualityRows(merged.quality ?? []),
      ads: fillDownstreamFields('ads', merged.ads ?? []),
      cleanse: fillDownstreamFields('cleanse', merged.cleanse ?? []),
    }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
