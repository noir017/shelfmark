// 生成 PWA 图标（纯 Node，无依赖）：圆角底 + 书签丝带。产物提交到 public/icons/。
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons')
mkdirSync(out, { recursive: true })

const BG = [0x2f, 0x6f, 0xdb]
const FG = [0xff, 0xff, 0xff]

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const ss = 4
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const p = pixel((x + (sx + 0.5) / ss) / size, (y + (sy + 0.5) / ss) / size)
          if (p) { r += p[0] * p[3]; g += p[1] * p[3]; b += p[2] * p[3]; a += p[3] }
        }
      const o = y * (size * 4 + 1) + 1 + x * 4
      const n = ss * ss
      raw[o] = a ? Math.round(r / a) : 0
      raw[o + 1] = a ? Math.round(g / a) : 0
      raw[o + 2] = a ? Math.round(b / a) : 0
      raw[o + 3] = Math.round((a / n) * 255)
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// 丝带：矩形底部开 V 形缺口；坐标都在 [0,1]，scale 控制占比（maskable 需要更小）
function ribbon(u, v, scale) {
  const x = (u - 0.5) / scale + 0.5
  const y = (v - 0.5) / scale + 0.5
  if (x < 0.3 || x > 0.7 || y < 0.2 || y > 0.82) return false
  return y <= 0.68 + Math.abs(x - 0.5) * 0.7
}
function roundedRect(u, v, r) {
  const dx = Math.max(r - u, 0, u - (1 - r))
  const dy = Math.max(r - v, 0, v - (1 - r))
  return dx * dx + dy * dy <= r * r
}

const regular = (u, v) => {
  if (!roundedRect(u, v, 0.2)) return null
  return ribbon(u, v, 1) ? [...FG, 1] : [...BG, 1]
}
const maskable = (u, v) => (ribbon(u, v, 0.7) ? [...FG, 1] : [...BG, 1])
const touch = (u, v) => (ribbon(u, v, 0.85) ? [...FG, 1] : [...BG, 1])

writeFileSync(join(out, 'icon-192.png'), png(192, regular))
writeFileSync(join(out, 'icon-512.png'), png(512, regular))
writeFileSync(join(out, 'maskable-512.png'), png(512, maskable))
writeFileSync(join(out, 'apple-touch-icon.png'), png(180, touch))
writeFileSync(
  join(out, 'favicon.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="13" fill="#2f6fdb"/><path d="M19 13h26v39.5L32 44l-13 8.5z" fill="#fff"/></svg>\n`,
)
console.log('icons written to', out)
