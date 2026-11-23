import { ProviderClient, SourceClient } from './clients.mjs'
import {
  buildCards, buildChains, buildEdges, collectPairs,
  diffEdges, findAuditTargets, pairKey, weekOf
} from './domain.mjs'

const STREAMS = ['cartons', 'components', 'plans', 'shops', 'requests', 'replacements', 'completed']

// 采集服务：一轮 collect 拉齐来源资料与外部凭据，评估服务卡并对账仓储预留
export class Collector {
  constructor({ sourceUrl, providerUrl, now } = {}) {
    this.source = new SourceClient(sourceUrl)
    this.provider = new ProviderClient(providerUrl)
    this.fixedNow = now
    this.holds = new Map()
    this.audits = []
    this.refetch = []
    this.edges = []
    this.edition = null
    this.state = null
    this.refetchSequence = 0
    this.confirmedCloses = new Set()
  }

  async collect() {
    const catalog = await this.source.catalog()
    const edition = catalog.edition
    const streams = {}
    for (const name of STREAMS) streams[name] = await this.source.stream(name, edition)
    const handover = (await this.provider.handover()) ?? []
    const bins = (await this.provider.bins()) ?? this.state?.bins ?? []
    const now = this.fixedNow ?? Math.max(0, ...streams.requests.map(row => Number(row[5])))
    const requestsById = new Map(streams.requests.map(row => [row[0], row]))
    const cartonsById = new Map()
    for (const row of streams.cartons) {
      if (!cartonsById.has(row[0])) cartonsById.set(row[0], row)
    }
    const closes = await this.collectCloses(streams, requestsById, cartonsById)
    const edges = buildEdges(streams.replacements, handover)
    const chains = buildChains(edges, collectPairs(streams, closes))
    if (this.edition !== null) {
      // 盘点表更正继承边：看出哪些凭据和未办卡因此应重新取
      const changes = diffEdges(this.edges, edges)
      if (changes.length) this.recordRefetch(changes, { chains, streams, cartonsById, closes, edition })
    }
    const cards = buildCards({ streams, edges, chains, closes })
    await this.reconcile(cards, bins, now)
    for (const target of findAuditTargets(cards)) this.recordAudit(target)
    for (const card of cards.values()) {
      const hold = this.holds.get(card.request)
      card.hold = hold
        ? {
            key: hold.key, receipt: hold.receipt, warehouse: hold.warehouse,
            state: hold.state, expires: hold.expires
          }
        : null
      card.status = this.statusOf(card, hold, now)
      card.filed = card.status === 'closed' || card.status === 'issued' || card.status === 'ready'
    }
    for (const entry of this.refetch) {
      if (entry.state === 'pending') entry.state = 'done'
    }
    this.edges = edges
    this.edition = edition
    this.state = { edition, bins, now, cards }
    return this.summary()
  }

  // 旧工单按销售市场与交接周归档；未索引周不能推出无闭单，只能标待查
  async collectCloses(streams, requestsById, cartonsById) {
    const closes = []
    for (const row of streams.completed) {
      const request = requestsById.get(row[0])
      const carton = request ? cartonsById.get(request[1]) : null
      closes.push({
        request: row[0], batch: row[1], part: row[2], close: row[3],
        market: carton ? carton[3] : null,
        week: request ? weekOf(Number(request[5])) : null,
        confirmed: false
      })
    }
    const targets = new Set()
    for (const close of closes) {
      if (close.market && close.week !== null) targets.add(close.market + ':' + close.week)
    }
    for (const row of streams.requests) {
      const carton = cartonsById.get(row[1])
      if (carton) targets.add(carton[3] + ':' + weekOf(Number(row[5])))
    }
    for (const target of targets) {
      const [market, week] = target.split(':')
      const archive = await this.provider.archive(market, week)
      if (!archive?.indexed) continue
      for (const order of archive.orders ?? []) {
        const known = closes.find(close => close.close === order.close)
        if (known) {
          known.confirmed = true
        } else {
          // 迟到闭单：归档里出现而来源尚未登记
          closes.push({
            request: order.job, batch: order.batch, part: order.part, close: order.close,
            market, week: Number(week), confirmed: true
          })
        }
      }
    }
    // 已闭单事实独立于当前可用次数：确认过的闭单不因柜点掉线而推翻
    for (const close of closes) {
      if (close.confirmed) this.confirmedCloses.add(close.close)
      else if (this.confirmedCloses.has(close.close)) close.confirmed = true
    }
    return closes
  }

