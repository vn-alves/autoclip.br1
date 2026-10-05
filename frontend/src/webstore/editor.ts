import { SubtitleSegment } from '../services/api'
import type { EditConfig } from '../components/editor/types'
import { STORES, dbPut, dbGet } from './db'

/**
 * Persistência do Editor de Corte na versão Web (sem servidor) — "versão básica" (ver
 * conversa): um vídeo só por corte (sem camadas secundárias) e sem sincronização de legenda
 * com IA, mas com posição/recorte do vídeo, edição/remoção de legenda e exportação com
 * legenda queimada (ver webpipeline/ffmpegClient.ts::exportWebClip) funcionando 100% local.
 *
 * Espelha a MESMA forma (SubtitleSegment[], EditConfig) que o app desktop troca com o
 * backend, pra reaproveitar os componentes do Editor sem nenhuma conversão de dados — só a
 * camada de carregar/salvar muda (ver ClipEditorPage.tsx, branch por isWebClip).
 */

export async function getWebClipSubtitles(clipId: string): Promise<SubtitleSegment[] | undefined> {
  const record = await dbGet<{ id: string; segments: SubtitleSegment[] }>(STORES.subtitles, clipId)
  return record?.segments
}

export async function saveWebClipSubtitles(clipId: string, segments: SubtitleSegment[]): Promise<void> {
  await dbPut(STORES.subtitles, { id: clipId, segments })
}

export async function getWebEditorConfig(clipId: string): Promise<EditConfig | undefined> {
  const record = await dbGet<{ id: string; config: EditConfig }>(STORES.editorConfigs, clipId)
  return record?.config
}

export async function saveWebEditorConfig(clipId: string, config: EditConfig): Promise<void> {
  await dbPut(STORES.editorConfigs, { id: clipId, config })
}
