import React from 'react'
import { Spin } from 'antd'
import { Btn, Icon, Segmented } from '../../ui'
import SubtitleStyleCards from './SubtitleStyleCards'
import {
  SubtitlePosition, SubtitlePositionPreset, SubtitleStyle, SubtitleStylePreset,
  SubtitleSyncStatus, SubtitleWordsPerCaption, WORDS_PER_CAPTION_OPTIONS,
  SubtitleTransition, SubtitleTransitionType, SUBTITLE_TRANSITION_OPTIONS,
  WordHighlight, WordHighlightType, WORD_HIGHLIGHT_OPTIONS,
} from './types'

interface SubtitleControlsProps {
  loading: boolean
  error: string | null
  available: boolean
  hasSegments: boolean
  style: SubtitleStyle
  position: SubtitlePosition
  onApplyPreset: (preset: SubtitleStylePreset) => void
  onStyleChange: (patch: Partial<Omit<SubtitleStyle, 'id' | 'outline'>>) => void
  onOutlineChange: (patch: Partial<SubtitleStyle['outline']>) => void
  onPositionPreset: (preset: Exclude<SubtitlePositionPreset, 'custom'>) => void
  /** Etapa 4.2 — transição de entrada da legenda e destaque da palavra ativa. */
  transition: SubtitleTransition
  onTransitionChange: (patch: Partial<SubtitleTransition>) => void
  wordHighlight: WordHighlight
  onWordHighlightChange: (patch: Partial<WordHighlight>) => void
  /** Sincronização precisa (Whisper + alinhamento) — ver subtitle_sync_service.py. */
  syncStatus: SubtitleSyncStatus
  syncMessage: string | null
  syncError: string | null
  syncedAt: string | null
  onStartSync: () => void
  /** false na "versão básica" do Editor sem servidor (ver ClipEditorPage) — sincronização por
   * IA ainda não existe lá (precisaria de outra chamada de transcrição client-side). Default
   * true (app desktop sempre suporta). */
  syncSupported?: boolean
  wordsPerCaption: SubtitleWordsPerCaption
  onWordsPerCaptionChange: (value: SubtitleWordsPerCaption) => void
}

const FONT_OPTIONS = [
  { value: "Inter, 'Noto Sans SC', system-ui, sans-serif", label: 'Inter' },
  { value: "Arial, 'Noto Sans SC', sans-serif", label: 'Arial' },
  { value: "Georgia, 'Noto Sans SC', serif", label: 'Georgia' },
  { value: "Impact, 'Noto Sans SC', sans-serif", label: 'Impact' },
]

// Segmented só aceita valores string; o peso real (number) fica em SubtitleStyle.fontWeight.
const WEIGHT_OPTIONS: { value: string; label: string }[] = [
  { value: '400', label: 'Normal' },
  { value: '600', label: 'Médio' },
  { value: '700', label: 'Negrito' },
  { value: '800', label: 'Extra' },
]

const POSITION_OPTIONS: { value: Exclude<SubtitlePositionPreset, 'custom'>; label: string }[] = [
  { value: 'top', label: 'Topo' },
  { value: 'center', label: 'Centro' },
  { value: 'bottom', label: 'Inferior' },
]

/** Grade de chips — usado pra Transição/Destaque (mais opções do que o Segmented pill
 * comporta numa coluna estreita; mesmo visual "calmo" do resto do editor, ver DESIGN.md). */
