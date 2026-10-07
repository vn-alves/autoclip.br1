import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../ui'
import { resolveDownloadUrls, WINDOWS_DOWNLOAD_URL, MACOS_DOWNLOAD_URL } from '../config/downloads'
import { openExternalLink } from '../utils/externalLinks'
import { markEnteredApp } from '../utils/webEntry'
import './LandingPage.css'

const FEATURES = [
  {
    icon: <Icon.Video size={18} />,
    title: 'Editor de vídeo',
    desc: 'Edite seus cortes com camadas, redimensionamento livre e enquadramento automático (9:16, 16:9, 1:1) direto no navegador ou no aplicativo.',
  },
  {
    icon: <Icon.Chat size={18} />,
    title: 'Legendas sincronizadas',
    desc: 'Legendas alinhadas à fala real por IA, com agrupamento automático ou por número de palavras.',
  },
  {
    icon: <Icon.Check size={18} />,
    title: 'Destaque de palavras',
    desc: 'A palavra falada no momento é destacada automaticamente — karaokê, cor, fundo ou escala.',
  },
  {
    icon: <Icon.Plus size={18} />,
    title: 'Estilos e transições',
    desc: 'Presets prontos de fonte, cor e contorno, mais transições de entrada (fade, pop, slide, zoom, palavra a palavra).',
  },
  {
    icon: <Icon.External size={18} />,
    title: 'Múltiplas camadas',
    desc: 'Combine o vídeo principal com camadas extras, cada uma com seu próprio enquadramento e janela de tempo.',
  },
  {
    icon: <Icon.Down size={18} />,
    title: 'Exportação',
    desc: 'Renderize o corte final já com legenda, camadas e enquadramento aplicados, pronto pra publicar.',
  },
]

const STEPS = [
  { n: '1', title: 'Envie ou escolha seu vídeo', desc: 'Importe um arquivo local ou um link (YouTube, Bilibili).' },
  { n: '2', title: 'A IA corta os melhores momentos', desc: 'Cortes automáticos por relevância, prontos pra revisar.' },
  { n: '3', title: 'Edite e adicione legendas', desc: 'Ajuste camadas, enquadramento, legendas e efeitos no Editor.' },
  { n: '4', title: 'Exporte seu vídeo', desc: 'Baixe o corte final pronto para redes sociais.' },
]

/**
 * Landing Page — exclusiva da versão Web (ver App.tsx: isTauri() decide). Não tem formulário de
 * login próprio: "Entrar" leva para /settings, onde já mora o login real (AccountSection,
 * Supabase) — ver cloudSettings.ts. "Começar agora"/"Acessar plataforma" levam para "/", o app
 * de verdade, sem nenhum gate (o produto já funciona sem login; login aqui é só pra sincronizar
 * configurações na nuvem).
 */
