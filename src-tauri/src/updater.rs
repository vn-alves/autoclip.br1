//! Atualização dentro do app: baixa o instalador da release nova do GitHub e o aplica
//! sem o usuário precisar abrir o navegador nem reinstalar manualmente.
//! - Windows: baixa o instalador (.exe) e o executa por cima da instalação atual; o app fecha
//!   para liberar os arquivos e o instalador o reabre ao final.
//! - macOS: baixa o .dmg, monta, substitui o .app no mesmo lugar onde está instalado
//!   (normalmente /Applications), remove a quarentena e reabre o app.
use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Serialize)]
struct Progress {
    downloaded: u64,
    total: u64,
    stage: String,
}

fn emit(app: &AppHandle, downloaded: u64, total: u64, stage: &str) {
    let _ = app.emit(
        "update-progress",
        Progress { downloaded, total, stage: stage.to_string() },
    );
}

async fn download(app: &AppHandle, url: &str, dest: &PathBuf) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .user_agent("AutoClip-Desktop-Updater")
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Falha ao baixar a atualização: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("Falha ao baixar a atualização (HTTP {})", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(dest).map_err(|e| e.to_string())?;
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        if downloaded - last_emit > 512 * 1024 {
            last_emit = downloaded;
            emit(app, downloaded, total, "downloading");
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    emit(app, downloaded, total, "downloaded");
    Ok(())
}

#[tauri::command]
pub async fn download_and_install_update(
    app_handle: AppHandle,
    url: String,
    file_name: String,
) -> Result<(), String> {
    let safe_name: String = file_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if !url.starts_with("https://github.com/") && !url.starts_with("https://objects.githubusercontent.com/") {
        return Err("Endereço de atualização não permitido".into());
    }
    let dir = std::env::temp_dir().join("autoclip-update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&safe_name);
    download(&app_handle, &url, &dest).await?;
    emit(&app_handle, 0, 0, "installing");

    // Para o servidor interno antes de trocar os arquivos.
    {
        let backend_manager = app_handle.state::<crate::BackendManager>();
        let _ = backend_manager.stop();
    }

    install(&app_handle, &dest)?;
    // Dá tempo da interface mostrar "Instalando..." antes de fechar.
    std::thread::sleep(std::time::Duration::from_millis(800));
    app_handle.exit(0);
    Ok(())
}

#[cfg(target_os = "windows")]
fn install(_app: &AppHandle, installer: &PathBuf) -> Result<(), String> {
    // /P = modo passivo (só barra de progresso), /R = reabrir o app ao terminar.
    std::process::Command::new(installer)
        .args(["/P", "/R"])
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar o instalador: {}", e))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn install(_app: &AppHandle, dmg: &PathBuf) -> Result<(), String> {
    // Descobre onde o .app atual está instalado (…/AutoClip Desktop.app).
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let app_bundle = exe
        .ancestors()
        .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("/Applications/AutoClip Desktop.app"));
    let pid = std::process::id();
    let script = format!(
        r#"#!/bin/bash
set -e
DMG="{dmg}"
TARGET="{target}"
while kill -0 {pid} 2>/dev/null; do sleep 0.5; done
MNT=$(mktemp -d /tmp/autoclip-mnt.XXXX)
hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$MNT"
SRC=$(find "$MNT" -maxdepth 1 -name "*.app" | head -n 1)
if [ -n "$SRC" ]; then
  rm -rf "$TARGET.old"
  mv "$TARGET" "$TARGET.old" 2>/dev/null || true
  if ditto "$SRC" "$TARGET"; then
    rm -rf "$TARGET.old"
  else
    rm -rf "$TARGET"; mv "$TARGET.old" "$TARGET"
  fi
  xattr -cr "$TARGET" 2>/dev/null || true
fi
hdiutil detach "$MNT" -quiet || true
rm -f "$DMG"
open "$TARGET"
"#,
        dmg = dmg.display(),
        target = app_bundle.display(),
        pid = pid
    );
    let script_path = std::env::temp_dir().join("autoclip-update").join("install.sh");
    std::fs::write(&script_path, script).map_err(|e| e.to_string())?;
    std::process::Command::new("/bin/bash")
        .arg(&script_path)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Não foi possível iniciar a instalação: {}", e))?;
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn install(_app: &AppHandle, _file: &PathBuf) -> Result<(), String> {
    Err("Atualização automática disponível apenas no Windows e no macOS".into())
}
