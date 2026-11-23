// 领域规则：凭据链、资格初审、闭单确认与额度核算。全部为纯函数，便于单测。

export const pairKey = (batch, part) => batch + '/' + part

// 旧工单按销售市场与交接周归档：申请日折算交接周
export const weekOf = day => Math.floor(day / 7) + 1

// 维修权链：只有"继承"边把新旧批次并成同一条实物权利
export class Chains {
  constructor() {
    this.parent = new Map()
  }

  add(key) {
    if (!this.parent.has(key)) this.parent.set(key, key)
  }

  find(key) {
    this.add(key)
    let root = key
    while (this.parent.get(root) !== root) root = this.parent.get(root)
    let node = key
    while (node !== root) {
      const next = this.parent.get(node)
      this.parent.set(node, root)
      node = next
    }
    return root
  }

  union(a, b) {
    const first = this.find(a)
    const second = this.find(b)
    if (first !== second) this.parent.set(second, first)
  }

  membersOf(key) {
    const root = this.find(key)
    return [...this.parent.keys()].filter(candidate => this.find(candidate) === root)
  }
}

// 继承边来自两处：来源的换件单（盘点表）与厂家交接凭据
export function buildEdges(replacements, handover) {
  const edges = []
  for (const row of replacements ?? []) {
    edges.push({
      id: row[0],
      before: pairKey(row[1], row[2]),
      after: pairKey(row[3], row[4]),
      inherit: row[5] === 'inherit',
      via: '盘点表'
    })
  }
  for (const order of handover ?? []) {
    edges.push({
      id: order.handover,
      before: pairKey(order.before[0], order.before[1]),
      after: pairKey(order.after[0], order.after[1]),
      inherit: Boolean(order.retains),
      via: '厂家交接'
    })
  }
  return edges
}

export function collectPairs(streams, closes) {
  const pairs = new Set()
  for (const row of streams.components ?? []) pairs.add(pairKey(row[0], row[2]))
  for (const row of streams.requests ?? []) pairs.add(pairKey(row[2], row[3]))
  for (const row of streams.completed ?? []) pairs.add(pairKey(row[1], row[2]))
  for (const close of closes ?? []) pairs.add(pairKey(close.batch, close.part))
  return [...pairs]
}

export function buildChains(edges, pairs) {
  const chains = new Chains()
  for (const pair of pairs) chains.add(pair)
  for (const edge of edges) {
    chains.add(edge.before)
    chains.add(edge.after)
    if (edge.inherit) chains.union(edge.before, edge.after)
  }
  return chains
}

// 盘点表更正继承边时，分出新增、改正与删除
export function diffEdges(previous, current) {
  const changes = []
  const before = new Map(previous.map(edge => [edge.id, edge]))
  for (const edge of current) {
    const old = before.get(edge.id)
    if (!old) {
      changes.push({ kind: 'added', edge })
    } else if (old.before !== edge.before || old.after !== edge.after || old.inherit !== edge.inherit) {
      changes.push({ kind: 'corrected', edge, was: old })
    }
  }
  const now = new Set(current.map(edge => edge.id))
  for (const old of previous) {
    if (!now.has(old.id)) changes.push({ kind: 'removed', edge: old })
  }
  return changes
}

function deny(card, code, detail) {
  card.outcome = 'blocked'
  card.reasons.push({ code, detail })
}

