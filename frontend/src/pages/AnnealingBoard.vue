<script setup lang="ts">
/**
 * /annealing 退火窑位分配与曲线编排
 * 窑位冲突时禁用提交；出炉即回写作品状态为「已退火」。
 * 支持补记各曲线段实际时长：补记 / 撤销后该段时长、全流程合计与占用窗立即按新口径重算，
 * 同窑位撞上的记录对实时标在占用表上。
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

const actualDialogVisible = ref(false)
const actualTargetId = ref<string | null>(null)
const actualHoursInput = ref<number>(0)

const form = reactive<AnnealDraft>({
  pieceId: '',
  kilnSlot: '',
  curveSeg: '缓冷' as CurveSeg,
  inAt: nowLocalInput(),
  outAt: '',
  state: '待入窑',
})

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

/** 当前表单的窑位冲突检测结果，冲突时禁用提交 */
const conflict = computed(() =>
  annealStore.conflictOf({
    id: editingId.value ?? '',
    kilnSlot: form.kilnSlot,
    inAt: form.inAt,
    outAt: form.outAt,
    curveSeg: form.curveSeg,
    pieceId: form.pieceId,
  })
)

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

/** 补记对话框当前指向的退火记录（随 store 实时更新） */
const actualTarget = computed<Anneal | null>(() =>
  actualTargetId.value === null
    ? null
    : annealStore.anneals.find((row) => row.id === actualTargetId.value) ?? null,
)

/** 补记对话框里该段的理论参考时长 */
const actualTheory = computed(() => {
  const target = actualTarget.value
  if (target === null) return { thickness: 0, hours: 0, text: '' }
  const thickness = annealStore.wallThicknessOf(target.pieceId)
  const hours = segmentHours(target.curveSeg, thickness)
  return { thickness, hours, text: formatHours(hours) }
})

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

function openActual(row: Anneal): void {
  actualTargetId.value = row.id
  actualHoursInput.value = row.actualHours ?? segmentHours(row.curveSeg, annealStore.wallThicknessOf(row.pieceId))
  actualDialogVisible.value = true
}

