/**
 * Camada de armazenamento 100% no navegador (IndexedDB) — Fase 1 do plano "Web sem
 * servidor". Usada SÓ pela versão Web (gated por isTauri() em App.tsx); o app desktop
 * continua intacto, falando com o backend Python real via projectApi/api.ts.
 *
 * Object stores:
 * - "projects": registros de projeto (mesma forma de useProjectStore.Project).
 * - "clips": cortes gerados (mesma forma de useProjectStore.Clip), indexado por project_id.
 * - "blobs": arquivos de vídeo em si (o File/Blob bruto), chave = projectId ou clipId.
 * - "subtitles": legenda de um corte (SubtitleSegment[], ver services/api.ts), chave = clipId —
 *   usado pelo Editor na Web (ver webstore/editor.ts).
 * - "editorConfigs": config do Editor (EditConfig, mesma forma salva no backend pelo app
 *   desktop), chave = clipId.
 *
 * Vídeo em blob dentro do IndexedDB (em vez de OPFS) é intencional aqui: suporte mais
 * amplo entre navegadores e não precisa de flag/permissão extra. Se algum dia os vídeos
 * ficarem grandes o suficiente pra pesar a cota do navegador, é o primeiro lugar a trocar
 * por OPFS (Origin Private File System).
 */
const DB_NAME = 'autoclip-web'
const DB_VERSION = 2

export const STORES = {
  projects: 'projects',
  clips: 'clips',
  blobs: 'blobs',
  subtitles: 'subtitles',
  editorConfigs: 'editorConfigs',
} as const

let dbPromise: Promise<IDBDatabase> | null = null

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.projects)) {
        db.createObjectStore(STORES.projects, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.clips)) {
        const clipStore = db.createObjectStore(STORES.clips, { keyPath: 'id' })
        clipStore.createIndex('project_id', 'project_id', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.blobs)) {
        db.createObjectStore(STORES.blobs, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.subtitles)) {
        db.createObjectStore(STORES.subtitles, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.editorConfigs)) {
        db.createObjectStore(STORES.editorConfigs, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store)
}

export async function dbPut<T>(store: string, value: T): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const req = tx(db, store, 'readwrite').put(value)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function dbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, store, 'readonly').get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

export async function dbDelete(store: string, key: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const req = tx(db, store, 'readwrite').delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

export async function dbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, store, 'readonly').getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

export async function dbGetAllByIndex<T>(store: string, indexName: string, value: string): Promise<T[]> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const req = tx(db, store, 'readonly').index(indexName).getAll(value)
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

export async function dbDeleteAllByIndex(store: string, indexName: string, value: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(store, 'readwrite')
    const idx = t.objectStore(store).index(indexName)
    const req = idx.openCursor(value)
    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        cursor.delete()
        cursor.continue()
      }
    }
    t.oncomplete = () => resolve()
    t.onerror = () => reject(t.error)
  })
}