function ChipGroup<T extends string>({ value, onChange, options, ariaLabel }: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  ariaLabel: string
}) {
  return (
    <div className="ac-editor-chip-group" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`ac-editor-chip${o.value === value ? ' ac-editor-chip--active' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

const formatSyncedAt = (iso: string): string => {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}


/** Painel de propriedades da legenda — Etapa 2. Some sozinho quando o corte não tem legenda. */
const SubtitleControls: React.FC<SubtitleControlsProps> = ({
  loading, error, available, hasSegments, style, position,
  onApplyPreset, onStyleChange, onOutlineChange, onPositionPreset,
  transition, onTransitionChange, wordHighlight, onWordHighlightChange,
  syncStatus, syncMessage, syncError, syncedAt, onStartSync, syncSupported = true,
  wordsPerCaption, onWordsPerCaptionChange,
}) => {
  if (loading) {
    return (
      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Legenda</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ac-sub)', fontSize: 13 }}>
          <Spin size="small" /> Carregando legendas…
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Legenda</div>
        <p style={{ color: 'var(--ac-error)', fontSize: 13, margin: 0 }}>{error}</p>
      </div>
    )
  }

  if (!available || !hasSegments) {
    return (
      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Legenda</div>
        <p style={{ color: 'var(--ac-sub)', fontSize: 13, margin: 0 }}>
          Este corte não possui legendas disponíveis.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Sincronização</div>
        {!syncSupported ? (
          <p className="ac-editor-hint" style={{ marginTop: 0 }}>
            Indisponível na versão Web por enquanto — a legenda usa o tempo estimado por palavra.
          </p>
        ) : syncStatus === 'syncing' ? (
          <Btn size="sm" loading disabled>{syncMessage || 'Sincronizando…'}</Btn>
        ) : syncStatus === 'synced' ? (
          <>
            <p className="ac-editor-hint" style={{ color: 'var(--ac-accent)', marginTop: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
              <Icon.Check size={12} /> Sincronizado{syncedAt ? ` · ${formatSyncedAt(syncedAt)}` : ''}
            </p>
            <Btn size="sm" onClick={onStartSync}>Sincronizar novamente</Btn>
          </>
        ) : (
          <>
            <Btn size="sm" onClick={onStartSync}>Sincronizar com IA</Btn>
            <p className="ac-editor-hint">
              Alinha a legenda ao áudio real do corte (timing preciso por palavra, karaokê correto).
            </p>
          </>
        )}
        {syncStatus === 'error' && syncError && (
          <p style={{ color: 'var(--ac-error)', fontSize: 12, marginTop: 8 }}>{syncError}</p>
        )}
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Palavras por legenda</div>
        <select
          className="ac-input"
          value={String(wordsPerCaption)}
          onChange={(e) => onWordsPerCaptionChange((e.target.value === 'auto' ? 'auto' : Number(e.target.value)) as SubtitleWordsPerCaption)}
        >
          {WORDS_PER_CAPTION_OPTIONS.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
          ))}
        </select>
        {syncStatus !== 'synced' && (
          <p className="ac-editor-hint">
            Funciona mesmo sem sincronizar, mas com tempos estimados por palavra. Sincronize com IA
            para um agrupamento com timing real.
          </p>
        )}
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Estilo</div>
        <SubtitleStyleCards activePresetId={style.id} onApply={onApplyPreset} />
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Fonte</div>
        <select
          className="ac-input"
          value={style.fontFamily}
          onChange={(e) => onStyleChange({ fontFamily: e.target.value })}
          style={{ marginBottom: 10 }}
        >
          {FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <Segmented
          size="sm"
          value={String(style.fontWeight)}
          onChange={(v) => onStyleChange({ fontWeight: Number(v) as SubtitleStyle['fontWeight'] })}
          options={WEIGHT_OPTIONS}
          ariaLabel="Peso da fonte"
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
          <input
            type="range"
            min={20}
            max={100}
            value={style.fontSize}
            onChange={(e) => onStyleChange({ fontSize: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
          <span className="ac-editor-value-label">{style.fontSize}px</span>
        </div>
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Cor</div>
        <div className="ac-editor-color-row">
          <label>
            <span>Texto</span>
            <input type="color" className="ac-editor-color-input" value={style.color} onChange={(e) => onStyleChange({ color: e.target.value })} />
          </label>
          <label>
            <span>Destaque</span>
            <input type="color" className="ac-editor-color-input" value={style.highlightColor} onChange={(e) => onStyleChange({ highlightColor: e.target.value })} />
          </label>
        </div>
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Fundo da caixa</div>
        <Segmented
          size="sm"
          ariaLabel="Fundo da caixa"
          value={style.backgroundOpacity > 0 ? 'on' : 'off'}
          onChange={(v) => onStyleChange({ backgroundOpacity: v === 'on' ? (style.backgroundOpacity > 0 ? style.backgroundOpacity : 0.75) : 0 })}
          options={[{ value: 'on', label: 'Ativo' }, { value: 'off', label: 'Desativado' }]}
        />
        {style.backgroundOpacity > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <input type="color" className="ac-editor-color-input" style={{ width: 44 }} value={style.backgroundColor} onChange={(e) => onStyleChange({ backgroundColor: e.target.value })} />
              <input
                type="range" min={0.1} max={1} step={0.05}
                value={style.backgroundOpacity}
                onChange={(e) => onStyleChange({ backgroundOpacity: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span className="ac-editor-value-label">{Math.round(style.backgroundOpacity * 100)}%</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <input
                type="range" min={0} max={24}
                value={style.borderRadius}
                onChange={(e) => onStyleChange({ borderRadius: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              <span className="ac-editor-value-label">raio {style.borderRadius}px</span>
            </div>
          </>
        )}
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Contorno</div>
        <Segmented
          size="sm"
          ariaLabel="Contorno"
          value={style.outline.enabled ? 'on' : 'off'}
          onChange={(v) => onOutlineChange({ enabled: v === 'on' })}
          options={[{ value: 'on', label: 'Ativo' }, { value: 'off', label: 'Desativado' }]}
        />
        {style.outline.enabled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <input type="color" className="ac-editor-color-input" style={{ width: 44 }} value={style.outline.color} onChange={(e) => onOutlineChange({ color: e.target.value })} />
            <input
              type="range"
              min={1}
              max={6}
              value={style.outline.width}
              onChange={(e) => onOutlineChange({ width: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span className="ac-editor-value-label">{style.outline.width}px</span>
          </div>
        )}
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Posição</div>
        <Segmented
          size="sm"
          ariaLabel="Posição da legenda"
          value={position.preset as Exclude<SubtitlePositionPreset, 'custom'>}
          onChange={onPositionPreset}
          options={POSITION_OPTIONS}
        />
        <p className="ac-editor-hint">Ou arraste a legenda diretamente no canvas para uma posição personalizada.</p>
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Transição da legenda</div>
        <ChipGroup<SubtitleTransitionType>
          ariaLabel="Transição da legenda"
          value={transition.type}
          onChange={(v) => onTransitionChange({ type: v })}
          options={SUBTITLE_TRANSITION_OPTIONS}
        />
        {(transition.type === 'word_by_word' || transition.type === 'word_follow') && (
          <p className="ac-editor-hint">
            {transition.type === 'word_by_word'
              ? 'Cada palavra nasce um pouco abaixo e desliza pra posição final, no timestamp exato dela — não é o bloco inteiro que entra de uma vez.'
              : 'Cada palavra aparece exatamente no timestamp dela, sem o bloco inteiro aparecer de uma vez.'}
          </p>
        )}
        {transition.type !== 'none' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
            <input
              type="range" min={0.08} max={0.6} step={0.02}
              value={transition.duration}
              onChange={(e) => onTransitionChange({ duration: Number(e.target.value) })}
              style={{ flex: 1 }}
            />
            <span className="ac-editor-value-label">{Math.round(transition.duration * 1000)}ms</span>
          </div>
        )}
      </div>

      <div className="ac-editor-panel-section">
        <div className="ac-editor-panel-label">Destaque de palavras</div>
        <ChipGroup<WordHighlightType>
          ariaLabel="Destaque de palavras"
          value={wordHighlight.type}
          onChange={(v) => onWordHighlightChange({ type: v })}
          options={WORD_HIGHLIGHT_OPTIONS}
        />
        {wordHighlight.type !== 'none' && (
          <>
            <div className="ac-editor-color-row" style={{ marginTop: 10 }}>
              {(wordHighlight.type === 'color' || wordHighlight.type === 'color_background' || wordHighlight.type === 'pop' || wordHighlight.type === 'karaoke') && (
                <label>
                  <span>Cor</span>
                  <input type="color" className="ac-editor-color-input" value={wordHighlight.color} onChange={(e) => onWordHighlightChange({ color: e.target.value })} />
                </label>
              )}
              {(wordHighlight.type === 'background' || wordHighlight.type === 'color_background') && (
                <label>
                  <span>Fundo</span>
                  <input type="color" className="ac-editor-color-input" value={wordHighlight.backgroundColor} onChange={(e) => onWordHighlightChange({ backgroundColor: e.target.value })} />
                </label>
              )}
            </div>
            {(wordHighlight.type === 'scale' || wordHighlight.type === 'pop') && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <input
                  type="range" min={1} max={1.5} step={0.02}
                  value={wordHighlight.scale}
                  onChange={(e) => onWordHighlightChange({ scale: Number(e.target.value) })}
                  style={{ flex: 1 }}
                />
                <span className="ac-editor-value-label">{Math.round(wordHighlight.scale * 100)}%</span>
              </div>
            )}
            {wordHighlight.type !== 'pop' && (
              <Segmented
                size="sm"
                ariaLabel="Palavra ativa + animação"
                value={wordHighlight.animation}
                onChange={(v) => onWordHighlightChange({ animation: v })}
                options={[{ value: 'none', label: 'Sem animação extra' }, { value: 'pop', label: '+ Pop' }]}

              />
            )}
          </>
        )}
      </div>
    </>
  )
}

export default SubtitleControls