async function handleSaveActual(): Promise<void> {
  if (actualTarget.value === null) return
  submitting.value = true
  try {
    const ok = await annealStore.saveActualHours(actualTarget.value.id, actualHoursInput.value)
    if (!ok) {
      ElMessage.error(annealStore.lastMessage)
      return
    }
    ElMessage.success('补记已保存，占用窗已按补记重算')
    actualDialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function handleClearActual(): Promise<void> {
  if (actualTarget.value === null) return
  submitting.value = true
  try {
    const ok = await annealStore.clearActualHours(actualTarget.value.id)
    if (!ok) return
    ElMessage.success('已撤销补记，恢复按壁厚计算的理论口径')
    actualDialogVisible.value = false
  } finally {
    submitting.value = false
  }
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
      v-if="annealStore.conflictPairs.length > 0"
      type="error"
      show-icon
      :closable="false"
      class="mb-14"
      :title="`窑位时段冲突 ${annealStore.conflictPairs.length} 处：以下记录的占用窗重叠，请调整排产`"
    >
      <div v-for="pair in annealStore.conflictPairs" :key="`${pair.aId}-${pair.bId}`">
        窑位 {{ pair.kilnSlot }}：「{{ pair.aName }}」与「{{ pair.bName }}」时段重叠
      </div>
    </el-alert>

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

      <el-table v-else v-loading="!annealStore.ready" :data="annealStore.visibleAnneals" row-key="id" stripe>
        <el-table-column label="作品" min-width="190">
          <template #default="{ row }">
            <div class="cell-stack">
              <el-link type="primary" @click="$router.push(`/pieces/${row.pieceId}/steps`)">
                {{ pieceName[row.pieceId] ?? '（作品已删除）' }}
              </el-link>
              <span class="cell-sub">
                壁厚 {{ annealStore.wallThicknessOf(row.pieceId) }} mm · 全流程
                {{ annealStore.durationOf(row.pieceId).text
                }}{{ annealStore.durationOf(row.pieceId).hasActual ? '（含补记）' : '' }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="阶段" width="150">
          <template #default="{ row }">
            <StageTag :stage="pieceStore.pieces.find((item) => item.id === row.pieceId)?.state ?? null" size="small" />
          </template>
        </el-table-column>
        <el-table-column prop="kilnSlot" label="窑位" width="130" />
        <el-table-column label="曲线段" width="120">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="row.curveSeg === '升温' ? 'warning' : row.curveSeg === '保温' ? 'primary' : 'success'"
            >
              {{ row.curveSeg }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="该段时长" width="140" align="right">
          <template #default="{ row }">
            <div class="cell-stack cell-right">
              <span>
                {{ formatHours(annealStore.segHoursOf(row)) }}
                <el-tag v-if="row.actualHours !== null" size="small" type="warning" effect="plain">补记</el-tag>
              </span>
              <span v-if="row.actualHours !== null" class="cell-sub">
                理论 {{ formatHours(segmentHours(row.curveSeg, annealStore.wallThicknessOf(row.pieceId))) }}
              </span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="入窑时间" width="160">
          <template #default="{ row }">{{ row.inAt.replace('T', ' ') }}</template>
        </el-table-column>
        <el-table-column label="出炉时间" width="160">
          <template #default="{ row }">
            <span v-if="row.outAt === ''" class="cell-sub">未出炉</span>
            <span v-else>{{ row.outAt.replace('T', ' ') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110">
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
        <el-table-column label="操作" width="280" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" :disabled="row.state === '已出炉'" @click="handleAdvance(row)">
              推进状态
            </el-button>
            <el-button link type="primary" size="small" @click="openActual(row)">
              {{ row.actualHours === null ? '补记时长' : '改补记' }}
            </el-button>
            <el-button link type="primary" size="small" @click="openEdit(row)">编辑</el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="mt-14">
      <template #header>
        <span class="card-header__title">窑位占用表</span>
      </template>
      <div class="slot-grid">
        <div
          v-for="slot in annealStore.allSlots"
          :key="slot"
          class="slot-cell"
          :class="{
            'is-occupied': annealStore.occupancy.some((row) => row.kilnSlot === slot && row.occupied),
            'is-conflict': annealStore.occupancy.some((row) => row.kilnSlot === slot && row.conflictWith.length > 0),
          }"
        >
          <div class="slot-name">
            <span>{{ slot }}</span>
            <el-tag
              v-if="annealStore.occupancy.some((row) => row.kilnSlot === slot && row.conflictWith.length > 0)"
              type="danger"
              size="small"
              effect="dark"
            >
              冲突
            </el-tag>
          </div>
          <template v-for="row in annealStore.occupancy.filter((item) => item.kilnSlot === slot)" :key="row.annealId">
            <div class="slot-detail" :class="{ 'is-conflict': row.conflictWith.length > 0 }">
              <div>{{ row.pieceName }} · {{ row.curveSeg }} · {{ row.state }}</div>
              <div class="slot-window">
                {{ row.inAt.slice(5).replace('T', ' ') }} → {{ row.outAt === '' ? '预计 ' : '' }}{{ row.windowEnd }}
              </div>
              <div v-if="row.conflictWith.length > 0" class="slot-conflict">
                ⚠ 与「{{ row.conflictWith.join('」「') }}」时段重叠
              </div>
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
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" :disabled="conflict.conflict" @click="handleSubmit">
          保存
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="actualDialogVisible" title="补记曲线段实际时长" width="520px">
      <template v-if="actualTarget !== null">
        <el-descriptions :column="1" border size="small" class="mb-14">
          <el-descriptions-item label="作品">
            {{ pieceName[actualTarget.pieceId] ?? '（作品已删除）' }}
          </el-descriptions-item>
          <el-descriptions-item label="窑位 / 曲线段">
            {{ actualTarget.kilnSlot }} · {{ actualTarget.curveSeg }}
          </el-descriptions-item>
          <el-descriptions-item label="理论时长">
            按壁厚 {{ actualTheory.thickness }} mm 计算：{{ actualTheory.text }}
          </el-descriptions-item>
        </el-descriptions>
        <el-form label-width="120px">
          <el-form-item label="实际时长">
            <el-input-number v-model="actualHoursInput" :min="0.5" :max="999" :precision="1" :step="0.5" />
            <span class="unit-suffix">小时</span>
          </el-form-item>
        </el-form>
        <el-alert
          type="info"
          show-icon
          :closable="false"
          title="保存后该段时长、全流程合计与占用表上的占用窗都按补记计算，同窑位后续记录立即重判冲突；撤销补记即回到理论口径。"
        />
      </template>
      <template #footer>
        <el-button
          v-if="actualTarget !== null && actualTarget.actualHours !== null"
          type="danger"
          plain
          :loading="submitting"
          @click="handleClearActual"
        >
          撤销补记
        </el-button>
        <el-button @click="actualDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSaveActual">保存补记</el-button>
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

.cell-right {
  align-items: flex-end;
}

.cell-sub {
  font-size: 12px;
  color: #8b95a1;
}

.unit-suffix {
  margin-left: 8px;
  color: #5b6b7a;
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

.slot-cell.is-conflict {
  border-color: #f56c6c;
  background: #fef0f0;
}

.slot-name {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
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

.slot-detail.is-conflict {
  color: #c45656;
}

.slot-window {
  color: #8b95a1;
}

.slot-detail.is-conflict .slot-window {
  color: #c45656;
}

.slot-conflict {
  font-weight: 600;
  color: #f56c6c;
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
