/**
 * Estado do Editor de Corte — ETAPA 1 (fundação) + ETAPA 2 (legendas).
 *
 * Só existe em memória (React state) nesta etapa; não é persistido no
 * backend. A forma já é pensada para crescer nas próximas etapas
 * (múltiplas layers, legendas, render spec) sem precisar reescrever o
 * que já existe — ver docs/EDITOR_SPEC.md.
 */

import type { SubtitleSegment, SubtitleWord, SubtitleSyncStatus } from '../../services/api'

export type { SubtitleSegment, SubtitleWord, SubtitleSyncStatus }

export type CanvasFormat = '9:16' | '16:9' | '1:1'

/** Resolução lógica de referência por formato — não depende do tamanho físico do preview na tela. */
export const CANVAS_DIMENSIONS: Record<CanvasFormat, { width: number; height: number }> = {
  '9:16': { width: 1080, height: 1920 },
  '16:9': { width: 1920, height: 1080 },
  '1:1': { width: 1080, height: 1080 },
}

export const canvasRatio = (format: CanvasFormat): number => {
  const { width, height } = CANVAS_DIMENSIONS[format]
  return width / height
}

/**
 * Posição/tamanho normalizados (0..1) relativos ao canvas — nunca em pixels
 * físicos do preview, para que redimensionar a janela não destrua o
 * posicionamento (ver EDITOR_SPEC.md seção 8).
 */
export interface NormalizedTransform {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

/** true se o transform é inválido (NaN/<=0) ou não tem NENHUMA sobreposição com o canvas
 * [0,1]x[0,1] — ou seja, a layer nunca aparece na tela com esse valor. Usado ao carregar um
 * edit_config salvo (ver ClipEditorPage): um transform assim só pode ser dado corrompido de
 * antes do sistema fitMode existir, nunca uma customização real — o usuário via o preview
 * enquanto arrastava/redimensionava, então uma customização de verdade é sempre pelo menos
 * parcialmente visível. Corrigir isso automaticamente nunca desfaz um ajuste manual legítimo. */
export function isDegenerateTransform(t: NormalizedTransform): boolean {
  if (![t.x, t.y, t.width, t.height].every((n) => Number.isFinite(n))) return true
  if (t.width <= 0 || t.height <= 0) return true
  if (t.x + t.width <= 0 || t.x >= 1) return true
  if (t.y + t.height <= 0 || t.y >= 1) return true
  return false
}

export type BackgroundType = 'blur' | 'color'

export interface BackgroundConfig {
  type: BackgroundType
  color: string
  blurAmount: number
}

export const DEFAULT_BACKGROUND: BackgroundConfig = { type: 'blur', color: '#000000', blurAmount: 36 }

/* ------------------------------------------------------------------ Layers de vídeo (Etapa 3) --- */

/**
 * Uma camada de vídeo no Canvas. A layer principal (`isMain: true`) é sempre a primeira,
 * corresponde ao corte original e não pode ser removida nem ter o `source` trocado — seu
 * `startTime`/`endTime` cobrem o corte inteiro (Infinity = "sempre ativa", já que sua própria
 * duração natural do arquivo já delimita quando ela para de tocar). Layers secundárias são
 * vídeos adicionados localmente pelo usuário (upload), com uma janela de tempo própria dentro
 * do currentTime global do Editor — ver findActiveLayers().
 */
export interface VideoLayer {
  id: string
  type: 'video'
  name: string
  /** URL do vídeo (endpoint do clip para a layer principal; object URL de upload local para as demais). */
  source: string
  visible: boolean
  transform: NormalizedTransform
  /** Maior = mais acima na composição visual. */
  zIndex: number
  /** Janela [startTime, endTime] no relógio global do Editor em que esta layer aparece. */
  startTime: number
  endTime: number
  isMain: boolean
  /**
   * Referência do backend para o arquivo desta layer secundária (Stage 4) — preenchida só
   * depois do upload real do vídeo (ver ClipEditorPage.handleSaveEditorConfig). `source`
   * continua sendo um object URL válido só NESTA sessão do navegador; `assetId` é o que
   * sobrevive a salvar/recarregar/renderizar. undefined na layer principal (ela nunca é um
   * asset do Editor, é o próprio vídeo do corte) e em layers ainda não enviadas ao backend.
   */
  assetId?: string
  /**
   * Como a layer é reenquadrada automaticamente (onLoadedMetadata / troca de formato do
   * Canvas, ver ClipEditorPage.fitLayerTransform) enquanto o usuário não arrasta/redimensiona
   * manualmente (customizedLayersRef). 'cover' preenche o Canvas inteiro cortando o excesso
   * (padrão — nunca deixa borda preta); 'contain' mostra o vídeo inteiro, com espaço sobrando
   * quando a proporção não bate. Não afeta o render: o FFmpeg só lê `transform`, calculado a
   * partir deste modo.
   */
  fitMode: 'contain' | 'cover'
  /**
   * true depois que o usuário arrasta/redimensiona esta layer manualmente — só então trocar
   * fitMode/formato do Canvas para de recalcular automaticamente (ver ClipEditorPage
   * handleLayerLoadedMetadata/handleFormatChange). PRECISA ser persistido (não um Set em
   * memória à parte): sem isso, reabrir uma edição salva não tinha como saber que uma layer
   * NUNCA foi customizada de verdade, e a Etapa anterior marcava TODAS como customizadas ao
   * carregar — travando pra sempre o enquadramento antigo (contain, com borda preta) mesmo
   * depois do fitMode virar 'cover' por padrão. Configs salvas antes deste campo existir
   * (undefined) tratam como false — é exatamente o caso que precisava ser corrigido.
   */
  customized: boolean
  /** true se for uma cópia (ex. duplicação do vídeo principal). */
  isDuplicate?: boolean
}

// fitMode 'contain' (Normal) por padrão na layer principal: 'cover' pode deixar o box real do
// <video> bem maior que o frame (ex.: vídeo 16:9 em canvas 9:16 passa de 300% de largura), o
// que dispara um bug real do Chromium — o vídeo às vezes some ao ser selecionado, mostrando só
// o fundo (ver EditorCanvas.tsx, useLayoutEffect de aplicação de transform). 'contain' nunca
// ultrapassa o frame, então nunca aciona esse caso. Cover continua disponível como opção manual.
export const createMainVideoLayer = (source: string): VideoLayer => ({
  id: 'main', type: 'video', name: 'Vídeo principal', source, visible: true,
  transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0 },
  zIndex: 0, startTime: 0, endTime: Number.POSITIVE_INFINITY, isMain: true, fitMode: 'contain',
  customized: false,
})

