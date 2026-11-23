const jsonHeaders = { 'Content-Type': 'application/json' }

function parseRows(text) {
  return text.split('\n').filter(Boolean).map(line => line.split('\t'))
}

// 本地来源：目录、资料版隔离、逐页领取与条件请求
export class SourceClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
    this.cache = new Map()
  }

  async catalog() {
    const response = await fetch(this.baseUrl + '/catalog')
    if (!response.ok) throw new Error('来源目录不可用：' + response.status)
    return response.json()
  }

  async stream(name, edition) {
    const key = edition + ':' + name
    const cached = this.cache.get(key)
    const headers = cached ? { 'If-None-Match': cached.etag } : {}
    let response = await fetch(
      this.baseUrl + '/records/' + name + '?edition=' + encodeURIComponent(edition), { headers })
    if (response.status === 404) {
      this.cache.delete(key)
      return []
    }
    if (response.status === 304 && cached) return cached.rows
    if (!response.ok) throw new Error(`资料流 ${name} 领取失败：${response.status}`)
    if (response.headers.get('X-Edition') !== edition) {
      throw new Error(`资料流 ${name} 资料版不一致`)
    }
    const etag = response.headers.get('ETag')
    const rows = parseRows(await response.text())
    let link = response.headers.get('Link')
    while (link) {
      const next = /<([^>]+)>\s*;\s*rel="next"/.exec(link)
      if (!next) break
      response = await fetch(new URL(next[1], this.baseUrl))
      if (!response.ok) throw new Error(`资料流 ${name} 续页领取失败：${response.status}`)
      rows.push(...parseRows(await response.text()))
      link = response.headers.get('Link')
    }
    this.cache.set(key, { etag, rows })
    return rows
  }
}

// 外部接口：厂家归档、跨批交接与仓储回执；404 一律视为"没有该资料"
export class ProviderClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl
  }

  async #get(path) {
    const response = await fetch(this.baseUrl + path)
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`外部接口 ${path} 失败：${response.status}`)
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  async #post(path, payload) {
    const response = await fetch(this.baseUrl + path, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload)
    })
    if (response.status === 404) return null
    if (!response.ok) throw new Error(`外部接口 ${path} 失败：${response.status}`)
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }

  archive(market, week) {
    return this.#get('/repairs/archive?market=' + encodeURIComponent(market) +
      '&week=' + encodeURIComponent(week))
  }

  handover() {
    return this.#get('/repairs/handover')
  }

  bins() {
    return this.#get('/stock/bins')
  }

  receipt(key) {
    return this.#get('/stock/receipts?key=' + encodeURIComponent(key))
  }

  hold(payload) {
    return this.#post('/stock/holds', payload)
  }

  release(receipt) {
    return this.#post('/stock/release', { receipt })
  }
}
