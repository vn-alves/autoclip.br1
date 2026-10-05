import React, { useState, useEffect } from 'react'
import { Card, Button, Space, Typography, Popconfirm, message, Tooltip } from 'antd'
import { PlayCircleOutlined, DeleteOutlined, DownloadOutlined, ReloadOutlined, LoadingOutlined } from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import { Project } from '../store/useProjectStore'
import { projectApi } from '../services/api'
import { UnifiedStatusBar } from './UnifiedStatusBar'
import FeedbackDialog from './FeedbackDialog'
import { useSimpleProgressStore } from '../stores/useSimpleProgressStore'
import { Btn } from '../ui'
// import { 
//   getProjectStatusConfig, 
//   calculateProjectProgress, 
//   normalizeProjectStatus,
//   getProgressStatus 
// } from '../utils/statusUtils'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import 'dayjs/locale/pt-br'

dayjs.extend(relativeTime)
dayjs.extend(timezone)
dayjs.extend(utc)
dayjs.locale('pt-br')

// Adicionar estilo de animação CSS
const pulseAnimation = `
  @keyframes pulse {
    0% {
      opacity: 1;
      transform: scale(1);
    }
    50% {
      opacity: 0.5;
      transform: scale(1.1);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
`

// Injetar estilos na página
if (typeof document !== 'undefined') {
  const style = document.createElement('style')
  style.textContent = pulseAnimation
  document.head.appendChild(style)
}

const { Text } = Typography

// Tracks which project ids have already had a best-effort auto-start, surviving
// component remounts (the list briefly unmounts while HomePage shows its
// loading spinner). A useRef would reset on every remount and let auto-start
// fire again, which created an infinite onRetry→loadProjects→remount loop.
// Project ids are unique per import, so once-per-session is exactly right.
const autoStartedProjectIds = new Set<string>()

interface ProjectCardProps {
  project: Project
  onDelete: (id: string) => void
  onRetry?: (id: string) => void
  onClick?: () => void
}