let secondaryLayerCounter = 0

/** Nova layer secundária a partir de um arquivo local (item 4) — ainda sem `transform` ajustado
 * ao aspect ratio real do vídeo (isso só é conhecido depois do onLoadedMetadata, ver
 * EditorCanvas); usa um enquadramento central razoável como ponto de partida. */
export function createVideoLayerFromFile(file: File, existingLayers: VideoLayer[], duration: number): VideoLayer {
  secondaryLayerCounter += 1
  const nextIndex = existingLayers.length + 1
  const maxZ = existingLayers.reduce((m, l) => Math.max(m, l.zIndex), 0)
  return {
    id: `layer-${Date.now()}-${secondaryLayerCounter}`,
    type: 'video',
    name: `Vídeo ${nextIndex}`,
    source: URL.createObjectURL(file),
    visible: true,
    transform: { x: 0.15, y: 0.15, width: 0.5, height: 0.5, rotation: 0 },
    zIndex: maxZ + 1,
    startTime: 0,
    endTime: duration > 0 ? duration : Number.POSITIVE_INFINITY,
    isMain: false,
    fitMode: 'cover',
    customized: false,
  }
}

/** Duplica uma layer existente (útil para duplicar o vídeo principal sem precisar de upload). */
export function duplicateVideoLayer(sourceLayer: VideoLayer, existingLayers: VideoLayer[]): VideoLayer {
  secondaryLayerCounter += 1
  const maxZ = existingLayers.reduce((m, l) => Math.max(m, l.zIndex), 0)
  return {
    ...sourceLayer,
    id: `layer-dup-${Date.now()}-${secondaryLayerCounter}`,
    name: `${sourceLayer.name} (Cópia)`,
    zIndex: maxZ + 1,
    isDuplicate: true,
    transform: { ...sourceLayer.transform, x: sourceLayer.transform.x + 0.05, y: sourceLayer.transform.y + 0.05 },
    customized: true,
  }
}

/** Layers visíveis cujo intervalo [startTime, endTime] contém currentTime (item 13) — a
 * principal, com endTime=Infinity, está sempre incluída enquanto visível. */
export function findActiveLayers(layers: VideoLayer[], currentTime: number): VideoLayer[] {
  return layers.filter((l) => l.visible && currentTime >= l.startTime && currentTime <= l.endTime)
}

/* ---------------------------------------------------------------- Legendas (Etapa 2) --- */

export type SubtitlePositionPreset = 'top' | 'center' | 'bottom' | 'custom'

