// 极简 IndexedDB 封装：kv（树、设置、库列表等缓存）和 queue（离线收藏队列）

const DB_NAME = 'shelfmark'
const DB_VERSION = 1

let dbp: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv')
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbp = null
      reject(req.error)
    }
  })
  return dbp
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        t.oncomplete = () => resolve(req.result)
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      }),
  )
}

export const idbAvailable = () => typeof indexedDB !== 'undefined'

export async function kvGet<T>(key: string): Promise<T | undefined> {
  if (!idbAvailable()) return undefined
  try {
    return (await tx('kv', 'readonly', (s) => s.get(key))) as T | undefined
  } catch {
    return undefined
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  if (!idbAvailable()) return
  try {
    await tx('kv', 'readwrite', (s) => s.put(value, key))
  } catch {
    /* 存储满或被禁用时忽略，缓存只是锦上添花 */
  }
}

export async function kvDel(key: string): Promise<void> {
  if (!idbAvailable()) return
  await tx('kv', 'readwrite', (s) => s.delete(key))
}

export async function kvKeys(prefix: string): Promise<string[]> {
  if (!idbAvailable()) return []
  const keys = (await tx('kv', 'readonly', (s) => s.getAllKeys())) as IDBValidKey[]
  return keys.map(String).filter((k) => k.startsWith(prefix))
}

export async function kvClear(): Promise<void> {
  if (!idbAvailable()) return
  await tx('kv', 'readwrite', (s) => s.clear())
}

export async function queueAdd<T extends object>(value: T): Promise<number> {
  return (await tx('queue', 'readwrite', (s) => s.add(value))) as number
}

export async function queueAll<T>(): Promise<T[]> {
  if (!idbAvailable()) return []
  return (await tx('queue', 'readonly', (s) => s.getAll())) as T[]
}

export async function queueDelete(id: number): Promise<void> {
  await tx('queue', 'readwrite', (s) => s.delete(id))
}

export async function queuePut<T extends object>(value: T): Promise<void> {
  await tx('queue', 'readwrite', (s) => s.put(value))
}

/** 测试用：关闭并丢弃连接 */
export async function _resetForTests(): Promise<void> {
  if (dbp) (await dbp).close()
  dbp = null
}
