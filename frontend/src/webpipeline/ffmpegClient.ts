import { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile, toBlobURL } from '@ffmpeg/util'

/**
 * ffmpeg.wasm — motor de corte de vídeo 100% no navegador (Fase 2 do plano "Web sem
 * servidor"). Mesmo ffmpeg que o backend usa, só que compilado pra WebAssembly: os comandos
 * (`-ss`/`-to`, extração de áudio) são os mesmos, só a forma de invocar muda.
 *
 * Núcleo carregado sob demanda (~30MB) — só na primeira vez que o usuário realmente for
 * cortar ou transcrever algo, nunca no carregamento inicial da página.
 */
let ffmpegPromise: Promise<FFmpeg> | null = null

async function getFFmpeg(): Promise<FFmpeg> {
  if (!ffmpegPromise) {
    ffmpegPromise = (async () => {
      const ffmpeg = new FFmpeg()
      const base = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'
      await ffmpeg.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      })
      return ffmpeg
    })()
  }
  return ffmpegPromise
}

/** Extrai só o áudio (comprimido, mp3 64kbps) — usado antes de transcrever: reduz um vídeo
 * de qualquer tamanho pra um arquivo pequeno o bastante pra caber no limite de 25MB da API
 * de transcrição, sem precisar mandar o vídeo inteiro. */
export async function extractAudio(videoBlob: Blob, onProgress?: (p: number) => void): Promise<Blob> {
  const ffmpeg = await getFFmpeg()
  const inputName = 'input' + guessExtension(videoBlob)
  const outputName = 'audio.mp3'
  const offProgress = onProgress
    ? ffmpeg.on('progress', ({ progress }) => onProgress(Math.min(1, Math.max(0, progress))))
    : undefined
  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoBlob))
    await ffmpeg.exec(['-i', inputName, '-vn', '-acodec', 'libmp3lame', '-b:a', '64k', '-ac', '1', outputName])
    const data = await ffmpeg.readFile(outputName)
    return new Blob([data as unknown as BlobPart], { type: 'audio/mp3' })
  } finally {
    void offProgress
    await safeDelete(ffmpeg, inputName)
    await safeDelete(ffmpeg, outputName)
  }
}

/** Corta um único clipe [startSec, endSec) do vídeo original — equivalente ao
 * VideoProcessor.extract_clip do backend (mesmos parâmetros de recodificação). */
export async function cutClip(videoBlob: Blob, startSec: number, endSec: number): Promise<Blob> {
  const ffmpeg = await getFFmpeg()
  const inputName = 'input' + guessExtension(videoBlob)
  const outputName = 'clip.mp4'
  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoBlob))
    await ffmpeg.exec([
      '-ss', String(Math.max(0, startSec)),
      '-to', String(Math.max(startSec + 0.5, endSec)),
      '-i', inputName,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'superfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      outputName,
    ])
    const data = await ffmpeg.readFile(outputName)
    return new Blob([data as unknown as BlobPart], { type: 'video/mp4' })
  } finally {
    await safeDelete(ffmpeg, inputName)
    await safeDelete(ffmpeg, outputName)
  }
}

// Fonte usada pra queimar a legenda (drawtext precisa de um arquivo de fonte explícito — o
// core do ffmpeg.wasm não tem fontconfig/fontes do sistema). Buscada uma vez só (cacheada no
// módulo) e reaproveitada em toda exportação; TTF cru (freetype não lê woff/woff2).
let fontBytesPromise: Promise<Uint8Array> | null = null
async function getFontBytes(): Promise<Uint8Array> {
  if (!fontBytesPromise) {
    fontBytesPromise = (async () => {
      const res = await fetch('https://cdn.jsdelivr.net/gh/google/fonts@main/apache/roboto/static/Roboto-Regular.ttf')
      if (!res.ok) throw new Error(`Falha ao baixar fonte para legenda (${res.status})`)
      return new Uint8Array(await res.arrayBuffer())
    })()
  }
  return fontBytesPromise
}

