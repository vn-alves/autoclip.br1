import { useEffect } from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import { Layout } from 'antd'
import HomePage from './pages/HomePage'
import ProjectDetailPage from './pages/ProjectDetailPage'
import ClipEditorPage from './pages/ClipEditorPage'
import SettingsPage from './pages/SettingsPage'
import LandingPage from './pages/LandingPage'
import Header from './components/Header'
import UpdateBanner from './components/UpdateBanner'
import { trackPageview } from './analytics/posthog'
import { isTauri } from './utils/isTauri'
import { hasEnteredApp } from './utils/webEntry'

const { Content } = Layout

// Relatar pageview manualmente sob HashRouter (pageview automático desativado na inicialização)
function usePageviewTracking() {
  const location = useLocation()
  useEffect(() => {
    trackPageview(location.pathname + location.search)
  }, [location.pathname, location.search])
}

function App() {
  console.log('🎬 Componente do App carregado');
  usePageviewTracking()
  const location = useLocation()

  // Landing Page é exclusiva da versão Web na raiz ("/") — nunca no app desktop (Tauri) e nunca
  // em outras rotas (link direto pra um corte/projeto continua abrindo a ferramenta normalmente).
  // isTauri() é síncrono (window.__TAURI__), então não há flash de Landing no app instalado.
  // hasEnteredApp() evita ficar preso nela: depois do primeiro "Começar agora"/"Entrar" nesta
  // aba, qualquer "voltar ao início" (Header, botão Voltar etc. — todos navegam pra "/") cai
  // na Home de verdade, não na Landing de novo.
  if (!isTauri() && location.pathname === '/' && !hasEnteredApp()) {
    return <LandingPage />
  }

  return (
    <Layout>
      <UpdateBanner />
      <Header />
      <Content>
        <Routes>
          {/* HomePage é a mesma tela em Web e Desktop — na Web ela usa o armazenamento local
              (webstore/, ver FileUpload.tsx) no lugar da API pra "Importar Arquivo"; "Importar
              Link" continua visível mas só funciona no desktop (precisa de servidor de verdade). */}
          <Route path="/" element={<HomePage />} />
          <Route path="/project/:id" element={<ProjectDetailPage />} />
          <Route path="/project/:id/editor/:clipId" element={<ClipEditorPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Content>
    </Layout>
  )
}

export default App
