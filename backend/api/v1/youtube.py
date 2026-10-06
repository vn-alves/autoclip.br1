"""
YouTube相关API路由
处理YouTube视频解析和下载功能
"""

import logging
import re
from typing import Optional
from fastapi import APIRouter, HTTPException, Form, UploadFile, File
from pydantic import BaseModel
import sys
from pathlib import Path
sys.path.append(str(Path(__file__).parent.parent.parent))
from ...core.config import get_data_directory
import uuid
import asyncio
from datetime import datetime
from contextlib import contextmanager
import os
import yt_dlp

logger = logging.getLogger(__name__)
router = APIRouter()

# 存储下载任务的状态
download_tasks = {}

# Pedir muitos idiomas de legenda de uma vez causa HTTP 429 no YouTube e derruba o download
# inteiro. 'en' foi removido: _pick_portuguese_subtitle_file (abaixo) nunca aceita uma legenda
# baixada em inglês mesmo que ela exista, então pedi-la só aumentava a chance de 429 à toa —
# sem ela, se pt/pt-BR não existirem a transcrição cai no Whisper (que gera o idioma certo a
# partir do áudio real). Pode ser sobrescrito com AUTOCLIP_YT_SUBTITLE_LANGS (separado por vírgula).
DEFAULT_SUBTITLE_LANGS = ['pt', 'pt-BR']



def _final_videos(download_dir):
    """Só arquivos .mp4 finais (com áudio). Ignora fragmentos do yt-dlp tipo 'x.f137.mp4'
    (stream só de vídeo antes do merge) — pegá-los gerava cortes sem som."""
    import re as _re, subprocess as _sp
    from ...utils.ffmpeg_utils import get_ffprobe_path
    out = []
    for f in download_dir.glob("*.mp4"):
        if _re.search(r"\.f\d+\.mp4$", f.name) or f.name.endswith(".part"):
            continue
        try:
            r = _sp.run([get_ffprobe_path(), '-v', 'error', '-select_streams', 'a',
                         '-show_entries', 'stream=index', '-of', 'csv=p=0', str(f)],
                        capture_output=True, text=True, timeout=30)
            if r.returncode == 0 and not r.stdout.strip():
                logger.warning(f"Vídeo baixado sem áudio, descartando: {f.name}")
                f.unlink(missing_ok=True)
                continue
        except Exception:
            pass
        out.append(f)
    return out

def get_subtitle_langs() -> list:
    raw = os.getenv('AUTOCLIP_YT_SUBTITLE_LANGS', '')
    langs = [lang.strip() for lang in raw.split(',') if lang.strip()]
    return langs or list(DEFAULT_SUBTITLE_LANGS)


# Bug real (legenda do corte saindo em inglês mesmo em vídeo falado em português): o yt-dlp
# grava um arquivo .srt POR IDIOMA pedido que conseguir baixar (ex.: "Título.pt.srt",
# "Título.en.srt") — quando 'pt'/'pt-BR' não tem faixa automática disponível (comum) mas 'en'
# tem, e o código escolhia `subtitle_files[0]` (glob("*.srt")[0], ordem arbitrária do
# filesystem), podia pegar a legenda em inglês sem nenhum aviso, e pior: por já ter "achado uma
# legenda", pulava o fallback de Whisper inteiro (que transcreveria o áudio real, em português).
# Esta função só aceita um .srt baixado da PLATAFORMA se o nome do arquivo indicar
# português — qualquer outro idioma (inclusive inglês) é tratado como "sem legenda boa",
# deixando o Whisper (abaixo) gerar a transcrição de verdade a partir do áudio.
_PT_SUBTITLE_SUFFIX_RE = re.compile(r'\.(pt|pt-br)\.srt$', re.IGNORECASE)


def _pick_portuguese_subtitle_file(subtitle_files: list) -> Optional[str]:
    for f in subtitle_files:
        if _PT_SUBTITLE_SUFFIX_RE.search(str(f)):
            return str(f)
    return None


def _is_cookie_error(error: Exception) -> bool:
    """Detecta falhas causadas pela leitura de cookies do navegador.

    'cookiesfrombrowser' do yt-dlp lê direto o banco de cookies do navegador
    instalado na máquina. No Windows isso é frágil: navegador aberto (banco
    bloqueado), perfil ausente, ou peculiaridades do SQLite/DPAPI fazem o
    yt-dlp propagar um OSError genérico do sistema (ex.: "[Errno 22] Invalid
    argument") em vez de uma mensagem que mencione "cookie" — sem isso o
    fallback para "seguir sem cookies" nunca era acionado e a importação
    falhava de imediato.
    """
    text = str(error).lower()
    if 'cookie' in text or 'keyring' in text:
        return True
    return 'errno 22' in text or 'invalid argument' in text or 'winerror' in text


def _is_subtitle_error(error: Exception) -> bool:
    """Detecta falhas que vêm apenas do download das legendas."""
    text = str(error).lower()
    return 'subtitle' in text or 'subtitles' in text


def _drop_browser_cookies(ydl_opts: dict) -> None:
    ydl_opts.pop('cookiesfrombrowser', None)
    ydl_opts.pop('cookiefile', None)


from ...utils.yt_cookies import (  # noqa: E402
    cookies_status,
    delete_cookies,
    get_cookies_file,
    save_cookies_text,
)


def _apply_ffmpeg(ydl_opts: dict) -> None:
    """O yt-dlp só procura o ffmpeg no PATH. O app desktop traz o dele embutido e
    o expõe via AUTOCLIP_FFMPEG_PATH; sem repassar isso, juntar vídeo+áudio falha
    com "ffmpeg is not installed" mesmo com o ffmpeg instalado junto do app."""
    from ...utils.ffmpeg_utils import get_ffmpeg_path
    ffmpeg_path = get_ffmpeg_path()
    if ffmpeg_path and os.path.isfile(ffmpeg_path):
        ydl_opts['ffmpeg_location'] = ffmpeg_path


