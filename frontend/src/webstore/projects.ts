import { Project, Clip } from '../store/useProjectStore'
import { STORES, dbPut, dbGet, dbGetAll, dbDelete, dbGetAllByIndex, dbDeleteAllByIndex } from './db'

/**
 * CRUD de projetos/cortes 100% local (IndexedDB) — ver db.ts. Espelha a forma dos tipos
 * Project/Clip que o resto do app já usa (useProjectStore), pra que HomePage/ProjectDetailPage
 * na Web possam reaproveitar os mesmos componentes de card sem conversão de dados.
 *
 * Sem servidor: cada navegador/perfil tem seu próprio armazenamento, isolado — não sincroniza
 * com o app desktop nem entre navegadores diferentes (ver conversa: isso é uma limitação
 * conhecida, não um bug).
 */

let idCounter = 0
function newId(): string {
  idCounter += 1
  return `web-${Date.now()}-${idCounter}`
}

export async function listWebProjects(): Promise<Project[]> {
  const projects = await dbGetAll<Project>(STORES.projects)
  return projects.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
}

export async function getWebProject(id: string): Promise<Project | undefined> {
  return dbGet<Project>(STORES.projects, id)
}

export async function listWebClips(projectId: string): Promise<Clip[]> {
  return dbGetAllByIndex<Clip>(STORES.clips, 'project_id', projectId)
}

/** Um corte específico por id — usado pelo Editor na Web (ClipEditorPage), que só conhece o
 * clipId da rota, não o projectId necessariamente em mãos no mesmo momento. */
export async function getWebClip(id: string): Promise<Clip | undefined> {
  return dbGet<Clip>(STORES.clips, id)
}

/**
 * Cria um projeto a partir de um arquivo de vídeo local — item central da Fase 1 (upload
 * sem link, ver decisão da conversa: Web não baixa de URL, só arquivo do computador).
 * O vídeo em si fica guardado como Blob no IndexedDB (store "blobs"); o registro do
 * projeto guarda só metadados, igual ao que o backend faz com o filesystem.
 *
 * status fica 'pending': o corte por IA (Fase 2 do plano) ainda não está implementado —
 * o projeto aparece na lista, mas mostra "aguardando corte" até essa fase existir.
 */
export async function createWebProjectFromFile(file: File, name?: string): Promise<Project> {
  const id = newId()
  const now = new Date().toISOString()
  const project: Project = {
    id,
    name: name?.trim() || file.name.replace(/\.[^.]+$/, ''),
    description: 'Vídeo local enviado na versão Web (sem servidor)',
    project_type: 'default',
    status: 'pending',
    source_file: file.name,
    created_at: now,
    updated_at: now,
    total_clips: 0,
    total_collections: 0,
  }
  await dbPut(STORES.blobs, { id, blob: file })
  await dbPut(STORES.projects, project)
  return project
}

export async function getWebProjectBlob(id: string): Promise<Blob | undefined> {
  const record = await dbGet<{ id: string; blob: Blob }>(STORES.blobs, id)
  return record?.blob
}

export async function updateWebProject(id: string, patch: Partial<Project>): Promise<Project | undefined> {
  const project = await getWebProject(id)
  if (!project) return undefined
  const updated: Project = { ...project, ...patch, updated_at: new Date().toISOString() }
  await dbPut(STORES.projects, updated)
  return updated
}

/** Salva um corte gerado pela IA (ver webpipeline/) — o vídeo do clipe (já cortado via
 * ffmpeg.wasm) fica no mesmo store de blobs que o vídeo original, chaveado pelo próprio id
 * do clipe. */
export async function addWebClip(projectId: string, clip: Omit<Clip, 'id'> & { id?: string }, videoBlob: Blob): Promise<Clip> {
  const id = clip.id || newId()
  const fullClip: Clip = { ...clip, id } as Clip
  await dbPut(STORES.blobs, { id, blob: videoBlob })
  await dbPut(STORES.clips, { ...fullClip, project_id: projectId } as Clip & { project_id: string })
  return fullClip
}

export async function deleteWebProject(id: string): Promise<void> {
  await dbDelete(STORES.projects, id)
  await dbDelete(STORES.blobs, id)
  const clips = await listWebClips(id)
  for (const clip of clips) {
    await dbDelete(STORES.blobs, clip.id)
  }
  await dbDeleteAllByIndex(STORES.clips, 'project_id', id)
}

/** URL tocável (blob:) pro vídeo de um projeto ou corte — precisa ser revogada
 * (URL.revokeObjectURL) quando o componente que a usa desmonta, senão vaza memória. */
export async function getWebVideoUrl(id: string): Promise<string | null> {
  const record = await dbGet<{ id: string; blob: Blob }>(STORES.blobs, id)
  if (!record) return null
  return URL.createObjectURL(record.blob)
}
