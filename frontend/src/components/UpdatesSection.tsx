import React, { useEffect, useState } from 'react'
import { message } from 'antd'
import { Btn, ProgressLine, Row, Section, StatusDot } from '../ui'
import { isTauri } from '../utils/isTauri'
import { openExternalLink } from '../utils/externalLinks'
import { MACOS_DOWNLOAD_URL, WINDOWS_DOWNLOAD_URL, resolveDownloadUrls } from '../config/downloads'
import {
  checkForUpdate, detectPlatform, getCurrentVersion, installUpdate,
  type InstallProgress, type UpdateInfo,
} from '../utils/updater'

const mb = (n: number) => (n / 1024 / 1024).toFixed(1)

const UpdatesSection: React.FC = () => {
  const desktop = isTauri()
  const platform = detectPlatform()
  const [current, setCurrent] = useState('')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<InstallProgress | null>(null)
  const [installing, setInstalling] = useState(false)
  // Links de download resolvem a release mais recente; fallback na última versão conhecida.
  const [downloads, setDownloads] = useState({ windows: WINDOWS_DOWNLOAD_URL, macos: MACOS_DOWNLOAD_URL })

  const check = async () => {
    setChecking(true); setError('')
    try { setInfo(await checkForUpdate()) } catch (e: any) { setError(e?.message || 'Falha ao verificar') }
    finally { setChecking(false) }
  }

  useEffect(() => { getCurrentVersion().then(setCurrent); check() }, [])

  const install = async () => {
    if (!info) return
    setInstalling(true); setError('')
    try {
      await installUpdate(info, setProgress)
    } catch (e: any) {
      setInstalling(false); setProgress(null)
      const msg = typeof e === 'string' ? e : e?.message || 'Falha ao instalar a atualização'
      setError(msg); message.error(msg)
    }
  }

  const pct = progress && progress.total > 0 ? Math.round((progress.downloaded / progress.total) * 100) : 0
  const location =
    platform === 'macos'
      ? 'O app novo substitui o atual no mesmo lugar (normalmente na pasta Aplicativos) e reabre sozinho.'
      : platform === 'windows'
        ? 'O instalador atualiza o app na pasta onde ele já está instalado e reabre sozinho. Seus projetos e configurações são mantidos.'
        : 'Atualização automática disponível no Windows e no macOS.'

  return (
    <Section title="Atualizações" description="Mantenha o AutoClip atualizado sem precisar baixar e reinstalar manualmente.">
      <div className="ac-rows">
        <Row label="Versão instalada" hint={desktop ? 'Versão do aplicativo neste computador.' : 'Você está usando a versão Web, que já é sempre a mais recente.'}>
          <span style={{ fontFamily: 'var(--ac-font-mono)', fontSize: 13 }}>{desktop ? `v${current}` : 'Web'}</span>
        </Row>

        <Row
          label="Versão mais recente"
          hint={error || (info ? (info.available ? 'Há uma nova versão pronta para instalar.' : 'Você já está na versão mais recente.') : 'Verificando…')}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {info && <StatusDot tone={info.available ? 'accent' : 'ok'} label={`v${info.latest}`} />}
            <Btn size="sm" loading={checking} disabled={installing} onClick={check}>Verificar agora</Btn>
          </div>
        </Row>

        {desktop && info?.available && (
          <Row label="Instalar atualização" hint={location}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, minWidth: 220 }}>
              <Btn variant="cta" size="sm" loading={installing} onClick={install}>
                {installing ? 'Atualizando…' : `Atualizar para v${info.latest}`}
              </Btn>
              {progress && (
                <div style={{ width: 220 }}>
                  <ProgressLine percent={progress.stage === 'downloading' ? pct : 100} />
                  <div style={{ fontSize: 12, color: 'var(--ac-sub)', marginTop: 4, textAlign: 'right' }}>
                    {progress.stage === 'downloading'
                      ? `Baixando ${mb(progress.downloaded)}${progress.total ? ` de ${mb(progress.total)}` : ''} MB`
                      : progress.stage === 'downloaded' ? 'Download concluído' : 'Instalando — o app vai fechar e reabrir'}
                  </div>
                </div>
              )}
            </div>
          </Row>
        )}

        {info?.available && info.notes && (
          <Row label="Novidades" hint={<span style={{ whiteSpace: 'pre-wrap' }}>{info.notes.slice(0, 600)}</span>}>
            <Btn variant="text" size="sm" onClick={() => openExternalLink(info.pageUrl)}>Ver detalhes</Btn>
          </Row>
        )}

        {!desktop && (
          <Row label="Baixar o aplicativo" hint="Instale uma vez; depois as atualizações chegam direto pelo app.">
            <div style={{ display: 'flex', gap: 8 }}>
              <Btn size="sm" onClick={() => openExternalLink(downloads.windows)}>Windows</Btn>
              <Btn size="sm" onClick={() => openExternalLink(downloads.macos)}>macOS</Btn>
            </div>
          </Row>
        )}
      </div>
    </Section>
  )
}

export default UpdatesSection
