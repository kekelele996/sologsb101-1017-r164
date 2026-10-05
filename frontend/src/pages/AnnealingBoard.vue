<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排
 * 窑位冲突时禁用提交；出炉即回写作品状态为「已退火」。
 * 消费模型：Anneal、Piece、Furnace；复用组件：<FilterBar>、<StatBadge>、<StageTag>、<EmptyPanel>
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import FilterBar from '@/components/common/FilterBar.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import StageTag from '@/components/common/StageTag.vue'
import { useAnnealStore } from '@/stores/annealStore'
import { useFurnaceStore } from '@/stores/furnaceStore'
import { usePieceStore } from '@/stores/pieceStore'
import { ANNEAL_STATE_OPTIONS, CURVE_SEG_OPTIONS, type Anneal, type AnnealDraft, type AnnealState, type CurveSeg } from '@/types/anneal'
import { ANNEAL_CURVE, formatHours, segmentHours, totalAnnealHours } from '@/utils/thermal'
import { nowLocalInput } from '@/utils/id'

const annealStore = useAnnealStore()
const pieceStore = usePieceStore()
const furnaceStore = useFurnaceStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const editingId = ref<string | null>(null)
const formRef = ref<FormInstance>()

/** 补记实际时长弹窗 */
const actualDialogVisible = ref(false)
const actualSaving = ref(false)
const actualRow = ref<Anneal | null>(null)
const actualHoursInput = ref<number | null>(null)

const form = reactive<AnnealDraft>({
  pieceId: '',
  kilnSlot: '',
  curveSeg: '缓冷' as CurveSeg,
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
})

const actualRules: FormRules<{ hours: number | null }> = {
  hours: [
    {
      validator: (_rule, value: number | null, callback: (err?: Error) => void) => {
        if (value === null || value === undefined) return callback()
        if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
          return callback(new Error('请输入大于 0 的小时数'))
        }
        callback()
      },
      trigger: 'blur',
    },
  ],
}
const actualFormRef = ref<FormInstance>()

const rules: FormRules<AnnealDraft> = {
  pieceId: [{ required: true, message: '请选择作品', trigger: 'change' }],
  kilnSlot: [{ required: true, message: '请选择窑位', trigger: 'change' }],
  curveSeg: [{ required: true, message: '请选择曲线段', trigger: 'change' }],
  inAt: [{ required: true, message: '请选择入窑时间', trigger: 'change' }],
  state: [{ required: true, message: '请选择退火状态', trigger: 'change' }],
}

const pieceName = computed<Record<string, string>>(() =>
  Object.fromEntries(pieceStore.pieces.map((row) => [row.id, `${row.name} · ${row.craft}`]))
)

const slotOptions = computed<string[]>(() => {
  const codes = furnaceStore.annealingFurnaces.map((row) => row.code)
  if (codes.length === 0) return annealStore.allSlots
  const list: string[] = []
  codes.forEach((code) => {
    for (let index = 0; index < 9; index += 1) {
      const row = String.fromCharCode(65 + Math.floor(index / 3))
      list.push(`${code}-${row}${(index % 3) + 1}`)
    }
  })
  return list
})

/** 当前表单的窑位冲突检测结果，冲突时禁用提交；编辑时沿用该记录的补记口径 */
const conflict = computed(() => {
  const editing = editingId.value === null ? null : annealStore.anneals.find((row) => row.id === editingId.value) ?? null
  return annealStore.conflictOf({
    id: editingId.value ?? '',
    kilnSlot: form.kilnSlot,
    inAt: form.inAt,
    outAt: form.outAt,
    curveSeg: form.curveSeg,
    pieceId: form.pieceId,
    actualHours: editing?.actualHours ?? null,
  })
})

const formDuration = computed(() => {
  const piece = pieceStore.pieces.find((row) => row.id === form.pieceId)
  const thickness = piece?.wallThicknessMm ?? 4
  return {
    segment: formatHours(segmentHours(form.curveSeg, thickness)),
    total: formatHours(totalAnnealHours(thickness)),
    hint: ANNEAL_CURVE[form.curveSeg].hint,
  }
})

