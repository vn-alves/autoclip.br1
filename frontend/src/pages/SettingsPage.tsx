import React, { useState, useEffect, useMemo } from 'react'
import { Form, Input, Select, Switch, message } from 'antd'
import { useLocation } from 'react-router-dom'
import { settingsApi } from '../services/api'
import SpeechRecognitionConfig from '../components/SpeechRecognitionConfig'
import FeedbackDialog from '../components/FeedbackDialog'
import { isDesktopMode, canSaveSettings } from '../utils/desktopMode'
import { openExternalLink } from '../utils/externalLinks'
import { trackApiKeyConfigured } from '../analytics/events'
import { isAnalyticsEnabled, setAnalyticsEnabled } from '../analytics/posthog'
import { getRuntimeInfo } from '../analytics/lifecycle'
import { FEEDBACK_FORM_URL, FEEDBACK_ISSUES_URL } from '../analytics/feedback'
import { useTheme } from '../context/ThemeContext'
import { Btn, Icon, Row, Section, Segmented, StatusDot } from '../ui'
import { loadBrowserSettings, saveBrowserSettings } from '../utils/browserSettings'
import AccountSection from '../components/AccountSection'
import UpdatesSection from '../components/UpdatesSection'
import { RELEASES_URL } from '../config/downloads'
import { getCloudUser, onCloudAuthChange, loadCloudSettings, saveCloudSettings, type CloudUser } from '../utils/cloudSettings'

const normalizeBaseUrl = (value: unknown): string =>
  typeof value === 'string' ? value.trim().replace(/\/+$/, '') : ''

// A caixa de seleção do modelo é mode="tags" Select, o usuário insere manualmente e obtém um array; o backend aceita apenas string
const normalizeModelName = (value: unknown): string => {
  if (Array.isArray(value)) return String(value[value.length - 1] ?? '').trim()
  return typeof value === 'string' ? value.trim() : ''
}
const toNumber = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? n : fallback
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, errorMessage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(errorMessage)), milliseconds)
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

