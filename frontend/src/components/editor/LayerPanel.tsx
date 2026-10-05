import React, { useRef, useState } from 'react'
import { Btn, Icon, Segmented } from '../../ui'
import { VideoLayer } from './types'

interface LayerPanelProps {
  layers: VideoLayer[]
  selectedLayerId: string | null
  duration: number
  onSelect: (id: string) => void
  onToggleVisible: (id: string) => void
  onRename: (id: string, name: string) => void
  onMoveUp: (id: string) => void
  onMoveDown: (id: string) => void
  onRemove: (id: string) => void
  onTimeRangeChange: (id: string, startTime: number, endTime: number) => void
  onAddFiles: (files: FileList) => void
  onSetFitMode: (id: string, mode: 'contain' | 'cover') => void
  uploadError: string | null
  /** Legenda tratada como mais uma linha desta lista (mesmo ícone de olho, mesmo padrão
   * visual) — só aparece quando o corte tem legenda disponível (ver SubtitleControls, que
   * continua com o resto dos controles de legenda abaixo desta lista). */
  subtitleAvailable: boolean
  subtitleVisible: boolean
  onToggleSubtitleVisible: () => void
  /** false na "versão básica" do Editor sem servidor (ver ClipEditorPage) — camadas
   * secundárias exigiriam upload+composição multi-camada via ffmpeg.wasm, fora do escopo
   * desta primeira versão. Default true (app desktop sempre suporta). */
  allowSecondaryLayers?: boolean
}

// Rótulos em português (o valor interno continua 'contain'/'cover', só o texto muda) —
// 'contain' é o comportamento que já existia antes desta funcionalidade (resize livre pelos
// handles, sem recorte automático); 'cover' é o modo novo.
const FIT_MODE_OPTIONS: { value: 'cover' | 'contain'; label: string }[] = [
  { value: 'contain', label: 'Normal' },
  { value: 'cover', label: 'Preencher proporcionalmente' },
]

const ACCEPTED_VIDEO_TYPES = 'video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov'

const clampSeconds = (v: number, duration: number): number => {
  if (!isFinite(v) || v < 0) return 0
  return duration > 0 ? Math.min(v, duration) : v
}

/**
 * Painel de Layers — Etapa 3. Lista as layers de vídeo (a principal sempre primeiro),
 * ordenadas visualmente da mais acima (zIndex maior) pra mais abaixo. Seleção, visibilidade,
 * renomear, reordenar e a janela de tempo de cada layer secundária ficam todos aqui — item 3.
 */