def _apply_cookies(ydl_opts: dict, browser: Optional[str] = None) -> None:
    """Cookies do YouTube: arquivo cookies.txt tem prioridade sobre o navegador.

    Em servidor sem navegador logado, 'cookiesfrombrowser' nunca funciona;
    o cookies.txt enviado pelo usuário é o caminho confiável.
    """
    cookies_file = get_cookies_file()
    if cookies_file:
        ydl_opts['cookiefile'] = cookies_file
    elif browser:
        ydl_opts['cookiesfrombrowser'] = (browser.lower(),)


# Clientes alternativos usados quando o YouTube pede verificação ("não sou um robô")
YT_CLIENT_FALLBACKS = ['web_safari', 'tv', 'android_vr', 'ios', 'mweb']


def _is_bot_check_error(error: Exception) -> bool:
    text = str(error).lower()
    return (
        'confirm you' in text
        or 'sign in to confirm' in text
        or 'not a bot' in text
        or 'needs to be reloaded' in text
        or 'requested format is not available' in text
    )


def _is_missing_ffmpeg_error(error: Exception) -> bool:
    text = str(error).lower()
    return 'ffmpeg' in text and 'not installed' in text


def _friendly_yt_error(error: Exception) -> str:
    if _is_missing_ffmpeg_error(error):
        return (
            "O ffmpeg não foi encontrado, então o vídeo e o áudio não puderam ser juntados. "
            "Reinstale o AutoClip ou instale o ffmpeg e tente de novo."
        )
    if _is_bot_check_error(error):
        if get_cookies_file():
            return (
                "O YouTube recusou este vídeo mesmo usando os cookies enviados. "
                "Eles podem ter expirado: exporte um cookies.txt novo (estando logado no YouTube) "
                "e envie de novo, ou importe o arquivo de vídeo direto do seu computador."
            )
        return (
            "O YouTube está pedindo verificação para este vídeo a partir deste servidor. "
            "Envie um arquivo cookies.txt de uma conta logada do YouTube na tela de importação "
            "para liberar o download, ou importe o arquivo de vídeo direto do seu computador."
        )
    return str(error)



def _with_client(ydl_opts: dict, client: str) -> dict:
    opts = dict(ydl_opts)
    opts['extractor_args'] = {'youtube': {'player_client': [client]}}
    return opts





@contextmanager
def sanitized_yt_env():
    """临时清理与 yt-dlp 相关的环境变量，避免外部配置影响行为"""
    original_env = os.environ.copy()
    try:
        for key in list(os.environ.keys()):
            upper_key = key.upper()
            if upper_key.startswith("YT_DLP") or upper_key.startswith("YTDL") or upper_key.startswith("YOUTUBE_DL") or upper_key.startswith("YOUTUBEDL"):
                os.environ.pop(key, None)
        yield
    finally:
        os.environ.clear()
        os.environ.update(original_env)

class YouTubeParseRequest(BaseModel):
    url: str
    browser: Optional[str] = None

class YouTubeDownloadRequest(BaseModel):
    url: str
    project_name: str
    video_category: Optional[str] = "default"
    browser: Optional[str] = None
    # Escolhas opcionais da tela de importação; None = deixa o profile automático
    # (duração do vídeo) decidir, como sempre foi.
    target_clip_seconds: Optional[int] = None
    clip_count: Optional[int] = None

class YouTubeVideoInfo(BaseModel):
    title: str
    description: str
    duration: int
    uploader: str
    upload_date: str
    view_count: int
    like_count: int
    thumbnail: str

class YouTubeDownloadTask(BaseModel):
    id: str
    url: str
    project_name: str
    video_category: str
    status: str  # pending, processing, completed, failed
    progress: float
    error_message: Optional[str] = None
    project_id: Optional[str] = None
    created_at: str
    updated_at: str


@router.get("/cookies")
async def get_youtube_cookies_status():
    """Situação atual dos cookies do YouTube usados no download."""
    return {"success": True, **cookies_status()}


@router.post("/cookies")
async def upload_youtube_cookies(
    file: Optional[UploadFile] = File(None),
    content: Optional[str] = Form(None),
):
    """Recebe um cookies.txt (Netscape) exportado de uma conta logada do YouTube."""
    text = content or ''
    if file is not None:
        raw = await file.read()
        if len(raw) > 2 * 1024 * 1024:
            raise HTTPException(status_code=400, detail="O arquivo de cookies é muito grande (máximo 2 MB).")
        text = raw.decode('utf-8', errors='ignore')

    if not text.strip():
        raise HTTPException(status_code=400, detail="Envie o arquivo cookies.txt ou cole o conteúdo dele.")

    ok, detail = save_cookies_text(text)
    if not ok:
        raise HTTPException(status_code=400, detail=detail)

    return {"success": True, "message": detail, **cookies_status()}


@router.delete("/cookies")
async def delete_youtube_cookies():
    """Remove os cookies salvos do YouTube."""
    removed = delete_cookies()
    return {
        "success": True,
        "message": "Cookies removidos." if removed else "Não havia cookies salvos.",
        **cookies_status(),
    }


