import { createApp } from './app.mjs'

const app = createApp({
  sourceUrl: process.env.SOURCE_URL || 'http://127.0.0.1:8700',
  providerUrl: process.env.PROVIDER_URL || 'http://127.0.0.1:8701',
  now: process.env.NOW_DAY === undefined ? undefined : Number(process.env.NOW_DAY)
})

app.listen(Number(process.env.PORT || 8720), '127.0.0.1', () => {
  console.log('采集服务已启动')
})
