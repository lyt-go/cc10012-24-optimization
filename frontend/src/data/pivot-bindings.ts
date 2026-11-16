/** 图表构建与透视配置的绑定关系：图表只读透视产出的聚合结果，不自己算数。 */

export type ChartPivotBinding = {
  /** 图表构建模块里的配置编号，例如 CHAR-0001。 */
  chartNo: string
  chartName: string
  /** 关联的透视配置编号；为空表示图表尚未绑定透视。 */
  pivotId: string
  xField: string
  yField: string
  groupField: string
}

export const CHART_PIVOT_BINDINGS: ChartPivotBinding[] = [
  { chartNo: 'CHAR-0001', chartName: '区域销售额柱状图', pivotId: 'PVT-0001', xField: '区域', yField: '销售额', groupField: '渠道' },
  { chartNo: 'CHAR-0002', chartName: '城市客流趋势折线图', pivotId: 'PVT-0002', xField: '城市', yField: '客流量', groupField: '月份' },
  { chartNo: 'CHAR-0003', chartName: '客服时长峰值条形图', pivotId: 'PVT-0003', xField: '团队', yField: '处理时长', groupField: '优先级' },
  { chartNo: 'CHAR-0004', chartName: '区域订单量分布图', pivotId: 'PVT-0004', xField: '区域', yField: '订单量', groupField: '渠道' },
  { chartNo: 'CHAR-0005', chartName: '渠道订单量饼图', pivotId: 'PVT-0004', xField: '渠道', yField: '订单量', groupField: '区域' },
  { chartNo: 'CHAR-0006', chartName: '城市成交单数柱状图', pivotId: 'PVT-0005', xField: '城市', yField: '成交单数', groupField: '商圈' },
  { chartNo: 'CHAR-0007', chartName: '客服满意度均值图', pivotId: 'PVT-0007', xField: '团队', yField: '满意度', groupField: '问题类型' },
  { chartNo: 'CHAR-0008', chartName: '渠道销售额对比柱状图', pivotId: 'PVT-0008', xField: '渠道', yField: '销售额', groupField: '区域' },
  { chartNo: 'CHAR-0009', chartName: '区域销售额堆叠图', pivotId: 'PVT-0008', xField: '区域', yField: '销售额', groupField: '渠道' },
  { chartNo: 'CHAR-0010', chartName: '商圈客流对比饼图', pivotId: 'PVT-0009', xField: '商圈', yField: '客流量', groupField: '城市' },
  { chartNo: 'CHAR-0011', chartName: '优先级工单量柱状图', pivotId: 'PVT-0010', xField: '优先级', yField: '工单数', groupField: '团队' },
  { chartNo: 'CHAR-0012', chartName: '区域客单销售额折线图', pivotId: 'PVT-0011', xField: '区域', yField: '销售额', groupField: '渠道' },
  { chartNo: 'CHAR-0013', chartName: '城市停留时长峰值图', pivotId: 'PVT-0012', xField: '城市', yField: '停留时长', groupField: '月份' },
  { chartNo: 'CHAR-0014', chartName: '华南区域销售额图', pivotId: 'PVT-0001', xField: '区域', yField: '销售额', groupField: '渠道' },
  { chartNo: 'CHAR-0015', chartName: '月度客流平均值图', pivotId: 'PVT-0002', xField: '月份', yField: '客流量', groupField: '城市' },
]

export function pivotIdForChart(chartNo: string): string {
  return CHART_PIVOT_BINDINGS.find((binding) => binding.chartNo === chartNo)?.pivotId ?? ''
}
