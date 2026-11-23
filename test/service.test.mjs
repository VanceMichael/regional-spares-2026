import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { createSource } from '../source/source.mjs'
import { provider } from '../source/provider.mjs'
import { createApp } from '../service/app.mjs'

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

async function setup(t) {
  const sourceUrl = await listen(t, createSource())
  const providerUrl = await listen(t, provider())
  const appUrl = await listen(t, createApp({ sourceUrl, providerUrl }))
  return { sourceUrl, providerUrl, appUrl }
}

const get = async url => (await fetch(url)).json()
const post = async url => (await fetch(url, { method: 'POST' })).json()
const cardOf = (cards, id) => cards.find(card => card.request === id)

test('采集服务找回凭据形成服务卡，并跟随演练档推进', async t => {
  const { sourceUrl, providerUrl, appUrl } = await setup(t)

  // 第一回合：r1 资料，首次预留掉线，回查后认领源仓库存
  let summary = await post(appUrl + '/collect')
  assert.equal(summary.edition, 'r1')
  let cards = await get(appUrl + '/cards')
  let j2 = cardOf(cards, 'J2')
  assert.equal(j2.status, 'ready')
  assert.equal(j2.batch, 'L')
  assert.equal(j2.type, 'MOT')
  assert.deepEqual(j2.chain, ['L/02'])
  assert.equal(j2.hold.receipt, 'H1')
  assert.equal(j2.hold.warehouse, 'W1')
  let lab = await get(providerUrl + '/lab')
  assert.equal(lab.arrivals.filter(arrival => arrival.path === '/stock/holds').length, 1)
  // 掉线恢复后再采集不重复预留
  await post(appUrl + '/collect')
  lab = await get(providerUrl + '/lab')
  assert.equal(lab.arrivals.filter(arrival => arrival.path === '/stock/holds').length, 1)
  cards = await get(appUrl + '/cards')
  assert.equal(cardOf(cards, 'J1').status, 'pending-stock')
  assert.equal(cardOf(cards, 'J3').status, 'pending-stock')
  assert.equal(cardOf(cards, 'J4').status, 'closed')
  assert.equal(cardOf(cards, 'J5').status, 'issued')
  assert.ok(cardOf(cards, 'J5').concerns.some(concern => concern.code === 'receipt-unconfirmed'))

  // 第二回合：盘点表更正继承边（r1→r2），归档仍未索引，闭单标待查
  await post(sourceUrl + '/control?edition=r2')
  summary = await post(appUrl + '/collect')
  assert.equal(summary.edition, 'r2')
  cards = await get(appUrl + '/cards')
  j2 = cardOf(cards, 'J2')
  assert.deepEqual(j2.chain, ['L/02', 'V/02'])
  assert.equal(j2.status, 'ready')
  assert.ok(j2.concerns.some(concern => concern.code === 'closes-pending'))
  assert.equal(j2.quota.pending, 1)
  assert.equal(j2.quota.confirmed, 0)
  // 互不继承的同号件各管各的
  assert.deepEqual(cardOf(cards, 'J1').chain, ['L/01'])
  assert.deepEqual(cardOf(cards, 'J3').chain, ['K/01'])
  // 继承边更正后，能看出哪些凭据和未办卡应重新取
  const refetch = await get(appUrl + '/refetch')
  for (const target of ['J1', 'J2', 'J3', 'J4']) {
    assert.ok(refetch.some(entry => entry.kind === 'card' && entry.target === target), target)
  }
  assert.ok(refetch.some(entry => entry.kind === 'credential' && entry.target === 'archive:MY:2'))
  assert.ok(refetch.some(entry => entry.kind === 'credential' && entry.target === 'handover'))

  // 第三回合：厂家闭单确认，继承链额度用尽，未出库的预留被释放
  await post(providerUrl + '/lab?stage=late')
  await post(appUrl + '/collect')
  cards = await get(appUrl + '/cards')
  j2 = cardOf(cards, 'J2')
  assert.equal(j2.status, 'blocked')
  assert.ok(j2.reasons.some(reason => reason.code === 'quota-exhausted'))
  assert.equal(j2.quota.confirmed, 1)
  assert.equal(j2.hold.state, 'release-pending')
  lab = await get(providerUrl + '/lab')
  assert.ok(lab.arrivals.some(arrival =>
    arrival.path === '/stock/release' && arrival.payload?.receipt === 'H1'))

  // 第四回合：回查确认释放结果，J5 回执已出库，门店查到可交接的件和仓号
  await post(providerUrl + '/lab?stage=warehouse')
  await post(appUrl + '/collect')
  cards = await get(appUrl + '/cards')
  assert.equal(cardOf(cards, 'J2').hold.state, 'released')
  const j5 = cardOf(cards, 'J5')
  assert.equal(j5.hold.receipt, 'H2')
  assert.equal(j5.hold.warehouse, 'W1')
  const handover = await get(appUrl + '/handover')
  assert.deepEqual(handover.map(entry => entry.request), ['J5'])
  assert.equal(handover[0].warehouse, 'W1')
  // 已办卡明细与未办原因
  const filed = await get(appUrl + '/cards?filed=true')
  assert.deepEqual(filed.map(card => card.request).sort(), ['J4', 'J5'])
  const unfiled = await get(appUrl + '/unfiled')
  assert.deepEqual(unfiled.map(entry => entry.request).sort(), ['J1', 'J2', 'J3'])
  assert.ok(unfiled.find(entry => entry.request === 'J2')
    .reasons.some(reason => reason.code === 'quota-exhausted'))
  assert.ok(unfiled.find(entry => entry.request === 'J1')
    .reasons.some(reason => reason.code === 'no-stock'))
  assert.equal((await get(appUrl + '/audits')).length, 0)
})

