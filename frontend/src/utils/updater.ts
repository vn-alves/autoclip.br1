import { isTauri } from './isTauri'

/**
 * Atualização do app desktop direto pelo aplicativo: consulta a release mais recente no
 * GitHub, compara com a versão instalada e, se houver nova, baixa e instala pelo próprio app
 * (comando Rust `download_and_install_update`, ver src-tauri/src/updater.rs).
 */
const REPO = 'vn-alves/autoclip.br'
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`
const DISMISS_KEY = 'autoclip.update.dismissed'

export interface UpdateInfo {
  current: string
  latest: string
  available: boolean
  notes: string
  publishedAt: string
  assetUrl: string | null
  assetName: string | null
  pageUrl: string
}

export type Platform = 'windows' | 'macos' | 'other'

export function detectPlatform(): Platform {
  const ua = (navigator.userAgent || '').toLowerCase()
  if (ua.includes('windows')) return 'windows'
  if (ua.includes('mac')) return 'macos'
  return 'other'
}

const clean = (v: string) => v.trim().replace(/^v/i, '')

export function compareVersions(a: string, b: string): number {
  const pa = clean(a).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  const pb = clean(b).split(/[.-]/).map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

export async function getCurrentVersion(): Promise<string> {
  if (isTauri()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      return await getVersion()
    } catch {
      /* cai no valor do build */
    }
  }
  return (import.meta as any).env?.VITE_APP_VERSION || '0.0.0'
}

export async function checkForUpdate(): Promise<UpdateInfo> {
  const current = await getCurrentVersion()
  const res = await fetch(LATEST_API, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) throw new Error(`Não foi possível verificar atualizações (HTTP ${res.status})`)
  const data = await res.json()
  const latest = clean(String(data.tag_name || '0.0.0'))
  const assets: any[] = Array.isArray(data.assets) ? data.assets : []
  const platform = detectPlatform()
  const asset =
    platform === 'windows'
      ? assets.find((a) => /x64-setup\.exe$/i.test(a.name)) || assets.find((a) => /\.exe$/i.test(a.name))
      : platform === 'macos'
        ? assets.find((a) => /\.dmg$/i.test(a.name))
        : null
  // A versão real é a do instalador (ex.: AutoClip.Desktop_1.9.6_aarch64.dmg); a tag pode divergir.
  const assetVersion = asset?.name?.match(/_(\d+\.\d+\.\d+)_/)?.[1]
  const effective = assetVersion || latest
  return {
    current,
    latest: effective,
    available: compareVersions(effective, current) > 0 && Boolean(asset),
    notes: String(data.body || ''),
    publishedAt: String(data.published_at || ''),
    assetUrl: asset?.browser_download_url || null,
    assetName: asset?.name || null,
    pageUrl: String(data.html_url || `https://github.com/${REPO}/releases/latest`),
  }
}

export interface InstallProgress {
  downloaded: number
  total: number
  stage: 'downloading' | 'downloaded' | 'installing'
}

export async function installUpdate(info: UpdateInfo, onProgress?: (p: InstallProgress) => void): Promise<void> {
  if (!isTauri()) throw new Error('A atualização automática só funciona no aplicativo instalado.')
  if (!info.assetUrl || !info.assetName) throw new Error('Nenhum instalador disponível para este sistema.')
  const { invoke } = await import('@tauri-apps/api/core')
  const { listen } = await import('@tauri-apps/api/event')
  const unlisten = await listen<InstallProgress>('update-progress', (e) => onProgress?.(e.payload))
  try {
    await invoke('download_and_install_update', { url: info.assetUrl, fileName: info.assetName })
  } finally {
    unlisten()
  }
}

export const isUpdateDismissed = (version: string) => {
  try { return localStorage.getItem(DISMISS_KEY) === version } catch { return false }
}
export const dismissUpdate = (version: string) => {
  try { localStorage.setItem(DISMISS_KEY, version) } catch { /* ignore */ }
}