const stats = computed(() => ({
  total: annealStore.anneals.length,
  waiting: annealStore.anneals.filter((row) => row.state === '待入窑').length,
  firing: annealStore.anneals.filter((row) => row.state === '退火中').length,
  done: annealStore.anneals.filter((row) => row.state === '已出炉').length,
}))

/** 行级补记口径展示 */
function rowSeg(row: Anneal): { text: string; actual: boolean; theoryText: string } {  const info = annealStore.segmentDurationOf(row)
  return { text: info.text, actual: info.actual, theoryText: formatHours(info.theoryHours) }
}

function rowTotal(row: Anneal): { text: string; hasActual: boolean; theoryText: string } {
  const info = annealStore.durationOf(row.pieceId)
  return { text: info.text, hasActual: info.hasActual, theoryText: formatHours(info.theoryHours) }
}

/** 该行撞车的对方记录（占用表高亮联动） */
function clashPartners(row: Anneal): string[] {
  return annealStore.clashesOf(row.id).map((clash) => {
    const otherId = clash.aId === row.id ? clash.bId : clash.aId
    const other = annealStore.occupancy.find((item) => item.annealId === otherId)
    return `${clash.kilnSlot}：${other?.pieceName ?? '（作品已删除）'}（${otherId}）`
  })
}

/** 占用格：该窑位是否有撞车 */
function slotHasClash(slot: string): boolean {
  return annealStore.clashes.some((clash) => clash.kilnSlot === slot)
}

/** 占用格内某条记录的撞车提示 */
function slotRowClashText(annealId: string): string {
  const names = annealStore
    .clashesOf(annealId)
    .map((clash) => {
      const otherId = clash.aId === annealId ? clash.bId : clash.aId
      const other = annealStore.occupancy.find((item) => item.annealId === otherId)
      return other?.pieceName ?? '（作品已删除）'
    })
  return names.length === 0 ? '' : `撞车：与 ${names.join('、')} 时间窗重叠`
}

/** el-table 行样式：撞车行标红 */
function tableRowClass({ row }: { row: Anneal }): string {
  return annealStore.clashesOf(row.id).length > 0 ? 'row-clash' : ''
}

onMounted(() => {
  void annealStore.loadAll()
  void pieceStore.loadAll()
  void furnaceStore.loadAll()
})

function openCreate(): void {
  editingId.value = null
  Object.assign(form, {
    pieceId: pieceStore.currentPieceId ?? pieceStore.pieces[0]?.id ?? '',
    kilnSlot: slotOptions.value[0] ?? 'AN-01-A1',
    curveSeg: '缓冷' as CurveSeg,
    inAt: nowLocalInput(),
    outAt: '',
    state: '待入窑' as AnnealState,
  })
  dialogVisible.value = true
}

function openEdit(row: Anneal): void {
  editingId.value = row.id
  Object.assign(form, {
    pieceId: row.pieceId,
    kilnSlot: row.kilnSlot,
    curveSeg: row.curveSeg,
    inAt: row.inAt,
    outAt: row.outAt,
    state: row.state,
  })
  dialogVisible.value = true
}

/** 打开补记弹窗：已补记的回填数值，未补记的预填理论值作参考 */
function openActual(row: Anneal): void {
  actualRow.value = row
  actualHoursInput.value = typeof row.actualHours === 'number' ? row.actualHours : null
  actualDialogVisible.value = true
}

/** 占用表撞车对点击：按 id 找回记录再打开（找不到则忽略） */
function openActualById(annealId: string): void {
  const row = annealStore.anneals.find((item) => item.id === annealId)
  if (row !== undefined) openActual(row)
}

async function handleSaveActual(): Promise<void> {
  if (actualRow.value === null) return
  if (actualFormRef.value !== undefined) {
    const valid = await actualFormRef.value.validate().catch(() => false)
    if (!valid) return
  }
  actualSaving.value = true
  try {
    const result = await annealStore.saveActualHours(actualRow.value.id, actualHoursInput.value)
    if (result === null) {
      ElMessage.error('退火记录不存在或已被删除')
      return
    }
    if (result.clashes.length > 0) ElMessage.warning(result.message)
    else ElMessage.success(result.message)
    actualDialogVisible.value = false
  } finally {
    actualSaving.value = false
  }
}