/** Igual a NormalizedTransform em espírito (0..1 relativo ao canvas), mas sem altura —
 * a caixa de legenda tem altura automática (definida pelo texto), nunca esticada. */
export interface SubtitlePosition {
  preset: SubtitlePositionPreset
  x: number
  y: number
  width: number
}

export const SUBTITLE_POSITION_PRESETS: Record<Exclude<SubtitlePositionPreset, 'custom'>, Omit<SubtitlePosition, 'preset'>> = {
  top: { x: 0.07, y: 0.06, width: 0.86 },
  center: { x: 0.07, y: 0.46, width: 0.86 },
  bottom: { x: 0.07, y: 0.78, width: 0.86 },
}

export type SubtitleAnimation = 'none' | 'karaoke' | 'pop_in'

export interface SubtitleOutline {
  enabled: boolean
  color: string
  width: number
}

export interface SubtitleStyle {
  /** id do preset aplicado por último (ver SUBTITLE_STYLE_PRESETS), ou 'custom' após qualquer edição manual. */
  id: string
  fontFamily: string
  /** px, relativo à resolução lógica do canvas (CANVAS_DIMENSIONS) — escalado na hora de renderizar. */
  fontSize: number
  fontWeight: 400 | 500 | 600 | 700 | 800
  color: string
  highlightColor: string
  outline: SubtitleOutline
  /** @deprecated Etapa 4.2: karaoke/pop_in agora vivem em WordHighlight/SubtitleTransition —
   * mantido só para configs salvas antes desta etapa continuarem carregando sem erro (ver
   * migrateLegacyAnimation). Novo código não deve escrever neste campo. */
  animation: SubtitleAnimation
  /** Cor de fundo da caixa da legenda (estilos tipo "Simple Boxy") — 'transparent' ou
   * backgroundOpacity=0 desliga a caixa inteiramente. */
  backgroundColor: string
  /** 0..1 */
  backgroundOpacity: number
  /** px, mesma escala lógica do canvas que fontSize. */
  borderRadius: number
  shadow: boolean
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  id: 'white-outline',
  fontFamily: "Inter, 'Noto Sans SC', system-ui, sans-serif",
  fontSize: 46,
  fontWeight: 700,
  color: '#FFFFFF',
  highlightColor: '#2D6BFF',
  outline: { enabled: true, color: '#000000', width: 2 },
  animation: 'none',
  backgroundColor: '#000000',
  backgroundOpacity: 0,
  borderRadius: 8,
  shadow: false,
}

/* ---------------------------------------------------- Transição/destaque de palavra (Etapa 4.2) --- */

/** Animação de ENTRADA — do bloco inteiro (a maioria dos tipos) ou de cada palavra
 * individualmente quando o tipo é 'word_by_word'/'word_follow' (ver item 4 da Etapa 4.2:
 * nesses dois modos a animação NUNCA é aplicada ao bloco todo de uma vez). */
export type SubtitleTransitionType =
  | 'none' | 'fade' | 'pop' | 'slide_up' | 'slide_down' | 'slide_left' | 'slide_right'
  | 'zoom' | 'bounce' | 'word_by_word' | 'word_follow'

export interface SubtitleTransition {
  type: SubtitleTransitionType
  /** segundos */
  duration: number
  easing: 'linear' | 'easeOut' | 'easeInOut'
}

export const DEFAULT_SUBTITLE_TRANSITION: SubtitleTransition = { type: 'fade', duration: 0.18, easing: 'easeOut' }

export const SUBTITLE_TRANSITION_OPTIONS: { value: SubtitleTransitionType; label: string }[] = [
  { value: 'none', label: 'Nenhuma' },
  { value: 'fade', label: 'Fade' },
  { value: 'pop', label: 'Pop' },
  { value: 'slide_up', label: 'Deslizar ↑' },
  { value: 'slide_down', label: 'Deslizar ↓' },
  { value: 'slide_left', label: 'Deslizar ←' },
  { value: 'slide_right', label: 'Deslizar →' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'bounce', label: 'Bounce' },
  { value: 'word_by_word', label: 'Palavra por palavra' },
  { value: 'word_follow', label: 'Palavra seguindo a fala' },
]

/** Destaque da PALAVRA ATIVA — determinado por subtitle_sync.words (findActiveWord), nunca
 * pelo índice visual do bloco (item 5 da Etapa 4.2). */
export type WordHighlightType =
  | 'none' | 'color' | 'background' | 'bold' | 'scale' | 'color_background' | 'pop' | 'karaoke'