const LandingPage: React.FC = () => {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)
  // Resolve a release mais recente no GitHub; se falhar, usa os links fixos da última versão conhecida.
  const [urls, setUrls] = useState({ windows: WINDOWS_DOWNLOAD_URL, macos: MACOS_DOWNLOAD_URL })
  useEffect(() => {
    let alive = true
    resolveDownloadUrls().then((r) => { if (alive) setUrls({ windows: r.windows, macos: r.macos }) })
    return () => { alive = false }
  }, [])

  const enterPlatform = () => { markEnteredApp(); navigate('/') }
  const goToLogin = () => { markEnteredApp(); navigate('/settings') }
  const downloadWindows = () => openExternalLink(urls.windows)
  const downloadMacos = () => openExternalLink(urls.macos)

  return (
    <div className="lp">
      <header className="lp-header">
        <div className="lp-header-inner">
          <div className="lp-logo" onClick={enterPlatform}>
            Auto<em>Clip</em>
          </div>
          <nav className="lp-nav">
            <a href="#recursos">Recursos</a>
            <a href="#como-funciona">Como funciona</a>
            <a href="#desktop">Desktop</a>
          </nav>
          <div className="lp-header-actions">
            <button type="button" className="lp-btn lp-btn--text" onClick={goToLogin}>Entrar</button>
            <button type="button" className="lp-btn lp-btn--cta" onClick={enterPlatform}>Começar agora</button>
          </div>
          <button type="button" className="lp-burger" aria-label="Menu" onClick={() => setMenuOpen((v) => !v)}>
            <Icon.Down size={16} />
          </button>
        </div>
        {menuOpen && (
          <div className="lp-mobile-menu">
            <a href="#recursos" onClick={() => setMenuOpen(false)}>Recursos</a>
            <a href="#como-funciona" onClick={() => setMenuOpen(false)}>Como funciona</a>
            <a href="#desktop" onClick={() => setMenuOpen(false)}>Desktop</a>
            <button type="button" className="lp-btn lp-btn--text" onClick={goToLogin}>Entrar</button>
            <button type="button" className="lp-btn lp-btn--cta" onClick={enterPlatform}>Começar agora</button>
          </div>
        )}
      </header>

      <main>
        {/* ---------------------------------------------------------------- Hero --- */}
        <section className="lp-hero">
          <span className="lp-eyebrow">Edição de vídeo com IA</span>
          <h1>Transforme seus vídeos em conteúdo pronto para publicar.</h1>
          <p className="lp-hero-sub">
            O AutoClip corta seus vídeos longos em clipes prontos para redes sociais: edite, adicione
            legendas sincronizadas, destaque palavras, combine camadas e exporte — no navegador ou no
            aplicativo, do seu jeito.
          </p>
          <div className="lp-hero-ctas">
            <button type="button" className="lp-btn lp-btn--cta lp-btn--lg" onClick={enterPlatform}>Começar agora</button>
            <button type="button" className="lp-btn lp-btn--lg" onClick={downloadWindows}>
              <Icon.External size={13} /> Baixar para Windows
            </button>
            <button type="button" className="lp-btn lp-btn--lg" onClick={downloadMacos}>
              <Icon.External size={13} /> Baixar para macOS
            </button>
          </div>

          {/* Screenshots reais do produto (não é mockup) — ver DESIGN.md: preferir reaproveitar
              telas reais em vez de inventar imagens externas. */}
          <div className="lp-showcase">
            <img
              className="lp-showcase-wide"
              src="/landing/project-clips.png"
              alt="Cortes gerados automaticamente por IA, prontos para revisar"
              loading="lazy"
            />
            <img
              className="lp-showcase-tall"
              src="/landing/editor-panel.png"
              alt="Painel de estilo e sincronização de legendas do Editor de Corte"
              loading="lazy"
            />
          </div>
        </section>

        {/* -------------------------------------------------------------- Recursos --- */}
        <section className="lp-section" id="recursos">
          <h2>Uma ferramenta completa para seus vídeos</h2>
          <div className="lp-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="lp-feature-card">
                <div className="lp-feature-icon">{f.icon}</div>
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ---------------------------------------------------------- Web/Desktop --- */}
        <section className="lp-section" id="desktop">
          <h2>Escolha como você quer usar</h2>
          <p className="lp-section-sub">
            O AutoClip funciona no navegador e como aplicativo — a conta e as configurações são as
            mesmas nos dois.
          </p>
          <div className="lp-platforms">
            <div className="lp-platform-card">
              <h3>No navegador</h3>
              <p>Sem instalação. Acesse sua conta e configurações de qualquer computador.</p>
              <button type="button" className="lp-btn" onClick={enterPlatform}>Acessar Web</button>
            </div>
            <div className="lp-platform-card">
              <h3>Windows</h3>
              <p>Aplicativo desktop com o corte por IA, edição e exportação completos.</p>
              <button type="button" className="lp-btn" onClick={downloadWindows}>Baixar Windows</button>
            </div>
            <div className="lp-platform-card">
              <h3>macOS</h3>
              <p>Aplicativo desktop com o corte por IA, edição e exportação completos.</p>
              <button type="button" className="lp-btn" onClick={downloadMacos}>Baixar macOS</button>
            </div>
          </div>
          <p className="lp-hint">
            A importação e o corte por IA rodam no aplicativo instalado — o navegador é ideal para
            gerenciar sua conta e configurações de qualquer lugar.
          </p>
        </section>

        {/* -------------------------------------------------------------- Fluxo --- */}
        <section className="lp-section" id="como-funciona">
          <h2>Como funciona</h2>
          <div className="lp-steps">
            {STEPS.map((s) => (
              <div key={s.n} className="lp-step">
                <span className="lp-step-n">{s.n}</span>
                <h3>{s.title}</h3>
                <p>{s.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ------------------------------------------------------------ CTA final --- */}
        <section className="lp-cta-final">
          <h2>Pronto para transformar seus vídeos?</h2>
          <div className="lp-hero-ctas">
            <button type="button" className="lp-btn lp-btn--cta lp-btn--lg" onClick={enterPlatform}>Começar agora</button>
            <button type="button" className="lp-btn lp-btn--lg" onClick={downloadWindows}>Baixar para Windows</button>
            <button type="button" className="lp-btn lp-btn--lg" onClick={downloadMacos}>Baixar para macOS</button>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <span>© {new Date().getFullYear()} AutoClip</span>
        <a href="#recursos">Recursos</a>
        <a href="#como-funciona">Como funciona</a>
        <a href="#desktop">Desktop</a>
      </footer>
    </div>
  )
}

export default LandingPage
