import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import Moveable, { type OnDrag, type OnDragEnd, type OnResize, type OnResizeEnd, type OnResizeStart } from 'react-moveable'
import { BackgroundConfig, CANVAS_DIMENSIONS, CanvasFormat, NormalizedTransform, SubtitlePosition, SubtitleSegment, SubtitleStyle, SubtitleTransition, WordHighlight, VideoLayer, findActiveLayers } from './types'
import SubtitleLayer from './SubtitleLayer'
import { snapToCenter } from './centerSnap'

interface EditorCanvasProps {
  format: CanvasFormat
  background: BackgroundConfig
  /** layers[0] é sempre a principal (ver types.ts createMainVideoLayer). */
  layers: VideoLayer[]
  selectedLayerId: string | null
  onSelectLayer: (id: string | null) => void
  onLayerTransformChange: (id: string, t: NormalizedTransform) => void
  /** Metadados de vídeo (largura/altura reais) — usado pra enquadrar cada layer no primeiro load. */
  onLayerLoadedMetadata: (id: string, videoWidth: number, videoHeight: number) => void
  /** A layer principal também dirige o relógio global do Editor (currentTime/duration/play) —
   * ver ClipEditorPage: um único player "de verdade", os demais só seguem o tempo dele. */
  mainVideoRef: React.RefObject<HTMLVideoElement>
  onMainTimeUpdate: () => void
  onMainDurationChange: (d: number) => void
  onMainEnded: () => void
  onMainPlayStateChange: (playing: boolean) => void
  currentTime: number
  isPlaying: boolean
  /** Etapa 2 — legenda. */
  subtitleSegments: SubtitleSegment[]
  subtitleStyle: SubtitleStyle
  subtitlePosition: SubtitlePosition
  /** Etapa 4.2 — transição de entrada e destaque da palavra ativa. */
  subtitleTransition: SubtitleTransition
  wordHighlight: WordHighlight
  /** Oculta a legenda do preview inteiro (mesma flag usada no render — ver types.ts). */
  subtitleVisible: boolean
  onSubtitlePositionChange: (p: Partial<SubtitlePosition>) => void
}

/**
 * Canvas do Editor de Corte.
 *
 * Cada layer de vídeo é um elemento <video> real (não canvas de pixels), posicionado via
 * `transform` normalizado (0..1), como desde a Etapa 1. Layers secundárias permanecem sempre
 * montadas no DOM (nunca desmontadas ao ocultar/sair da janela de tempo) pra não perder o
 * estado de reprodução — só ficam com display:none + pausadas quando inativas (item 9/24).
 * Só a layer selecionada tem Moveable ativo.
 */
