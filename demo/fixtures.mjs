export const FIXED_NOW = '2026-10-02T09:00:00+08:00';
export function makeOrders(count = 12) {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      orderId: `ORD-${String(n).padStart(3, '0')}`,
      customer: ['林同学', '陈女士', '周先生', '吴女士'][i % 4],
      amount: 129 + n * 37,
      paidHoursAgo: 30 + n * 13,
      paymentStatus: n % 5 === 0 ? 'refunded' : 'paid',
      shipmentStatus: n % 4 === 0 ? 'shipped' : 'pending',
      warehouse: ['杭州仓', '上海仓'][i % 2],
      auditTrail: ('仓库同步成功；支付流水已归档；这是演示用的非必要字段。').repeat(3),
    };
  });
}
export function candidateOrders(orders) {
  return orders.filter(o => o.paidHoursAgo > 72 && o.paymentStatus === 'paid' && o.shipmentStatus === 'pending');
}
export function reportFor(rows) {
  const matched = rows.filter(x => x.payment.status === 'paid' && x.shipment.status === 'pending');
  return {
    matchedCount: matched.length,
    top3: matched.sort((a, b) => b.order.paidHoursAgo - a.order.paidHoursAgo).slice(0, 3).map(x => ({
      orderId: x.order.orderId,
      customer: x.order.customer,
      paidHoursAgo: x.order.paidHoursAgo,
      amount: x.order.amount,
      warehouse: x.shipment.warehouse,
      suggestion: `优先联系${x.shipment.warehouse}核实备货，确认发货时间后向客户反馈。`,
    })),
  };
}
const schema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const orderParam = { orderId: { type: 'string', description: '订单编号，例如 ORD-001。' } };
export function catalog(size = 18) {
  const string = { type: 'string' };
  const orderSchema = schema({ orderId: string, customer: string, amount: { type: 'number' }, paidHoursAgo: { type: 'number' }, paymentStatus: { type: 'string', enum: ['paid', 'refunded'] }, shipmentStatus: { type: 'string', enum: ['pending', 'shipped'] }, warehouse: string, auditTrail: string });
  const tools = [
    { name: 'list_orders', description: 'List orders 订单列表。返回 {orders:[{orderId,customer,amount,paidHoursAgo,paymentStatus,shipmentStatus,warehouse,auditTrail}],asOf}。paidHoursAgo 是数字；paymentStatus 为 paid/refunded，shipmentStatus 为 pending/shipped。先用三个条件筛选候选，再核对候选的支付和物流。auditTrail 是无关审计字段。', inputSchema: schema({}), outputSchema: schema({ orders: { type: 'array', items: orderSchema }, asOf: string }) },
    { name: 'get_payment', description: 'Get payment status 支付状态。按订单编号返回 {orderId,status,paidHoursAgo,transactionId,auditTrail}，status 为 paid/refunded；只需使用业务状态，审计记录不参与判断。', inputSchema: schema(orderParam), outputSchema: schema({ orderId: string, status: { type: 'string', enum: ['paid', 'refunded'] }, paidHoursAgo: { type: 'number' }, transactionId: string, auditTrail: string }) },
    { name: 'get_shipment', description: 'Get shipment status 物流状态。按订单编号返回 {orderId,status,warehouse,trackingNo,scanHistory}，status 为 pending/shipped，trackingNo 可为 null；仓库用于跟进建议，扫描记录不参与判断。', inputSchema: schema(orderParam), outputSchema: schema({ orderId: string, status: { type: 'string', enum: ['pending', 'shipped'] }, warehouse: string, trackingNo: { type: ['string', 'null'] }, scanHistory: string }) },
  ];
  const names = ['inventory', 'customer_profile', 'product_catalog', 'coupon_rules', 'sales_chart', 'warehouse_capacity', 'sku_labels', 'refund_policy', 'tax_categories', 'supplier_profile', 'product_reviews', 'store_hours', 'category_tree', 'address_regions', 'promotion_calendar'];
  for (let i = 3; i < size; i++) {
    tools.push({ name: `read_${names[(i - 3) % names.length]}_${i}`, description: `读取${names[(i - 3) % names.length]}的演示配置；返回编号、标题、标签、更新时间和说明。这是另一个业务功能的只读接口。`, inputSchema: schema({ id: { type: 'string', description: '业务对象标识' }, includeDetails: { type: 'boolean', description: '是否包含完整说明' }, locale: { type: 'string', enum: ['zh-CN', 'en-US'] } }) });
  }
  return tools.map(t => ({ ...t, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
}
export function executeTool(name, args, orders) {
  if (name === 'list_orders') return { orders, asOf: FIXED_NOW };
  if (name === 'get_payment' || name === 'get_shipment') {
    const o = orders.find(o => o.orderId === args.orderId);
    if (!o) throw new Error(`Unknown order: ${args.orderId}`);
    return name === 'get_payment'
      ? { orderId: o.orderId, status: o.paymentStatus, paidHoursAgo: o.paidHoursAgo, transactionId: `DEMO-TXN-${o.orderId}`, auditTrail: '模拟支付网关审计记录。'.repeat(80) }
      : { orderId: o.orderId, status: o.shipmentStatus, warehouse: o.warehouse, trackingNo: o.shipmentStatus === 'shipped' ? 'DEMO-TRACKING' : null, scanHistory: '模拟仓库扫描记录，不影响状态核对。'.repeat(80) };
  }
  return { id: args.id, source: name, demo: true };
}