const LayerPanel: React.FC<LayerPanelProps> = ({
  layers, selectedLayerId, duration,
  onSelect, onToggleVisible, onRename, onMoveUp, onMoveDown, onRemove, onTimeRangeChange, onAddFiles,
  onSetFitMode, uploadError,
  subtitleAvailable, subtitleVisible, onToggleSubtitleVisible,
  allowSecondaryLayers = true,
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const ordered = [...layers].sort((a, b) => b.zIndex - a.zIndex)

  const startRename = (layer: VideoLayer) => {
    setRenamingId(layer.id)
    setRenameDraft(layer.name)
  }
  const commitRename = (id: string) => {
    const name = renameDraft.trim()
    if (name) onRename(id, name)
    setRenamingId(null)
  }

  return (
    <div className="ac-editor-panel-section">
      <div className="ac-editor-panel-label">Camadas</div>
      <div className="ac-layer-list">
        {subtitleAvailable && (
          <div className="ac-layer-row ac-layer-row--subtitle">
            <div className="ac-layer-row-main">
              <button
                type="button"
                className="ac-layer-visibility"
                aria-label={subtitleVisible ? 'Ocultar legenda' : 'Mostrar legenda'}
                onClick={onToggleSubtitleVisible}
              >
                {subtitleVisible ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />}
              </button>
              <span className="ac-layer-icon"><Icon.Chat size={13} /></span>
              <span className="ac-layer-name">Legenda</span>
            </div>
          </div>
        )}
        {ordered.map((layer, idx) => {
          const isSelected = layer.id === selectedLayerId
          const isTop = idx === 0
          const isBottom = idx === ordered.length - 1
          return (
            <div key={layer.id} className={`ac-layer-row${isSelected ? ' ac-layer-row--selected' : ''}`}>
              <div className="ac-layer-row-main" onClick={() => onSelect(layer.id)}>
                <button
                  type="button"
                  className="ac-layer-visibility"
                  aria-label={layer.visible ? 'Ocultar camada' : 'Mostrar camada'}
                  onClick={(e) => { e.stopPropagation(); onToggleVisible(layer.id) }}
                >
                  {layer.visible ? <Icon.Eye size={13} /> : <Icon.EyeOff size={13} />}
                </button>
                <span className="ac-layer-icon"><Icon.Video size={13} /></span>
                {renamingId === layer.id ? (
                  <input
                    autoFocus
                    className="ac-layer-name-input"
                    value={renameDraft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(layer.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(layer.id); if (e.key === 'Escape') setRenamingId(null) }}
                  />
                ) : (
                  <span
                    className="ac-layer-name"
                    onDoubleClick={(e) => { e.stopPropagation(); startRename(layer) }}
                    title="Duplo clique para renomear"
                  >
                    {layer.name}
                  </span>
                )}
              </div>
              <div className="ac-layer-row-actions">
                <button type="button" disabled={isTop} onClick={() => onMoveUp(layer.id)} aria-label="Mover para cima" title="Mover para cima">
                  <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon.Down size={12} /></span>
                </button>
                <button type="button" disabled={isBottom} onClick={() => onMoveDown(layer.id)} aria-label="Mover para baixo" title="Mover para baixo">
                  <Icon.Down size={12} />
                </button>
                {!layer.isMain && (
                  <button type="button" onClick={() => onRemove(layer.id)} aria-label="Remover camada" title="Remover camada">
                    <Icon.Close size={12} />
                  </button>
                )}
              </div>
              {isSelected && (
                <div className="ac-layer-fill-screen" onClick={(e) => e.stopPropagation()}>
                  <Segmented
                    size="sm"
                    ariaLabel="Enquadramento do vídeo"
                    value={layer.fitMode}
                    onChange={(v) => onSetFitMode(layer.id, v)}
                    options={FIT_MODE_OPTIONS}
                  />
                  <p className="ac-layer-fit-hint">
                    {layer.fitMode === 'cover'
                      ? 'Preenche a tela toda, sem bordas — o excesso é cortado. Arraste o vídeo pra escolher a parte visível.'
                      : 'Mostra o vídeo inteiro — pode sobrar espaço se a proporção não bater.'}
                  </p>
                </div>
              )}
              {isSelected && !layer.isMain && (
                <div className="ac-layer-time-range" onClick={(e) => e.stopPropagation()}>
                  <label>
                    <span>Início (s)</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={layer.startTime}
                      onChange={(e) => onTimeRangeChange(layer.id, clampSeconds(Number(e.target.value), duration), layer.endTime)}
                    />
                  </label>
                  <label>
                    <span>Fim (s)</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={layer.endTime}
                      onChange={(e) => onTimeRangeChange(layer.id, layer.startTime, clampSeconds(Number(e.target.value), duration))}
                    />
                  </label>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {allowSecondaryLayers ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_VIDEO_TYPES}
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) onAddFiles(e.target.files)
              e.target.value = ''
            }}
          />
          <Btn size="sm" onClick={() => fileInputRef.current?.click()} style={{ marginTop: 10, width: '100%' }}>
            <Icon.Plus size={13} /> Adicionar vídeo
          </Btn>
          {uploadError && (
            <p style={{ color: 'var(--ac-error)', fontSize: 12, marginTop: 8 }}>{uploadError}</p>
          )}
        </>
      ) : (
        <p className="ac-editor-hint" style={{ marginTop: 10 }}>
          Camadas de vídeo extras ainda não estão disponíveis na versão Web.
        </p>
      )}
    </div>
  )
}

export default LayerPanel