const EditorCanvas: React.FC<EditorCanvasProps> = ({
  format, background, layers, selectedLayerId, onSelectLayer, onLayerTransformChange, onLayerLoadedMetadata,
  mainVideoRef, onMainTimeUpdate, onMainDurationChange, onMainEnded, onMainPlayStateChange,
  currentTime, isPlaying,
  subtitleSegments, subtitleStyle, subtitlePosition, subtitleTransition, wordHighlight, subtitleVisible, onSubtitlePositionChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const bgVideoRef = useRef<HTMLVideoElement>(null)
  const [frameSize, setFrameSize] = useState({ width: 0, height: 0 })
  const [subtitleSelected, setSubtitleSelected] = useState(false)
  // Registro dos elementos <video> de cada layer — precisa ser estado (não só ref) pra o
  // Moveable perceber quando o elemento da layer selecionada já existe no DOM.
  const [videoEls, setVideoEls] = useState<Record<string, HTMLVideoElement | null>>({})
  // Alvo REAL do Moveable: um <div> invisível, nunca o <video> — ver useLayoutEffect abaixo
  // (bug do Chromium: um <video> com layout box bem maior que a área visível às vezes nunca
  // pinta). O vídeo em si fica SEMPRE do tamanho do frame + transform:scale (nunca ganha um box
  // maior que o frame, selecionado ou não); o proxy é quem recebe o box "cru" em pixels que o
  // Moveable precisa pra calcular drag/resize, e cada mudança nele é espelhada no vídeo via
  // syncVideoToProxy. Precisa ser estado (não só ref) pra o Moveable perceber quando o elemento
  // já existe no DOM — mesmo motivo de videoEls abaixo.
  const [proxyEl, setProxyEl] = useState<HTMLDivElement | null>(null)
  // Instância do Moveable ativo — ver useLayoutEffect abaixo: precisamos poder mandar ele
  // remedir o alvo manualmente depois de QUALQUER mudança de estilo feita por fora dele
  // (troca de formato, seleção, fitMode), já que ele só remede sozinho durante o próprio
  // drag/resize do usuário.
  const moveableRef = useRef<Moveable<any>>(null)
  // Contorno VISUAL limitado ao frame. O contorno nativo do Moveable continua existindo (só
  // fica transparente via CSS) para preservar toda a área interativa e os cálculos internos.
  // Este elemento acompanha os mesmos limites aplicados aos pontos, sem alterar o box real.
  const clampedOutlineRef = useRef<HTMLDivElement>(null)
  const centerGuidesRef = useRef<HTMLDivElement>(null)
  const snappedAxesRef = useRef({ x: false, y: false })
  const clearCenterGuides = () => {
    snappedAxesRef.current = { x: false, y: false }
    if (centerGuidesRef.current) centerGuidesRef.current.style.display = 'none'
  }
  const dragWithCenterSnap = (target: HTMLElement, left: number, top: number) => {
    if (!frameSize.width || !frameSize.height) return
    const width = parseFloat(target.style.width || '0')
    const height = parseFloat(target.style.height || '0')
    const rotation = (selectedLayer?.transform.rotation ?? 0) * Math.PI / 180
    // The proxy rotates around its center; the rendered video rotates around its origin.
    const centerX = (width * Math.cos(rotation) - height * Math.sin(rotation)) / 2
    const centerY = (width * Math.sin(rotation) + height * Math.cos(rotation)) / 2
    const rect = frameRef.current?.getBoundingClientRect()
    const x = snapToCenter(left, frameSize.width / 2 - centerX, snappedAxesRef.current.x, rect ? rect.width / frameSize.width : 1)
    const y = snapToCenter(top, frameSize.height / 2 - centerY, snappedAxesRef.current.y, rect ? rect.height / frameSize.height : 1)
    snappedAxesRef.current = { x: x.snapped, y: y.snapped }
    target.style.left = `${x.position}px`
    target.style.top = `${y.position}px`
    const guides = centerGuidesRef.current
    if (guides) {
      guides.style.display = 'block'
      guides.classList.toggle('ac-editor-center-guides--x', x.snapped)
      guides.classList.toggle('ac-editor-center-guides--y', y.snapped)
    }
    syncVideoToProxy(target)
    scheduleHandleClamp()
  }
  // O retângulo do vídeo pode crescer muito além do frame. O Moveable precisa manter esse
  // retângulo real para calcular o zoom, mas suas alças não precisam ser desenhadas fora da
  // área visível. Reposicionamos apenas cada controle (e sua área clicável) na borda do frame;
  // a direção e os cálculos do resize continuam ligados ao canto/borda original.
  const handleClampRafRef = useRef<number | null>(null)
  const clampMoveableHandlesToFrame = () => {
    const frame = frameRef.current
    if (!frame) return
    const frameRect = frame.getBoundingClientRect()
    const controls = frame.querySelectorAll<HTMLElement>('.moveable-control.moveable-direction.moveable-resizable')
    controls.forEach((control) => {
      // Mede sempre a posição real gerada pelo Moveable, sem acumular a correção anterior.
      control.style.translate = ''
      const rect = control.getBoundingClientRect()
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const clampedX = Math.min(Math.max(centerX, frameRect.left), frameRect.right)
      const clampedY = Math.min(Math.max(centerY, frameRect.top), frameRect.bottom)
      const offsetX = clampedX - centerX
      const offsetY = clampedY - centerY
      control.style.translate = `${offsetX}px ${offsetY}px`
    })

    const outline = clampedOutlineRef.current
    const proxy = proxyEl
    if (!outline || !proxy) return
    const proxyRect = proxy.getBoundingClientRect()
    const left = Math.min(Math.max(proxyRect.left, frameRect.left), frameRect.right)
    const right = Math.min(Math.max(proxyRect.right, frameRect.left), frameRect.right)
    const top = Math.min(Math.max(proxyRect.top, frameRect.top), frameRect.bottom)
    const bottom = Math.min(Math.max(proxyRect.bottom, frameRect.top), frameRect.bottom)
    outline.style.left = `${left - frameRect.left}px`
    outline.style.top = `${top - frameRect.top}px`
    outline.style.width = `${Math.max(0, right - left)}px`
    outline.style.height = `${Math.max(0, bottom - top)}px`
    outline.style.display = 'block'
  }
  const scheduleHandleClamp = () => {
    if (handleClampRafRef.current !== null) cancelAnimationFrame(handleClampRafRef.current)
    handleClampRafRef.current = requestAnimationFrame(() => {
      handleClampRafRef.current = null
      clampMoveableHandlesToFrame()
    })
  }
  // Um callback de ref ESTÁVEL por layer (memoizado aqui, não recriado a cada render) — um
  // `ref={(el) => ...}` inline faz o React desanexar+reanexar a ref (null, depois o elemento
  // de novo) a cada commit, porque a identidade da função muda a cada render; cada uma dessas
  // chamadas disparava setVideoEls, gerando outro render, recriando a função de novo — um loop
  // infinito ("Maximum update depth exceeded"). Com a mesma função reutilizada por layer.id,
  // o React só desanexa/reanexa quando o elemento de verdade muda (montar/desmontar).
  const refCallbacksRef = useRef<Map<string, (el: HTMLVideoElement | null) => void>>(new Map())
  const getVideoRefCallback = (layerId: string, isMain: boolean) => {
    let cb = refCallbacksRef.current.get(layerId)
    if (!cb) {
      cb = (el: HTMLVideoElement | null) => {
        if (isMain) (mainVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el
        setVideoEls((prev) => (prev[layerId] === el ? prev : { ...prev, [layerId]: el }))
      }
      refCallbacksRef.current.set(layerId, cb)
    }
    return cb
  }

  const dims = CANVAS_DIMENSIONS[format]
  const canvasAspect = dims.width / dims.height
  const mainLayer = layers.find((l) => l.isMain) ?? layers[0]
  const activeIds = new Set(findActiveLayers(layers, currentTime).map((l) => l.id))
  const selectedLayer = layers.find((l) => l.id === selectedLayerId) ?? null

  // Espelha o box "cru" em pixels do proxy no <video> real da layer selecionada, convertido
  // pro modelo frame-size+scale (ver comentário do proxyEl acima) — chamado tanto no
  // useLayoutEffect (seleção/troca de formato) quanto ao vivo durante um drag/resize
  // (handleDrag/handleResize), pra o vídeo sempre acompanhar visualmente o proxy sem nunca
  // ganhar um layout box maior que o frame.
  const syncVideoToProxy = (proxy: HTMLElement) => {
    if (!selectedLayerId || frameSize.width === 0) return
    const el = videoEls[selectedLayerId]
    if (!el) return
    const left = parseFloat(proxy.style.left || '0')
    const top = parseFloat(proxy.style.top || '0')
    const width = parseFloat(proxy.style.width || '0')
    const height = parseFloat(proxy.style.height || '0')
    const rotatePart = proxy.style.transform || ''
    el.style.left = `${left}px`
    el.style.top = `${top}px`
    el.style.width = `${frameSize.width}px`
    el.style.height = `${frameSize.height}px`
    el.style.transformOrigin = '0 0'
    el.style.transform = `scale(${width / frameSize.width}, ${height / frameSize.height})${rotatePart ? ` ${rotatePart}` : ''}`
  }

  // Tamanho do frame = o maior retângulo com a proporção do formato que cabe no container disponível.
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const compute = () => {
      const { width: cw, height: ch } = container.getBoundingClientRect()
      if (cw <= 0 || ch <= 0) return
      const containerAspect = cw / ch
      const size = containerAspect > canvasAspect
        ? { width: ch * canvasAspect, height: ch }
        : { width: cw, height: cw / canvasAspect }
      setFrameSize(size)
    }
    compute()
    const observer = new ResizeObserver(compute)
    observer.observe(container)
    return () => observer.disconnect()
  }, [canvasAspect])

  // Reflete o transform normalizado de CADA layer em pixels do frame atual — troca de formato,
  // resize da janela, ou commit de um drag/resize (qualquer uma delas, não só a selecionada).
  //
  // Bug real (vídeo principal não aparecia ao abrir o Editor em 9:16, e reaparecia ao
  // SELECIONAR uma layer 'cover' já com o Canvas em 9:16): um <video> bem maior que o frame
  // (modo "cover" pode passar de 300%, ex.: vídeo 16:9 cobrindo canvas 9:16) e majoritariamente
  // recortado pelo overflow:hidden do frame às vezes nunca chegava a pintar NENHUM frame no
  // Chromium — o elemento existia no tamanho/posição certos, mas ficava transparente/preto.
  // Confirmado isolando: o MESMO vídeo pinta normalmente se o layout box dele nunca for maior
  // que o frame. Tentativas de "forçar o repaint" depois do box crescer (nudge de currentTime,
  // clip-path, translateZ/will-change, toggle de object-fit) nunca foram 100% confiáveis.
  //
  // Por isso o <video> em si NUNCA recebe um box maior que o frame, esteja selecionado ou não —
  // sempre frame-size + transform:scale() (CSS transform não conta como redimensionar o layout
  // pra esse bug do Chromium). Quem recebe o box "cru" em pixels que o Moveable precisa pra
  // calcular drag/resize é um <div> proxy invisível (ver proxyEl acima) na MESMA posição/tamanho
  // visual final — um <div> não tem esse bug de vídeo, então pode ficar arbitrariamente grande
  // sem problema. Cada mudança no proxy é espelhada no vídeo por syncVideoToProxy.
  //
  // Bug real (handles de resize ficando com o formato antigo do vídeo, ou o "preencher
  // proporcionalmente" parecendo não preencher a tela ao selecionar/trocar de formato): o
  // Moveable só remede o alvo sozinho durante o PRÓPRIO gesto de drag/resize — quando o box do
  // alvo muda por fora dele (aqui: troca de formato, seleção de outra layer, fitMode), ele fica
  // com o retângulo antigo em cache até a próxima interação do usuário, então as guias/handles
  // aparecem na posição/tamanho errados mesmo com o <video> já no lugar certo. Usar
  // useLayoutEffect (em vez de useEffect) garante que o estilo do alvo já está atualizado ANTES
  // do Moveable (filho na árvore, efeitos de filho rodam antes) medir de novo; o updateRect()
  // explícito no fim cobre o caso em que o Moveable mede antes desta mudança ainda ser aplicada
  // (ex.: acabou de montar ao selecionar a layer).
  useLayoutEffect(() => {
    if (frameSize.width === 0) return
    for (const layer of layers) {
      const el = videoEls[layer.id]
      if (!el) continue
      const left = layer.transform.x * frameSize.width
      const top = layer.transform.y * frameSize.height
      const rotatePart = layer.transform.rotation ? `rotate(${layer.transform.rotation}deg)` : ''
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      el.style.width = `${frameSize.width}px`
      el.style.height = `${frameSize.height}px`
      el.style.transformOrigin = '0 0'
      el.style.transform = `scale(${layer.transform.width}, ${layer.transform.height})${rotatePart ? ` ${rotatePart}` : ''}`
    }
    if (selectedLayer && proxyEl) {
      proxyEl.style.left = `${selectedLayer.transform.x * frameSize.width}px`
      proxyEl.style.top = `${selectedLayer.transform.y * frameSize.height}px`
      proxyEl.style.width = `${selectedLayer.transform.width * frameSize.width}px`
      proxyEl.style.height = `${selectedLayer.transform.height * frameSize.height}px`
      proxyEl.style.transform = selectedLayer.transform.rotation ? `rotate(${selectedLayer.transform.rotation}deg)` : ''
    }
    moveableRef.current?.updateRect()
    scheduleHandleClamp()
  }, [layers, frameSize, videoEls, selectedLayerId, selectedLayer, proxyEl])

  useEffect(() => () => {
    if (handleClampRafRef.current !== null) cancelAnimationFrame(handleClampRafRef.current)
  }, [])

  useEffect(clearCenterGuides, [selectedLayerId, format, frameSize])

  // Fundo desfocado: um segundo <video>, mudo, espelhando play/pause/tempo do vídeo PRINCIPAL
  // (não das layers secundárias — o fundo sempre reflete o corte original).
  useEffect(() => {
    if (background.type !== 'blur') return
    const main = mainVideoRef.current
    const bg = bgVideoRef.current
    if (!main || !bg) return
    const syncTime = () => {
      if (Math.abs(bg.currentTime - main.currentTime) > 0.3) bg.currentTime = main.currentTime
    }
    const onPlay = () => { bg.play().catch(() => {}); syncTime() }
    const onPause = () => bg.pause()
    main.addEventListener('play', onPlay)
    main.addEventListener('pause', onPause)
    main.addEventListener('seeked', syncTime)
    main.addEventListener('timeupdate', syncTime)
    syncTime()
    if (!main.paused) onPlay()
    return () => {
      main.removeEventListener('play', onPlay)
      main.removeEventListener('pause', onPause)
      main.removeEventListener('seeked', syncTime)
      main.removeEventListener('timeupdate', syncTime)
    }
  }, [background.type, mainVideoRef])

  // Sincroniza as layers SECUNDÁRIAS com o relógio global do Editor (item 13/14/15): usa o
  // mesmo currentTime/isPlaying que já dirige a layer principal — nenhum timer novo por vídeo.
  // tempo relativo do arquivo = currentTime - layer.startTime (item 14).
  useEffect(() => {
    for (const layer of layers) {
      if (layer.isMain) continue
      const el = videoEls[layer.id]
      if (!el) continue
      const active = layer.visible && currentTime >= layer.startTime && currentTime <= layer.endTime
      if (!active) {
        if (!el.paused) el.pause()
        continue
      }
      const relativeTime = currentTime - layer.startTime
      if (Math.abs(el.currentTime - relativeTime) > 0.3) el.currentTime = relativeTime
      if (isPlaying && el.paused) el.play().catch(() => {})
      if (!isPlaying && !el.paused) el.pause()
    }
  }, [layers, videoEls, currentTime, isPlaying])

  const commitFromTarget = (layerId: string, target: HTMLElement | SVGElement) => {
    if (frameSize.width === 0 || frameSize.height === 0) return
    const layer = layers.find((l) => l.id === layerId)
    if (!layer) return
    const el = target as HTMLElement
    const left = parseFloat(el.style.left || '0')
    const top = parseFloat(el.style.top || '0')
    const width = parseFloat(el.style.width || '0')
    const height = parseFloat(el.style.height || '0')
    onLayerTransformChange(layerId, {
      x: left / frameSize.width,
      y: top / frameSize.height,
      width: width / frameSize.width,
      height: height / frameSize.height,
      rotation: layer.transform.rotation,
    })
  }

  // Zoom via scroll do mouse na layer selecionada — escala proporcional ancorada na posição
  // do cursor dentro do frame (o ponto sob o cursor fica fixo). Não muda o tamanho do frame
  // nem afeta outras layers; o resultado final é um commit de NormalizedTransform (mesma
  // pipeline de drag/resize). O scroll fora de qualquer seleção é ignorado.
  const handleWheel = (e: React.WheelEvent) => {
    if (!selectedLayer || frameSize.width === 0) return
    e.preventDefault()
    e.stopPropagation()
    const ZOOM_STEP = 0.08
    const factor = e.deltaY < 0 ? 1 + ZOOM_STEP : 1 - ZOOM_STEP
    const t = selectedLayer.transform
    const newWidth = Math.min(10, Math.max(0.05, t.width * factor))
    const newHeight = Math.min(10, Math.max(0.05, t.height * factor))
    // Ponto do cursor em coordenadas normalizadas (0..1) relativas ao frame.
    const frameRect = frameRef.current?.getBoundingClientRect()
    let anchorNx = 0.5
    let anchorNy = 0.5
    if (frameRect && frameRect.width > 0 && frameRect.height > 0) {
      anchorNx = Math.min(1, Math.max(0, (e.clientX - frameRect.left) / frameRect.width))
      anchorNy = Math.min(1, Math.max(0, (e.clientY - frameRect.top) / frameRect.height))
    }
    // Mantém o ponto sob o cursor fixo: newX = anchorNx - (anchorNx - oldX) * (newW / oldW)
    const scaleX = t.width > 0 ? newWidth / t.width : 1
    const scaleY = t.height > 0 ? newHeight / t.height : 1
    const newX = anchorNx - (anchorNx - t.x) * scaleX
    const newY = anchorNy - (anchorNy - t.y) * scaleY
    onLayerTransformChange(selectedLayer.id, {
      x: newX,
      y: newY,
      width: newWidth,
      height: newHeight,
      rotation: t.rotation,
    })
  }

  const handleDrag = ({ target, left, top }: OnDrag) => {
    dragWithCenterSnap(target as HTMLElement, left, top)
  }

  // Dois comportamentos de resize, escolhidos pelo fitMode da layer selecionada:
  //
  // fitMode 'contain' (Normal): TODA alça (canto OU borda) dá zoom proporcional — nunca
  // deforma. Qualquer alça escala os dois eixos juntos, acompanhando continuamente o quanto o
  // usuário arrasta (não é um zoom fixo/preset) — o eixo que a alça não controla diretamente
  // (borda, não canto) é derivado via a proporção do vídeo, ancorado no CENTRO da caixa nesse
  // eixo (não tem uma borda natural pra ancorar ali).
  //
  // fitMode 'cover': TODOS os handles redimensionam livremente (largura e altura
  // independentes) — quem impede a deformação do CONTEÚDO não é travar o formato da caixa, é
  // o object-fit:cover no <video> (ver JSX). Só a altura muda ao arrastar os handles de cima/
  // baixo, a largura fica onde estava, e o vídeo nunca parece "esticar" porque quem está
  // sempre recortando/cobrindo a caixa é o navegador, não uma trava de proporção no drag.
  const resizeStartRef = useRef({ left: 0, top: 0, width: 0, height: 0, ratio: 1 })

  const handleResizeStart = ({ target }: OnResizeStart) => {
    const el = target as HTMLElement
    const left = parseFloat(el.style.left || '0')
    const top = parseFloat(el.style.top || '0')
    const width = parseFloat(el.style.width || '0')
    const height = parseFloat(el.style.height || '0')
    resizeStartRef.current = { left, top, width, height, ratio: height > 0 ? width / height : 1 }
  }

  const handleResize = ({ target, width, height, direction }: OnResize) => {
    const [dx, dy] = direction
    const s = resizeStartRef.current
    let newWidth = width
    let newHeight = height

    if (selectedLayer?.fitMode !== 'cover') {
      const ratio = s.ratio
      if (dx !== 0) newHeight = newWidth / ratio
      else newWidth = newHeight * ratio
    }
    // dx/dy === 1 -> a borda direita/inferior é a que está sendo arrastada, então a
    // esquerda/topo fica ancorada (e vice-versa) — mesma convenção de direção do Moveable.
    // dx/dy === 0 (alça de borda, eixo derivado/não tocado) -> ancora no CENTRO da caixa
    // nesse eixo (não tem uma borda natural pra ancorar ali).
    const anchorX = dx === 1 ? s.left : (dx === -1 ? s.left + s.width : s.left + s.width / 2)
    const anchorY = dy === 1 ? s.top : (dy === -1 ? s.top + s.height : s.top + s.height / 2)
    const newLeft = dx === 1 ? anchorX : (dx === -1 ? anchorX - newWidth : anchorX - newWidth / 2)
    const newTop = dy === 1 ? anchorY : (dy === -1 ? anchorY - newHeight : anchorY - newHeight / 2)

    target.style.width = `${newWidth}px`
    target.style.height = `${newHeight}px`
    target.style.left = `${newLeft}px`
    target.style.top = `${newTop}px`
    syncVideoToProxy(target as HTMLElement)
    scheduleHandleClamp()
  }

  // Layers renderizadas em ordem de zIndex crescente (a última no DOM fica visualmente acima
  // por padrão), mas o empilhamento real é controlado por style.zIndex explícito — assim
  // reordenar (mudar zIndex) nunca precisa remontar o elemento <video> (perderia o playback).
  const orderedLayers = [...layers].sort((a, b) => a.zIndex - b.zIndex)

  return (
    <div ref={containerRef} className="ac-editor-canvas-container">
      <div
        ref={frameRef}
        className="ac-editor-frame"
        style={{ width: frameSize.width, height: frameSize.height }}
        onMouseDown={(e) => { if (e.target === frameRef.current) { onSelectLayer(null); setSubtitleSelected(false) } }}
        onWheel={handleWheel}
      >
        {/* Recorta só o vídeo/fundo — ver .ac-editor-clip no CSS (as alças do Moveable ficam
            fora daqui, direto no .ac-editor-frame, pra nunca ficarem escondidas quando o zoom
            deixa a caixa maior que a tela). */}
        <div className="ac-editor-clip">
          {/* Fundo */}
          {background.type === 'color' ? (
            <div className="ac-editor-bg" style={{ background: background.color }} />
          ) : (
            <div className="ac-editor-bg ac-editor-bg--blur">
              <video
                ref={bgVideoRef}
                src={mainLayer?.source}
                muted
                playsInline
                style={{ filter: `blur(${background.blurAmount}px)`, transform: 'scale(1.18)' }}
              />
            </div>
          )}

        {orderedLayers.map((layer) => {
          const isActive = activeIds.has(layer.id)
          return (
            <video
              key={layer.id}
              ref={getVideoRefCallback(layer.id, layer.isMain)}
              src={layer.source}
              className="ac-editor-video"
              draggable={false}
              playsInline
              muted={!layer.isMain}
              // 'cover': o conteúdo NUNCA deforma não importa o formato da caixa (o usuário
              // pode redimensionar livremente pra escolher o crop) — quem garante isso é o
              // object-fit, não uma trava no resize. 'contain'/Normal continua 'fill' (a caixa
              // já É o retângulo final calculado por fitTransform ou por um resize manual
              // travado em proporção nos cantos, ver handleResize).
              style={{ zIndex: layer.zIndex, display: isActive ? undefined : 'none', objectFit: layer.fitMode === 'cover' ? 'cover' : 'fill' }}
              onClick={(e) => { e.stopPropagation(); setSubtitleSelected(false); onSelectLayer(layer.id) }}
              // Arraste manual (pointer events): funciona igual no navegador e no app desktop
              // (WebKit do macOS/WebView2 não repassam bem o arraste do <video> ao Moveable).
              onPointerDown={(e) => {
                if (e.button !== 0) return
                if (layer.id !== selectedLayerId || !proxyEl) return
                e.preventDefault()
                e.stopPropagation()
                const videoEl = e.currentTarget
                const startX = e.clientX
                const startY = e.clientY
                const startLeft = parseFloat(proxyEl.style.left || '0')
                const startTop = parseFloat(proxyEl.style.top || '0')
                clearCenterGuides()
                const frameRect = frameRef.current?.getBoundingClientRect()
                const scaleX = frameRect ? frameRect.width / frameSize.width : 1
                const scaleY = frameRect ? frameRect.height / frameSize.height : 1
                let moved = false
                try { videoEl.setPointerCapture(e.pointerId) } catch { /* ignore */ }
                const onMove = (ev: PointerEvent) => {
                  const dx = ev.clientX - startX
                  const dy = ev.clientY - startY
                  if (!moved && Math.abs(dx) + Math.abs(dy) < 2) return
                  moved = true
                  dragWithCenterSnap(proxyEl, startLeft + dx / scaleX, startTop + dy / scaleY)
                  moveableRef.current?.updateRect()
                }
                const onUp = (ev: PointerEvent) => {
                  try { videoEl.releasePointerCapture(ev.pointerId) } catch { /* ignore */ }
                  window.removeEventListener('pointermove', onMove)
                  window.removeEventListener('pointerup', onUp)
                  window.removeEventListener('pointercancel', onUp)
                  clearCenterGuides()
                  if (moved) commitFromTarget(layer.id, proxyEl)
                }
                window.addEventListener('pointermove', onMove)
                window.addEventListener('pointerup', onUp)
                window.addEventListener('pointercancel', onUp)
              }}
              onLoadedMetadata={(e) => {
                onLayerLoadedMetadata(layer.id, e.currentTarget.videoWidth, e.currentTarget.videoHeight)
                // Bug real: um vídeo "cover" pode nascer com até ~300%+ do tamanho do frame e a
                // maior parte fora da área visível (recortada pelo overflow:hidden do frame) —
                // nesse caso o Chromium às vezes nunca decodifica/pinta nenhum frame sozinho
                // (elemento correto em tamanho/posição, porém completamente em branco) até um
                // seek ou play explícito acontecer. Mesmo motivo do ClipCard.tsx forçar
                // `video.currentTime` pra gerar a miniatura: um nudge mínimo força a decodificação
                // do frame atual. Sem custo perceptível (não altera o tempo de reprodução real).
                if (e.currentTarget.currentTime === 0) e.currentTarget.currentTime = 0.01
              }}
              onTimeUpdate={layer.isMain ? onMainTimeUpdate : undefined}
              onDurationChange={layer.isMain ? (e) => onMainDurationChange(e.currentTarget.duration || 0) : undefined}
              onEnded={layer.isMain ? onMainEnded : undefined}
              onPlay={layer.isMain ? () => onMainPlayStateChange(true) : undefined}
              onPause={layer.isMain ? () => onMainPlayStateChange(false) : undefined}
            />
          )
        })}
        </div>

        <div ref={centerGuidesRef} className="ac-editor-center-guides" aria-hidden="true">
          <div className="ac-editor-center-guide ac-editor-center-guide--vertical" />
          <div className="ac-editor-center-guide ac-editor-center-guide--horizontal" />
        </div>

        {/* Alvo real do Moveable — ver comentário de proxyEl/syncVideoToProxy acima. Invisível
            e sem pointer-events próprio: quem desenha a caixa/alças visíveis e captura o
            arrasto é o overlay que o próprio Moveable renderiza sobre este retângulo. */}
        {selectedLayer && frameSize.width > 0 && (
          <div ref={setProxyEl} className="ac-editor-moveable-proxy" style={{ position: 'absolute', pointerEvents: 'none' }} />
        )}

        {selectedLayer && frameSize.width > 0 && (
          <div ref={clampedOutlineRef} className="ac-editor-moveable-outline" aria-hidden="true" />
        )}

        {selectedLayer && proxyEl && frameSize.width > 0 && (
          <Moveable
            ref={moveableRef}
            target={proxyEl}
            // O proxy continua sendo a geometria usada no resize, mas o próprio vídeo visível
            // captura o arraste. Assim, depois de ampliar, o usuário pode clicar em qualquer
            // parte do vídeo dentro do preview e reposicioná-lo sem procurar a linha/alça.
            container={frameRef.current}
            origin={false}
            draggable
            resizable
            throttleDrag={0}
            throttleResize={0}
            snappable
            snapCenter
            snapThreshold={6}
            // 8 handles (cantos + centros de cada borda). No modo Normal, TODAS preservam o
            // aspect ratio do vídeo (zoom); no Preencher proporcionalmente, todas redimensionam
            // livremente — ver handleResize. O Canvas tem overflow:hidden (ac.editor-frame),
            // então ampliar o vídeo além do frame e arrastar funciona como janela de recorte,
            // sem precisar de uma segunda lógica de transformação. Vale pra qualquer layer
            // selecionada.
            renderDirections={['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se']}
            verticalGuidelines={[0, frameSize.width / 2, frameSize.width]}
            horizontalGuidelines={[0, frameSize.height / 2, frameSize.height]}
            onDrag={handleDrag}
            onDragStart={clearCenterGuides}
            onDragEnd={({ target }: OnDragEnd) => { clearCenterGuides(); commitFromTarget(selectedLayer.id, target) }}
            onResizeStart={handleResizeStart}
            onResize={handleResize}
            onResizeEnd={({ target }: OnResizeEnd) => commitFromTarget(selectedLayer.id, target)}
            onRender={scheduleHandleClamp}
          />
        )}

        {subtitleVisible && (
          <SubtitleLayer
            segments={subtitleSegments}
            currentTime={currentTime}
            style={subtitleStyle}
            position={subtitlePosition}
            transition={subtitleTransition}
            wordHighlight={wordHighlight}
            frameSize={frameSize}
            frameEl={frameRef.current}
            logicalWidth={dims.width}
            selected={subtitleSelected}
            onSelect={() => { onSelectLayer(null); setSubtitleSelected(true) }}
            onPositionChange={onSubtitlePositionChange}
          />
        )}
      </div>
    </div>
  )
}

export default EditorCanvas