type ProviderKey = 'dashscope' | 'openai' | 'gemini' | 'siliconflow' | 'ollama' | 'lmstudio'
type LocalPreset = { baseUrl: string; defaultModel: string; docsUrl: string; app: string }
const PROVIDERS: Record<ProviderKey, { name: string; short: string; hint: string; apiKeyField: string; placeholder: string; keyUrl: string; local?: LocalPreset }> = {
  dashscope: { name: 'Alibaba Tongyi Qianwen', short: 'Tongyi Qianwen', hint: 'Alibaba Cloud DashScope. Conexão direta na China, qwen-plus tem bom custo-benefício.', apiKeyField: 'dashscope_api_key', placeholder: 'sk-…', keyUrl: 'https://dashscope.console.aliyun.com/apiKey' },
  openai: { name: 'OpenAI / Interface compatível', short: 'OpenAI compatível', hint: 'OpenAI, ou qualquer interface compatível: Zhipu, DeepSeek, OpenRouter, vLLM.', apiKeyField: 'openai_api_key', placeholder: 'sk-…(Deixe em branco para serviço próprio)', keyUrl: 'https://platform.openai.com/api-keys' },
  gemini: { name: 'Google Gemini', short: 'Gemini', hint: 'Série Gemini do Google AI Studio.', apiKeyField: 'gemini_api_key', placeholder: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
  siliconflow: { name: 'Silicone Flow', short: 'Silicone Flow', hint: 'Plataforma agregadora SiliconFlow, modelos de código aberto como DeepSeek / Qwen.', apiKeyField: 'siliconflow_api_key', placeholder: 'sk-…', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  // Predefinição local: a base é compatível com openai + base_url, backend core/local_presets.py é responsável pela restauração; sem chave, sem custo, disponível offline
  ollama: { name: 'Ollama', short: 'Ollama', hint: 'Ollama rodando localmente, gratuito e offline. Recomenda-se ollama pull qwen2.5:7b.', apiKeyField: 'openai_api_key', placeholder: '', keyUrl: 'https://ollama.com/download', local: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'qwen2.5:7b', docsUrl: 'https://ollama.com/download', app: 'Ollama' } },
  lmstudio: { name: 'LM Studio', short: 'LM Studio', hint: 'Servidor Local do LM Studio, gratuito e offline. Carregue o modelo no LM Studio e inicie o serviço.', apiKeyField: 'openai_api_key', placeholder: '', keyUrl: 'https://lmstudio.ai', local: { baseUrl: 'http://localhost:1234/v1', defaultModel: '', docsUrl: 'https://lmstudio.ai', app: 'LM Studio' } },
}
const isLocalProvider = (p: ProviderKey) => !!PROVIDERS[p]?.local

const MODEL_GROUPS: Array<{ label: string; models: string[] }> = [
  { label: 'Tongyi Qianwen', models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen-long'] },
  { label: 'OpenAI', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini'] },
  { label: 'Gemini', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'] },
  { label: 'SiliconFlow / Código Aberto', models: ['deepseek-ai/DeepSeek-V3', 'deepseek-chat', 'Qwen/Qwen2.5-72B-Instruct'] },
]

const CLOUD_DEFAULT_MODEL: Partial<Record<ProviderKey, string>> = {
  dashscope: 'qwen-plus', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash', siliconflow: 'deepseek-ai/DeepSeek-V3',
}

type SectionKey = 'model' | 'account' | 'speech' | 'app' | 'updates' | 'feedback'
const NAV: Array<{ key: SectionKey; label: string }> = [
  { key: 'model', label: 'Modelo' },
  { key: 'account', label: 'Conta' },
  { key: 'speech', label: 'Transcrever' },
  { key: 'app', label: 'Aplicativo' },
  { key: 'updates', label: 'Atualizações' },
  { key: 'feedback', label: 'Feedback' },
]

// Calm Premium settings — left nav + setting rows (see DESIGN.md → App Layer)
const SettingsPage: React.FC = () => {
  const [form] = Form.useForm()
  const location = useLocation()
  const initialSection = useMemo<SectionKey>(() => {
    const s = new URLSearchParams(location.search).get('section')
    return (NAV.find((n) => n.key === s)?.key as SectionKey) || 'model'
  }, [location.search])
  const [active, setActive] = useState<SectionKey>(initialSection)
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [currentProvider, setCurrentProvider] = useState<any>({})
  const [selectedProvider, setSelectedProvider] = useState<ProviderKey>('dashscope')
  // Detecção de modelo predefinido local:{ reachable, models } —— Permita que o usuário selecione em um menu suspenso, em vez de digitar qwen2.5:7b
  const [localModels, setLocalModels] = useState<{ loading: boolean; reachable: boolean | null; models: string[] }>({ loading: false, reachable: null, models: [] })
  const [analyticsOn, setAnalyticsOn] = useState(isAnalyticsEnabled())
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null)
  const [syncing, setSyncing] = useState(false)
  const runtime = getRuntimeInfo()

  useEffect(() => { loadData() }, [])
  useEffect(() => {
    getCloudUser().then(setCloudUser).catch(() => setCloudUser(null))
    return onCloudAuthChange((user) => {
      setCloudUser(user)
      if (user) loadData()
    })
  }, [])
  useEffect(() => { setActive(initialSection) }, [initialSection])

  // Aplica um conjunto de configurações (da conta ou do navegador) no formulário
  const applySettings = (saved: any) => {
    const providerName = (saved?.api?.api_provider || 'dashscope') as ProviderKey
    form.setFieldsValue({
      llm_provider: providerName,
      dashscope_api_key: saved?.api?.api_keys?.dashscope || '',
      openai_api_key: saved?.api?.api_keys?.openai || '',
      openai_base_url: providerName === 'openai' ? saved?.api?.api_base_url || '' : '',
      local_base_url: isLocalProvider(providerName) ? saved?.api?.api_base_url || '' : '',
      gemini_api_key: saved?.api?.api_keys?.gemini || '',
      siliconflow_api_key: saved?.api?.api_keys?.siliconflow || '',
      jimeng_access_key: saved?.api?.api_keys?.jimeng_access || '',
      jimeng_secret_key: saved?.api?.api_keys?.jimeng_secret || '',
      model_name: saved?.api?.api_model || 'qwen-plus',
      chunk_size: saved?.processing?.processing_chunk_size || 5000,
      min_score_threshold: saved?.processing?.processing_min_score || 0.7,
      max_clips_per_collection: saved?.processing?.processing_max_clips || 5,
    })
    setSelectedProvider(PROVIDERS[providerName] ? providerName : 'dashscope')
    setCurrentProvider(saved ? { available: true, provider: providerName, display_name: PROVIDERS[providerName]?.name, model: saved.api?.api_model } : { available: false })
  }

  const loadData = async () => {
    try {
      // A conta manda: se houver configurações salvas na conta, elas valem em qualquer navegador
      const cloud = await loadCloudSettings().catch(() => null)
      if (cloud) {
        applySettings(cloud)
        saveBrowserSettings(cloud)
        // O processamento roda no servidor local. Ao entrar em outro navegador,
        // copie para ele as configurações recuperadas da conta antes de importar.
        const serverAvailable = await withTimeout(canSaveSettings(), 4000, 'O servidor local demorou para responder').catch(() => false)
        if (serverAvailable) {
          await withTimeout(
            settingsApi.updateSettings(cloud),
            6000,
            'O servidor local demorou para sincronizar as configurações',
          ).catch((err) => console.warn('Falha ao sincronizar configurações da conta com o servidor local:', err))
        }
        return
      }
      const serverAvailable = await canSaveSettings()
      if (serverAvailable) {
        const [settings, provider] = await Promise.allSettled([
          settingsApi.getSettings(),
          settingsApi.getCurrentProvider()
        ])
        const settingsData = settings.status === 'fulfilled' ? settings.value : {}
        const providerData = provider.status === 'fulfilled'
          ? provider.value
          : { available: false, provider: 'dashscope', display_name: 'Alibaba Tongyi Qianwen', model: 'qwen-plus' }
        // Prevalece o provedor salvo em settings.json; se a configuração antiga não tiver este campo, retorna ao provedor atual relatado pelo backend
        const providerName = (settingsData.api?.api_provider || providerData.provider || 'dashscope') as ProviderKey
        setCurrentProvider(providerData)
        const savedBaseUrl = settingsData.api?.api_base_url || ''
        const localPreset = PROVIDERS[providerName]?.local
        form.setFieldsValue({
          llm_provider: providerName,
          dashscope_api_key: settingsData.api?.api_keys?.dashscope || '',
          openai_api_key: settingsData.api?.api_keys?.openai || '',
          openai_base_url: localPreset ? '' : savedBaseUrl,
          // Predefinições locais só preenchem o endereço no formulário se o endereço padrão tiver sido alterado
          local_base_url: localPreset && savedBaseUrl && savedBaseUrl !== localPreset.baseUrl ? savedBaseUrl : '',
          gemini_api_key: settingsData.api?.api_keys?.gemini || '',
          siliconflow_api_key: settingsData.api?.api_keys?.siliconflow || '',
          jimeng_access_key: settingsData.api?.api_keys?.jimeng_access || '',
          jimeng_secret_key: settingsData.api?.api_keys?.jimeng_secret || '',
          model_name: settingsData.api?.api_model || 'qwen-plus',
          chunk_size: settingsData.processing?.processing_chunk_size || 5000,
          min_score_threshold: settingsData.processing?.processing_min_score || 0.7,
          max_clips_per_collection: settingsData.processing?.processing_max_clips || 5
        })
        setSelectedProvider(PROVIDERS[providerName] ? providerName : 'dashscope')
      } else {
        applySettings(loadBrowserSettings())
      }
    } catch (err) {
      console.error('Falha ao carregar dados:', err)
    }
  }

  const handleSave = async (values: any) => {
    try {
      setLoading(true)
      // Primeiro, leia a configuração existente para evitar apagar as chaves salvas de outros provedores
      let existing: any = loadBrowserSettings()
      const serverAvailable = await withTimeout(
        canSaveSettings(),
        4000,
        'O servidor local demorou para responder',
      ).catch(() => false)
      if (serverAvailable) {
        try {
          existing = await withTimeout(
            settingsApi.getSettings(),
            5000,
            'O servidor local demorou para carregar as configurações',
          )
        } catch (err) {
          console.warn('Falha ao obter configuração existente:', err)
        }
      }
      if (cloudUser) {
        const cloudExisting = await withTimeout(
          loadCloudSettings(),
          6000,
          'A conta demorou para responder',
        ).catch(() => null)
        if (cloudExisting) existing = cloudExisting
      }
      const keys = existing?.api?.api_keys || {}
      const provider = (values.llm_provider || selectedProvider) as ProviderKey

      const nextSettings = {
        basic: { app_name: 'AutoClip Desktop', app_version: runtime.version !== 'unknown' ? runtime.version : '1.0.0', debug_mode: false, auto_start: true },
        service: { host: '127.0.0.1', port: 8000, max_memory_usage: 2048 },
        api: {
          api_keys: {
            dashscope: values.dashscope_api_key || keys.dashscope || '',
            openai: values.openai_api_key || keys.openai || '',
            gemini: values.gemini_api_key || keys.gemini || '',
            siliconflow: values.siliconflow_api_key || keys.siliconflow || '',
            jimeng_access: values.jimeng_access_key || keys.jimeng_access || '',
            jimeng_secret: values.jimeng_secret_key || keys.jimeng_secret || ''
          },
          api_provider: provider,
          api_base_url: provider === 'openai'
            ? normalizeBaseUrl(values.openai_base_url)
            : isLocalProvider(provider) ? normalizeBaseUrl(values.local_base_url) : '',
          api_model: normalizeModelName(values.model_name) || 'qwen-plus',
          api_max_tokens: 4096,
          api_timeout: 30
        },
        processing: {
          processing_chunk_size: toNumber(values.chunk_size, 5000),
          processing_min_score: toNumber(values.min_score_threshold, 0.7),
          processing_max_clips: toNumber(values.max_clips_per_collection, 5),
          processing_max_retries: 3
        },
        logs: { log_level: 'INFO', log_retention_days: 7 }
        // paths são determinados pelo backend com base no diretório de dados real, o frontend não os envia
      }
      saveBrowserSettings(nextSettings)
      let savedToAccount = false
      let savedToServer = false
      if (cloudUser) {
        try {
          savedToAccount = await withTimeout(
            saveCloudSettings(nextSettings),
            6000,
            'A sincronização com a conta demorou para responder',
          )
        } catch (err) {
          console.warn('Falha ao salvar na conta:', err)
        }
      }
      if (serverAvailable) {
        try {
          await withTimeout(
            settingsApi.updateSettings(nextSettings),
            6000,
            'O servidor local demorou para salvar',
          )
          savedToServer = true
        } catch (err) {
          console.warn('Falha ao salvar no servidor local:', err)
        }
      }
      if (savedToAccount) {
        message.success('Configurações salvas na sua conta')
      } else if (savedToServer) {
        message.success('Configurações salvas')
      } else if (cloudUser) {
        message.warning('Configurações salvas neste navegador. A conta não respondeu agora.')
      } else {
        message.success('Configurações salvas neste navegador')
      }
      trackApiKeyConfigured({ provider, hasKey: isLocalProvider(provider) || !!values[PROVIDERS[provider].apiKeyField] })
      setCurrentProvider({ available: true, provider, display_name: PROVIDERS[provider].name, model: nextSettings.api.api_model })
    } catch (err: any) {
      message.error('Falha ao salvar: ' + (err.message || 'Erro Desconhecido'))
    } finally {
      setLoading(false)
    }
  }

  const handleTest = async () => {
    const cfg = PROVIDERS[selectedProvider]
    const local = isLocalProvider(selectedProvider)
    const apiKey: string = local ? '' : (form.getFieldValue(cfg.apiKeyField) || '')
    const baseUrl = selectedProvider === 'openai'
      ? normalizeBaseUrl(form.getFieldValue('openai_base_url'))
      : local ? (normalizeBaseUrl(form.getFieldValue('local_base_url')) || cfg.local!.baseUrl) : ''
    const modelName = normalizeModelName(form.getFieldValue('model_name'))
    if (local && !modelName) {
      message.error('Por favor, selecione um modelo primeiro')
      return
    }
    // Serviços compatíveis auto-hospedados (Ollama / vLLM, etc.) geralmente não precisam de chave, podem ser testados com o endereço
    if (!apiKey.trim() && !baseUrl) {
      message.error('Por favor, preencha a chave API primeiro')
      return
    }
    try {
      setTesting(true)
      const r = await settingsApi.testApiKey(selectedProvider, apiKey, { baseUrl: baseUrl || undefined, model: modelName || undefined })
      if (r.success) message.success('Conexão Normal')
      else message.error('Falha na conexão: ' + (r.error || 'Erro Desconhecido'))
    } catch (err: any) {
      message.error('Falha no teste: ' + (err.message || 'Erro Desconhecido'))
    } finally {
      setTesting(false)
    }
  }

  const detectLocalModels = async (p: ProviderKey, baseUrl?: string) => {
    const preset = PROVIDERS[p]?.local
    if (!preset) return
    setLocalModels((s) => ({ ...s, loading: true }))
    try {
      const r = await settingsApi.listCompatibleModels({ provider: p, baseUrl: normalizeBaseUrl(baseUrl) || undefined })
      setLocalModels({ loading: false, reachable: r.reachable, models: r.models || [] })
      // Modelo detectado e nenhum selecionado / o selecionado não está na lista → Ajude o usuário a escolher um (priorizar o padrão predefinido)
      const current = normalizeModelName(form.getFieldValue('model_name'))
      if (r.reachable && r.models.length && (!current || !r.models.includes(current))) {
        form.setFieldsValue({ model_name: r.models.includes(preset.defaultModel) ? preset.defaultModel : r.models[0] })
      }
    } catch {
      setLocalModels({ loading: false, reachable: false, models: [] })
    }
  }

  const handleProviderChange = (p: ProviderKey) => {
    const prev = selectedProvider
    setSelectedProvider(p)
    form.setFieldsValue({ llm_provider: p })
    const preset = PROVIDERS[p]?.local
    const current = normalizeModelName(form.getFieldValue('model_name'))
    if (preset) {
      // Ao mudar da nuvem para o local, nomes de modelos de nuvem como qwen-plus não fazem sentido para serviços locais
      if (!current || MODEL_GROUPS.some((g) => g.models.includes(current))) {
        form.setFieldsValue({ model_name: preset.defaultModel || undefined })
      }
      void detectLocalModels(p, form.getFieldValue('local_base_url'))
    } else if (isLocalProvider(prev) || !current) {
      // Mudar de local para nuvem: nomes de modelos locais como qwen2.5:7b não fazem sentido para a nuvem, dar um padrão comum para este provedor
      form.setFieldsValue({ model_name: CLOUD_DEFAULT_MODEL[p] })
    }
  }

  // Ao abrir a página de configurações, se já for uma predefinição local, detecte uma vez
  useEffect(() => {
    if (isLocalProvider(selectedProvider)) void detectLocalModels(selectedProvider, form.getFieldValue('local_base_url'))
  }, [selectedProvider])

  const openaiBaseUrl = Form.useWatch('openai_base_url', form)
  const usingCustomEndpoint = selectedProvider === 'openai' && !!normalizeBaseUrl(openaiBaseUrl)
  const cfg = PROVIDERS[selectedProvider]
  const localCfg = cfg.local

  return (
    <div className="ac-page">
      <header>
        <h1 className="ac-title" style={{ marginTop: 0 }}>Configurações</h1>
        <div className="ac-meta">
          <span className="ac-mono">{runtime.version !== 'unknown' ? `v${runtime.version}` : 'dev'}</span>
          <span className="dot" />
          <span className="ac-mono">{runtime.os}/{runtime.arch}</span>
          {currentProvider?.available && (
            <>
              <span className="dot" />
              <span>Modelo Atual <span className="ac-mono">{currentProvider.provider} · {currentProvider.model}</span></span>
            </>
          )}
        </div>
      </header>

      <div className="ac-settings" style={{ marginTop: 36 }}>
        <nav className="ac-settings-nav" aria-label="Definir Categoria">
          {NAV.map((n) => (
            <button key={n.key} aria-current={active === n.key} onClick={() => setActive(n.key)}>{n.label}</button>
          ))}
        </nav>

        <div className="ac-settings-body">
          {/* ---------------- Modelo ---------------- */}
          {active === 'model' && (
            <Section title="Modelo" description="Qual modelo usar para analisar os clipes. A chave é salva na sua conta quando você está conectado ou neste navegador.">
              <Form
                form={form}
                layout="vertical"
                onFinish={handleSave}
                requiredMark={false}
                initialValues={{ llm_provider: 'dashscope', model_name: 'qwen-plus', chunk_size: 5000, min_score_threshold: 0.7, max_clips_per_collection: 5 }}
              >
                <Form.Item name="llm_provider" hidden><Input /></Form.Item>
                <div className="ac-rows">
                  <Row label="Provedor" hint={cfg.hint} stack>
                    <Segmented
                      size="sm"
                      ariaLabel="Provedor"
                      value={selectedProvider}
                      onChange={handleProviderChange}
                      options={(Object.keys(PROVIDERS) as ProviderKey[]).map((k) => ({ value: k, label: PROVIDERS[k].short }))}
                    />
                  </Row>

                  {localCfg && (
                    <Row
                      wide
                      label="Endereço do Serviço"
                      hint={<>Padrão <span className="ac-mono">{localCfg.baseUrl}</span>, só precisa preencher se a porta foi alterada. Se não estiver instalado, vá para <a href={localCfg.docsUrl} onClick={(e) => { e.preventDefault(); openExternalLink(localCfg.docsUrl) }} style={{ color: 'var(--ac-accent)' }}>{localCfg.app} Site Oficial</a> Baixar.</>}
                    >
                      <Form.Item
                        name="local_base_url"
                        style={{ width: '100%' }}
                        rules={[{
                          validator: (_, value) => {
                            const url = normalizeBaseUrl(value)
                            if (!url || /^https?:\/\/\S+$/.test(url)) return Promise.resolve()
                            return Promise.reject(new Error('Por favor, insira um endereço que comece com http:// ou https://'))
                          },
                        }]}
                      >
                        <Input
                          placeholder={localCfg.baseUrl}
                          allowClear
                          className="ac-mono"
                          onBlur={(e) => void detectLocalModels(selectedProvider, e.target.value)}
                        />
                      </Form.Item>
                    </Row>
                  )}

                  {selectedProvider === 'openai' && (
                    <Row
                      wide
                      label="Endereço da API"
                      hint={<>Deixe em branco para o endereço oficial da OpenAI. Para serviços compatíveis, preencha o seu, por exemplo <span className="ac-mono">https://api.deepseek.com/v1</span>, <span className="ac-mono">http://localhost:11434/v1</span> (Ollama) . </>}
                    >
                      <Form.Item
                        name="openai_base_url"
                        style={{ width: '100%' }}
                        rules={[{
                          validator: (_, value) => {
                            const url = normalizeBaseUrl(value)
                            if (!url || /^https?:\/\/\S+$/.test(url)) return Promise.resolve()
                            return Promise.reject(new Error('Por favor, insira um endereço que comece com http:// ou https://'))
                          },
                        }]}
                      >
                        <Input placeholder="https://api.openai.com/v1" allowClear className="ac-mono" />
                      </Form.Item>
                    </Row>
                  )}

                  {!localCfg && <Row
                    wide
                    label="API Key"
                    hint={usingCustomEndpoint
                      ? 'Pode ser deixado em branco se o serviço auto-hospedado/local compatível não verificar a chave.'
                      : <>Em <a href={cfg.keyUrl} onClick={(e) => { e.preventDefault(); openExternalLink(cfg.keyUrl) }} style={{ color: 'var(--ac-accent)' }}>{cfg.name} Console</a> Obter.</>}
                  >
                    <Form.Item
                      name={cfg.apiKeyField}
                      style={{ width: '100%' }}
                      rules={usingCustomEndpoint ? [] : [
                        { required: true, message: 'Por favor, insira a API Key' },
                        { min: 10, message: 'O comprimento da API Key não pode ser inferior a 10 caracteres' }
                      ]}
                    >
                      <Input.Password placeholder={cfg.placeholder} className="ac-mono" />
                    </Form.Item>
                  </Row>}

                  <Row
                    wide
                    label="Modelo"
                    hint={localCfg
                      ? (localModels.loading
                          ? 'Detectando serviço local…'
                          : localModels.reachable
                            ? <>Conectado, detectado {localModels.models.length} modelos.<a onClick={() => void detectLocalModels(selectedProvider, form.getFieldValue('local_base_url'))} style={{ color: 'var(--ac-accent)', cursor: 'pointer' }}>Atualizar</a></>
                            : localModels.reachable === false
                              ? <>Não conectado {localCfg.app}. Inicie-o primeiro{localCfg.defaultModel ? <>e <span className="ac-mono">ollama pull {localCfg.defaultModel}</span></> : ''}, então <a onClick={() => void detectLocalModels(selectedProvider, form.getFieldValue('local_base_url'))} style={{ color: 'var(--ac-accent)', cursor: 'pointer' }}>Detectar Novamente</a>. Você também pode inserir o nome do modelo diretamente.</>
                              : 'Selecione entre os modelos carregados do serviço local.')
                      : usingCustomEndpoint
                        ? 'Preencha o nome do modelo real fornecido por este serviço (ex: glm-4-flash, deepseek-chat, qwen2.5:7b) e pressione Enter para confirmar.'
                        : 'Você pode inserir o nome do modelo diretamente e pressionar Enter para confirmar.'}
                  >
                    <Form.Item
                      name="model_name"
                      style={{ width: '100%' }}
                      getValueFromEvent={(value) => Array.isArray(value) ? value.slice(-1) : value}
                      rules={[{ required: true, message: 'Por favor, insira ou selecione um modelo' }]}
                    >
                      <Select
                        placeholder={localCfg ? (localCfg.defaultModel || 'Selecione ou insira o nome do modelo') : 'qwen-plus'}
                        showSearch
                        allowClear
                        mode="tags"
                        maxTagCount={1}
                        loading={localCfg ? localModels.loading : false}
                        className="ac-mono"
                        options={(localCfg
                          ? localModels.models.map((m) => ({ value: m, label: m }))
                          : MODEL_GROUPS.map((g) => ({ label: g.label, options: g.models.map((m) => ({ value: m, label: m })) }))) as any}
                      />
                    </Form.Item>
                  </Row>

                  <Row label="Teste de Conexão" hint={localCfg ? 'Teste se o serviço local e o modelo estão disponíveis antes de salvar.' : 'Teste a chave e o modelo antes de salvar para verificar a disponibilidade.'}>
                    <Btn size="sm" loading={testing} onClick={handleTest}>Testar Conexão</Btn>
                  </Row>
                </div>

                <div className="ac-eyebrow" style={{ marginTop: 40, marginBottom: 12 }}>Parâmetros de Fatiamento</div>
                <div className="ac-rows">
                  <Row label="Tamanho do bloco de texto" hint="Comprimento da legenda enviada para análise do modelo a cada vez. Quanto maior, mais coerente e mais lento, recomendado 5000.">
                    <Form.Item name="chunk_size">
                      <input className="ac-input ac-input--mono" type="number" min={1000} step={500} style={{ width: 120, textAlign: 'right' }} />
                    </Form.Item>
                    <span className="ac-unit">Caractere</span>
                  </Row>
                  <Row label="Limite mínimo de pontuação" hint="Segmentos abaixo desta pontuação serão descartados. Pode ser reduzido quando o corte for 0.">
                    <Form.Item name="min_score_threshold">
                      <input className="ac-input ac-input--mono" type="number" min={0} max={1} step={0.05} style={{ width: 120, textAlign: 'right' }} />
                    </Form.Item>
                    <span className="ac-unit" />
                  </Row>
                  <Row label="Máximo de clipes por coleção" hint="Ao recomendar coleções de IA, um tópico pode ter no máximo quantos trechos.">
                    <Form.Item name="max_clips_per_collection">
                      <input className="ac-input ac-input--mono" type="number" min={1} max={20} style={{ width: 120, textAlign: 'right' }} />
                    </Form.Item>
                    <span className="ac-unit">item</span>
                  </Row>
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12, marginTop: 28 }}>
                  {currentProvider?.available && (
                    <StatusDot tone="ok" label={<>Configurado <span className="ac-mono">{currentProvider.display_name} · {currentProvider.model}</span></>} />
                  )}
                  <Btn variant="cta" loading={loading} onClick={() => form.submit()}>Salvar</Btn>
                </div>
              </Form>
            </Section>
          )}

          {/* ---------------- Conta ---------------- */}
          {active === 'account' && (
            <AccountSection
              user={cloudUser}
              syncing={syncing}
              onSyncNow={async () => {
                setSyncing(true)
                try {
                  const cloud = await loadCloudSettings()
                  if (cloud) {
                    applySettings(cloud)
                    saveBrowserSettings(cloud)
                    message.success('Configurações da conta carregadas')
                  } else {
                    message.info('Nenhuma configuração salva na conta ainda')
                  }
                } catch (err: any) {
                  message.error(err?.message || 'Não foi possível buscar as configurações')
                } finally {
                  setSyncing(false)
                }
              }}
            />
          )}

          {/* ---------------- Transcrição ---------------- */}
          {active === 'speech' && (
            <Section
              title="Transcrever"
              description="Quando o vídeo não tem legendas, use o Whisper local para gerá-las e depois analise. Vídeos com legendas embutidas (como Bilibili) não precisam, a decisão de instalar ou qual modelo instalar é sua."
            >
              <SpeechRecognitionConfig />
            </Section>
          )}

          {/* ---------------- Aplicativo ---------------- */}
          {active === 'app' && (
            <AppSection analyticsOn={analyticsOn} onAnalyticsChange={(on) => { setAnalyticsEnabled(on); setAnalyticsOn(on) }} />
          )}

          {active === 'updates' && <UpdatesSection />}

          {/* ---------------- Feedback ---------------- */}
          {active === 'feedback' && (
            <Section title="Feedback" description="Diga o que está errado ou o que você quer. O ambiente de execução será anexado automaticamente, sem conteúdo de vídeo ou chaves de API.">
              <div className="ac-rows">
                <Row label="Enviar Feedback" hint="Basta escrever uma frase no aplicativo, nós verificamos todas as semanas.">
                  <Btn variant="cta" size="sm" style={{ height: 32, fontSize: 13, padding: '0 16px' }} onClick={() => setFeedbackOpen(true)}>
                    <Icon.Chat size={13} /> Escrever feedback
                  </Btn>
                </Row>
                <Row label="Formulário de Feedback" hint="Use quando não quiser escrever no aplicativo, ou quiser anexar capturas de tela/logs.">
                  <Btn size="sm" onClick={() => openExternalLink(FEEDBACK_FORM_URL)}>Abrir Formulário <Icon.External size={12} /></Btn>
                </Row>
                <Row label="GitHub" hint="Desenvolvedores podem abrir um Issue diretamente (há um template) ou discutir em Discussions.">
                  <Btn size="sm" onClick={() => openExternalLink(FEEDBACK_ISSUES_URL)}>Criar Issue <Icon.External size={12} /></Btn>
                </Row>
                <Row label="Status atual e problemas conhecidos" hint="O ritmo de lançamento, bugs conhecidos e soluções estão nesta Issue fixada.">
                  <Btn variant="text" size="sm" onClick={() => openExternalLink('https://github.com/zhouxiaoka/autoclip/issues/96')}>#96 <Icon.External size={12} /></Btn>
                </Row>
              </div>
            </Section>
          )}
        </div>
      </div>

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} context={{ source: 'settings' }} />
    </div>
  )
}

/* ---------------- Aplicativo ---------------- */
const AppSection: React.FC<{ analyticsOn: boolean; onAnalyticsChange: (on: boolean) => void }> = ({ analyticsOn, onAnalyticsChange }) => {
  const { theme, setTheme } = useTheme()
  const [autostart, setAutostart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [desktop, setDesktop] = useState(false)

  useEffect(() => {
    (async () => {
      try {
        const isDesktop = await isDesktopMode()
        setDesktop(isDesktop)
        if (isDesktop) {
          const { invoke } = await import('@tauri-apps/api/core')
          setAutostart(Boolean(await invoke('is_autostart_enabled')))
        }
      } catch (err) {
        console.error('Falha ao verificar o status de inicialização automática:', err)
      }
    })()
  }, [])

  const toggleAutostart = async (enabled: boolean) => {
    if (!desktop) { message.error('Este recurso está disponível apenas no aplicativo de desktop'); return }
    setBusy(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke(enabled ? 'enable_autostart' : 'disable_autostart')
      setAutostart(enabled)
    } catch (err) {
      console.error('Falha ao alternar o status de inicialização automática:', err)
      message.error(`Falha na operação: ${err}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title="Aplicar" description="Aparência, inicialização e privacidade.">
      <div className="ac-rows">
        {!desktop && (
          <Row
            wide
            label="Aplicativo desktop"
            hint="A importação de vídeo (YouTube, Bilibili, corte por IA) roda no aplicativo instalado no seu computador — este site é só para conta e configurações. Baixe o instalador para Windows ou macOS."
          >
            <Btn variant="cta" size="sm" onClick={() => openExternalLink(RELEASES_URL)}>
              Baixar o app <Icon.External size={12} />
            </Btn>
          </Row>
        )}
        <Row label="Aparência" hint="Primeira inicialização segue o sistema.">
          <Segmented size="sm" ariaLabel="Aparência" value={theme} onChange={setTheme} options={[{ value: 'light', label: 'Claro' }, { value: 'dark', label: 'Escuro' }]} />
        </Row>
        <Row label="Iniciar automaticamente ao ligar" hint="Inicia com o sistema quando ativado, pode ser aberto pela bandeja. Disponível apenas para aplicativos de desktop.">
          <Switch checked={autostart} onChange={toggleAutostart} loading={busy} disabled={!desktop} />
        </Row>
        <Row label="Estatísticas de uso anônimas" hint="Coleta apenas eventos anônimos como uso de recursos, sucesso/falha na exportação, não incluindo conteúdo de vídeo, texto de legenda ou chaves de API. Se desativado, o feedback no aplicativo usará um formulário.">
          <Switch checked={analyticsOn} onChange={onAnalyticsChange} />
        </Row>
        <Row label="Conta Bilibili" hint="Gerenciamento de múltiplas contas e postagem com um clique, em desenvolvimento.">
          <span className="ac-hint" style={{ margin: 0 }}>Em Breve</span>
        </Row>
      </div>
    </Section>
  )
}

export default SettingsPage
