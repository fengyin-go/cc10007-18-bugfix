/**
 * 修复对照：按业务场景分组列出「修复前对象」与「修复后对象」，并标明每一项的下游影响。
 * 这些是给运营和审核人员看的说明性数据，不参与任何放行判定。
 */

export type FixObject = {
  name: string
  state: string
}

export type FixScenario = {
  key: string
  scene: string
  title: string
  before: FixObject[]
  after: FixObject[]
  impact: string[]
}

export const QUALITY_FIX_SCENARIOS: FixScenario[] = [
  {
    key: 'resubmit',
    scene: '已启用规则重复提交校验',
    title: '提交校验不再把已启用规则退回待校验',
    before: [
      { name: '质量规则 QUAL-0001', state: '已启用 → 待校验，旧结论被清空' },
      { name: '质量校验页统计', state: '待校验 +1，已启用 -1' },
    ],
    after: [
      { name: '质量规则 QUAL-0001', state: '保持已启用，登记重判 RUN-QUAL-0001-2' },
      { name: '当前结论 v2（通过）', state: '保留为唯一放行证明，复核完成前不删除' },
    ],
    impact: [
      '质量校验页：状态列与资格列仍显示已启用 / 放行',
      '运营概览：重判中 +1，待处理不增加',
      '应用层发布：ADS-0001、ADS-0003 继续按 v2 放行',
      '清洗加工：CLEA-0001、CLEA-0003 继续按 v2 放行',
    ],
  },
  {
    key: 'cross-page',
    scene: '跨页面质量结论',
    title: '应用层 / 清洗加工 / 概览读取同一质量截面',
    before: [
      { name: '应用层发布 ADS-0003', state: '读规则状态列：待校验，无法发布' },
      { name: '运营概览（质量校验）', state: '显示 1 条待处理' },
    ],
    after: [
      { name: '应用层发布 ADS-0003', state: '读质量截面：放行（QUAL-0001 v2）' },
      { name: '运营概览（质量校验）', state: '待处理 0，重判中 1（旧结论仍有效）' },
    ],
    impact: [
      '同一张表 dwd_order_detail 的放行资格在各页面一致',
      '阻断表 dws_trade_summary 的应用层与清洗规则同时被拦截',
    ],
  },
  {
    key: 'concurrent-review',
    scene: '两个复核动作同时到达',
    title: '复核采用 Compare-And-Set，只允许一个动作推进资格',
    before: [
      { name: '复核动作 A（通过）', state: '推进为新版本 v3' },
      { name: '复核动作 B（驳回）', state: '同一版本被再次改写，结论自相矛盾' },
    ],
    after: [
      { name: '复核动作 A（通过）', state: '匹配 revision r，写入 v3 并推进资格' },
      { name: '复核动作 B（驳回）', state: 'revision 已变为 r+1，被拒绝且不产生第二个结果' },
    ],
    impact: ['质量校验：同一待复核结论只会出现一个最终去向', '应用层 / 清洗加工：只读取一个确定的质量截面'],
  },
  {
    key: 'resume',
    scene: '校验失败后的样本续跑',
    title: '从尚未完成的样本继续，不重头再来',
    before: [
      { name: 'QUAL-0002 首次校验 RUN-QUAL-0002-1', state: '失败后重跑全部 3 个样本' },
    ],
    after: [
      { name: 'QUAL-0002 首次校验 RUN-QUAL-0002-1', state: '已完成 1/3 保留，只续跑失败与待执行的 2 个样本' },
      { name: '完成后的执行证据', state: '生成 EV 证据并进入待复核' },
    ],
    impact: ['质量校验：样本进度可核对，失败不丢已完成结果', '复核：只接受完整执行证据'],
  },
  {
    key: 'history',
    scene: '历史版本追溯',
    title: '历史版本可查，但不作为当前放行证明',
    before: [
      { name: 'QUAL-0002 v1（通过，历史）', state: '被当作放行依据使用' },
    ],
    after: [
      { name: 'QUAL-0002 v1（历史）', state: '标记「仅追溯」，不参与放行判定' },
      { name: 'QUAL-0002 当前结论', state: '为空 / 待定，直到新证据复核通过' },
    ],
    impact: ['应用层 / 清洗加工：质量资格为「待定」，禁止发布或启用', '回看：可查到 v1 证据编号与失效时间'],
  },
  {
    key: 'blocking-review',
    scene: '阻断结论回看',
    title: '核对阻断时仍以质量校验为主对象',
    before: [
      { name: '变更审计 AUDI-0003', state: '以应用数据集 ADS-0002 为主对象' },
    ],
    after: [
      { name: '质量规则 QUAL-0003（v2 阻断）', state: '主对象：结论、证据、阻断原因' },
      { name: 'ADS-0002 / CLEA-0002 / AUDI-0003', state: '作为影响面挂在该规则下' },
    ],
    impact: ['质量校验：先看规则阻断结论，再看受影响的下游对象', '变更审计：审计记录按规则编号归集'],
  },
  {
    key: 'list-detail',
    scene: '侧栏列表与详情一致性',
    title: '列表与详情来自同一个质量截面',
    before: [
      { name: '质量规则侧栏 QUAL-0001', state: '残留旧章 v1（阻断）' },
      { name: '质量规则详情 QUAL-0001', state: '显示 v2（通过）' },
    ],
    after: [
      { name: '质量规则侧栏 QUAL-0001', state: '与详情同源：已启用 / v2 通过 / 重判中' },
      { name: '质量规则详情 QUAL-0001', state: '同上，并展开样本与历史版本' },
    ],
    impact: ['质量校验：任意页面刷新后列表与详情结论一致', '运营概览：按同一截面汇总待处理与重判中'],
  },
]