@router.post("/parse")
async def parse_youtube_video(
    url: str = Form(...),
    browser: Optional[str] = Form(None),
    client: Optional[str] = Form(None)
):
    """解析YouTube视频信息"""
    try:
        logger.info(f"开始解析YouTube视频: {url}")
        
        # 简单的URL验证
        if "youtube.com" not in url and "youtu.be" not in url:
            raise HTTPException(status_code=400, detail="Link do YouTube inválido")
        
        # 记录版本信息，便于排查
        try:
            logger.info(f"yt-dlp={yt_dlp.version.__version__}, py={sys.executable}")
        except Exception:
            pass

        # 使用 subprocess 直接调用 yt-dlp 命令行工具，避免 Python 环境配置影响
        import subprocess
        import json
        import asyncio
        
        def extract_info_sync(url, browser, client_override=None, skip_cookies=False):
            # 用当前解释器的 yt_dlp 模块，保证与后端运行环境（venv / Docker / 桌面便携 Python）一致
            cmd = [
                sys.executable, '-m', 'yt_dlp',
                '--ignore-config',
                '--no-warnings',
                '--no-playlist',
                '--dump-json',
                '--skip-download',  # 修正参数名
                '--no-cache-dir'
            ]

            cookies_file = None if skip_cookies else get_cookies_file()
            if cookies_file:
                cmd.extend(['--cookies', cookies_file])
            elif browser and not skip_cookies:
                cmd.extend(['--cookies-from-browser', browser.lower()])

            # 可选兜底客户端，规避 SABR / 机器人验证
            yt_client = (client_override or client or os.getenv('AUTOCLIP_YT_CLIENT', '')).strip().lower()
            if yt_client:
                cmd.extend(['--extractor-args', f"youtube:player_client={yt_client}"])

            
            cmd.append(url)
            
            try:
                # 执行命令（清理环境变量，避免 YT_* 影响）
                env = os.environ.copy()
                for k in list(env.keys()):
                    uk = k.upper()
                    if uk.startswith('YT_DLP') or uk.startswith('YTDL') or uk.startswith('YOUTUBE_DL') or uk.startswith('YOUTUBEDL'):
                        env.pop(k, None)

                logger.info(f"执行命令: {' '.join(cmd)}")
                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=60,
                    cwd=str(get_data_directory()),
                    env=env
                )

                logger.info(f"命令返回码: {result.returncode}")
                logger.info(f"命令输出(前200字): {result.stdout[:200]}...")
                if result.stderr:
                    logger.info(f"命令错误: {result.stderr}")

                if result.returncode != 0:
                    raise Exception(f"yt-dlp failed: {result.stderr or result.stdout}")

                # 解析 JSON 输出
                info_dict = json.loads(result.stdout)
                return info_dict
                
            except subprocess.TimeoutExpired:
                raise Exception("yt-dlp timeout")
            except json.JSONDecodeError as e:
                raise Exception(f"Failed to parse yt-dlp output: {e}")
            except Exception as e:
                raise Exception(f"yt-dlp execution failed: {e}")
        
        loop = asyncio.get_event_loop()
        try:
            info_dict = await loop.run_in_executor(None, extract_info_sync, url, browser)
        except Exception as e:
            if (browser or get_cookies_file()) and _is_cookie_error(e):
                logger.warning(f"Cookies indisponíveis/inválidos no servidor, tentando sem cookies: {e}")
                try:
                    info_dict = await loop.run_in_executor(None, extract_info_sync, url, None, None, True)
                except Exception as retry_error:
                    e = retry_error
                    info_dict = None
            else:
                info_dict = None

            if info_dict is None:
                if not _is_bot_check_error(e):
                    raise
                # O YouTube pediu verificação: tenta os clientes alternativos
                last_error = e
                for fallback in YT_CLIENT_FALLBACKS:
                    try:
                        logger.warning(f"YouTube pediu verificação, tentando cliente alternativo: {fallback}")
                        info_dict = await loop.run_in_executor(None, extract_info_sync, url, None, fallback)
                        last_error = None
                        break
                    except Exception as fallback_error:
                        last_error = fallback_error
                if last_error:
                    raise Exception(_friendly_yt_error(last_error))

        
        logger.info(f"YouTube视频信息解析成功: {info_dict.get('title', 'Unknown')}")
        
        return {
            "success": True,
            "video_info": {
                "title": info_dict.get('title', 'Unknown'),
                "description": info_dict.get('description', ''),
                "duration": info_dict.get('duration', 0) or 0,
                "uploader": info_dict.get('uploader', 'Unknown'),
                "upload_date": info_dict.get('upload_date', ''),
                "view_count": info_dict.get('view_count', 0),
                "like_count": info_dict.get('like_count', 0),
                "thumbnail": info_dict.get('thumbnail', '')
            }
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"解析YouTube视频失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Não foi possível ler o vídeo: {str(e)}")