const ProjectCard: React.FC<ProjectCardProps> = ({ project, onDelete, onRetry, onClick }) => {
  const navigate = useNavigate()
  const [videoThumbnail, setVideoThumbnail] = useState<string | null>(null)
  const [thumbnailLoading, setThumbnailLoading] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)

  // Obter informações de categoria
  const getCategoryInfo = (category?: string) => {
    const categoryMap: Record<string, { name: string; icon: string; color: string }> = {
      'default': { name: 'Padrão', icon: '🎬', color: '#4facfe' },
      'knowledge': { name: 'Conhecimento Científico', icon: '📚', color: '#52c41a' },
      'business': { name: 'Negócios e Finanças', icon: '💼', color: '#faad14' },
      'opinion': { name: 'Opiniões e Comentários', icon: '💭', color: '#722ed1' },
      'experience': { name: 'Compartilhamento de Experiências', icon: '🌟', color: '#13c2c2' },
      'speech': { name: 'Palestra/Talk Show', icon: '🎤', color: '#eb2f96' },
      'content_review': { name: 'Explicação de Conteúdo', icon: '🎭', color: '#f5222d' },
      'entertainment': { name: 'Conteúdo de Entretenimento', icon: '🎪', color: '#fa8c16' }
    }
    return categoryMap[category || 'default'] || categoryMap['default']
  }

  // Gerenciamento de cache de miniaturas
  const thumbnailCacheKey = `thumbnail_${project.id}`
  
  // Gerar miniatura do vídeo do projeto (com cache)
  useEffect(() => {
    const generateThumbnail = async () => {
      // Priorizar o uso de miniaturas fornecidas pelo backend
      if (project.thumbnail) {
        setVideoThumbnail(project.thumbnail)
        console.log(`Usar miniaturas fornecidas pelo backend: ${project.id}`)
        return
      }
      
      if (!project.video_path) {
        console.log('Projeto sem caminho de vídeo:', project.id)
        return
      }
      
      // Verificar cache
      const cachedThumbnail = localStorage.getItem(thumbnailCacheKey)
      if (cachedThumbnail) {
        setVideoThumbnail(cachedThumbnail)
        return
      }
      
      setThumbnailLoading(true)
      
      try {
        const video = document.createElement('video')
        video.crossOrigin = 'anonymous'
        video.muted = true
        video.preload = 'metadata'
        
        // Tentar vários caminhos possíveis para o arquivo de vídeo
        const possiblePaths = [
          'input/input.mp4',
          'input.mp4',
          project.video_path,
          `${project.video_path}/input.mp4`
        ].filter(Boolean)
        
        let videoLoaded = false
        
        for (const path of possiblePaths) {
          if (videoLoaded) break
          
          try {
            const videoUrl = projectApi.getProjectFileUrl(project.id, path)
            console.log('Tentando carregar vídeo:', videoUrl)
            
            await new Promise((resolve, reject) => {
              const timeoutId = setTimeout(() => {
                reject(new Error('Tempo limite de carregamento do vídeo'))
              }, 10000) // 10 segundos de timeout
              
              video.onloadedmetadata = () => {
                clearTimeout(timeoutId)
                console.log('Metadados do vídeo carregados com sucesso:', videoUrl)
                video.currentTime = Math.min(5, video.duration / 4) // Pega o frame a 1/4 do vídeo ou aos 5 segundos
              }
              
              video.onseeked = () => {
                clearTimeout(timeoutId)
                try {
                  const canvas = document.createElement('canvas')
                  const ctx = canvas.getContext('2d')
                  if (!ctx) {
                    reject(new Error('Não foi possível obter o contexto do canvas'))
                    return
                  }
                  
                  // Definir dimensões apropriadas para a miniatura
                  const maxWidth = 320
                  const maxHeight = 180
                  const aspectRatio = video.videoWidth / video.videoHeight
                  
                  let width = maxWidth
                  let height = maxHeight
                  
                  if (aspectRatio > maxWidth / maxHeight) {
                    height = maxWidth / aspectRatio
                  } else {
                    width = maxHeight * aspectRatio
                  }
                  
                  canvas.width = width
                  canvas.height = height
                  ctx.drawImage(video, 0, 0, width, height)
                  
                  const thumbnail = canvas.toDataURL('image/jpeg', 0.7)
                  setVideoThumbnail(thumbnail)
                  
                  // Miniaturas em cache
                  try {
                    localStorage.setItem(thumbnailCacheKey, thumbnail)
                  } catch (e) {
                    // Se o espaço de localStorage for insuficiente, limpe o cache antigo
                    const keys = Object.keys(localStorage).filter(key => key.startsWith('thumbnail_'))
                    if (keys.length > 50) { // Manter um cache de no máximo 50 miniaturas
                      keys.slice(0, 10).forEach(key => localStorage.removeItem(key))
                      localStorage.setItem(thumbnailCacheKey, thumbnail)
                    }
                  }
                  
                  videoLoaded = true
                  resolve(thumbnail)
                } catch (error) {
                  reject(error)
                }
              }
              
              video.onerror = (error) => {
                clearTimeout(timeoutId)
                console.error('Falha ao carregar vídeo:', videoUrl, error)
                reject(error)
              }
              
              video.src = videoUrl
            })
            
            break // Se carregado com sucesso, sair do loop
          } catch (error) {
            console.warn(`Caminho ${path} Falha ao carregar:`, error)
            continue // Tentar o próximo caminho
          }
        }
        
        if (!videoLoaded) {
          console.error('Falha ao carregar todos os caminhos de vídeo')
        }
      } catch (error) {
        console.error('Erro ao gerar miniatura:', error)
      } finally {
        setThumbnailLoading(false)
      }
    }
    
    generateThumbnail()
  }, [project.id, project.video_path, thumbnailCacheKey])

  // Verifica se está em status de download - com base no progresso do download
  const downloadProgress = project.processing_config?.download_progress || 0
  const isDownloading = project.status === 'pending' && downloadProgress > 0 && downloadProgress < 100
  const isImporting = project.status === 'pending' && !isDownloading
  
  // Processamento de padronização de status
  const normalizedStatus = project.status === 'error' ? 'failed' : 
                          isDownloading ? 'downloading' :
                          isImporting ? 'importing' : project.status
  
  // Informações de depuração
  console.log('ProjectCard Debug:', {
    projectId: project.id,
    projectStatus: project.status,
    downloadProgress,
    isDownloading,
    isImporting,
    normalizedStatus,
    processingConfig: project.processing_config
  })

  // Iniciar automaticamente projetos com status pendente (mas não incluindo projetos em download).
  // Chave: cada projeto tenta automaticamente apenas uma vez, e não exibe toast em caso de falha.
  // Antes, isRetrying era colocado nas dependências aqui, e isRetrying era invertido em handleRetry,
  // Faz com que o efeito seja acionado repetidamente → POST /process freneticamente para um projeto Bilibili que ainda não terminou de baixar (retorna
  // 400 "Video file not found") → Tela cheia ”Falha na repetição”. O backend iniciará automaticamente após o download.
  // pipeline, então aqui basta fazer uma inicialização ’melhor esforço’.
  useEffect(() => {
    if (
      project.status === 'pending' &&
      !isDownloading &&
      !autoStartedProjectIds.has(project.id)
    ) {
      autoStartedProjectIds.add(project.id)
      // Best-effort, one-shot per project. Uploads (file already present) start
      // processing; Bilibili imports whose download isn't done yet return 400 here —
      // that's fine, the backend auto-starts the pipeline when the download
      // completes. Silent + no onRetry so this never drives the parent's
      // toast/reload path.
      handleRetry({ silent: true })
    }
  }, [project.status, project.id, isDownloading])
  
  // Calcular porcentagem de progresso
  const progressPercent = project.status === 'completed' ? 100 : 
                         project.status === 'failed' ? 0 :
                         isDownloading ? downloadProgress : // Exibe o progresso real do download durante o download
                         isImporting ? Math.max(5, Math.min(99, downloadProgress)) : // Exibe 5% de progresso para o status pendente, indicando espera por processamento
                         project.current_step && project.total_steps ? 
                         Math.round((project.current_step / project.total_steps) * 100) : 
                         project.status === 'processing' ? 10 : 0

  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const failedProgress = useSimpleProgressStore((st) => st.getProgress(project.id))
  const failureContext = {
    source: 'failure' as const,
    project_id: project.id,
    stage: failedProgress?.stage,
    error_message: project.error_message || failedProgress?.message || undefined,
  }

  const handleRetry = async (opts?: { silent?: boolean }) => {
    if (isRetrying) return

    setIsRetrying(true)
    try {
      // Para projetos com status PENDING, use startProcessing; para outros status, use retryProcessing
      if (project.status === 'pending') {
        await projectApi.startProcessing(project.id)
      } else {
        await projectApi.retryProcessing(project.id)
      }
      // Deixa o componente pai lidar com toast / atualização. Mas a ’inicialização automática silenciosa’ nunca deve acionar o componente pai,
      // Caso contrário, handleRetryProject será chamado → loadProjects → Remontar lista → Reiniciar automaticamente
      // loop infinito. Notifica o componente pai apenas quando o usuário clica em tentar novamente.
      if (onRetry && !opts?.silent) {
        onRetry(project.id)
      }
    } catch (error) {
      console.error('Falha ao tentar novamente:', error)
      // A inicialização automática (silenciosa) não incomoda o usuário se falhar; só avisa se o usuário clicar manualmente em tentar novamente.
      if (!opts?.silent) {
        message.error('Falha ao tentar novamente, por favor, tente mais tarde')
      }
    } finally {
      setIsRetrying(false)
    }
  }

  return (
    <>
    <Card
      hoverable
      className="project-card"
      style={{
        width: '100%',
        borderRadius: '16px',
        overflow: 'hidden',
        background: 'var(--ac-card)',
        border: '1px solid var(--ac-line)',
        boxShadow: 'none',
        transition: 'all 0.2s ease',
        cursor: 'pointer',
        marginBottom: '0px'
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-2px)'
        e.currentTarget.style.boxShadow = 'var(--ac-shadow)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)'
        e.currentTarget.style.boxShadow = 'none'
      }}
      bodyStyle={{
        padding: '18px 20px 20px',
        background: 'transparent',
        display: 'flex',
        flexDirection: 'column'
      }}
      cover={
        <div
          style={{
            height: 160,
            position: 'relative',
            background: videoThumbnail
              ? `url(${videoThumbnail}) center/cover`
              : 'var(--ac-thumb)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden'
          }}
          onClick={() => {
            // Projetos em status de importação não podem ser clicados para ver detalhes
            if (project.status === 'pending') {
              message.warning('O projeto está sendo importado, por favor, verifique os detalhes mais tarde')
              return
            }
            
            // Projetos em processamento não podem ser clicados para ver detalhes
            if (project.status === 'processing') {
              message.warning('Projeto em processamento, verifique após a conclusão')
              return
            }
            
            if (onClick) {
              onClick()
            } else {
              navigate(`/project/${project.id}`)
            }
          }}
        >
          {/* Status de carregamento da miniatura */}
          {thumbnailLoading && (
            <div style={{ textAlign: 'center', color: 'var(--ac-muted)' }}>
              <LoadingOutlined style={{ fontSize: '22px', marginBottom: '4px' }} />
              <div style={{ fontSize: '12px' }}>Gerando capa…</div>
            </div>
          )}

          {/* Exibição padrão quando não há miniatura */}
          {!videoThumbnail && !thumbnailLoading && (
            <PlayCircleOutlined style={{ fontSize: '32px', color: 'var(--ac-muted)' }} />
          )}
          
          {/* Etiqueta de Categoria - Canto Superior Esquerdo */}
          {project.video_category && project.video_category !== 'default' && (
            <div style={{
              position: 'absolute',
              top: '8px',
              left: '8px'
            }}>
              <span className="ac-tag ac-tag--sans" style={{ position: 'static', fontSize: 11 }}>
                {getCategoryInfo(project.video_category).name}
              </span>
            </div>
          )}
          
          {/* Remover indicador de status superior direito - baixa legibilidade e redundante */}
          
          {/* Hora da atualização e botão de ação - mover para a parte inferior da capa */}
          <div style={{
            position: 'absolute',
            bottom: '0',
            left: '0',
            right: '0',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-end',
            background: 'linear-gradient(to top, rgba(0,0,0,0.42), rgba(0,0,0,0))',
            borderRadius: '0',
            padding: '10px 12px',
            height: '52px'
          }}>
            <Text style={{ fontSize: '12px', color: 'rgba(255, 255, 255, 0.92)' }}>
              {dayjs(project.created_at).tz('America/Sao_Paulo').fromNow()}
            </Text>
            
            {/* Botão de ação */}
            <div 
              className="card-action-buttons"
              style={{
                display: 'flex',
                gap: '4px',
                opacity: 0,
                transition: 'opacity 0.3s ease'
              }}
            >
              {/* Status de falha: exibir apenas os botões de tentar novamente e excluir */}
              {normalizedStatus === 'failed' ? (
                <>
                  <Button
                    type="text"
                    icon={<ReloadOutlined />}
                    loading={isRetrying}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleRetry()
                    }}
                    style={{
                      height: '22px',
                      width: '22px',
                      borderRadius: '999px',
                      color: 'rgba(255,255,255,0.9)',
                      border: '1px solid rgba(255,255,255,0.25)',
                      background: 'rgba(20,20,19,0.45)',
                      padding: 0,
                      minWidth: '22px',
                      fontSize: '10px'
                    }}
                  />
                  
                  <Popconfirm
                    title="Tem certeza de que deseja excluir este projeto?"
                    description="Não pode ser recuperado após exclusão"
                    onConfirm={(e) => {
                      e?.stopPropagation()
                      onDelete(project.id)
                    }}
                    onCancel={(e) => {
                      e?.stopPropagation()
                    }}
                    okText="Confirmar"
                    cancelText="Cancelar"
                  >
                    <Button
                      type="text"
                      icon={<DeleteOutlined />}
                      onClick={(e) => {
                        e.stopPropagation()
                      }}
                      style={{
                      height: '22px',
                      width: '22px',
                      borderRadius: '999px',
                      color: 'rgba(255,255,255,0.9)',
                      border: '1px solid rgba(255,255,255,0.25)',
                      background: 'rgba(20,20,19,0.45)',
                      padding: 0,
                      minWidth: '22px',
                      fontSize: '10px'
                    }}
                    />
                  </Popconfirm>
                </>
              ) : (
                /* Outros estados: exibir botões de download, tentar novamente e excluir */
                <>
                  <Space size={4}>
                    {/* Botão de tentar novamente - Exibido nos estados ’em processamento’ e ’aguardando’, permite ao usuário reenviar a tarefa */}
                    {(normalizedStatus === 'processing' || normalizedStatus === 'importing' || project.status === 'pending') && (
                      <Tooltip title={project.status === 'pending' ? "Iniciar Processamento" : "Reenviar tarefa"}>
                        <Button
                          type="text"
                          icon={<ReloadOutlined />}
                          loading={isRetrying}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleRetry()
                          }}
                          style={{
                      height: '22px',
                      width: '22px',
                      borderRadius: '999px',
                      color: 'rgba(255,255,255,0.9)',
                      border: '1px solid rgba(255,255,255,0.25)',
                      background: 'rgba(20,20,19,0.45)',
                      padding: 0,
                      minWidth: '22px',
                      fontSize: '10px'
                    }}
                        />
                      </Tooltip>
                    )}
                    
                    {/* Botão de download - exibir apenas no status concluído */}
                    {normalizedStatus === 'completed' && (
                      <Button
                        type="text"
                        icon={<DownloadOutlined />}
                        onClick={(e) => {
                          e.stopPropagation()
                          // Implementar função de download
                          message.info('Recurso de download em desenvolvimento...')
                        }}
                        style={{
                      height: '22px',
                      width: '22px',
                      borderRadius: '999px',
                      color: 'rgba(255,255,255,0.9)',
                      border: '1px solid rgba(255,255,255,0.25)',
                      background: 'rgba(20,20,19,0.45)',
                      padding: 0,
                      minWidth: '22px',
                      fontSize: '10px'
                    }}
                      />
                    )}
                    
                    {/* Botão Excluir */}
                    <Popconfirm
                      title="Tem certeza de que deseja excluir este projeto?"
                      description="Não pode ser recuperado após exclusão"
                      onConfirm={(e) => {
                        e?.stopPropagation()
                        onDelete(project.id)
                      }}
                      onCancel={(e) => {
                        e?.stopPropagation()
                      }}
                      okText="Confirmar"
                      cancelText="Cancelar"
                    >
                      <Button
                        type="text"
                        icon={<DeleteOutlined />}
                        onClick={(e) => {
                          e.stopPropagation()
                        }}
                        style={{
                      height: '22px',
                      width: '22px',
                      borderRadius: '999px',
                      color: 'rgba(255,255,255,0.9)',
                      border: '1px solid rgba(255,255,255,0.25)',
                      background: 'rgba(20,20,19,0.45)',
                      padding: 0,
                      minWidth: '22px',
                      fontSize: '10px'
                    }}
                      />
                    </Popconfirm>
                  </Space>
                 </>
               )}
            </div>
          </div>
        </div>
      }
    >
      <div style={{ padding: '0', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div>
          {/* Nome do Projeto - Sempre no topo */}
          <div style={{ marginBottom: '12px', position: 'relative' }}>
            <Tooltip title={project.name} placement="top">
              <Text 
                strong 
                style={{ 
                  fontSize: '13px', 
                  color: '#ffffff',
                  fontWeight: 600,
                  lineHeight: '16px',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  cursor: 'help',
                  height: '32px'
                }}
              >
                {project.name}
              </Text>
            </Tooltip>
          </div>
          
          {/* Status e estatísticas — Calm Premium, ver DESIGN.md */}
          {(normalizedStatus === 'importing' || normalizedStatus === 'downloading' || normalizedStatus === 'processing' || normalizedStatus === 'failed') ? (
            // Em andamento / Falha: linha de progresso detalhada ou ponto final, preenchendo toda a largura
            <div style={{ marginBottom: '2px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <UnifiedStatusBar
                projectId={project.id}
                status={normalizedStatus}
                downloadProgress={progressPercent}
                onStatusChange={(newStatus) => {
                  console.log(`Projeto ${project.id} Mudança de status: ${normalizedStatus} -> ${newStatus}`)
                }}
                onDownloadProgressUpdate={(progress) => {
                  console.log(`Projeto ${project.id} Atualização do progresso do download: ${progress}%`)
                }}
              />
              {normalizedStatus === 'failed' && (
                // Estado de falha: tentar novamente + feedback (feedback inclui automaticamente fase / erro / versão / contexto do modelo)
                <div style={{ display: 'flex', gap: 2, flex: '0 0 auto' }} onClick={(e) => e.stopPropagation()}>
                  <Btn variant="text" size="sm" style={{ height: 26, padding: '0 8px', fontSize: 12.5 }} loading={isRetrying} onClick={() => handleRetry()}>Tentar Novamente</Btn>
                  <Btn variant="text" size="sm" style={{ height: 26, padding: '0 8px', fontSize: 12.5 }} onClick={() => setFeedbackOpen(true)}>Feedback</Btn>
                </div>
              )}
            </div>
          ) : (
            // Concluído:● Concluído + metadados mono cinza (N fatias · Coleção M)
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '2px' }}>
              <UnifiedStatusBar
                projectId={project.id}
                status={normalizedStatus}
                downloadProgress={progressPercent}
                onStatusChange={() => {}}
              />
              <div style={{ color: 'var(--ac-muted)', fontSize: '12.5px', whiteSpace: 'nowrap' }}>
                <span className="ac-mono">{project.total_clips || 0}</span> Fatiar
                <span style={{ margin: '0 6px' }}>·</span>
                <span className="ac-mono">{project.total_collections || 0}</span> Coleção
              </div>
            </div>
          )}

          {/* Exibição detalhada do progresso oculta - apenas a porcentagem é mostrada no bloco de status */}

        </div>
      </div>
    </Card>
    <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} context={failureContext} />
    </>
  )
}

export default ProjectCard