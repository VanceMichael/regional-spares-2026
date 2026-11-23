import http from 'node:http'
import { Collector } from './collector.mjs'

// 门店可查：可交接的件和仓号
function handoverView(state) {
  if (!state) return []
  return [...state.cards.values()]
    .filter(card => (card.status === 'ready' || card.status === 'issued') && card.hold)
    .map(card => ({
      request: card.request,
      type: card.type,
      batch: card.batch,
      part: card.part,
      warehouse: card.hold.warehouse,
      receipt: card.hold.receipt,
      expires: card.hold.expires,
      state: card.status === 'ready' ? 'held' : 'issued',
      pending: card.concerns.length > 0
    }))
}

// 门店可查：未办原因
function unfiledView(state) {
  if (!state) return []
  return [...state.cards.values()]
    .filter(card => !card.filed)
    .map(card => ({
      request: card.request,
      status: card.status,
      reasons: card.reasons.length ? card.reasons : [stockReason(card)],
      concerns: card.concerns
    }))
}

function stockReason(card) {
  if (card.stockState === 'hold-failed') {
    return { code: 'hold-failed', detail: '预留未成功，待下次领取重试' }
  }
  return { code: 'no-stock', detail: '授权仓暂无该件类可用库存' }
}

export function createApp(options) {
  const collector = new Collector(options)
  return http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const send = (code, data) => {
      response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(data))
    }
    try {
      if (url.pathname === '/health') {
        return send(200, { ok: true, edition: collector.edition })
      }
      if (url.pathname === '/collect') {
        if (request.method !== 'POST') return send(405, { error: '不支持该操作' })
        return send(200, await collector.collect())
      }
      if (request.method !== 'GET') return send(405, { error: '不支持该操作' })
      if (url.pathname === '/cards') {
        const filed = url.searchParams.get('filed')
        let cards = [...(collector.state?.cards.values() ?? [])]
        if (filed === 'true') cards = cards.filter(card => card.filed)
        if (filed === 'false') cards = cards.filter(card => !card.filed)
        return send(200, cards)
      }
      const cardMatch = /^\/cards\/([\w-]+)$/.exec(url.pathname)
      if (cardMatch) {
        const card = collector.state?.cards.get(cardMatch[1])
        return card ? send(200, card) : send(404, { error: '没有该服务卡' })
      }
      if (url.pathname === '/handover') return send(200, handoverView(collector.state))
      if (url.pathname === '/unfiled') return send(200, unfiledView(collector.state))
      if (url.pathname === '/audits') return send(200, collector.audits)
      if (url.pathname === '/refetch') return send(200, collector.refetch)
      if (url.pathname === '/stock') return send(200, collector.state?.bins ?? [])
      return send(404, { error: '没有该资料' })
    } catch (error) {
      return send(500, { error: error.message })
    }
  })
}