@router.post("/download")
async def create_youtube_download_task(request: YouTubeDownloadRequest):
    """创建YouTube视频下载任务 - 立即创建项目"""
    try:
        logger.info(f"创建YouTube下载任务: {request.url}")
        
        # 先获取视频信息以获取缩略图
        import yt_dlp
        import asyncio
        
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'ignoreconfig': True,
            'noplaylist': True,
            'config_locations': [],
            'cachedir': False,
        }
        
        _apply_cookies(ydl_opts, request.browser)

        # 可选兜底客户端
        yt_client_env = os.getenv('AUTOCLIP_YT_CLIENT', '').strip().lower()
        if yt_client_env in {"android", "ios", "tv"}:
            ydl_opts.setdefault('extractor_args', {}).setdefault('youtube', {}).setdefault('player_client', []).append(yt_client_env)

        def extract_info_sync(url, ydl_opts):
            with sanitized_yt_env():
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    return ydl.extract_info(url, download=False)
        
        loop = asyncio.get_event_loop()
        video_info = None
        info_error = None
        try:
            video_info = await loop.run_in_executor(None, extract_info_sync, request.url, ydl_opts)
        except Exception as e:
            info_error = e
            if (request.browser or 'cookiefile' in ydl_opts) and _is_cookie_error(e):
                logger.warning(f"Cookies indisponíveis/inválidos no servidor, seguindo sem cookies: {e}")
                _drop_browser_cookies(ydl_opts)
                try:
                    video_info = await loop.run_in_executor(None, extract_info_sync, request.url, ydl_opts)
                    info_error = None
                except Exception as retry_error:
                    info_error = retry_error

        if video_info is None and info_error is not None:
            if not _is_bot_check_error(info_error):
                raise Exception(_friendly_yt_error(info_error))
            for fallback in YT_CLIENT_FALLBACKS:
                try:
                    logger.warning(f"YouTube pediu verificação, tentando cliente alternativo: {fallback}")
                    video_info = await loop.run_in_executor(
                        None, extract_info_sync, request.url, _with_client(ydl_opts, fallback)
                    )
                    info_error = None
                    break
                except Exception as fallback_error:
                    info_error = fallback_error
            if info_error:
                raise Exception(_friendly_yt_error(info_error))


        
        # 立即创建项目记录
        from ...core.database import SessionLocal
        from ...services.project_service import ProjectService
        from ...schemas.project import ProjectCreate, ProjectType, ProjectStatus
        
        db = SessionLocal()
        try:
            project_service = ProjectService(db)
            
            # 处理缩略图 - 直接使用解析出来的封面图
            thumbnail_data = None
            thumbnail_url = video_info.get('thumbnail', '')
            if thumbnail_url:
                try:
                    import requests
                    import base64

                    # requests.get é bloqueante — sem run_in_executor, prende o event loop do
                    # FastAPI (até 10s, o timeout) toda vez que alguém cria um projeto por link,
                    # atrasando/travando outras requisições em andamento nesse meio-tempo.
                    response = await loop.run_in_executor(None, lambda: requests.get(thumbnail_url, timeout=10))
                    if response.status_code == 200:
                        # 转换为base64
                        thumbnail_base64 = base64.b64encode(response.content).decode('utf-8')
                        thumbnail_data = f"data:image/jpeg;base64,{thumbnail_base64}"
                        logger.info(f"YouTube缩略图获取成功: {video_info.get('title', 'Unknown')}")
                    else:
                        logger.warning(f"下载YouTube缩略图失败: {response.status_code}")
                except Exception as e:
                    logger.error(f"处理YouTube缩略图失败: {e}")
                    # 缩略图处理失败不影响主流程
            
            # 创建项目数据
            project_data = ProjectCreate(
                name=request.project_name,
                description=f"从YouTube下载: {video_info.get('title', 'Unknown')}",
                project_type=ProjectType(request.video_category),
                status=ProjectStatus.PENDING,  # 初始状态为等待中
                source_url=request.url,
                source_file=None,  # 暂时为空，下载完成后更新
                settings={
                    "download_status": "downloading",
                    "download_progress": 0.0,
                    "youtube_info": {
                        "url": request.url,
                        "browser": request.browser,
                        "title": video_info.get('title', 'Unknown'),
                        "uploader": video_info.get('uploader', 'Unknown'),
                        "duration": video_info.get('duration', 0),
                        "view_count": video_info.get('view_count', 0),
                        "thumbnail_url": thumbnail_url
                    },
                    "clip_options": {
                        "target_clip_seconds": request.target_clip_seconds,
                        "clip_count": request.clip_count,
                    },
                }
            )
            
            project = project_service.create_project(project_data)
            project_id = str(project.id)
            
            # 设置缩略图
            if thumbnail_data:
                project.thumbnail = thumbnail_data
                db.commit()
                logger.info(f"项目 {project_id} 缩略图已设置")
            
            # 创建项目目录
            from ...core.path_utils import get_project_directory
            project_dir = get_project_directory(project_id)
            raw_dir = project_dir / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            
            logger.info(f"项目已创建: {project_id}")
            
            # 生成下载任务ID
            task_id = str(uuid.uuid4())
            
            # 创建任务记录
            task = YouTubeDownloadTask(
                id=task_id,
                url=request.url,
                project_name=request.project_name,
                video_category=request.video_category,
                status="pending",
                progress=0.0,
                project_id=project_id,  # 关联项目ID
                created_at=str(uuid.uuid1().time),
                updated_at=str(uuid.uuid1().time)
            )
            
            # 存储任务
            download_tasks[task_id] = task
            
            # 异步启动下载任务 - 使用安全的任务管理器
            from .async_task_manager import task_manager
            await task_manager.create_safe_task(
                f"youtube_download_{task_id}", 
                process_youtube_download_task, 
                task_id, 
                request, 
                project_id
            )
            
            # 返回项目信息而不是任务信息
            return {
                "project_id": project_id,
                "task_id": task_id,
                "status": "created",
                "message": "Projeto criado, baixando o vídeo..."
            }
            
        finally:
            db.close()
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"创建YouTube下载任务失败: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Não foi possível iniciar a importação: {str(e)}")


@router.get("/tasks/{task_id}")
async def get_youtube_task_status(task_id: str):
    """获取YouTube下载任务状态"""
    if task_id not in download_tasks:
        raise HTTPException(status_code=404, detail="Tarefa não encontrada")
    
    return download_tasks[task_id]

@router.get("/tasks")
async def get_all_youtube_tasks():
    """获取所有YouTube下载任务"""
    return list(download_tasks.values())