/** '#RRGGBB' -> '0xRRGGBB' (sintaxe de cor do ffmpeg; nomes de cor tipo 'white' passam direto). */
function toFfmpegColor(hex: string): string {
  return hex.startsWith('#') ? `0x${hex.slice(1)}` : hex
}

/** Escapa um texto pra caber dentro de drawtext=text='...' — ver nota extensa em
 * buildDrawtextChain sobre por que só backslash/aspas simples/% precisam de tratamento aqui
 * (o valor inteiro já fica entre aspas simples, que protegem ':'/',' automaticamente). */
function escapeDrawtextText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/'/g, `'\\''`)
}

function roundEven(n: number): number {
  const r = Math.round(n)
  return r % 2 === 0 ? r : r + 1
}

export interface WebExportSubtitleSegment {
  startTime: number
  endTime: number
  text: string
}

export interface WebExportSubtitleStyle {
  fontSize: number
  color: string
  outlineColor?: string
  outlineWidth?: number
}

export interface WebExportSubtitlePosition {
  /** 0..1, fração do canvas — mesma forma de SubtitlePosition (ver components/editor/types.ts). */
  x: number
  y: number
  width: number
}

export interface WebExportParams {
  videoBlob: Blob
  canvasWidth: number
  canvasHeight: number
  durationSec: number
  /** Transform normalizado (0..1) da layer principal — única layer suportada na "versão
   * básica" do Editor sem servidor (sem camadas secundárias, ver ClipEditorPage). */
  mainTransform: { x: number; y: number; width: number; height: number }
  subtitle?: {
    visible: boolean
    segments: WebExportSubtitleSegment[]
    style: WebExportSubtitleStyle
    position: WebExportSubtitlePosition
  }
  onProgress?: (p: number) => void
}

/** Monta a cadeia de filtros drawtext (um por legenda, cada um só visível na própria janela de
 * tempo via enable='between(t,start,end)') — queima texto simples, sem o sistema rico de
 * estilo/transição/destaque por palavra do Editor desktop (ASS via libass, que o core padrão
 * do ffmpeg.wasm não tem). Versão básica: lê posição/tamanho/cor/contorno do estilo já
 * configurado no Editor, mas sempre mostra a legenda inteira do segmento de uma vez.
 *
 * Nota de escaping: cada valor (`text=`, `fontcolor=`, etc.) fica entre aspas simples, que no
 * parser de filtro do ffmpeg protegem ':' e ',' automaticamente — só backslash, aspas simples
 * e '%' (sintaxe de expansão do drawtext) precisam de tratamento manual (ver escapeDrawtextText).
 */
function buildDrawtextChain(
  inputLabel: string,
  segments: WebExportSubtitleSegment[],
  style: WebExportSubtitleStyle,
  position: WebExportSubtitlePosition,
  canvasWidth: number,
): { filter: string; outputLabel: string } {
  const boxLeft = Math.round(position.x * canvasWidth)
  const boxWidth = Math.round(position.width * canvasWidth)
  const centerX = boxLeft + boxWidth / 2
  const fontColor = toFfmpegColor(style.color)
  const outline = style.outlineWidth
    ? `:borderw=${style.outlineWidth}:bordercolor=${toFfmpegColor(style.outlineColor || '#000000')}`
    : ''

  let filter = ''
  let last = inputLabel
  segments.forEach((seg, i) => {
    const label = `sub${i}`
    const text = escapeDrawtextText(seg.text)
    filter += `;[${last}]drawtext=fontfile=font.ttf:text='${text}':fontsize=${Math.round(style.fontSize)}`
      + `:fontcolor=${fontColor}${outline}:x=${centerX}-(text_w/2):y=h*${position.y.toFixed(4)}`
      + `:enable='between(t,${seg.startTime.toFixed(2)},${seg.endTime.toFixed(2)})'[${label}]`
    last = label
  })
  return { filter, outputLabel: last }
}

/**
 * Exporta um corte da Web (versão básica do Editor sem servidor, ver conversa): recorta/escala
 * o vídeo principal pro enquadramento escolhido (mesma matemática de posição/tamanho do preview,
 * ver EditorCanvas — mas aqui composta de verdade via filtro overlay, não CSS) e queima a
 * legenda (texto simples, ver buildDrawtextChain). Sem camadas secundárias — não suportadas
 * nesta primeira versão.
 *
 * Resiliente a falha no passo de legenda: se o comando com drawtext falhar por qualquer motivo
 * (fonte não carregou, texto com algum caractere que escapou mal), tenta de novo SEM legenda em
 * vez de falhar a exportação inteira — o usuário sempre sai com algum vídeo, mesmo que sem
 * legenda queimada dessa vez.
 */
export async function exportWebClip(params: WebExportParams): Promise<Blob> {
  const { videoBlob, canvasWidth: W, canvasHeight: H, durationSec, mainTransform, subtitle, onProgress } = params
  const ffmpeg = await getFFmpeg()
  const inputName = 'input' + guessExtension(videoBlob)
  const outputName = 'export.mp4'
  const boxW = Math.max(2, roundEven(mainTransform.width * W))
  const boxH = Math.max(2, roundEven(mainTransform.height * H))
  const left = Math.round(mainTransform.x * W)
  const top = Math.round(mainTransform.y * H)
  const duration = Math.max(0.5, durationSec)

  // Bug real: um `scale=boxW:boxH` direto ESTICA o vídeo pra caber exatamente na caixa —
  // distorce sempre que a caixa (redimensionada livremente pelo usuário, ver EditorCanvas)
  // tem uma proporção diferente da do vídeo original. `force_original_aspect_ratio=increase`
  // + `crop` reproduz object-fit:cover de verdade (escala preservando a proporção até cobrir
  // a caixa, corta o excesso) — mesmo filtro usado no render do backend desktop
  // (editor_render_service.py), pra exportação e preview nunca divergirem.
  const baseFilter = `color=c=black:s=${W}x${H}:d=${duration}[bg];`
    + `[0:v]scale=${boxW}:${boxH}:force_original_aspect_ratio=increase,crop=${boxW}:${boxH}[fg];`
    + `[bg][fg]overlay=x=${left}:y=${top}:shortest=1[comp]`

  const run = async (filterComplex: string, mapLabel: string) => {
    await ffmpeg.exec([
      '-i', inputName,
      '-filter_complex', filterComplex,
      '-map', `[${mapLabel}]`, '-map', '0:a?',
      '-t', String(duration),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
      outputName,
    ])
  }

  const offProgress = onProgress
    ? ffmpeg.on('progress', ({ progress }) => onProgress(Math.min(1, Math.max(0, progress))))
    : undefined

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(videoBlob))

    const hasSubtitle = !!subtitle?.visible && subtitle.segments.length > 0
    let fontReady = false
    if (hasSubtitle) {
      try {
        await ffmpeg.writeFile('font.ttf', await getFontBytes())
        fontReady = true
      } catch {
        fontReady = false // segue sem legenda em vez de falhar a exportação inteira
      }
    }

    if (hasSubtitle && fontReady && subtitle) {
      const { filter, outputLabel } = buildDrawtextChain('comp', subtitle.segments, subtitle.style, subtitle.position, W)
      try {
        await run(baseFilter + filter, outputLabel)
      } catch {
        // Comando com legenda falhou (ex.: algum caractere escapou mal) — tenta de novo sem
        // queimar legenda, pra garantir que o usuário saia com ALGUM vídeo exportado.
        await run(baseFilter, 'comp')
      }
    } else {
      await run(baseFilter, 'comp')
    }

    const data = await ffmpeg.readFile(outputName)
    return new Blob([data as unknown as BlobPart], { type: 'video/mp4' })
  } finally {
    void offProgress
    await safeDelete(ffmpeg, inputName)
    await safeDelete(ffmpeg, outputName)
    await safeDelete(ffmpeg, 'font.ttf')
  }
}

async function safeDelete(ffmpeg: FFmpeg, name: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(name)
  } catch {
    // arquivo pode já não existir se um passo anterior falhou — não é crítico.
  }
}

function guessExtension(blob: Blob): string {
  if (blob.type.includes('webm')) return '.webm'
  if (blob.type.includes('quicktime')) return '.mov'
  return '.mp4'
}
