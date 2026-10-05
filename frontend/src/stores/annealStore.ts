/**
 * 退火窑位与曲线状态管理（Pinia）
 * 维护窑位占用表与退火曲线段；窑位冲突时禁止提交，出炉即回写作品状态。
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
} from '../utils/db'
import {
  checkSlotConflict,
  effectivePieceDuration,
  effectiveSegmentHours,
  findSlotClashes,
  formatHours,
  kilnSlots,
  round1,
  segmentHours,
  type SlotClash,
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
  /** 该段生效时长（小时）：已补记按补记，否则按壁厚理论值 */
  segHours: number
  /** 是否已补记实际时长 */
  actual: boolean
  /** 该段理论时长（小时，壁厚口径） */
  theoryHours: number
  state: AnnealState
  /** 该窑位当前是否被未出炉记录占用 */
  occupied: boolean
  /** 与本行撞车的其它退火记录 id */
  clashIds: string[]
}

/** 展示用撞车对（已解析作品名与时间窗） */
export interface SlotClashView extends SlotClash {
  aName: string
  bName: string
}

/** 补记结果：保存后立即对同窑位后续记录重判的撞车情况 */
export interface ActualHoursResult {
  ok: boolean
  /** 保存后涉及该窑位的撞车（至少一端是被补记记录） */
  clashes: SlotClashView[]
  message: string
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

  /** 全部窑位（按已有退火记录推导窑号，兜底 AN-01） */
  const allSlots = computed<string[]>(() => {
    const codes = kilnCodes.value.length > 0 ? kilnCodes.value : ['AN-01']
    return codes.flatMap((code) => kilnSlots(code))
  })

  /** 当前全部窑位撞车对（补记 / 撤回后立即重判） */
  const clashes = computed<SlotClashView[]>(() =>
    findSlotClashes(anneals.value, wallThicknessOf).map((clash) => ({
      ...clash,
      aName: pieces.value.find((row) => row.id === clash.aPieceId)?.name ?? '（作品已删除）',
      bName: pieces.value.find((row) => row.id === clash.bPieceId)?.name ?? '（作品已删除）',
    })),
  )

  /** annealId → 与其撞车的记录 id 集合 */
  const clashIdsByAnneal = computed<Map<string, Set<string>>>(() => {
    const map = new Map<string, Set<string>>()
    clashes.value.forEach((clash) => {
      const add = (a: string, b: string): void => {
        const set = map.get(a) ?? new Set<string>()
        set.add(b)
        map.set(a, set)
      }
      add(clash.aId, clash.bId)
      add(clash.bId, clash.aId)
    })
    return map
  })