async def update_project_download_progress(project_id: str, progress: float, message: str):
    """更新项目下载进度"""
    try:
        from ...core.database import SessionLocal
        from ...services.project_service import ProjectService
        
        db = SessionLocal()
        try:
            project_service = ProjectService(db)
            project = project_service.get(project_id)
            
            if project:
                # 更新项目设置中的下载进度
                if not project.processing_config:
                    project.processing_config = {}
                
                project.processing_config.update({
                    "download_progress": progress,
                    "download_message": message
                })
                
                # 如果进度达到100%，更新状态为等待处理
                if progress >= 100.0:
                    from ...schemas.project import ProjectStatus
                    project.status = ProjectStatus.PENDING
                
                db.commit()
                logger.info(f"项目 {project_id} 下载进度更新: {progress}% - {message}")
                
        finally:
            db.close()
            
    except Exception as e:
        logger.error(f"更新项目下载进度失败: {e}")

async def process_youtube_download_task(task_id: str, request: YouTubeDownloadRequest, project_id: str):
    """处理YouTube下载任务"""
    try:
        # 更新任务状态为处理中
        download_tasks[task_id].status = "processing"
        download_tasks[task_id].progress = 10.0
        
        # 更新项目状态和进度
        await update_project_download_progress(project_id, 10.0, "正在获取视频信息...")
        
        # 使用yt-dlp下载视频
        import yt_dlp
        import asyncio
        from ...core.config import get_data_directory
        
        data_dir = get_data_directory()
        download_dir = data_dir / "temp"
        download_dir.mkdir(exist_ok=True)
        
        # 更新项目进度
        await update_project_download_progress(project_id, 30.0, "正在下载视频...")
        
        # 设置下载选项
        _MAXH = int(os.getenv('AUTOCLIP_MAX_VIDEO_HEIGHT', '720') or 720)
        ydl_opts = {
            # Não fixar o áudio em [ext=m4a]: o YouTube responde 403 para o áudio m4a direto
            # (exige token de origem), enquanto o opus/webm baixa normalmente. Sem teto de
            # altura o seletor antigo pegava AV1 2160p, pesado demais para baixar e cortar.
            'format': (
                f'bestvideo[height<={_MAXH}][vcodec^=avc1]+bestaudio'
                f'/bestvideo[height<={_MAXH}]+bestaudio'
                f'/best[height<={_MAXH}][acodec!=none]/best'
            ),
            'merge_output_format': 'mp4',
            'writesubtitles': True,
            'writeautomaticsub': True,  # 下载自动生成的字幕
            'subtitleslangs': get_subtitle_langs(),
            'subtitlesformat': 'srt',
            'outtmpl': str(download_dir / '%(title)s.%(ext)s'),
            'noplaylist': True,
            'quiet': True,
            'no_warnings': False,  # 显示警告信息以便调试
            'ignoreconfig': True,
            'config_locations': [],
            'cachedir': False,
        }

        _apply_cookies(ydl_opts, request.browser)
        _apply_ffmpeg(ydl_opts)

        # 可选兜底客户端
        yt_client_env = os.getenv('AUTOCLIP_YT_CLIENT', '').strip().lower()
        if yt_client_env in {"android", "ios", "tv"}:
            ydl_opts.setdefault('extractor_args', {}).setdefault('youtube', {}).setdefault('player_client', []).append(yt_client_env)

        def download_sync(url, ydl_opts):
            with sanitized_yt_env():
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    return ydl.download([url])

        loop = asyncio.get_event_loop()

        # O servidor pode não ter navegador instalado e as legendas do YouTube podem falhar (HTTP 429).
        # Nenhuma dessas situações deve impedir o download do vídeo: a legenda é gerada depois.
        attempts = [dict(ydl_opts)]
        if 'cookiesfrombrowser' in ydl_opts or 'cookiefile' in ydl_opts:
            without_cookies = dict(ydl_opts)
            _drop_browser_cookies(without_cookies)
            attempts.append(without_cookies)
        no_subs = dict(attempts[-1])
        no_subs['writesubtitles'] = False
        no_subs['writeautomaticsub'] = False
        attempts.append(no_subs)

        # Quando o YouTube pede verificação, tenta clientes alternativos
        for fallback in YT_CLIENT_FALLBACKS:
            attempts.append(_with_client(no_subs, fallback))

        last_error = None
        attempt_errors = []
        for index, attempt_opts in enumerate(attempts):
            try:
                await loop.run_in_executor(None, download_sync, request.url, attempt_opts)
                last_error = None
                break
            except Exception as attempt_error:
                last_error = attempt_error
                attempt_errors.append(attempt_error)
                logger.warning(f"Tentativa {index + 1} de download falhou: {attempt_error}")
                if _final_videos(download_dir):
                    # O vídeo já veio; só a legenda falhou.
                    last_error = None
                    break
        if last_error and not _final_videos(download_dir):
            # As tentativas com outros "clients" repetem um erro genérico de formato; o
            # motivo real (ex.: ffmpeg ausente) fica numa tentativa anterior.
            root_error = next((e for e in attempt_errors if _is_missing_ffmpeg_error(e)), last_error)
            raise Exception(_friendly_yt_error(root_error))



        
        # 查找下载的文件
        video_files = _final_videos(download_dir)
        if not video_files:
            # Última chance: formato único com áudio e vídeo juntos.
            try:
                single = dict(no_subs); single['format'] = 'best[acodec!=none][vcodec!=none]/best'
                await loop.run_in_executor(None, download_sync, request.url, single)
            except Exception as e:
                logger.warning(f"Download com formato único falhou: {e}")
            video_files = _final_videos(download_dir)
        subtitle_files = list(download_dir.glob("*.srt"))
        
        if not video_files:
            raise Exception("O arquivo de vídeo baixado não foi encontrado")
        
        video_path = str(video_files[0])
        # Ver _pick_portuguese_subtitle_file: só aceita a legenda baixada da plataforma se for
        # em português — qualquer outra (inglês incluso) vira "sem legenda" pra cair no
        # fallback de Whisper (abaixo), que transcreve o áudio real em vez de usar um idioma
        # errado.
        subtitle_path = _pick_portuguese_subtitle_file(subtitle_files) or ""
        
        download_tasks[task_id].progress = 80.0
        
        # 更新项目进度
        await update_project_download_progress(project_id, 60.0, "视频下载完成，正在处理字幕...")
        
        # 如果没有字幕文件，优先使用Whisper生成字幕
        if not subtitle_path:
            logger.info("优先使用Whisper生成高质量字幕")
            # 更新项目进度
            await update_project_download_progress(project_id, 70.0, "正在使用Whisper生成字幕...")
            
            try:
                from ...utils.speech_recognizer import generate_subtitle_for_video, SpeechRecognitionError
                video_file_path = Path(video_path)
                
                # 根据视频信息选择合适的模型
                model = os.getenv("AUTOCLIP_WHISPER_MODEL", "tiny")  # tiny: ~5x mais rápido que base
                language = "auto"  # 默认自动检测语言
                
                # 可以根据视频标题判断内容类型
                # 这里可以添加更智能的内容类型判断逻辑
                
                logger.info(f"使用Whisper生成字幕 - 语言: {language}, 模型: {model}")

                # Bug real ("importação trava em algum % e nunca sai disso" quando há mais de
                # um vídeo/usuário ao mesmo tempo): generate_subtitle_for_video roda a
                # transcrição do Whisper de forma SÍNCRONA — pra um vídeo de alguns minutos
                # isso pode levar bem mais de 10 minutos de CPU. Chamado direto (sem
                # run_in_executor) dentro desta função async, ele bloqueia o event loop
                # inteiro do FastAPI por todo esse tempo: nenhuma outra requisição roda
                # nesse meio-tempo — nem o polling de progresso de OUTRO projeto, nem o
                # início de OUTRO download —, dando exatamente a impressão de "travado".
                # O download em si já roda certo, via run_in_executor (ver acima); a
                # transcrição precisa do mesmo tratamento.
                generated_subtitle = await loop.run_in_executor(
                    None, lambda: generate_subtitle_for_video(video_file_path, language=language, model=model)
                )
                subtitle_path = str(generated_subtitle)
                logger.info(f"Whisper字幕生成成功: {subtitle_path}")
                
                # 更新项目进度
                await update_project_download_progress(project_id, 90.0, "字幕生成完成，正在准备处理...")
                
            except SpeechRecognitionError as e:
                logger.error(f"Whisper字幕生成失败: {e}")
                # Whisper失败时，尝试多种策略获取平台字幕作为备用
                logger.info("尝试下载平台字幕作为备用方案")
                try:
                    subtitle_path = await _try_youtube_subtitle_strategies(request.url, download_dir, request.browser)
                    if subtitle_path:
                        logger.info(f"备用字幕获取成功: {subtitle_path}")
                    else:
                        logger.warning("所有字幕获取策略都失败了")
                        subtitle_path = None  # 确保字幕路径为空，后续会标记项目失败
                except Exception as backup_error:
                    logger.error(f"备用字幕获取也失败: {backup_error}")
                    subtitle_path = None  # 确保字幕路径为空，后续会标记项目失败
            except Exception as e:
                logger.error(f"Falha inesperada ao gerar a legenda: {e}")
                # Tenta as legendas públicas da plataforma antes de desistir
                try:
                    subtitle_path = await _try_youtube_subtitle_strategies(request.url, download_dir, None)
                    if subtitle_path:
                        logger.info(f"备用字幕获取成功: {subtitle_path}")
                    else:
                        subtitle_path = None
                except Exception as backup_error:
                    logger.error(f"备用字幕获取也失败: {backup_error}")
                    subtitle_path = None

        
        logger.info(f"下载完成 - 视频文件: {video_path}, 字幕文件: {subtitle_path}")
        
        # 更新项目信息（项目已在开始时创建）
        from ...services.project_service import ProjectService
        from ...core.database import SessionLocal
        
        db = SessionLocal()
        try:
            project_service = ProjectService(db)
            
            # 获取已创建的项目
            project = project_service.get(project_id)
            if not project:
                raise Exception(f"项目 {project_id} 不存在")
            
            # 更新项目信息
            project.description = f"从YouTube下载: {request.project_name}"
            # 注意：不要在这里设置video_path，等文件移动完成后再设置
            
            # 更新项目设置
            if not project.processing_config:
                project.processing_config = {}
            
            project.processing_config.update({
                "youtube_info": {
                    "title": request.project_name,
                    "uploader": "YouTube",
                    "duration": 0,
                    "view_count": 0,
                    "like_count": 0
                },
                "subtitle_path": subtitle_path,
                "download_status": "completed",
                "download_progress": 100.0
            })
            
            # 移动文件到项目目录
            from ...core.path_utils import get_project_directory
            project_dir = get_project_directory(project_id)
            raw_dir = project_dir / "raw"
            raw_dir.mkdir(parents=True, exist_ok=True)
            
            # 移动视频文件到项目目录
            import shutil

            
            if video_path:
                video_file_path = Path(video_path)
                if video_file_path.exists():
                    # 重命名视频文件为input.mp4
                    new_video_path = raw_dir / "input.mp4"
                    shutil.move(str(video_file_path), str(new_video_path))
                    logger.info(f"视频文件已移动到: {new_video_path}")
                    
                    # 更新项目中的视频路径
                    project.video_path = str(new_video_path)
            
            # 移动字幕文件到项目目录
            if subtitle_path:
                subtitle_file_path = Path(subtitle_path)
                if subtitle_file_path.exists():
                    # 重命名字幕文件为input.srt
                    new_subtitle_path = raw_dir / "input.srt"
                    shutil.move(str(subtitle_file_path), str(new_subtitle_path))
                    logger.info(f"字幕文件已移动到: {new_subtitle_path}")
                    
                    # 更新项目处理配置中的字幕路径
                    if not project.processing_config:
                        project.processing_config = {}
                    project.processing_config["subtitle_path"] = str(new_subtitle_path)
            
            # 保存项目更新
            db.commit()
            
            # 检查字幕文件是否存在，如果不存在则标记项目为失败
            srt_file_path = raw_dir / "input.srt"
            if not srt_file_path.exists():
                logger.error(f"字幕文件不存在: {srt_file_path}，项目将标记为失败状态")
                from ...schemas.project import ProjectStatus
                project.status = ProjectStatus.FAILED
                if not project.processing_config:
                    project.processing_config = {}
                project.processing_config["error_message"] = "Não foi possível obter nem gerar a legenda do vídeo"
                db.commit()
                
                # 更新任务状态为失败
                download_tasks[task_id].status = "failed"
                download_tasks[task_id].error_message = "Não foi possível obter nem gerar a legenda do vídeo"
                download_tasks[task_id].progress = 0.0
                download_tasks[task_id].project_id = str(project.id)
                download_tasks[task_id].updated_at = datetime.now().isoformat()
                
                # 更新项目下载进度为失败
                await update_project_download_progress(project_id, 0.0, "Falha na importação: não foi possível obter a legenda")
                
                logger.info(f"YouTube下载任务失败: {task_id}, 项目ID: {project.id}, 原因: 字幕文件不存在")
                return
            
            # 更新项目下载进度为完成
            await update_project_download_progress(project_id, 100.0, "下载完成，准备开始处理")
            
            # 更新任务状态
            download_tasks[task_id].status = "completed"
            download_tasks[task_id].progress = 100.0
            download_tasks[task_id].project_id = str(project.id)
            download_tasks[task_id].updated_at = datetime.now().isoformat()
            
            logger.info(f"YouTube下载任务完成: {task_id}, 项目ID: {project.id}")
            
            # 自动启动处理流程
            try:
                # 更新项目状态为等待处理
                from ...schemas.project import ProjectStatus
                project.status = ProjectStatus.PENDING  # 改为PENDING，让自动化服务启动
                db.commit()
                
                logger.info(f"YouTube项目 {project.id} 下载完成，等待自动化流水线启动")
                
                # 异步启动自动化流水线
                import asyncio
                from ...services.auto_pipeline_service import auto_pipeline_service
                
                # 使用create_task在已运行的事件循环中执行
                try:
                    loop = asyncio.get_running_loop()
                    # 在已运行的事件循环中创建任务
                    task = loop.create_task(
                        auto_pipeline_service.auto_start_pipeline(str(project.id))
                    )
                    # 等待任务完成
                    pipeline_result = await task
                except RuntimeError:
                    # 如果没有运行的事件循环，创建新的
                    pipeline_result = await auto_pipeline_service.auto_start_pipeline(str(project.id))
                
                if pipeline_result['status'] == 'started':
                    logger.info(f"YouTube项目 {project.id} 自动化流水线已启动: {pipeline_result}")
                else:
                    logger.warning(f"YouTube项目 {project.id} 自动化流水线启动结果: {pipeline_result}")
                
            except Exception as e:
                logger.error(f"启动YouTube项目 {project.id} 自动化流水线失败: {str(e)}")
                # 即使处理启动失败，也要返回下载成功
                # 用户可以通过重试按钮重新启动处理
            
        except Exception as e:
            logger.error(f"创建项目失败: {str(e)}")
            # 即使处理启动失败，也要返回下载成功
            # 用户可以通过重试按钮重新启动处理
            
        finally:
            db.close()
            
    except Exception as e:
        logger.error(f"处理下载任务失败: {str(e)}")
        download_tasks[task_id].status = "failed"
        download_tasks[task_id].error_message = _friendly_yt_error(e)
        download_tasks[task_id].progress = 0.0
        download_tasks[task_id].updated_at = datetime.now().isoformat()

        # Marca o projeto como falho para a importação não ficar "importando" para sempre
        try:
            from backend.core.database import SessionLocal
            from backend.services.project_service import ProjectService
            db_fail = SessionLocal()
            try:
                ProjectService(db_fail).update_project_status(project_id, "failed")
            finally:
                db_fail.close()
        except Exception as status_error:
            logger.error(f"Não foi possível marcar o projeto como falho: {status_error}")



