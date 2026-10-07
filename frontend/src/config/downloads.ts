/**
 * Config central dos links de download do app desktop — usada pela Landing Page e por
 * Configurações (SettingsPage). Única fonte, pra nunca ter duas URLs divergentes.
 *
 * Os links apontam para a release MAIS RECENTE com nomes de arquivo fixos
 * (o workflow "Desktop Build" publica os instaladores como
 * AutoClip.Desktop_x64-setup.exe e AutoClip.Desktop_aarch64.dmg).
 * Assim, ao publicar uma tag nova (ex.: v1.9.10), estes botões passam a
 * baixar a versão nova automaticamente, sem editar o site.
 */
export const RELEASES_URL = 'https://github.com/vn-alves/autoclip.br/releases/latest'

export const WINDOWS_DOWNLOAD_URL =
  'https://github.com/vn-alves/autoclip.br/releases/latest/download/AutoClip.Desktop_x64-setup.exe'
export const MACOS_DOWNLOAD_URL =
  'https://github.com/vn-alves/autoclip.br/releases/latest/download/AutoClip.Desktop_aarch64.dmg'
