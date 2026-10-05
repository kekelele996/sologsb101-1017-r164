/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
 * 支持补记各曲线段实际时长：补记后该段时长、全流程合计与占用窗按补记算，
 * 同窑位冲突立即重判并在占用表标出相撞的记录对；撤销补记回到理论口径。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type { Anneal, AnnealDraft, AnnealState, CurveSeg } from '../types/anneal'
import { ANNEAL_STATE_FLOW } from '../types/anneal'
import type { Piece } from '../types/piece'
import {
  ROW_REVISION,
  advanceAnnealState,
  db,
  initDatabase,
  putAnneal,
  removeAnneal,
  setAnnealActualHours,
} from '../utils/db'
import {
  annealWindow,
  checkSlotConflict,
  effectiveSegHours,
  effectiveTotalHours,
  findSlotConflictPairs,
  formatClock,
  formatHours,
  kilnSlots,
  round1,
  segmentHours,
  type SlotConflict,
} from '../utils/thermal'
import { nowIso, nowLocalInput, uuid } from '../utils/id'

/** 退火筛选条件 */
export interface AnnealFilters {
  keyword: string
  state: AnnealState | 'all'
  curveSeg: CurveSeg | 'all'
  kilnCode: string | 'all'
}

/** 窑位占用行 */
export interface SlotOccupancy {
  kilnSlot: string
  annealId: string
  pieceId: string
  pieceName: string
  curveSeg: CurveSeg
  inAt: string
  outAt: string
  state: AnnealState
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
  /** 占用窗结束时间：已出炉取实际出炉时间，未出炉按有效时长（补记优先）预计 */
  windowEnd: string
  /** 与该记录时间窗重叠的对方作品名（占用表据此标出哪两条撞上） */
  conflictWith: string[]
}

/** 一对撞在同一窑位时间窗上的退火记录 */
export interface SlotConflictInfo {
  kilnSlot: string
  aId: string
  bId: string
  aName: string
  bName: string
}

const EMPTY_FILTERS: AnnealFilters = { keyword: '', state: 'all', curveSeg: 'all', kilnCode: 'all' }

let subscribed = false

