# 厂家归档和仓储回执

`GET /repairs/archive?market=值&week=值` 返回 `indexed` 和 `orders`。未索引周不能推出无闭单。`GET /repairs/handover` 给跨批次换件单，`retains` 是厂方是否转接维修权。
`GET /stock/bins` 列仓、备件种类、销售市场和可用件数。`POST /stock/holds` 接仓号、服务卡、备件和请求号。`GET /stock/receipts?key=请求号` 有 `held`、`released`、`issued`、`expired` 等真实仓储状态。对未出库预留，`POST /stock/release` 接回执号，最终结果需回查。
演练 `week` 为首次领取后掉线，`late` 出现厂家闭单，`warehouse` 可看到原库存预留与新的库存分布。`shortage` 演示预留过期：旧预留号已失效，重新预留须用新尝试号，过期号不得转给另一家。`sglate` 演示 SG 的迟到闭单使已出库件额度用尽，应留下核查单。旧字段仍见资料格式。

仓库 W1 可处理 MY、SG 两市场，劣后站 W2 只服务 SG。归档挂在销售市场和有效周，J4 的厂批 V 在改签时转到 L。新申请可以查成品箱和备件的联合凭据，备件类型与当期仓库存量分别处理。

J5 是 SG 的另一台电机，和 J2 虽来自不同厂批，却争用 W1 同类库存；J5 已出库的事实独立于 MY 的继承闭单。