export interface WordHighlight {
  type: WordHighlightType
  color: string
  backgroundColor: string
  /** fator de escala aplicado quando type inclui escala (ou quando animation='pop'). */
  scale: number
  /** flourish extra combinável com qualquer type acima — "palavra ativa + animação" (item 9/10). */
  animation: 'none' | 'pop'
}

export const DEFAULT_WORD_HIGHLIGHT: WordHighlight = {
  type: 'color', color: '#2D6BFF', backgroundColor: '#2D6BFF', scale: 1.14, animation: 'none',
}

export const WORD_HIGHLIGHT_OPTIONS: { value: WordHighlightType; label: string }[] = [
  { value: 'none', label: 'Nenhum' },
  { value: 'color', label: 'Mudar cor' },
  { value: 'background', label: 'Fundo' },
  { value: 'bold', label: 'Negrito' },
  { value: 'scale', label: 'Escala' },
  { value: 'color_background', label: 'Cor + fundo' },
  { value: 'pop', label: 'Pop' },
  { value: 'karaoke', label: 'Karaokê' },
]

/** Migra um SubtitleStyle salvo ANTES da Etapa 4.2 (só tinha `animation`) para
 * transition/wordHighlight equivalentes — nunca perde o comportamento que o usuário já tinha
 * configurado. Só roda quando a config carregada não tem transition/wordHighlight (configs
 * novas sempre têm ambos, ver toEditConfig). */
export function migrateLegacyAnimation(legacy: SubtitleAnimation): { transition: SubtitleTransition; wordHighlight: WordHighlight } {
  if (legacy === 'karaoke') {
    return { transition: { ...DEFAULT_SUBTITLE_TRANSITION, type: 'none' }, wordHighlight: { ...DEFAULT_WORD_HIGHLIGHT, type: 'karaoke' } }
  }
  if (legacy === 'pop_in') {
    return { transition: { ...DEFAULT_SUBTITLE_TRANSITION, type: 'pop' }, wordHighlight: { ...DEFAULT_WORD_HIGHLIGHT, type: 'none' } }
  }
  return { transition: { ...DEFAULT_SUBTITLE_TRANSITION, type: 'none' }, wordHighlight: { ...DEFAULT_WORD_HIGHLIGHT, type: 'none' } }
}

/**
 * Função central de animação por palavra (item 7 da Etapa 4.2) — TODO componente de preview
 * usa esta função, nunca recalcula progresso/estado por conta própria, pra garantir que
 * preview e (futuramente) qualquer outra visualização fiquem sempre de acordo.
 */
export interface WordAnimationState {
  /** false = a palavra não deve ser desenhada ainda (gating de 'word_by_word'/'word_follow'). */
  visible: boolean
  /** 0..1 — progresso da animação de ENTRADA da palavra desde word.startTime. */
  enterProgress: number
  /** word.startTime <= currentTime <= word.endTime */
  isActive: boolean
  /** 0..1 — progresso DENTRO da duração da própria palavra (sweep do karaokê). */
  activeProgress: number
}

const EASINGS: Record<SubtitleTransition['easing'], (t: number) => number> = {
  linear: (t) => t,
  easeOut: (t) => 1 - (1 - t) ** 3,
  easeInOut: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
}