  /** 窑位占用表 */
  const occupancy = computed<SlotOccupancy[]>(() =>
    anneals.value
      .map((row) => {
        const piece = pieces.value.find((item) => item.id === row.pieceId)
        const thickness = piece?.wallThicknessMm ?? wallThicknessOf(row.pieceId)
        return {
          kilnSlot: row.kilnSlot,
          annealId: row.id,
          pieceId: row.pieceId,
          pieceName: piece?.name ?? '（作品已删除）',
          curveSeg: row.curveSeg,
          inAt: row.inAt,
          outAt: row.outAt,
          segHours: effectiveSegmentHours(row.curveSeg, thickness, row.actualHours),
          actual: typeof row.actualHours === 'number' && Number.isFinite(row.actualHours) && row.actualHours > 0,
          theoryHours: segmentHours(row.curveSeg, thickness),
          state: row.state,
          occupied: row.state !== '已出炉',
          clashIds: Array.from(clashIdsByAnneal.value.get(row.id) ?? []),
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

  /** 某条记录的窑位冲突检测（编辑时排除自身）；候选未带 actualHours 时按未补记处理 */
  function conflictOf(
    candidate: Pick<Anneal, 'id' | 'kilnSlot' | 'inAt' | 'outAt' | 'curveSeg' | 'pieceId'> & {
      actualHours?: number | null
    },
  ): SlotConflict {
    const result = checkSlotConflict(
      anneals.value,
      { actualHours: null, ...candidate },
      wallThicknessOf,
      candidate.id,
    )
    if (!result.conflict) return result
    // 拼出带作品名的可读说明
    const names = result.hits.map((hit) => {
      const row = anneals.value.find((item) => item.id === hit.withAnnealId)
      const name = pieces.value.find((item) => item.id === hit.withPieceId)?.name ?? '（作品已删除）'
      return `${name}（${row?.inAt.replace('T', ' ') ?? ''} 起）`
    })
    return {
      ...result,
      message: `窑位 ${candidate.kilnSlot} 在该时间窗内与已排的 ${names.join('、')} 撞车，请更换窑位或调整时间。`,
    }
  }

  /** 一件作品的退火时长汇总（按补记口径：补记的段按实际值，其余按壁厚理论值） */
  function durationOf(pieceId: string): {
    hours: number
    text: string
    theoryHours: number
    hasActual: boolean
    actualCount: number
  } {
    const thickness = wallThicknessOf(pieceId)
    const rows = anneals.value.filter((row) => row.pieceId === pieceId)
    const { totalHours, hasActual, actualCount } = effectivePieceDuration(rows, thickness)
    const theoryHours = effectivePieceDuration([], thickness).totalHours
    return { hours: totalHours, text: formatHours(totalHours), theoryHours, hasActual, actualCount }
  }

  /** 一条记录的该段时长（按补记口径）与理论时长 */
  function segmentDurationOf(row: Pick<Anneal, 'curveSeg' | 'actualHours' | 'pieceId'>): {
    hours: number
    theoryHours: number
    actual: boolean
    text: string
  } {
    const thickness = wallThicknessOf(row.pieceId)
    const hours = effectiveSegmentHours(row.curveSeg, thickness, row.actualHours)
    const theoryHours = segmentHours(row.curveSeg, thickness)
    const actual = typeof row.actualHours === 'number' && Number.isFinite(row.actualHours) && row.actualHours > 0
    return { hours, theoryHours, actual, text: formatHours(hours) }
  }

  /** 取某条记录当前撞车的对方记录（占用表/列表高亮用） */
  function clashesOf(annealId: string): SlotClashView[] {
    return clashes.value.filter((clash) => clash.aId === annealId || clash.bId === annealId)
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
      actualHours: null,
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
      actualHours: null,
      state: draft.state,
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
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return false
    // 排产编辑沿用既有补记口径参与判重（排产表单不改补记）
    const conflict = conflictOf({
      id: annealId,
      kilnSlot: draft.kilnSlot,
      inAt: draft.inAt,
      outAt: draft.outAt,
      curveSeg: draft.curveSeg,
      pieceId: draft.pieceId,
      actualHours: existing.actualHours,
    })
    if (conflict.conflict) {
      lastMessage.value = conflict.message
      return false
    }
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

  /**
   * 补记 / 改记 / 撤回某段实际时长（小时）。
   * hours 为正数 → 补记或改记；传 null → 撤回，口径回到壁厚理论值。
   * 保存后立刻对同窑位已排记录（含后面已排的）重判一次撞车，
   * 不阻断保存：撞车结果通过占用表与返回值暴露给排产员。
   */
  async function saveActualHours(annealId: string, hours: number | null): Promise<ActualHoursResult | null> {
    const existing = anneals.value.find((row) => row.id === annealId)
    if (existing === undefined) return null
    const nextHours = hours === null ? null : round1(hours)
    await putAnneal({ ...existing, actualHours: nextHours })
    revision.value += 1

    // liveQuery 回放是异步的，这里先用「已写入」的本地副本立即重判
    const simulated = anneals.value.map((row) => (row.id === annealId ? { ...row, actualHours: nextHours } : row))
    const allClashes = findSlotClashes(simulated, wallThicknessOf)
      .filter((clash) => clash.aId === annealId || clash.bId === annealId)
      .map((clash) => ({
        ...clash,
        aName: pieces.value.find((row) => row.id === clash.aPieceId)?.name ?? '（作品已删除）',
        bName: pieces.value.find((row) => row.id === clash.bPieceId)?.name ?? '（作品已删除）',
      }))

    const segText = formatHours(effectiveSegmentHours(existing.curveSeg, wallThicknessOf(existing.pieceId), nextHours))
    const who = (clash: SlotClashView): string => (clash.aId === annealId ? clash.bName : clash.aName)
    let message: string
    if (nextHours === null) {
      message =
        allClashes.length === 0
          ? `已撤回「${existing.curveSeg}」段补记，该段恢复理论时长 ${segText}`
          : `已撤回补记并恢复理论口径，但窑位 ${existing.kilnSlot} 仍与 ${allClashes.map(who).join('、')} 撞车`
    } else {
      message =
        allClashes.length === 0
          ? `已按补记保存「${existing.curveSeg}」段实际时长 ${segText}`
          : `已按补记保存「${existing.curveSeg}」段实际时长 ${segText}，窑位 ${existing.kilnSlot} 与后面已排的 ${allClashes
              .map(who)
              .join('、')} 撞车，请尽快调窑位或时间`
    }
    lastMessage.value = message
    return { ok: true, clashes: allClashes, message }
  }

  async function deleteAnneal(annealId: string): Promise<void> {
    await removeAnneal(annealId)
    revision.value += 1
    lastMessage.value = '退火记录已删除'
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
    clashes,
    occupiedSlotCount,
    occupancyRate,
    visibleAnneals,
    wallThicknessOf,
    conflictOf,
    durationOf,
    segmentDurationOf,
    clashesOf,
    saveActualHours,
    loadAll,
    setFilters,
    resetFilters,
    createAnneal,
    updateAnneal,
    deleteAnneal,
    advance,
  }
})