test('过期预留号不得转给另一家，需用新尝试号重新预留', async t => {
  const { providerUrl, appUrl } = await setup(t)
  await post(providerUrl + '/lab?stage=shortage')
  await post(appUrl + '/collect')
  const lab = await get(providerUrl + '/lab')
  const holds = lab.arrivals.filter(arrival => arrival.path === '/stock/holds')
  assert.equal(holds.length, 1)
  assert.equal(holds[0].payload.card, 'J2')
  assert.equal(holds[0].payload.key, 'h-J2-2')
  assert.ok(!holds.some(arrival => arrival.payload.key === 'h-J2'))
  assert.ok(!holds.some(arrival => arrival.payload.key === 'h-J5'))
  const cards = await get(appUrl + '/cards')
  const j2 = cardOf(cards, 'J2')
  assert.equal(j2.status, 'ready')
  assert.equal(j2.hold.receipt, 'H9')
  assert.ok(j2.concerns.some(concern => concern.code === 'hold-expired'))
  const handover = await get(appUrl + '/handover')
  assert.deepEqual(handover.map(entry => entry.request), ['J2'])
})

test('已出库件遇迟到闭单使额度用尽，留下核查单并显示仍占的旧维修权', async t => {
  const { sourceUrl, providerUrl, appUrl } = await setup(t)
  await post(sourceUrl + '/control?edition=r2')
  await post(providerUrl + '/lab?stage=sglate')
  await post(appUrl + '/collect')
  const audits = await get(appUrl + '/audits')
  assert.equal(audits.length, 2)
  assert.ok(audits.every(audit => audit.card === 'J5'))
  assert.ok(audits.every(audit => audit.occupiedRight.at === 'G/03'))
  assert.deepEqual(audits.map(audit => audit.occupiedRight.close).sort(), ['C8', 'C9'])
  const cards = await get(appUrl + '/cards')
  const j5 = cardOf(cards, 'J5')
  assert.equal(j5.status, 'issued')
  assert.equal(j5.quota.confirmed, 2)
  assert.equal(j5.hold.state, 'issued')
})