async def _try_youtube_subtitle_strategies(url: str, download_dir: Path, browser: Optional[str] = None) -> str:
    """尝试多种YouTube字幕获取策略"""
    strategies = [
        lambda: _try_download_with_different_formats(url, download_dir, browser),
        lambda: _try_download_with_different_langs(url, download_dir, browser),
        lambda: _try_extract_from_metadata(url, download_dir, browser)
    ]
    
    for strategy in strategies:
        try:
            subtitle_path = await strategy()
            if subtitle_path:
                logger.info(f"YouTube备用字幕策略成功")
                return subtitle_path
        except Exception as e:
            logger.warning(f"YouTube备用字幕策略失败: {e}")
            continue
    
    logger.warning("所有YouTube字幕获取策略都失败了")
    return ""


async def _try_download_with_different_formats(url: str, download_dir: Path, browser: Optional[str] = None) -> str:
    """尝试下载不同格式的字幕"""
    import asyncio
    logger.info("尝试下载不同格式的YouTube字幕...")
    
    formats = ['srt', 'vtt', 'json3']
    
    for fmt in formats:
        try:
            ydl_opts = {
                'format': 'best[ext=mp4]/best',
                'writesubtitles': True,
                'writeautomaticsub': True,
                'subtitleslangs': get_subtitle_langs(),
                'subtitlesformat': fmt,
                'outtmpl': str(download_dir / f'subtitle_%(title)s.%(ext)s'),
                'noplaylist': True,
                'quiet': True,
                'ignoreconfig': True,
                'config_locations': [],
            }
            
            _apply_cookies(ydl_opts, browser)
            
            def download_sync(url, ydl_opts):
                with sanitized_yt_env():
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        return ydl.download([url])
            
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, download_sync, url, ydl_opts)
            
            # 查找下载的字幕文件
            subtitle_files = list(download_dir.glob(f"*.{fmt}"))
            if subtitle_files:
                subtitle_path = str(subtitle_files[0])
                
                # 如果是VTT格式，转换为SRT
                if fmt == 'vtt':
                    srt_path = subtitle_path.replace('.vtt', '.srt')
                    await _convert_vtt_to_srt(subtitle_path, srt_path)
                    return srt_path
                
                return subtitle_path
                
        except Exception as e:
            logger.debug(f"尝试格式 {fmt} 失败: {e}")
            continue
    
    return ""


