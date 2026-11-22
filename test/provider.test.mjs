import assert from 'node:assert/strict'
import { once } from 'node:events'
import test from 'node:test'
import { provider } from '../source/provider.mjs'

async function listen(t) {
  const source = provider().listen(0, '127.0.0.1')
  t.after(() => new Promise((resolve, reject) => source.close(error => error ? reject(error) : resolve())))
  await once(source, 'listening')
  return 'http://127.0.0.1:' + source.address().port
}

function post(root, endpoint, value) {
  return fetch(root + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value) })
}

test('早期周档无法证明闭单不存在，仓库断线后仍可返回原预留', async t => {
  const root = await listen(t)
  const oldWeek = async () => (await (await fetch(root + '/repairs/archive?market=S&week=2')).json())
  assert.equal((await oldWeek()).indexed, false)
  await assert.rejects(post(root, '/stock/holds', { warehouse: 'W1', card: 'J2', key: 'h-J2' }))
  await post(root, '/lab?stage=late')
  assert.equal((await oldWeek()).orders[0].job, 'J4')
  assert.equal((await (await fetch(root + '/stock/receipts?key=h-J2')).json()).state, 'held')
  assert.equal((await post(root, '/stock/release', { receipt: 'H1' })).status, 202)
  await post(root, '/lab?stage=warehouse')
  assert.equal((await (await fetch(root + '/stock/receipts?key=h-J5')).json()).state, 'issued')
})
