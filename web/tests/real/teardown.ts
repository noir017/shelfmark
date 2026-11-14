import { rmSync } from 'node:fs'

export default function teardown() {
  if (process.env.SHELFMARK_E2E_DATA) rmSync(process.env.SHELFMARK_E2E_DATA, { recursive: true, force: true })
}
