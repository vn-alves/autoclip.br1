import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Btn } from '../ui'
import { isTauri } from '../utils/isTauri'
import { checkForUpdate, dismissUpdate, isUpdateDismissed, type UpdateInfo } from '../utils/updater'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

/** Aviso fixo no topo do app desktop quando há versão nova; leva para Configurações → Atualizações. */
const UpdateBanner: React.FC = () => {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (!isTauri()) return
    let alive = true
    const run = () =>
      checkForUpdate()
        .then((r) => { if (alive && r.available && !isUpdateDismissed(r.latest)) setInfo(r) })
        .catch(() => {})
    const first = window.setTimeout(run, 4000)
    const timer = window.setInterval(run, CHECK_EVERY_MS)
    return () => { alive = false; window.clearTimeout(first); window.clearInterval(timer) }
  }, [])

  if (!info) return null
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px',
        background: 'var(--ac-card)', borderBottom: '1px solid var(--ac-line)', color: 'var(--ac-ink)', fontSize: 13,
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--ac-accent)', flexShrink: 0 }} />
      <span style={{ flex: 1 }}>
        Nova versão disponível: <strong>v{info.latest}</strong>
        <span style={{ color: 'var(--ac-sub)' }}> — você está na v{info.current}. Atualize para receber as melhorias.</span>
      </span>
      <Btn variant="text" size="sm" onClick={() => { dismissUpdate(info.latest); setInfo(null) }}>Depois</Btn>
      <Btn variant="cta" size="sm" onClick={() => navigate('/settings?section=updates')}>Atualizar agora</Btn>
    </div>
  )
}

export default UpdateBanner
