import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCards, buildChains, collectPairs, diffEdges, findAuditTargets, weekOf
} from '../service/domain.mjs'

const baseStreams = () => ({
  cartons: [['C1', 'B1', 'D1', 'MY', 'M']],
  components: [['B1', 'D1', '02', 'MOT']],
  plans: [['MY', 'M', 'MOT', '30', '1']],
  shops: [['W', 'MY', 'MOT']],
  requests: [['J9', 'C1', 'B1', '02', 'W', '12', 'open']],
  replacements: [],
  completed: []
})

function evaluate(streams, edges, closes) {
  const chains = buildChains(edges, collectPairs(streams, closes))
  return buildCards({ streams, edges, chains, closes })
}

test('交接周按申请日折算', () => {
  assert.equal(weekOf(0), 1)
  assert.equal(weekOf(6), 1)
  assert.equal(weekOf(7), 2)
  assert.equal(weekOf(11), 2)
  assert.equal(weekOf(13), 2)
})

test('迟到闭单未确认前标待查，不当作余额可用', () => {
  const streams = baseStreams()
  const edges = [{ id: 'X1', before: 'B0/02', after: 'B1/02', inherit: true, via: '盘点表' }]
  const pending = [
    { request: 'J8', batch: 'B0', part: '02', close: 'C9', market: 'MY', week: 2, confirmed: false }
  ]
  let cards = evaluate(streams, edges, pending)
  let card = cards.get('J9')
  assert.equal(card.outcome, 'actionable')
  assert.deepEqual(card.chain, ['B0/02', 'B1/02'])
  assert.equal(card.quota.pending, 1)
  assert.equal(card.quota.remaining, 1)
  assert.ok(card.concerns.some(concern => concern.code === 'closes-pending'))
  const confirmed = [{ ...pending[0], confirmed: true }]
  cards = evaluate(streams, edges, confirmed)
  card = cards.get('J9')
  assert.equal(card.outcome, 'blocked')
  assert.ok(card.reasons.some(reason => reason.code === 'quota-exhausted'))
})

test('互不继承的同号件各管各的', () => {
  const streams = baseStreams()
  const edges = [{ id: 'X2', before: 'B0/02', after: 'B1/02', inherit: false, via: '盘点表' }]
  const closes = [
    { request: 'J8', batch: 'B0', part: '02', close: 'C9', market: 'MY', week: 2, confirmed: true }
  ]
  const cards = evaluate(streams, edges, closes)
  const card = cards.get('J9')
  assert.deepEqual(card.chain, ['B1/02'])
  assert.equal(card.outcome, 'actionable')
})

test('申报批次与纸箱记录不符时按真正厂批处理', () => {
  const streams = baseStreams()
  streams.requests = [['J9', 'C1', 'BX', '02', 'W', '12', 'open']]
  const cards = evaluate(streams, [], [])
  const card = cards.get('J9')
  assert.equal(card.batch, 'B1')
  assert.ok(card.concerns.some(concern => concern.code === 'batch-corrected'))
})

test('维修台可办种类只看销售地授权，仓所在市场不能顶替', () => {
  const streams = baseStreams()
  streams.shops = [['W', 'SG', 'MOT']]
  const cards = evaluate(streams, [], [])
  const card = cards.get('J9')
  assert.equal(card.outcome, 'blocked')
  assert.ok(card.reasons.some(reason => reason.code === 'shop-unauthorized'))
})

test('已出库件遇迟到闭单使额度用尽时成为核查对象且不释放', () => {
  const streams = baseStreams()
  streams.requests = [['J9', 'C1', 'B1', '02', 'W', '12', 'issued']]
  const closes = [
    { request: 'J8', batch: 'B1', part: '02', close: 'C9', market: 'MY', week: 2, confirmed: true }
  ]
  const cards = evaluate(streams, [], closes)
  const card = cards.get('J9')
  assert.notEqual(card.outcome, 'blocked')
  const targets = findAuditTargets(cards)
  assert.equal(targets.length, 1)
  assert.equal(targets[0].card.request, 'J9')
  assert.equal(targets[0].closes[0].close, 'C9')
})

test('继承边更正能分出新增、改正与删除', () => {
  const before = [
    { id: 'X1', before: 'A/01', after: 'B/01', inherit: true },
    { id: 'X2', before: 'C/01', after: 'D/01', inherit: false }
  ]
  const after = [
    { id: 'X1', before: 'A/01', after: 'B/01', inherit: false },
    { id: 'X3', before: 'E/01', after: 'F/01', inherit: true }
  ]
  const changes = diffEdges(before, after)
  assert.deepEqual(changes.map(change => change.kind).sort(), ['added', 'corrected', 'removed'])
})
