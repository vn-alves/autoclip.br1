import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { message } from 'antd'
import { Project, Clip } from '../store/useProjectStore'
import { Btn, Icon, StatusDot, ProgressLine, fmtClock, fmtDuration, parseTimecode } from '../ui'
import { listWebClips, getWebVideoUrl, deleteWebProject } from '../webstore/projects'
import { runWebPipeline, PipelineStage, WebPipelineError } from '../webpipeline/runPipeline'

interface WebProjectCardProps {
  project: Project
  onChanged: () => void
}

const stageLabel = (stage: PipelineStage | null): string => {
  if (!stage) return ''
  switch (stage.step) {
    case 'audio': return `Extraindo áudio… ${Math.round(stage.progress * 100)}%`
    case 'transcribing': return 'Transcrevendo com IA…'
    case 'analyzing': return 'Escolhendo os melhores trechos…'
    case 'cutting': return `Cortando clipe ${stage.index}/${stage.total}…`
    case 'done': return 'Concluído'
  }
}

/**
 * Card de projeto da Web sem servidor (Fase 2 do plano) — ver HomePage.tsx: usado no lugar
 * de ProjectCard só quando !isTauri(), pra não arriscar tocar no card do desktop (acoplado
 * à API real). O corte por IA aqui roda inteiro no navegador (ver webpipeline/).
 */
const WebProjectCard: React.FC<WebProjectCardProps> = ({ project, onChanged }) => {
  const navigate = useNavigate()
  const [running, setRunning] = useState(false)
  const [stage, setStage] = useState<PipelineStage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showClips, setShowClips] = useState(false)
  const [clips, setClips] = useState<Clip[]>([])

  useEffect(() => {
    if (showClips) {
      listWebClips(project.id).then(setClips)
    }
  }, [showClips, project.id])

  const handleRun = async () => {
    setRunning(true)
    setError(null)
    try {
      await runWebPipeline(project.id, setStage)
      message.success('Cortes gerados com sucesso')
      setShowClips(true)
      onChanged()
    } catch (err: any) {
      const msg = err instanceof WebPipelineError ? err.message : (err?.message || 'Falha ao cortar o vídeo')
      setError(msg)
      message.error(msg)
      onChanged()
    } finally {
      setRunning(false)
      setStage(null)
    }
  }

  const handleDelete = async () => {
    await deleteWebProject(project.id)
    message.success('Projeto removido')
    onChanged()
  }

  const handleDownloadClip = async (clip: Clip) => {
    const url = await getWebVideoUrl(clip.id)
    if (!url) { message.error('Vídeo do corte não encontrado'); return }
    const a = document.createElement('a')
    a.href = url
    a.download = `${clip.title || clip.id}.mp4`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  return (
    <article className="ac-card">
      <div className="ac-card-thumb" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon.Video size={28} />
      </div>
      <div className="ac-card-body">
        <div className="ac-card-title">{project.name}</div>
        <div className="ac-card-desc">{project.source_file}</div>

        {running && stage && (
          <div style={{ marginTop: 4 }}>
            <p className="ac-sub" style={{ margin: '0 0 6px' }}>{stageLabel(stage)}</p>
            {stage.step === 'audio' && <ProgressLine percent={stage.progress * 100} />}
          </div>
        )}
        {error && !running && <p style={{ color: 'var(--ac-error)', fontSize: 12.5, margin: '4px 0 0' }}>{error}</p>}

        <div className="ac-card-foot">
          {project.status === 'completed' ? (
            <StatusDot tone="ok" label={`${project.total_clips ?? clips.length} cortes`} />
          ) : project.status === 'failed' ? (
            <StatusDot tone="error" label="Falhou" />
          ) : running ? (
            <StatusDot tone="accent" label="Cortando…" />
          ) : (
            <StatusDot tone="muted" label="Aguardando corte" />
          )}
          <div className="ac-card-actions">
            {(project.status === 'pending' || project.status === 'failed') && !running && (
              <Btn variant="text" onClick={handleRun}><Icon.Plus size={13} /> Cortar com IA</Btn>
            )}
            {project.status === 'completed' && (
              <Btn variant="text" onClick={() => setShowClips((v) => !v)}>
                {showClips ? 'Ocultar' : 'Ver cortes'}
              </Btn>
            )}
            <Btn variant="text" onClick={handleDelete} disabled={running}><Icon.Trash size={13} /> Remover</Btn>
          </div>
        </div>

        {showClips && clips.length > 0 && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {clips.map((clip) => {
              const dur = Math.max(0, parseTimecode(clip.end_time) - parseTimecode(clip.start_time))
              return (
                <div key={clip.id} className="ac-row" style={{ padding: '6px 0' }}>
                  <div className="ac-row-label">
                    <b style={{ fontSize: 13 }}>{clip.title}</b>
                    <small>{fmtClock(clip.start_time)} – {fmtClock(clip.end_time)} · {fmtDuration(dur)}</small>
                  </div>
                  <div className="ac-row-control">
                    <Btn size="sm" variant="text" onClick={() => navigate(`/project/${project.id}/editor/${clip.id}`)}>
                      Editar
                    </Btn>
                    <Btn size="sm" onClick={() => handleDownloadClip(clip)}>Baixar</Btn>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </article>
  )
}

export default WebProjectCard