async def _try_download_with_different_langs(url: str, download_dir: Path, browser: Optional[str] = None) -> str:
    """尝试下载不同语言的字幕"""
    import asyncio
    logger.info("尝试下载不同语言的YouTube字幕...")
    
    # Bug real: legenda em chinês aparecendo em vídeos que não são chineses. YouTube serve
    # faixas de legenda automática TRADUZIDAS pra qualquer idioma pedido (writeautomaticsub +
    # subtitleslangs não exige que o idioma pedido bata com o do vídeo) — antes esta lista
    # incluía zh-Hans/zh/ja/ko como fallback "pra tentar qualquer coisa", e esse fallback só é
    # acionado quando Whisper falha (ver _try_youtube_subtitle_strategies), então o resultado
    # era uma legenda real, porém traduzida errado pra chinês/japonês/coreano, sendo queimada
    # no vídeo como se fosse o texto certo. Restrito aos idiomas que este app realmente usa
    # (mesma lista de get_subtitle_langs) — sem tentar línguas que o usuário nunca pediu.
    lang_combinations = [list(get_subtitle_langs()), ['auto']]
    
    for langs in lang_combinations:
        try:
            ydl_opts = {
                'format': 'best[ext=mp4]/best',
                'writesubtitles': True,
                'writeautomaticsub': True,
                'subtitleslangs': langs,
                'subtitlesformat': 'srt',
                'outtmpl': str(download_dir / f'lang_%(title)s.%(ext)s'),
                'noplaylist': True,
                'quiet': True,
                'ignoreconfig': True,
                'config_locations': [],
            }
            
            _apply_cookies(ydl_opts, browser)
            
            def download_sync(url, ydl_opts):
                with sanitized_yt_env():
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        return ydl.download([url])
            
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, download_sync, url, ydl_opts)
            
            # 查找下载的字幕文件
            subtitle_files = list(download_dir.glob("*.srt"))
            if subtitle_files:
                return str(subtitle_files[0])
                
        except Exception as e:
            logger.debug(f"尝试语言 {langs} 失败: {e}")
            continue
    
    return ""