  async reconcile(cards, bins, now) {
    for (const card of cards.values()) {
      try {
        await this.reconcileCard(card, bins, now)
      } catch (error) {
        card.concerns.push({ code: 'reconcile-error', detail: error.message })
      }
    }
  }

  async reconcileCard(card, bins, now) {
    const existing = this.holds.get(card.request)
    if (card.outcome !== 'actionable') {
      // 未出库的预留可释放，让另一张合法的卡承接；已出库的不能释放
      if (existing && existing.state === 'held' && !existing.dead) {
        const accepted = await this.provider.release(existing.receipt)
        if (accepted !== null) existing.state = 'release-pending'
      } else if (existing && existing.state === 'release-pending') {
        // 释放的最终结果需回查
        const receipt = await this.provider.receipt(existing.key)
        if (receipt?.state === 'released') existing.state = 'released'
      }
      return
    }
    if (card.known === 'issued') {
      const key = 'h-' + card.request
      const receipt = await this.provider.receipt(key)
      if (receipt && receipt.card === card.request && receipt.state === 'issued') {
        this.holds.set(card.request, {
          key, receipt: receipt.receipt ?? null, warehouse: receipt.warehouse ?? null,
          state: 'issued', expires: receipt.expires, attempt: 1
        })
      } else if (!this.holds.has(card.request)) {
        card.concerns.push({ code: 'receipt-unconfirmed', detail: '来源标记已出库，仓储回执暂未确认' })
      }
      return
    }
    if (existing && !existing.dead) {
      const receipt = await this.provider.receipt(existing.key)
      if (receipt && receipt.card === card.request) {
        existing.state = receipt.state
        existing.receipt = receipt.receipt ?? existing.receipt
        existing.warehouse = receipt.warehouse ?? existing.warehouse
        existing.expires = receipt.expires
      } else if (!receipt) {
        card.concerns.push({ code: 'receipt-unconfirmed', detail: `预留 ${existing.key} 暂未查到回执` })
      }
      if (this.isExpired(existing, now) || existing.state === 'released') {
        existing.dead = true
        card.concerns.push({
          code: 'hold-expired',
          detail: `预留号 ${existing.key} 已失效，过期预留号不得转给另一家`
        })
        await this.acquire(card, bins, (existing.attempt ?? 1) + 1, now)
      }
      return
    }
    // 掉线或重启后的恢复：先查源仓是否占了库存
    const key = 'h-' + card.request
    const receipt = await this.provider.receipt(key)
    if (receipt && receipt.card === card.request) {
      if (!this.isExpired(receipt, now) && receipt.state !== 'released' && receipt.state !== 'expired') {
        this.adopt(card, key, receipt, 1)
        return
      }
      card.concerns.push({
        code: 'hold-expired',
        detail: `预留号 ${key} 已失效，过期预留号不得转给另一家`
      })
      await this.acquire(card, bins, 2, now)
      return
    }
    await this.acquire(card, bins, 1, now)
  }

  // 通过资格初审后向实际出货仓预留库存；预留只对仓、到期时刻和具体服务卡有效
  async acquire(card, bins, attempt, now) {
    const key = attempt <= 1 ? 'h-' + card.request : `h-${card.request}-${attempt}`
    const existing = await this.provider.receipt(key)
    if (existing && existing.card === card.request &&
        !this.isExpired(existing, now) && existing.state !== 'released') {
      this.adopt(card, key, existing, attempt)
      return
    }
    // 仓可处理多个销售地的同种件：按件类与销售地挑有库存的仓
    const candidates = bins.filter(bin =>
      bin.part === card.type && bin.markets.includes(card.market) && bin.available > 0)
    if (!candidates.length) {
      card.stockState = 'no-stock'
      return
    }
    for (const bin of candidates) {
      let response
      try {
        response = await this.provider.hold({ warehouse: bin.warehouse, card: card.request, key })
      } catch {
        // 首次没收到回执：先查源仓是否占了库存，再决定释放或另找有授权库存的仓
        const receipt = await this.provider.receipt(key)
        if (receipt && receipt.card === card.request && receipt.state !== 'expired') {
          this.adopt(card, key, receipt, attempt)
          return
        }
        continue
      }
      if (response === null) continue
      const receipt = await this.provider.receipt(key)
      if (receipt && receipt.card === card.request) {
        this.adopt(card, key, receipt, attempt)
      } else {
        this.holds.set(card.request, {
          key, receipt: response?.receipt ?? null, warehouse: bin.warehouse,
          state: 'held', expires: response?.expires, attempt
        })
        card.concerns.push({ code: 'receipt-unconfirmed', detail: `预留 ${key} 已受理，回执待查` })
      }
      return
    }
    card.stockState = 'hold-failed'
  }