export function getWordAnimationProgress(
  currentTime: number,
  word: SubtitleWord,
  transition: SubtitleTransition,
): WordAnimationState {
  const isActive = currentTime >= word.startTime && currentTime <= word.endTime
  const activeProgress = isActive && word.endTime > word.startTime
    ? clamp01((currentTime - word.startTime) / (word.endTime - word.startTime))
    : (currentTime > word.endTime ? 1 : 0)

  const gatesByOwnTimestamp = transition.type === 'word_by_word' || transition.type === 'word_follow'
  const visible = !gatesByOwnTimestamp || currentTime >= word.startTime

  const dur = Math.max(0.01, transition.duration)
  const raw = clamp01((currentTime - word.startTime) / dur)
  const enterProgress = currentTime < word.startTime ? 0 : EASINGS[transition.easing](raw)

  return { visible, enterProgress, isActive, activeProgress }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

export const DEFAULT_SUBTITLE_POSITION: SubtitlePosition = { preset: 'bottom', ...SUBTITLE_POSITION_PRESETS.bottom }

export interface SubtitleStylePreset {
  id: string
  label: string
  /** aplicado por cima de DEFAULT_SUBTITLE_STYLE (merge raso; outline é substituído por inteiro quando presente). */
  style: Partial<Omit<SubtitleStyle, 'id'>>
  /** Etapa 4.2 — cada preset agora é um COMBO: estilo + transição + destaque (item 3/12: "o
   * resultado deve ser uma legenda visualmente igual ao estilo, entrando com a animação
   * escolhida, com a palavra falada recebendo o destaque escolhido"). */
  transition: Partial<SubtitleTransition>
  wordHighlight: Partial<WordHighlight>
}

/** Os 6 presets pedidos na Etapa 4.2 — cada um é só uma combinação de configuração
 * (style+transition+wordHighlight), reaproveitando o MESMO modelo/renderer para todos
 * (item 3: "não criar componentes separados para cada estilo"). */
export const SUBTITLE_STYLE_PRESETS: SubtitleStylePreset[] = [
  {
    id: 'super_simple',
    label: 'Super Simple',
    style: {
      color: '#FFFFFF', fontWeight: 700, outline: { enabled: true, color: '#000000', width: 2 },
      backgroundOpacity: 0, shadow: false,
    },
    transition: { type: 'fade', duration: 0.15 },
    wordHighlight: { type: 'color', color: '#2D6BFF' },
  },
  {
    id: 'simple_boxy',
    label: 'Simple Boxy',
    style: {
      color: '#FFFFFF', fontWeight: 700, outline: { enabled: false, color: '#000000', width: 0 },
      backgroundColor: '#000000', backgroundOpacity: 0.78, borderRadius: 10, shadow: false,
    },
    transition: { type: 'slide_up', duration: 0.2 },
    wordHighlight: { type: 'background', backgroundColor: '#FFE14D', color: '#111111' },
  },
  {
    id: 'word_focus',
    label: 'Word Focus',
    style: {
      color: '#9AA0A6', fontWeight: 700, outline: { enabled: true, color: '#000000', width: 2 },
      backgroundOpacity: 0,
    },
    transition: { type: 'fade', duration: 0.15 },
    wordHighlight: { type: 'color_background', color: '#FFFFFF', backgroundColor: '#2D6BFF', scale: 1.1 },
  },
  {
    id: 'pop_words',
    label: 'Pop Words',
    style: {
      color: '#FFFFFF', fontWeight: 800, outline: { enabled: true, color: '#000000', width: 2 },
      backgroundOpacity: 0,
    },
    transition: { type: 'word_by_word', duration: 0.16, easing: 'easeOut' },
    wordHighlight: { type: 'pop', color: '#FFFFFF', scale: 1.22 },
  },
  {
    id: 'spoken_words',
    label: 'Spoken Words',
    style: {
      color: '#FFFFFF', fontWeight: 700, outline: { enabled: true, color: '#000000', width: 2 },
      backgroundOpacity: 0,
    },
    transition: { type: 'word_follow', duration: 0.1 },
    wordHighlight: { type: 'background', backgroundColor: '#2D6BFF', color: '#FFFFFF' },
  },
  {
    id: 'highlight',
    label: 'Highlight',
    style: {
      color: '#FFFFFF', fontWeight: 700, outline: { enabled: true, color: '#000000', width: 2 },
      backgroundOpacity: 0,
    },
    transition: { type: 'none' },
    wordHighlight: { type: 'color_background', color: '#111111', backgroundColor: '#FFE14D' },
  },
]

/** Sombra em 8 direções — aproxima um contorno uniforme ao redor do texto (mais suave que -webkit-text-stroke sozinho). */
export function subtitleOutlineShadow(outline: SubtitleOutline): string {
  if (!outline.enabled || outline.width <= 0) return 'none'
  const w = outline.width
  const offsets: [number, number][] = [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]
  return offsets.map(([dx, dy]) => `${dx * w}px ${dy * w}px 0 ${outline.color}`).join(', ')
}

/** O segmento cujo intervalo [startTime, endTime] contém currentTime, ou null fora de qualquer legenda. */
export function findActiveSegment(segments: SubtitleSegment[], currentTime: number): SubtitleSegment | null {
  for (const seg of segments) {
    if (currentTime >= seg.startTime && currentTime <= seg.endTime) return seg
  }
  return null
}

/** A palavra ativa dentro do segmento (para o destaque karaokê), usando os timestamps já fornecidos pelo backend. */
export function findActiveWord(segment: SubtitleSegment, currentTime: number): SubtitleWord | null {
  for (const w of segment.words) {
    if (currentTime >= w.startTime && currentTime <= w.endTime) return w
  }
  return null
}

/* ------------------------------------------------------ Sincronização precisa (Etapa 2 — evolução) --- */

/** 'auto' deixa o sistema escolher a quantidade por bloco (pausas/pontuação/tamanho); os demais valores
 * são um TETO aproximado de palavras por legenda — não uma regra cega: uma pausa natural clara entre
 * palavras fecha o bloco mais cedo mesmo sem atingir o teto (ver groupWordsIntoSegments). Reagrupar
 * NUNCA chama IA — é só reparticionar a mesma lista de palavras já sincronizada, por isso é instantâneo. */
export type SubtitleWordsPerCaption = 'auto' | 5 | 10 | 15 | 20 | 25 | 30

export const WORDS_PER_CAPTION_OPTIONS: { value: SubtitleWordsPerCaption; label: string }[] = [
  { value: 'auto', label: 'Automático' },
  { value: 5, label: '5 palavras' },
  { value: 10, label: '10 palavras' },
  { value: 15, label: '15 palavras' },
  { value: 20, label: '20 palavras' },
  { value: 25, label: '25 palavras' },
  { value: 30, label: '30 palavras' },
]

const AUTO_MAX_WORDS = 8
const AUTO_MAX_CHARS = 42
// Pausa entre o fim de uma palavra e o início da próxima que conta como corte natural de frase —
// vale pra TODOS os modos (auto e contagem fixa): o teto de palavras é só um limite superior,
// uma pausa clara sempre fecha o bloco antes disso (item 4 do pedido de "palavras por legenda").
const NATURAL_PAUSE_GAP_SECONDS = 0.6
const SENTENCE_END_RE = /[.!?;]$/

// Mesmos separadores de backend/utils/subtitle_processor.py (SubtitleProcessor.word_separators)
// — pontuação chinesa/CJK comum + espaço em branco.
const WORD_SEPARATORS_RE = /[，。！？；：""''（）【】、\s]+/

/**
 * Quebra um texto livre (digitado pelo usuário ao editar uma legenda) em palavras com
 * timestamp, redistribuindo o tempo igualmente na janela [startTime, endTime] do segmento —
 * mesma lógica de backend/utils/subtitle_processor.py:_split_text_to_words (ver
 * _apply_subtitle_text_edits), só que local, pra refletir a edição no preview na hora, sem
 * esperar o round-trip da API confirmar. Usado só por edição manual (Editar texto no painel de
 * legenda) — a legenda estimada/sincronizada normal sempre vem pronta do backend.
 */
export function splitPlainTextToWords(text: string, startTime: number, endTime: number): SubtitleWord[] {
  const parts = text.trim().split(WORD_SEPARATORS_RE).map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return []
  const wordDuration = (endTime - startTime) / parts.length
  return parts.map((part, i) => ({
    id: `edit-${startTime}-${i}`,
    text: part,
    startTime: startTime + i * wordDuration,
    endTime: startTime + (i + 1) * wordDuration,
  }))
}

/**
 * Reagrupa uma lista "achatada" de palavras (já com timestamps reais, sincronizados
 * uma única vez com IA) em blocos de legenda — puramente local, sem tocar nos
 * timestamps individuais de cada palavra (item 7/13 da tarefa de sincronização).
 */
export function groupWordsIntoSegments(words: SubtitleWord[], mode: SubtitleWordsPerCaption): SubtitleSegment[] {
  if (words.length === 0) return []

  const maxWords = mode === 'auto' ? AUTO_MAX_WORDS : mode
  const groups: SubtitleWord[][] = []
  let current: SubtitleWord[] = []
  let currentChars = 0

  const flush = () => {
    if (current.length > 0) {
      groups.push(current)
      current = []
      currentChars = 0
    }
  }

  words.forEach((w, i) => {
    current.push(w)
    currentChars += w.text.length + 1
    const next = words[i + 1]
    const pause = next ? next.startTime - w.endTime : Infinity
    const reachedLimit = current.length >= maxWords || (mode === 'auto' && currentChars >= AUTO_MAX_CHARS)
    const sentenceEnd = mode === 'auto' && SENTENCE_END_RE.test(w.text)
    if (!next || sentenceEnd || pause >= NATURAL_PAUSE_GAP_SECONDS || reachedLimit) flush()
  })
  flush()

  return groups.map((group, index) => ({
    id: `synced-seg-${index}`,
    startTime: group[0].startTime,
    endTime: group[group.length - 1].endTime,
    text: group.map((w) => w.text).join(' '),
    index,
    words: group,
  }))
}

export interface SubtitleEditorState {
  style: SubtitleStyle
  position: SubtitlePosition
  /** Só para destacar o bloco na timeline de legendas; não controla o que aparece no canvas (isso é sempre derivado de currentTime). */
  selectedSegmentId: string | null
  wordsPerCaption: SubtitleWordsPerCaption
  transition: SubtitleTransition
  wordHighlight: WordHighlight
  /** Oculta a legenda inteira (preview e render) sem perder nenhuma config de estilo/sync —
   * útil pra exportar um corte "limpo" sem precisar apagar a sincronização. */
  visible: boolean
}

export interface EditorState {
  canvas: {
    format: CanvasFormat
    background: BackgroundConfig
  }
  /** layers[0] é sempre a layer principal (isMain=true) — ver createMainVideoLayer. */
  layers: VideoLayer[]
  selectedLayerId: string | null
  subtitle: SubtitleEditorState
}

/** Enquadra o vídeo dentro do canvas preservando a proporção original (contain-fit), centralizado. */
/**
 * Enquadra o vídeo no Canvas preservando a proporção original (nunca deforma/estica —
 * `width`/`height` sempre guardam a proporção real do vídeo entre si).
 *
 * 'cover' (padrão): preenche o Canvas inteiro, cortando o excesso via overflow:hidden do
 * frame — nunca aparece borda preta. 'contain': o vídeo inteiro fica visível, sobrando área
 * (fundo do Canvas) nos lados que não combinam com o formato.
 */
export function fitTransform(format: CanvasFormat, videoRatio: number, mode: 'contain' | 'cover' = 'cover'): NormalizedTransform {
  const cRatio = canvasRatio(format)
  let width: number
  let height: number
  // cover: escala = max(canvasW/videoW, canvasH/videoH) — equivalente a object-fit:cover.
  // contain: escala = min(...) — equivalente a object-fit:contain (comportamento antigo).
  const widerThanCanvas = mode === 'cover' ? videoRatio > cRatio : videoRatio <= cRatio
  if (widerThanCanvas) {
    // vídeo mais "largo" que o canvas: a ALTURA cobre 100%, a largura sobra (cover: recortada
    // nas laterais; contain: nunca acontece — aqui vira o ramo de altura sobrando embaixo/cima).
    height = 1
    width = videoRatio / cRatio
  } else {
    width = 1
    height = cRatio / videoRatio
  }
  return { x: (1 - width) / 2, y: (1 - height) / 2, width, height, rotation: 0 }
}

/**
 * Ao trocar o formato do canvas, o retângulo normalizado precisa ser
 * recalculado: a MESMA fração width/height representa proporções físicas
 * diferentes em canvas de proporções diferentes. Preserva a largura escolhida
 * pelo usuário e recalcula a altura para manter o vídeo sem distorção.
 */
export function resizeTransformForFormat(
  transform: NormalizedTransform,
  prevFormat: CanvasFormat,
  nextFormat: CanvasFormat,
  videoRatio: number,
): NormalizedTransform {
  if (prevFormat === nextFormat) return transform
  const nextCanvasRatio = canvasRatio(nextFormat)
  const height = (transform.width * nextCanvasRatio) / videoRatio
  return { ...transform, height }
}

/* -------------------------------------------------------- Persistência / Render (Etapa 4) --- */

/**
 * Forma serializável de EditorState, salva em clip.clip_metadata["edit_config"] (backend,
 * ver editor_render_service.py). Deliberadamente NÃO inclui `syncedWords`: os timestamps por
 * palavra já são persistidos de forma durável em clip_metadata.subtitle_sync.words (ver
 * subtitle_sync_service.py) — duplicá-los aqui criaria duas fontes de verdade para o mesmo
 * dado. O backend, ao renderizar, lê subtitle_sync.words direto (mesma função usada por
 * GET /subtitle-editor/.../subtitles) e reagrupa com groupWordsIntoSegments — a MESMA lógica
 * deste arquivo, portada para Python em editor_render_service.group_words_into_segments
 * (qualquer mudança nas constantes/regras precisa ser replicada nos dois lados).
 */
export const EDIT_CONFIG_VERSION = 1

export interface EditConfigLayer {
  id: string
  name: string
  visible: boolean
  transform: NormalizedTransform
  zIndex: number
  startTime: number
  /** Infinity (layer principal) não sobrevive a JSON.stringify — vira null; o backend trata
   * null como "até o fim do vídeo principal" (ver editor_render_service.build_render_spec). */
  endTime: number | null
  isMain: boolean
  assetId?: string
  fitMode?: 'contain' | 'cover'
  customized?: boolean
  isDuplicate?: boolean
}

export interface EditConfig {
  version: typeof EDIT_CONFIG_VERSION
  canvas: EditorState['canvas']
  layers: EditConfigLayer[]
  subtitle: {
    wordsPerCaption: SubtitleWordsPerCaption
    style: SubtitleStyle
    position: SubtitlePosition
    transition: SubtitleTransition
    wordHighlight: WordHighlight
    visible?: boolean
  }
}

/** true se alguma layer secundária ainda não tem assetId (upload pendente) — usado para
 * bloquear Salvar/Exportar até o upload terminar (ver ClipEditorPage). */
export function hasUnuploadedLayers(layers: VideoLayer[]): boolean {
  return layers.some((l) => !l.isMain && !l.assetId)
}

export function toEditConfig(state: EditorState): EditConfig {
  return {
    version: EDIT_CONFIG_VERSION,
    canvas: state.canvas,
    layers: state.layers.map((l) => ({
      id: l.id,
      name: l.name,
      visible: l.visible,
      transform: l.transform,
      zIndex: l.zIndex,
      startTime: l.startTime,
      endTime: Number.isFinite(l.endTime) ? l.endTime : null,
      isMain: l.isMain,
      assetId: l.assetId,
      fitMode: l.fitMode,
      customized: l.customized,
      isDuplicate: l.isDuplicate,
    })),
    subtitle: {
      wordsPerCaption: state.subtitle.wordsPerCaption,
      style: state.subtitle.style,
      position: state.subtitle.position,
      transition: state.subtitle.transition,
      wordHighlight: state.subtitle.wordHighlight,
      visible: state.subtitle.visible,
    },
  }
}

/**
 * Reconstrói o EditorState a partir de um EditConfig salvo. `resolveAssetSource` traduz o
 * assetId de cada layer secundária numa URL tocável (endpoint do backend que serve o asset —
 * o object URL original da sessão de upload não existe mais depois de um reload).
 */
export function applyEditConfig(
  config: EditConfig,
  mainVideoUrl: string,
  resolveAssetSource: (assetId: string) => string,
): EditorState {
  // Configs salvas antes da Etapa 4.2 não têm transition/wordHighlight — migra a partir do
  // `animation` antigo em vez de simplesmente cair no default (preserva o comportamento que
  // o usuário já tinha configurado; nunca perde uma sincronização/config existente).
  const legacy = !config.subtitle.transition || !config.subtitle.wordHighlight
    ? migrateLegacyAnimation(config.subtitle.style.animation)
    : null
  return {
    canvas: config.canvas,
    selectedLayerId: null,
    layers: config.layers.map((l) => ({
      id: l.id,
      type: 'video',
      name: l.name,
      source: l.isMain ? mainVideoUrl : (l.assetId ? resolveAssetSource(l.assetId) : ''),
      visible: l.visible,
      transform: l.transform,
      zIndex: l.zIndex,
      startTime: l.startTime,
      endTime: l.endTime === null ? Number.POSITIVE_INFINITY : l.endTime,
      isMain: l.isMain,
      assetId: l.assetId,
      // Configs salvas antes desta correção não têm fitMode — 'cover' é o padrão atual (nunca
      // borda preta), preserva o comportamento que o usuário já via antes de existir o campo.
      fitMode: l.fitMode ?? 'cover',
      // idem pra customized: configs antigas nunca tiveram esse campo — default false é
      // exatamente o que corrige o bug relatado (layer nunca foi customizada de verdade,
      // deixa o auto-fit por fitMode assumir o controle de novo em vez de travar pra sempre
      // no transform antigo, com borda preta).
      customized: l.customized ?? false,
      isDuplicate: l.isDuplicate,
    })),
    subtitle: {
      style: { ...DEFAULT_SUBTITLE_STYLE, ...config.subtitle.style },
      position: config.subtitle.position,
      selectedSegmentId: null,
      wordsPerCaption: config.subtitle.wordsPerCaption,
      transition: config.subtitle.transition ?? legacy!.transition,
      wordHighlight: config.subtitle.wordHighlight ?? legacy!.wordHighlight,
      // Configs salvas antes desta funcionalidade não têm o campo — default visível preserva
      // o comportamento que o usuário já via antes de existir a opção de ocultar.
      visible: config.subtitle.visible ?? true,
    },
  }
}

export function createDefaultEditorState(mainVideoUrl: string): EditorState {
  const mainLayer = createMainVideoLayer(mainVideoUrl)
  return {
    canvas: { format: '9:16', background: { ...DEFAULT_BACKGROUND } },
    layers: [mainLayer],
    selectedLayerId: null,
    subtitle: {
      style: { ...DEFAULT_SUBTITLE_STYLE, outline: { ...DEFAULT_SUBTITLE_STYLE.outline } },
      position: { ...DEFAULT_SUBTITLE_POSITION },
      selectedSegmentId: null,
      wordsPerCaption: 'auto',
      transition: { ...DEFAULT_SUBTITLE_TRANSITION },
      wordHighlight: { ...DEFAULT_WORD_HIGHLIGHT },
      visible: true,
    },
  }
}