async def _try_extract_from_metadata(url: str, download_dir: Path, browser: Optional[str] = None) -> str:
    """尝试从视频元数据中提取字幕信息"""
    import asyncio
    logger.info("尝试从YouTube视频元数据提取字幕信息...")
    
    try:
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'ignoreconfig': True,
            'config_locations': [],
        }
        
        _apply_cookies(ydl_opts, browser)

        def extract_info_sync(url, ydl_opts):
            with sanitized_yt_env():
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    return ydl.extract_info(url, download=False)
        
        loop = asyncio.get_event_loop()
        info_dict = await loop.run_in_executor(None, extract_info_sync, url, ydl_opts)
        
        # 检查是否有字幕信息
        subtitles = info_dict.get('subtitles', {})
        auto_subtitles = info_dict.get('automatic_captions', {})
        
        if subtitles or auto_subtitles:
            logger.info(f"发现YouTube字幕信息: {list(subtitles.keys()) + list(auto_subtitles.keys())}")
            # 这里可以进一步处理字幕信息，但目前返回空字符串
            return ""
        
        return ""
        
    except Exception as e:
        logger.debug(f"提取YouTube视频元数据失败: {e}")
        return ""


async def _convert_vtt_to_srt(vtt_path: str, srt_path: str):
    """将VTT字幕文件转换为SRT格式"""
    try:
        with open(vtt_path, 'r', encoding='utf-8') as vtt_file:
            vtt_content = vtt_file.read()
        
        # 简单的VTT到SRT转换
        lines = vtt_content.split('\n')
        srt_lines = []
        subtitle_count = 1
        
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            
            # 跳过VTT头部信息
            if line.startswith('WEBVTT') or line.startswith('NOTE') or not line:
                i += 1
                continue
            
            # 查找时间戳行
            if '-->' in line:
                # 转换时间格式 (VTT使用点，SRT使用逗号)
                time_line = line.replace('.', ',')
                srt_lines.append(str(subtitle_count))
                srt_lines.append(time_line)
                
                # 获取字幕文本
                i += 1
                subtitle_text = []
                while i < len(lines) and lines[i].strip():
                    subtitle_text.append(lines[i].strip())
                    i += 1
                
                srt_lines.extend(subtitle_text)
                srt_lines.append('')  # 空行分隔
                subtitle_count += 1
            
            i += 1
        
        # 写入SRT文件
        with open(srt_path, 'w', encoding='utf-8') as srt_file:
            srt_file.write('\n'.join(srt_lines))
            
        logger.info(f"VTT转SRT转换成功: {vtt_path} -> {srt_path}")
        
    except Exception as e:
        logger.error(f"VTT转SRT转换失败: {e}")
        raise