  adopt(card, key, receipt, attempt) {
    this.holds.set(card.request, {
      key, receipt: receipt.receipt ?? null, warehouse: receipt.warehouse ?? null,
      state: receipt.state, expires: receipt.expires, attempt
    })
  }

  isExpired(hold, now) {
    return hold.state === 'expired' ||
      (hold.expires !== undefined && hold.expires !== null && now > hold.expires)
  }

  statusOf(card, hold, now) {
    if (card.outcome === 'closed') return 'closed'
    if (card.outcome === 'blocked') return 'blocked'
    if (card.known === 'issued') return 'issued'
    if (hold && !hold.dead) {
      if (hold.state === 'issued') return 'issued'
      if (hold.state === 'held' && !this.isExpired(hold, now)) return 'ready'
    }
    return 'pending-stock'
  }

  recordRefetch(changes, { chains, streams, cartonsById, closes, edition }) {
    const kindLabel = { added: '新增', corrected: '更正', removed: '删除' }
    const requestsByPair = new Map()
    for (const row of streams.requests) {
      const carton = cartonsById.get(row[1])
      const pair = pairKey(carton ? carton[1] : row[2], row[3])
      const list = requestsByPair.get(pair) ?? []
      list.push(row[0])
      requestsByPair.set(pair, list)
    }
    for (const change of changes) {
      const { edge } = change
      const label =
        `继承边 ${edge.id}（${edge.before}→${edge.after}，${edge.inherit ? '继承' : '不继承'}）${kindLabel[change.kind]}`
      const affected = new Set([...chains.membersOf(edge.before), ...chains.membersOf(edge.after)])
      for (const pair of affected) {
        for (const request of requestsByPair.get(pair) ?? []) {
          this.pushRefetch({ kind: 'card', target: request, reason: `${label}，服务卡需重新评估`, edition })
        }
        for (const close of closes.filter(entry => pairKey(entry.batch, entry.part) === pair && entry.market)) {
          this.pushRefetch({
            kind: 'credential', target: `archive:${close.market}:${close.week}`,
            reason: `${label}，闭单凭据需重新取`, edition
          })
        }
      }
      this.pushRefetch({
        kind: 'credential', target: 'handover',
        reason: `${label}，厂家交接凭据需重新取`, edition
      })
    }
  }

  pushRefetch(entry) {
    const duplicate = this.refetch.some(record =>
      record.kind === entry.kind && record.target === entry.target && record.reason === entry.reason)
    if (duplicate) return
    this.refetch.push({ id: 'R' + ++this.refetchSequence, state: 'pending', ...entry })
  }

  // 已出库的件遇迟到闭单使额度用尽：留下核查单并显示仍占哪份旧维修权
  recordAudit({ card, closes }) {
    const hold = this.holds.get(card.request)
    for (const close of closes) {
      const id = `A-${card.request}-${close.close}`
      if (this.audits.some(audit => audit.id === id)) continue
      this.audits.push({
        id, card: card.request, state: 'open',
        warehouse: hold?.warehouse ?? null, receipt: hold?.receipt ?? null,
        occupiedRight: { at: pairKey(close.batch, close.part), close: close.close, request: close.request },
        detail: `已出库件遇迟到闭单 ${close.close}，${card.market} 的 ${card.type} 额度 ${card.plan.times} 已用尽，` +
          `仍占旧维修权 ${pairKey(close.batch, close.part)}`
      })
    }
  }

  summary() {
    const cards = [...this.state.cards.values()]
    const count = status => cards.filter(card => card.status === status).length
    return {
      edition: this.edition,
      cards: cards.length,
      ready: count('ready'),
      issued: count('issued'),
      closed: count('closed'),
      blocked: count('blocked'),
      pendingStock: count('pending-stock'),
      audits: this.audits.length,
      refetchPending: this.refetch.filter(entry => entry.state === 'pending').length
    }
  }
}
