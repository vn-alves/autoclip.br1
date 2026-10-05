import { Clip } from '../store/useProjectStore'
import { SubtitleSegment } from '../services/api'
import { splitPlainTextToWords } from '../components/editor/types'
import { getWebProjectBlob, updateWebProject, addWebClip } from '../webstore/projects'
import { saveWebClipSubtitles } from '../webstore/editor'
import { extractAudio, cutClip } from './ffmpegClient'
import { transcribeAudio, extractHighlightClips, WebPipelineError, TranscriptSegment } from './llmClient'

export { WebPipelineError }

export type PipelineStage =
  | { step: 'audio'; progress: number }
  | { step: 'transcribing' }
  | { step: 'analyzing' }
  | { step: 'cutting'; index: number; total: number }
  | { step: 'done' }

/** "HH:MM:SS,mmm" — mesmo formato SRT usado no resto do app (ver parseTimecode em ui/index.tsx
 * e backend/pipeline/quality.py::to_srt_time), pra que os cortes gerados aqui apareçam
 * corretamente em qualquer lugar que já sabe ler esse formato. */
function secToTimecode(sec: number): string {
  sec = Math.max(0, sec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const ms = Math.round((sec - Math.floor(sec)) * 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

/** Recorta a transcrição do vídeo INTEIRO pra só os segmentos do corte [clipStart, clipEnd),
 * com o tempo relativizado ao início do corte, e quebra cada um em palavras (estimativa linear
 * de tempo, mesma técnica de backend/utils/subtitle_processor.py — a API só devolve timestamp
 * por SEGMENTO, não por palavra, ver transcribeAudio). Sem isso a legenda do corte simplesmente
 * não existia no modo Web (a transcrição era usada só pra escolher os cortes, depois
 * descartada) — agora alimenta o Editor (ver webstore/editor.ts) e a exportação com legenda
 * queimada (ver ffmpegClient.exportWebClip). */
function buildClipSubtitles(segments: TranscriptSegment[], clipStart: number, clipEnd: number): SubtitleSegment[] {
  const overlapping = segments.filter((s) => s.end > clipStart && s.start < clipEnd)
  return overlapping.map((s, i) => {
    const startTime = Math.max(0, s.start - clipStart)
    const endTime = Math.max(startTime + 0.01, Math.min(clipEnd - clipStart, s.end - clipStart))
    return {
      id: `web-sub-${i}`,
      index: i,
      startTime,
      endTime,
      text: s.text,
      words: splitPlainTextToWords(s.text, startTime, endTime),
    }
  })
}

/**
 * Orquestra o corte por IA inteiro sem servidor (Fase 2 do plano): extrai áudio, transcreve
 * e escolhe os melhores trechos via API do usuário (ver llmClient.ts), corta cada um via
 * ffmpeg.wasm (ver ffmpegClient.ts) e salva no IndexedDB (ver webstore/projects.ts).
 *
 * Versão simplificada do pipeline real do backend (um prompt só, sem chunking pra vídeos
 * muito longos, sem passo de pontuação/deduplicação separado) — ver conversa: escopo
 * consciente pra funcionar sem servidor, não é o mesmo motor do app desktop.
 */
export async function runWebPipeline(
  projectId: string,
  onStage?: (stage: PipelineStage) => void,
): Promise<Clip[]> {
  const videoBlob = await getWebProjectBlob(projectId)
  if (!videoBlob) throw new WebPipelineError('Vídeo do projeto não encontrado no navegador.')

  await updateWebProject(projectId, { status: 'processing' })

  try {
    onStage?.({ step: 'audio', progress: 0 })
    const audioBlob = await extractAudio(videoBlob, (p) => onStage?.({ step: 'audio', progress: p }))

    onStage?.({ step: 'transcribing' })
    const segments = await transcribeAudio(audioBlob)
    const totalDurationSec = segments.length ? segments[segments.length - 1].end : 0

    onStage?.({ step: 'analyzing' })
    const highlights = await extractHighlightClips(segments, totalDurationSec)
    if (highlights.length === 0) {
      throw new WebPipelineError('A IA não encontrou nenhum trecho adequado pra cortar nesse vídeo.')
    }

    const clips: Clip[] = []
    for (let i = 0; i < highlights.length; i++) {
      onStage?.({ step: 'cutting', index: i + 1, total: highlights.length })
      const h = highlights[i]
      const clipBlob = await cutClip(videoBlob, h.start, h.end)
      const clip: Clip = {
        id: '',
        title: h.title,
        generated_title: h.title,
        start_time: secToTimecode(h.start),
        end_time: secToTimecode(h.end),
        final_score: 0.8,
        recommend_reason: h.title,
        outline: h.title,
        content: [h.title],
      }
      const saved = await addWebClip(projectId, clip, clipBlob)
      await saveWebClipSubtitles(saved.id, buildClipSubtitles(segments, h.start, h.end))
      clips.push(saved)
    }

    await updateWebProject(projectId, { status: 'completed', total_clips: clips.length })
    onStage?.({ step: 'done' })
    return clips
  } catch (err) {
    await updateWebProject(projectId, { status: 'failed' })
    throw err
  }
}