// 对每张维修请求做资格初审：找回真正厂批、核对销售地授权、按继承链核算额度
export function buildCards({ streams, edges, chains, closes }) {
  const cartonsById = new Map()
  for (const row of streams.cartons) {
    const list = cartonsById.get(row[0]) ?? []
    list.push(row)
    cartonsById.set(row[0], list)
  }
  const plans = new Map(streams.plans.map(row => [
    row[0] + '|' + row[1] + '|' + row[2],
    { deadline: Number(row[3]), times: Number(row[4]) }
  ]))
  // 可办种类由销售地授权决定，不能用仓库所在地顶替
  const shopRights = new Set(streams.shops.map(row => row.join('|')))
  const closesByPair = new Map()
  for (const close of closes) {
    const key = pairKey(close.batch, close.part)
    const list = closesByPair.get(key) ?? []
    list.push(close)
    closesByPair.set(key, list)
  }
  const cards = new Map()
  for (const row of streams.requests) {
    const [id, carton, claimedBatch, part, shop, day, known] = row
    const card = {
      request: id, carton, claimedBatch, part, shop,
      day: Number(day), week: weekOf(Number(day)), known,
      concerns: [], reasons: [], chain: [], chainEdges: [], closes: [],
      outcome: 'actionable'
    }
    cards.set(id, card)
    const cartonRows = cartonsById.get(carton)
    if (!cartonRows) {
      deny(card, 'unknown-carton', `纸箱号 ${carton} 在来源资料中不存在`)
      continue
    }
    // 找回真正的工厂批次：以纸箱记录为准，不以门店申报为准
    card.batch = cartonRows[0][1]
    card.market = cartonRows[0][3]
    card.model = cartonRows[0][4]
    if (card.batch !== claimedBatch) {
      card.concerns.push({
        code: 'batch-corrected',
        detail: `申报批次 ${claimedBatch} 与纸箱记录不符，已按真正厂批 ${card.batch} 处理`
      })
    }
    const devices = cartonRows.map(record => record[2])
    const component = streams.components.find(candidate =>
      candidate[0] === card.batch && candidate[2] === part && devices.includes(candidate[1]))
    if (!component) {
      deny(card, 'unknown-part', `厂批 ${card.batch} 的装置 ${devices.join('、')} 下找不到件号 ${part}`)
      continue
    }
    card.device = component[1]
    card.type = component[3]
    if (!shopRights.has([shop, card.market, card.type].join('|'))) {
      deny(card, 'shop-unauthorized',
        `维修台 ${shop} 未获销售地 ${card.market} 的 ${card.type} 受理授权，仓所在市场不能顶替`)
      continue
    }
    const plan = plans.get([card.market, card.model, card.type].join('|'))
    if (!plan) {
      deny(card, 'no-plan', `销售地 ${card.market} 没有机型 ${card.model} 的 ${card.type} 备件计划`)
      continue
    }
    card.plan = plan
    if (card.day > plan.deadline) {
      deny(card, 'deadline-passed', `申请日 ${card.day} 已超过截止日 ${plan.deadline}`)
      continue
    }
    // 领证范围跨新旧两边：沿继承链取闭单
    card.chain = chains.membersOf(pairKey(card.batch, part)).sort()
    card.chainEdges = edges
      .filter(edge => card.chain.includes(edge.before) && card.chain.includes(edge.after))
      .map(edge => edge.id)
    const relevant = card.chain
      .flatMap(pair => closesByPair.get(pair) ?? [])
      .filter(close => close.market === card.market)
    card.closes = [...new Map(relevant.map(close => [close.close, close])).values()]
    const confirmed = card.closes.filter(close => close.confirmed)
    const pending = card.closes.filter(close => !close.confirmed)
    card.quota = {
      times: plan.times,
      confirmed: confirmed.length,
      pending: pending.length,
      issued: 0,
      remaining: plan.times - confirmed.length
    }
    if (pending.length) {
      // 旧闭单效力无法确认前先标待查，不能当作余额可用
      card.concerns.push({
        code: 'closes-pending',
        detail: `闭单 ${pending.map(close => close.close).join('、')} 效力待查，未当作余额可用`
      })
    }
    if (known === 'completed') {
      card.outcome = 'closed'
      continue
    }
    // 已出库的卡不能按额度否决，迟到闭单走核查单
    if (known !== 'issued' && confirmed.length >= plan.times) {
      deny(card, 'quota-exhausted',
        `继承链 ${card.chain.join('、')} 已确认闭单 ${confirmed.length} 次，计划仅 ${plan.times} 次`)
    }
  }
  // 同链、同销售地、同件类的已出库占用也消耗维修权
  const issued = [...cards.values()].filter(card =>
    card.known === 'issued' && card.outcome === 'actionable' && card.plan)
  for (const card of cards.values()) {
    if (card.outcome !== 'actionable' || card.known === 'issued' || !card.plan) continue
    const root = chains.find(pairKey(card.batch, card.part))
    const others = issued.filter(candidate =>
      candidate.request !== card.request &&
      chains.find(pairKey(candidate.batch, candidate.part)) === root &&
      candidate.market === card.market && candidate.type === card.type)
    if (!others.length) continue
    card.quota.issued = others.length
    card.quota.remaining -= others.length
    if (card.quota.confirmed + others.length >= card.plan.times) {
      deny(card, 'quota-exhausted', `继承链 ${card.chain.join('、')} 的维修权已被已出库件占用`)
    }
  }
  return cards
}

// 已出库的件遇迟到闭单使额度用尽：留下核查单的对象
export function findAuditTargets(cards) {
  const targets = []
  for (const card of cards.values()) {
    if (card.known !== 'issued' || !card.plan) continue
    const confirmed = card.closes.filter(close => close.confirmed)
    if (confirmed.length >= card.plan.times) targets.push({ card, closes: confirmed })
  }
  return targets
}