async function handleRevokeActual(): Promise<void> {
  if (actualRow.value === null) return
  try {
    await ElMessageBox.confirm(
      `确认撤回「${actualRow.value.curveSeg}」段的实际时长补记？撤回后该段恢复按壁厚计算的理论口径。`,
      '撤回补记',
      { type: 'warning', confirmButtonText: '撤回', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const result = await annealStore.saveActualHours(actualRow.value.id, null)
  if (result !== null) {
    ElMessage.success(result.message)
    actualHoursInput.value = null
    actualDialogVisible.value = false
  }
}

async function handleSubmit(): Promise<void> {
  if (formRef.value === undefined) return
  const valid = await formRef.value.validate().catch(() => false)
  if (!valid) return
  if (conflict.value.conflict) {
    ElMessage.error(conflict.value.message)
    return
  }
  submitting.value = true
  try {
    if (editingId.value === null) {
      const row = await annealStore.createAnneal({ ...form })
      if (row === null) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success(`已分配窑位 ${row.kilnSlot}`)
    } else {
      const ok = await annealStore.updateAnneal(editingId.value, { ...form })
      if (!ok) {
        ElMessage.error(annealStore.lastMessage)
        return
      }
      ElMessage.success('退火编排已更新')
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleDelete(row: Anneal): Promise<void> {
  try {
    await ElMessageBox.confirm(`确认删除窑位 ${row.kilnSlot} 的退火记录？`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  await annealStore.deleteAnneal(row.id)
  ElMessage.success('退火记录已删除')
}

async function handleAdvance(row: Anneal): Promise<void> {
  const next = await annealStore.advance(row.id)
  if (next === null) {
    ElMessage.info('该记录已处于「已出炉」状态')
    return
  }
  ElMessage.success(annealStore.lastMessage)
}

function handleFilterChange(key: string, value: string): void {
  if (key === 'state') annealStore.setFilters({ state: value as AnnealState | 'all' })
  if (key === 'curveSeg') annealStore.setFilters({ curveSeg: value as CurveSeg | 'all' })
  if (key === 'kilnCode') annealStore.setFilters({ kilnCode: value })
}
</script>

<template>
  <div>
    <div class="stat-row">
      <StatBadge label="退火记录" :value="stats.total" suffix="条" tone="primary" icon="Histogram" />
      <StatBadge label="待入窑" :value="stats.waiting" suffix="条" tone="info" icon="DataLine" />
      <StatBadge label="退火中" :value="stats.firing" suffix="条" tone="warning" icon="TrendCharts" />
      <StatBadge label="已出炉" :value="stats.done" suffix="条" tone="success" icon="PieChart" />
      <StatBadge
        label="窑位占用率"
        :value="`${annealStore.occupancyRate}%`"
        :percent="annealStore.occupancyRate"
        tone="primary"
        icon="PieChart"
        :hint="`已占用 ${annealStore.occupiedSlotCount} / ${annealStore.allSlots.length} 个窑位`"
      />
    </div>

    <el-alert
      v-if="annealStore.lastMessage !== ''"
      type="info"
      show-icon
      :closable="false"
      class="mb-14"
      :title="annealStore.lastMessage"
    />

    <el-card shadow="never">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">退火窑位分配与曲线编排</span>
          <el-button type="primary" @click="openCreate" :disabled="pieceStore.pieces.length === 0 || slotOptions.length === 0">
            <el-icon><Plus /></el-icon>
            <span>分配窑位</span>
          </el-button>
        </div>
      </template>

      <FilterBar
        :keyword="annealStore.filters.keyword"
        :fields="[
          { key: 'state', label: '退火状态', options: ANNEAL_STATE_OPTIONS as unknown as string[] },
          { key: 'curveSeg', label: '曲线段', options: CURVE_SEG_OPTIONS as unknown as string[] },
          { key: 'kilnCode', label: '退火窑', options: annealStore.kilnCodes },
        ]"
        :values="{
          state: annealStore.filters.state,
          curveSeg: annealStore.filters.curveSeg,
          kilnCode: annealStore.filters.kilnCode,
        }"
        :result-text="`命中 ${annealStore.visibleAnneals.length} / ${annealStore.anneals.length} 条`"
        @update:keyword="(value: string) => annealStore.setFilters({ keyword: value })"
        @change="handleFilterChange"
        @reset="annealStore.resetFilters()"
      />

      <EmptyPanel
        v-if="annealStore.ready && annealStore.anneals.length === 0"
        title="还没有退火编排"
        description="为已完成全部工序的作品分配退火窑位与曲线段；同一窑位在时间窗重叠时会禁止提交。"
        action-text="分配第一个窑位"
        @action="openCreate"
      />

      <el-table
        v-else
        v-loading="!annealStore.ready"
        :data="annealStore.visibleAnneals"
        row-key="id"
        stripe
        :row-class-name="tableRowClass"
      >
        <el-table-column label="作品" min-width="210">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 全流程
                <span :class="{ 'seg-actual': rowTotal(row).hasActual }">{{ rowTotal(row).text }}</span>
                <template v-if="rowTotal(row).hasActual">
                  <el-tag size="small" type="warning" effect="plain">补记口径</el-tag>
                  <span class="cell-sub">理论 {{ rowTotal(row).theoryText }}</span>
                </template>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="150">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column prop="kilnSlot" label="窑位" width="120" />
        <el-table-column label="曲线段" width="110">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'"
            >
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="该段时长" width="170" align="right">
          <template #default="{ row }">
            <div class="cell-stack" style="align-items: flex-end">
              <span :class="{ 'seg-actual': rowSeg(row).actual }">{{ rowSeg(row).text }}</span>
              <span class="cell-sub">
                <template v-if="rowSeg(row).actual">补记 · 理论 {{ rowSeg(row).theoryText }}</template>
                <template v-else>按壁厚理论值</template>
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="入窑时间" width="155">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="出炉时间" width="155">
          <template #default="{ row }">
            <span v-if="row.outAt === ''" class="cell-sub">未出炉</span>
            <span v-else>{{ row.outAt.replace('T', ' ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="100">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.state === '已出炉' ? 'success' : row.state === '退火中' ? 'warning' : 'info'"
              effect="dark"
            >
              {{ row.state }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="撞车" min-width="180">
          <template #default="{ row }">
            <div v-if="clashPartners(row).length > 0" class="cell-stack">
              <el-tag size="small" type="danger" effect="dark">撞车 {{ clashPartners(row).length }} 条</el-tag>
              <span v-for="(text, idx) in clashPartners(row)" :key="idx" class="clash-text">{{ text }}</span>
            </div>
            <span v-else class="cell-sub">无</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button link type="warning" size="small" @click="openActual(row)">
              {{ typeof row.actualHours === 'number' ? '改/撤补记' : '补记实际时长' }}
            </el-button>
            <el-button link type="primary" size="small" :disabled="row.state === '已出炉'" @click="handleAdvance(row)">
              推进状态
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <div class="card-header">
          <span class="card-header__title">窑位占用表</span>
          <el-tag v-if="annealStore.clashes.length > 0" type="danger" effect="dark">
            {{ annealStore.clashes.length }} 对撞车
          </el-tag>
        </div>
      </template>

      <el-alert
        v-if="annealStore.clashes.length > 0"
        type="error"
        show-icon
        :closable="false"
        class="mb-14"
        title="以下窑位存在时间窗重叠（补记实际时长后立即重判）"
      >
        <div v-for="(clash, idx) in annealStore.clashes" :key="idx" class="clash-line">
          <el-tag size="small" type="danger" effect="plain">{{ clash.kilnSlot }}</el-tag>
          <span class="clash-link" @click="openActualById(clash.aId)">{{ clash.aName }}</span>
          <span class="clash-x">⇄</span>
          <span class="clash-link" @click="openActualById(clash.bId)">{{ clash.bName }}</span>
        </div>
      </el-alert>

      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{
            'is-occupied': annealStore.occupancy.some((row) => row.kilnSlot === slot && row.occupied),
            'is-clash': slotHasClash(slot),
          }"
        >
          <div class="slot-name">
            {{ slot }}
            <el-tag v-if="slotHasClash(slot)" size="small" type="danger" effect="dark">撞车</el-tag>
          </div>
          <template v-for="row in annealStore.occupancy.filter((item) => item.kilnSlot === slot)" :key="row.annealId">
            <div class="slot-detail" :class="{ 'slot-detail--clash': row.clashIds.length > 0 }">
              {{ row.pieceName }} · {{ row.curveSeg }} · {{ row.state }}
              <el-tag v-if="row.actual" size="small" type="warning" effect="plain">补记 {{ row.segHours }}h</el-tag>
            </div>
            <div v-if="slotRowClashText(row.annealId) !== ''" class="slot-clash-text">
              ⚠ {{ slotRowClashText(row.annealId) }}
            </div>
          </template>
          <div v-if="annealStore.occupancy.filter((item) => item.kilnSlot === slot).length === 0" class="slot-detail is-free">
            空闲
          </div>
        </div>
      </div>
    </el-card>

    <el-dialog v-model="dialogVisible" :title="editingId === null ? '分配退火窑位' : '编辑退火编排'" width="660px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="120px">
        <el-row :gutter="12">
          <el-col :span="12">
            <el-form-item label="作品" prop="pieceId">
              <el-select v-model="form.pieceId" filterable style="width: 100%">
                <el-option
                  v-for="item in pieceStore.pieces"
                  :key="item.id"
                  :value="item.id"
                  :label="`${item.name} · ${item.craft} · 壁厚 ${item.wallThicknessMm} mm`"
                />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="12">
            <el-form-item label="退火窑位" prop="kilnSlot">
              <el-select v-model="form.kilnSlot" filterable style="width: 100%">
                <el-option v-for="slot in slotOptions" :key="slot" :value="slot" :label="slot" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="曲线段" prop="curveSeg">
              <el-select v-model="form.curveSeg" style="width: 100%">
                <el-option v-for="item in CURVE_SEG_OPTIONS" :key="item" :value="item" :label="item" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="入窑时间" prop="inAt">
              <el-date-picker
                v-model="form.inAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="出炉时间">
              <el-date-picker
                v-model="form.outAt"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm"
                format="YYYY-MM-DD HH:mm"
                placeholder="未出炉可留空"
                style="width: 100%"
              />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="退火状态" prop="state">
          <el-select v-model="form.state" style="width: 100%">
            <el-option v-for="item in ANNEAL_STATE_OPTIONS" :key="item" :value="item" :label="item" />
          </el-select>
        </el-form-item>

        <el-alert
          v-if="conflict.conflict"
          type="error"
          show-icon
          :closable="false"
          title="窑位冲突，无法提交"
          :description="conflict.message"
        />
        <el-alert
          v-else
          type="success"
          show-icon
          :closable="false"
          title="窑位可用，可以提交"
          :description="`当前曲线段「${form.curveSeg}」理论时长 ${formDuration.segment}，该作品全流程退火 ${formDuration.total}。${formDuration.hint}`"
        />
        <el-alert
          v-if="editingId !== null && (annealStore.anneals.find((r) => r.id === editingId)?.actualHours ?? null) !== null"
          type="warning"
          show-icon
          :closable="false"
          class="mt-10"
          title="该记录已补记实际时长"
          description="占用判重按补记口径计算；如需修改或撤回补记，请保存后点列表中的「改/撤补记」。"
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="conflict.conflict" @click="handleSubmit">
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="actualDialogVisible" title="补记实际段时长" width="520px">
      <el-form
        v-if="actualRow !== null"
        ref="actualFormRef"
        :model="{ hours: actualHoursInput }"
        :rules="actualRules"
        label-width="110px"
      >
        <el-form-item label="作品 / 窑位">
          <span class="actual-meta">
            {{ pieceName[actualRow.pieceId] ?? '（作品已删除）' }} · {{ actualRow.kilnSlot }} · {{ actualRow.curveSeg }}
          </span>
        </el-form-item>
        <el-form-item label="入窑时间">
          <span class="actual-meta">{{ actualRow.inAt.replace('T', ' ') }}</span>
        </el-form-item>
        <el-form-item label="理论时长">
          <span class="actual-meta">
            {{ formatHours(segmentHours(actualRow.curveSeg, annealStore.wallThicknessOf(actualRow.pieceId))) }}
            （按壁厚 {{ annealStore.wallThicknessOf(actualRow.pieceId) }} mm 计算）
          </span>
        </el-form-item>
        <el-form-item label="实际时长" prop="hours">
          <el-input-number
            v-model="actualHoursInput"
            :min="0.1"
            :step="0.5"
            :precision="1"
            controls-position="right"
            placeholder="留空则撤回补记"
            style="width: 200px"
          />
          <span class="cell-sub" style="margin-left: 10px">小时；清空 = 撤回，回到理论口径</span>
        </el-form-item>
        <el-form-item label="当前生效">
          <el-tag :type="actualHoursInput === null || actualHoursInput === undefined ? 'info' : 'warning'" effect="plain">
            {{ actualHoursInput === null || actualHoursInput === undefined
              ? `未补记，按理论 ${formatHours(segmentHours(actualRow.curveSeg, annealStore.wallThicknessOf(actualRow.pieceId)))}`
              : `补记 ${formatHours(actualHoursInput)}` }}
          </el-tag>
        </el-form-item>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="保存后会立即重判同窑位后续已排记录"
          description="补记让占用时段变长或变短都照常保存；若与别的记录撞车，会在列表与窑位占用表中标红，不会改动其它记录。"
        />
      </el-form>
      <template #footer>
        <el-button
          v-if="actualRow !== null && typeof actualRow.actualHours === 'number'"
          type="danger"
          plain
          :loading="actualSaving"
          @click="handleRevokeActual"
        >
          撤回补记
        </el-button>
        <el-button @click="actualDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="actualSaving" @click="handleSaveActual">保存补记</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.stat-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 14px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.card-header__title {
  font-size: 15px;
  font-weight: 600;
  color: #1d2b3a;
}

.cell-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.slot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
  gap: 10px;
}

.slot-cell {
  border: 1px solid #e4e7ed;
  border-radius: 10px;
  padding: 10px 12px;
  background: #fafcff;
}

.slot-cell.is-occupied {
  border-color: #f0b27a;
  background: #fff8f1;
}

.slot-cell.is-clash {
  border-color: #f56c6c;
  border-width: 2px;
  background: #fef0f0;
}

.slot-detail--clash {
  color: #c45656;
  font-weight: 600;
}

.slot-clash-text {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: #f56c6c;
}

.seg-actual {
  color: #b88230;
  font-weight: 600;
}

.clash-text {
  font-size: 12px;
  line-height: 1.5;
  color: #c45656;
}

.clash-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  font-size: 13px;
}

.clash-link {
  color: #c45656;
  cursor: pointer;
  text-decoration: underline;
}

.clash-link:hover {
  color: #f56c6c;
}

.clash-x {
  color: #909399;
}

.actual-meta {
  font-size: 13px;
  color: #5b6b7a;
}

.mt-10 {
  margin-top: 10px;
}

:deep(.el-table .row-clash) {
  background-color: #fef0f0 !important;
}

:deep(.el-table .row-clash td.el-table__cell) {
  background-color: #fef0f0 !important;
}

.slot-name {
  font-size: 13px;
  font-weight: 600;
  color: #1d2b3a;
}

.slot-detail {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.6;
  color: #5b6b7a;
}

.slot-detail.is-free {
  color: #a8b0b8;
}

.mt-14 {
  margin-top: 14px;
}

.mb-14 {
  margin-bottom: 14px;
}
</style>
