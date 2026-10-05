import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function pingBackend(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      res.resume()
      resolve((res.statusCode || 500) < 500)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * O preview roda apenas o Vite, então o backend FastAPI (que faz o parse dos
 * links e todo o resto de /api) ficava fora do ar e a UI mostrava
 * "link inválido". Este plugin sobe o backend junto com o dev server.
 */
function autoclipBackend(): Plugin {
  return {
    name: 'autoclip-backend',
    apply: 'serve',
    async configureServer() {
      if (process.env.AUTOCLIP_SKIP_BACKEND === '1' || process.env.BACKEND_URL) return
      const port = Number(process.env.BACKEND_PORT || 8000)
      if (await pingBackend(port)) return

      const isWindows = process.platform === 'win32'
      const venvPython = isWindows 
        ? path.join(ROOT, '.venv', 'Scripts', 'python.exe') 
        : path.join(ROOT, '.venv', 'bin', 'python')
      const python = existsSync(venvPython) ? venvPython : (isWindows ? 'python' : 'python3')
      const logDir = path.join(ROOT, 'data', 'logs')
      mkdirSync(logDir, { recursive: true })
      const log = openSync(path.join(logDir, 'backend.stdout.log'), 'a')

      const child = spawn(
        python,
        ['-m', 'uvicorn', 'backend.app_factory:create_app', '--factory', '--host', '127.0.0.1', '--port', String(port)],
        {
          cwd: ROOT,
          detached: true,
          stdio: ['ignore', log, log],
          env: {
            ...process.env,
            AUTOCLIP_DESKTOP_MODE: '1',
            AUTOCLIP_MODE: 'desktop',
            AUTOCLIP_APP_DIR: process.env.AUTOCLIP_APP_DIR || path.join(ROOT, 'data'),
            AUTOCLIP_DATA_DIR: process.env.AUTOCLIP_DATA_DIR || path.join(ROOT, 'data'),
            DATABASE_URL: process.env.DATABASE_URL || `sqlite:///${path.join(ROOT, 'data', 'autoclip.db')}`,
            PYTHONPATH: ROOT,
            PYTHONUNBUFFERED: '1',
          },
        },
      )
      child.unref()
      console.log(`[autoclip] backend iniciado em http://127.0.0.1:${port}`)
    },
  }
}

/**
 * O arquivo .env da raiz não vai para o build publicado, então a conexão com o
 * Cloud ficava sem URL/chave e o login falhava ("indisponível neste endereço").
 * Aqui resolvemos os valores na ordem: .env → ambiente do build → valores
 * públicos do projeto (publicáveis por definição).
 */
const CLOUD_FALLBACKS: Record<string, string> = {
  VITE_SUPABASE_URL: 'https://c--452a92cf-a065-4be8-bc25-8c08c9c76b44-prod.lovable.cloud',
  VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_qsF5iYUZ1BDt3nH34QfJBQ_Z05qjiBC',
  VITE_SUPABASE_PROJECT_ID: 'alozbqulvxqgsczqhilb',
}

function cloudDefines(mode: string): Record<string, string> {
  const fileEnv = loadEnv(mode, ROOT, 'VITE_')
  const defines: Record<string, string> = {}
  for (const key of Object.keys(CLOUD_FALLBACKS)) {
    const value = fileEnv[key] || process.env[key] || CLOUD_FALLBACKS[key]
    defines[`import.meta.env.${key}`] = JSON.stringify(value)
  }
  return defines
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production'

  return {
    plugins: [react(), autoclipBackend()],
    base: isProduction ? './' : '/', // 生产环境使用相对路径
    optimizeDeps: {
      // '@tauri-apps/api/dialog' nao existe no Tauri v2 e fazia o pre-bundle falhar
      include: ['@tauri-apps/api']
    },
    build: {
      outDir: fileURLToPath(new URL('../dist', import.meta.url)),
      emptyOutDir: true,
      sourcemap: false,
      assetsInlineLimit: 4096,
      chunkSizeWarningLimit: 1600,
      rollupOptions: {
        external: [],
        // NOTE: do NOT hand-split React and antd into separate vendor chunks.
        // antd's top-level code calls React.createContext at module-eval time;
        // when React and antd are in different chunks, the chunk load order is
        // not guaranteed and antd can evaluate before React's CJS-interop is
        // initialized, leaving `React` undefined → "Cannot read properties of
        // undefined (reading 'createContext')" → blank/black screen. Letting
        // Rollup decide chunking keeps React's evaluation ordered correctly.
      },
      // 生产环境禁用 Service Worker
      serviceWorker: false
    },
    // As variáveis do Cloud (VITE_SUPABASE_*) vivem no .env da raiz do projeto.
    envDir: ROOT,
    // O .env não é publicado, então garantimos os valores públicos do Cloud no build.
    define: cloudDefines(mode),
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@cloud': path.join(ROOT, 'src', 'integrations'),
      },
    },
    server: {
      port: Number(process.env.FRONTEND_PORT || 8080),
      host: true,
      strictPort: false,
      fs: { allow: [ROOT] },
      hmr: {
        overlay: false // 禁用错误覆盖层
      },
      proxy: {
        '/api': {
          // Override when the desktop backend (random port) is running: BACKEND_URL=http://127.0.0.1:PORT npm run dev
          target: process.env.BACKEND_URL || 'http://127.0.0.1:8000',
          changeOrigin: true
        }
      }
    }
  }
})
