/**
 * Config central dos links de download do app desktop — usada pela Landing Page e por
 * Configurações (SettingsPage). Única fonte, pra nunca ter duas URLs divergentes.
 *
 * Aponta para os instaladores da release mais recente (v1.9.3). Como o nome dos
 * artefatos embute a versão, estes links precisam ser atualizados a cada release
 * (ou o CI passa a publicar um asset com nome fixo por SO).
 */
export const RELEASES_URL = 'https://github.com/vn-alves/autoclip.br/releases/latest'

export const WINDOWS_DOWNLOAD_URL =
  'https://github.com/vn-alves/autoclip.br/releases/download/v1.9.3/AutoClip.Desktop_1.9.3_x64-setup.exe'
export const MACOS_DOWNLOAD_URL =
  'https://github.com/vn-alves/autoclip.br/releases/download/v1.9.3/AutoClip.Desktop_1.9.3_aarch64.dmg'