export const useAnnealStore = defineStore('anneal', () => {
  const anneals = ref<Anneal[]>([])
  const pieces = ref<Piece[]>([])
  const loading = ref(true)
  const ready = ref(false)
  const error = ref('')
  const lastMessage = ref('')
  const revision = ref(0)
  const filters = reactive<AnnealFilters>({ ...EMPTY_FILTERS })

  const kilnCodes = computed<string[]>(() => {
    const set = new Set<string>()
    anneals.value.forEach((row) => {
      const code = row.kilnSlot.split('-').slice(0, -1).join('-')
      if (code !== '') set.add(code)
    })
    return Array.from(set).sort()
  })

  const wallThicknessOf = (pieceId: string): number =>
    pieces.value.find((row) => row.id === pieceId)?.wallThicknessMm ?? 4

  const pieceNameOf = (pieceId: string): string =>
    pieces.value.find((row) => row.id === pieceId)?.name ?? '（作品已删除）'

  /**
   * 当前全部窑位冲突对。
   * 冲突是从记录数据派生的纯计算：补记 / 撤销补记一落库，这里立即重判，
   * 同窑位后续记录是否被撞上马上可见，不必等到下次编辑那条记录。
   */
  const conflictPairs = computed<SlotConflictInfo[]>(() =>
    findSlotConflictPairs(anneals.value, wallThicknessOf).map((pair) => {
      const a = anneals.value.find((row) => row.id === pair.aId)
      const b = anneals.value.find((row) => row.id === pair.bId)
      return {
        kilnSlot: pair.kilnSlot,
        aId: pair.aId,
        bId: pair.bId,
        aName: pieceNameOf(a?.pieceId ?? ''),
        bName: pieceNameOf(b?.pieceId ?? ''),
      }
    }),
  )

  /** 每条退火记录撞上了哪些作品（annealId → 对方作品名列表） */
  const conflictNamesByAnneal = computed<Map<string, string[]>>(() => {
    const map = new Map<string, string[]>()
    conflictPairs.value.forEach((pair) => {
      map.set(pair.aId, [...(map.get(pair.aId) ?? []), pair.bName])
      map.set(pair.bId, [...(map.get(pair.bId) ?? []), pair.aName])
    })
    return map
  })

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 窑位占用表 */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const window = annealWindow(row, wallThicknessOf(row.pieceId))
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: pieceNameOf(row.pieceId),
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          state: row.state,
          occupied: row.state !== '已出炉',
          windowEnd: formatClock(window[1]),
          conflictWith: conflictNamesByAnneal.value.get(row.id) ?? [],
        }
      })
      .sort((a, b) => a.kilnSlot.localeCompare(b.kilnSlot) || a.inAt.localeCompare(b.inAt))
  )

  const occupiedSlotCount = computed<number>(() => new Set(occupancy.value.filter((row) => row.occupied).map((row) => row.kilnSlot)).size)
  const occupancyRate = computed<number>(() => {
    const total = allSlots.value.length
    return total === 0 ? 0 : Math.round((occupiedSlotCount.value / total) * 1000) / 10
  })

  const visibleAnneals = computed<Anneal[]>(() => {
    const keyword = filters.keyword.trim().toLowerCase()
    return anneals.value.filter((row) => {
      if (filters.state !== 'all' && row.state !== filters.state) return false
      if (filters.curveSeg !== 'all' && row.curveSeg !== filters.curveSeg) return false
      if (filters.kilnCode !== 'all' && !row.kilnSlot.startsWith(filters.kilnCode)) return false
      if (keyword === '') return true
      const piece = pieces.value.find((item) => item.id === row.pieceId)
      return (
        row.kilnSlot.toLowerCase().includes(keyword) ||
        (piece?.name ?? '').toLowerCase().includes(keyword) ||
        row.inAt.includes(keyword)
      )
    })
  })

  /** 某件作品的窑位冲突检测（编辑时排除自身，并带上该记录已保存的补记时长） */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'>,
  ): SlotConflict {
    const existing = anneals.value.find((row) => row.id === candidate.id)
    return checkSlotConflict(
      anneals.value,
      { ...candidate, actualHours: existing?.actualHours ?? null },
      wallThicknessOf,
      candidate.id,
    )
  }

  /** 该记录曲线段的有效时长：补记优先，未补记按壁厚理论值 */
  function segHoursOf(row: Pick<Anneal, 'curveSeg' | 'actualHours' | 'pieceId'>): number {
    return effectiveSegHours(row, wallThicknessOf(row.pieceId))
  }

  /** 某件作品的退火时长汇总：已补记的段按补记算，未补记的段按壁厚理论值 */
  function durationOf(pieceId: string): { hours: number; text: string; hasActual: boolean } {
    const rows = anneals.value.filter((row) => row.pieceId === pieceId)
    const hours = effectiveTotalHours(rows, wallThicknessOf(pieceId))
    const hasActual = rows.some((row) => typeof row.actualHours === 'number' && row.actualHours > 0)
    return { hours, text: formatHours(hours), hasActual }
  }

  async function loadAll(): Promise<void> {
    loading.value = true
    error.value = ''
    try {
      await initDatabase()
      if (!subscribed) {
        subscribed = true
        liveQuery(async () => {
          const [annealRows, pieceRows] = await Promise.all([db.anneals.toArray(), db.pieces.toArray()])
          return { annealRows, pieceRows }
        }).subscribe({
          next: ({ annealRows, pieceRows }) => {
            anneals.value = [...annealRows].sort((a, b) => a.inAt.localeCompare(b.inAt))
            pieces.value = pieceRows
            loading.value = false
            ready.value = true
            error.value = ''
          },
          error: (err: unknown) => {
            error.value = err instanceof Error ? err.message : '读取退火数据失败'
            loading.value = false
          },
        })
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化本地数据库失败'
      loading.value = false
    }
  }

  function setFilters(patch: Partial<AnnealFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    Object.assign(filters, { ...EMPTY_FILTERS })
  }

  async function createAnneal(draft: AnnealDraft): Promise<Anneal | null> {
    const conflict = conflictOf({
      id: '',
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return null
    }
    const stamp = nowIso()
    const row: Anneal = {
      id: uuid('anneal'),
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
      actualHours: null,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putAnneal(row)
    revision.value += 1
    lastMessage.value = `已分配窑位 ${row.kilnSlot}，理论时长 ${formatHours(segmentHours(row.curveSeg, wallThicknessOf(row.pieceId)))}`
    return row
  }

  async function updateAnneal(annealId: string, draft: AnnealDraft): Promise<boolean> {
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    await putAnneal({
      ...existing,
      pieceId: draft.pieceId,
      kilnSlot: draft.kilnSlot,
      curveSeg: draft.curveSeg,
      inAt: draft.inAt,
      outAt: draft.outAt,
      state: draft.state,
    })
    revision.value += 1
    lastMessage.value = '退火编排已更新'
    return true
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
  }

  /** 在给定记录集合上检查某条记录是否撞上同窑位的其他记录，返回提醒文案；否则返回空串 */
  function conflictNoticeOf(rows: Anneal[], annealId: string): string {
    const hits = findSlotConflictPairs(rows, wallThicknessOf).filter(
      (pair) => pair.aId === annealId || pair.bId === annealId,
    )
    if (hits.length === 0) return ''
    const nameOf = (id: string): string => pieceNameOf(rows.find((row) => row.id === id)?.pieceId ?? '')
    const others = hits.map((pair) => (pair.aId === annealId ? nameOf(pair.bId) : nameOf(pair.aId)))
    return `注意：占用窗变化后与「${others.join('」「')}」在窑位 ${hits[0].kilnSlot} 时段重叠，请调整排产。`
  }

  /** 补记（或修改）某条记录的曲线段实际时长；保存后立即按新占用窗重判同窑位冲突 */
  async function saveActualHours(annealId: string, hours: number): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    const value = round1(hours)
    if (!Number.isFinite(value) || value <= 0) {
      lastMessage.value = '补记时长必须大于 0 小时'
      return false
    }
    await setAnnealActualHours(annealId, value)
    revision.value += 1
    // 在本地套用补记后的记录集合上重判，不依赖 liveQuery 回读时序
    const nextRows = anneals.value.map((row) => (row.id === annealId ? { ...row, actualHours: value } : row))
    const notice = conflictNoticeOf(nextRows, annealId)
    lastMessage.value = `已补记「${existing.curveSeg}」段实际时长 ${formatHours(value)}，该段时长、全流程合计与占用窗均按补记计算。${notice}`
    return true
  }

  /** 撤销补记：该段时长、全流程合计与占用窗回到按壁厚计算的理论口径，并立即重判冲突 */
  async function clearActualHours(annealId: string): Promise<boolean> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    if (existing.actualHours === null) return false
    await setAnnealActualHours(annealId, null)
    revision.value += 1
    const nextRows = anneals.value.map((row) => (row.id === annealId ? { ...row, actualHours: null } : row))
    const notice = conflictNoticeOf(nextRows, annealId)
    lastMessage.value = `已撤销「${existing.curveSeg}」段补记，恢复按壁厚 ${wallThicknessOf(existing.pieceId)} mm 的理论时长 ${formatHours(
      segmentHours(existing.curveSeg, wallThicknessOf(existing.pieceId)),
    )} 计算。${notice}`
    return true
  }

  /** 推进退火状态；「已出炉」写回出炉时间并同步作品状态 */
  async function advance(annealId: string): Promise<AnnealState | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const index = ANNEAL_STATE_FLOW.indexOf(existing.state)
    if (index < 0 || index >= ANNEAL_STATE_FLOW.length - 1) return null
    const next = ANNEAL_STATE_FLOW[index + 1]
    await advanceAnnealState(annealId, next, nowLocalInput())
    revision.value += 1
    lastMessage.value =
      next === '已出炉' ? '已登记出炉，作品状态已回写为「已退火」' : `退火状态已推进为「${next}」`
    return next
  }

  return {
    anneals,
    pieces,
    loading,
    ready,
    error,
    filters,
    lastMessage,
    revision,
    kilnCodes,
    allSlots,
    occupancy,
    conflictPairs,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    wallThicknessOf,
    conflictOf,
    segHoursOf,
    durationOf,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    saveActualHours,
    clearActualHours,
    advance,
  }
})
