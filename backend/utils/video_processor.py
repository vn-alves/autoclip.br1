import os
"""
视频处理工具
"""
import subprocess
import json
import logging
import re
from typing import List, Dict, Optional, Callable
from pathlib import Path
from .ffmpeg_utils import get_ffmpeg_path, get_ffprobe_path

# 修复导入问题
try:
    from ..core.shared_config import CLIPS_DIR, COLLECTIONS_DIR
except ImportError:
    # 如果相对导入失败，尝试绝对导入
    import sys
    from pathlib import Path
    backend_path = Path(__file__).parent.parent
    if str(backend_path) not in sys.path:
        sys.path.insert(0, str(backend_path))
    from ..core.shared_config import CLIPS_DIR, COLLECTIONS_DIR

logger = logging.getLogger(__name__)

class VideoProcessor:
    """视频处理工具类"""
    
    def __init__(self, clips_dir: Optional[str] = None, collections_dir: Optional[str] = None):
        # 强制使用传入的项目特定路径，不使用全局路径作为后备
        if not clips_dir:
            raise ValueError("clips_dir 参数是必需的，不能使用全局路径")
        if not collections_dir:
            raise ValueError("collections_dir 参数是必需的，不能使用全局路径")
        
        self.clips_dir = Path(clips_dir)
        self.collections_dir = Path(collections_dir)
    
    @staticmethod
    def sanitize_filename(filename: str) -> str:
        """
        清理文件名，移除或替换不合法的字符
        
        Args:
            filename: 原始文件名
            
        Returns:
            清理后的文件名
        """
        # 移除或替换不合法的字符
        # Windows和Unix系统都不允许的字符: < > : " | ? * \ /
        # 替换为下划线
        sanitized = re.sub(r'[<>:"|?*\\/]', '_', filename)
        
        # 移除前后空格和点
        sanitized = sanitized.strip(' .')
        
        # 限制长度，避免文件名过长
        if len(sanitized) > 100:
            sanitized = sanitized[:100]
        
        # 确保文件名不为空
        if not sanitized:
            sanitized = "untitled"
            
        return sanitized
    
    @staticmethod
    def convert_srt_time_to_ffmpeg_time(srt_time: str) -> str:
        """
        将SRT时间格式转换为FFmpeg时间格式
        
        Args:
            srt_time: SRT时间格式 (如 "00:00:06,140" 或 "00:00:06.140")
            
        Returns:
            FFmpeg时间格式 (如 "00:00:06.140")
        """
        # 将逗号替换为点
        return srt_time.replace(',', '.')
    
    @staticmethod
    def convert_seconds_to_ffmpeg_time(seconds: float) -> str:
        """
        将秒数转换为FFmpeg时间格式
        
        Args:
            seconds: 秒数
            
        Returns:
            FFmpeg时间格式 (如 "00:00:06.140")
        """
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)
        milliseconds = int((seconds % 1) * 1000)
        
        return f"{hours:02d}:{minutes:02d}:{secs:02d}.{milliseconds:03d}"
    
    @staticmethod
    def convert_ffmpeg_time_to_seconds(time_str: str) -> float:
        """
        将FFmpeg时间格式转换为秒数
        
        Args:
            time_str: FFmpeg时间格式 (如 "00:00:06.140")
            
        Returns:
            秒数
        """
        try:
            # 处理毫秒部分
            if '.' in time_str:
                time_part, ms_part = time_str.split('.')
                milliseconds = int(ms_part)
            else:
                time_part = time_str
                milliseconds = 0
            
            # 解析时分秒
            h, m, s = map(int, time_part.split(':'))
            
            return h * 3600 + m * 60 + s + milliseconds / 1000
        except Exception as e:
            logger.error(f"时间格式转换失败: {time_str}, 错误: {e}")
            return 0.0
    
    @staticmethod
    def extract_clip(input_video: Path, output_path: Path, 
                    start_time: str, end_time: str) -> bool:
        """
        从视频中提取指定时间段的片段
        
        Args:
            input_video: 输入视频路径
            output_path: 输出视频路径
            start_time: 开始时间 (格式: "00:01:25,140")
            end_time: 结束时间 (格式: "00:02:53,500")
            
        Returns:
            是否成功
        """
        try:
            # 确保输出目录存在
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 转换时间格式：从SRT格式转换为FFmpeg格式
            ffmpeg_start_time = VideoProcessor.convert_srt_time_to_ffmpeg_time(start_time)
            ffmpeg_end_time = VideoProcessor.convert_srt_time_to_ffmpeg_time(end_time)
            
            # 计算持续时间
            start_seconds = VideoProcessor.convert_ffmpeg_time_to_seconds(ffmpeg_start_time)
            end_seconds = VideoProcessor.convert_ffmpeg_time_to_seconds(ffmpeg_end_time)
            duration = end_seconds - start_seconds
            
            # Bug real (legenda dessincronizada a partir do 2º corte, alternando certo/errado):
            # '-ss' antes de '-i' com '-c:v copy' não é frame-accurate — o demuxer só consegue
            # começar o vídeo no keyframe mais próximo ANTES de start_time (não dá pra cortar
            # no meio de um GOP sem decodificar), enquanto o áudio (sem dependência de GOP) é
            # cortado exatamente em start_time. Resultado: o arquivo do corte tem "sobra" de
            # vídeo antes do áudio/legenda começarem — em vídeos do YouTube, com intervalo de
            # keyframe praticamente constante, a distância até o keyframe anterior varia de
            # forma quase periódica entre os cortes (por isso o padrão alternado certo/errado,
            # não um offset constante). Reencodar o vídeo (em vez de copiar o stream) faz o
            # ffmpeg decodificar a partir do keyframe e descartar os frames antes de
            # start_time, então o frame 0 do corte bate exatamente com o offset já usado pelas
            # legendas.
            #
            # Bug real #2 (residual depois do fix acima: legenda ficava um pouco ADIANTADA da
            # fala em todo corte com start_time > 0, exceto o primeiro): reencodar só o vídeo e
            # deixar o áudio em '-c:a copy' quebra a simetria — o accurate-seek do ffmpeg só
            # descarta o "lead-in" de pré-seek em streams REENCODADOS; um stream copiado
            # preserva esse pedacinho de áudio anterior a start_time (até ~1 frame de
            # áudio, ~20-40ms). Como esse pacote de áudio fica com PTS negativo, o
            # '-avoid_negative_ts make_zero' empurra TODOS os streams pra frente por esse mesmo
            # valor pra compensar — deslocando o t=0 real do arquivo pra depois de start_time,
            # exatamente na direção "legenda adiantada" (tudo que o resto do código calcula a
            # partir de start_time assume t=0 == start_time). Só não acontecia no 1º corte
            # porque start_time=0 não aciona seek nenhum (sem lead-in, sem PTS negativo, sem
            # correção). Reencodar o áudio também elimina a assimetria: os dois streams passam
            # pelo mesmo descarte preciso, então t=0 bate exato com start_time nos dois.
            ffmpeg_bin = get_ffmpeg_path()
            cmd = [
                ffmpeg_bin,
                '-ss', ffmpeg_start_time,  # 在输入前定位，更精确
                '-i', str(input_video),
                '-t', str(duration),  # 使用持续时间而不是绝对结束时间
                # Mapeia explicitamente o 1º vídeo e o 1º áudio (se houver) — sem isso,
                # arquivos com várias trilhas podiam sair com a trilha errada/muda.
                '-map', '0:v:0', '-map', '0:a:0?',
                '-c:v', 'libx264', '-preset', os.getenv('AUTOCLIP_CLIP_PRESET', 'superfast'), '-crf', '22',
                '-threads', '0',
                '-c:a', 'aac', '-b:a', '192k',
                '-avoid_negative_ts', 'make_zero',
                '-y',  # 覆盖输出文件
                str(output_path)
            ]
            
            # Bug real (importação travando pra sempre em ~70%, sem erro nenhum no log): este
            # subprocess.run nunca teve timeout — se o ffmpeg travar (ex.: entrada
            # corrompida/parcial de um download que falhou e foi reaproveitado, encode preso),
            # o processo do Editor/import fica esperando pra sempre, sem nunca reportar
            # progresso nem erro. Timeout generoso (reencode de vídeo pode ser lento em cortes
            # longos) + captura explícita de TimeoutExpired, matando o processo e reportando
            # falha em vez de travar o pipeline inteiro silenciosamente.
            result = subprocess.run(
                cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=600,
            )

            if result.returncode == 0:
                logger.info(f"成功提取视频片段: {output_path} ({ffmpeg_start_time} -> {ffmpeg_end_time}, 时长: {duration:.2f}秒)")
                return True
            else:
                logger.error(f"提取视频片段失败: {result.stderr}")
                return False

        except subprocess.TimeoutExpired:
            logger.error(f"提取视频片段超时（travado): {output_path}")
            return False
        except Exception as e:
            logger.error(f"视频处理异常: {str(e)}")
            return False
    
    @staticmethod
    def create_collection(clips_list: List[Path], output_path: Path) -> bool:
        """
        将多个视频片段拼接成合集
        
        Args:
            clips_list: 视频片段路径列表
            output_path: 输出合集路径
            
        Returns:
            是否成功
        """
        try:
            # 验证输入参数
            if not clips_list:
                logger.error("clips_list为空，无法创建合集")
                return False
            
            # 验证所有视频文件是否存在
            valid_clips = []
            for clip_path in clips_list:
                if not clip_path.exists():
                    logger.warning(f"视频文件不存在，跳过: {clip_path}")
                    continue
                valid_clips.append(clip_path)
            
            if not valid_clips:
                logger.error("没有有效的视频文件，无法创建合集")
                return False
            
            # 确保输出目录存在
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 创建concat文件
            concat_file = output_path.parent / "concat_list.txt"
            
            with open(concat_file, 'w', encoding='utf-8') as f:
                for clip_path in valid_clips:
                    # 使用绝对路径并转义单引号
                    abs_path = clip_path.absolute()
                    escaped_path = str(abs_path).replace("'", "'\"'\"'")
                    f.write(f"file '{escaped_path}'\n")
            
            # 验证concat文件内容
            if concat_file.stat().st_size == 0:
                logger.error("concat文件为空，无法创建合集")
                concat_file.unlink(missing_ok=True)
                return False
            
            # 构建FFmpeg命令 - 使用H.264编码确保兼容性
            ffmpeg_bin = get_ffmpeg_path()
            cmd = [
                ffmpeg_bin,
                '-f', 'concat',
                '-safe', '0',
                '-i', str(concat_file),
                '-c:v', 'libx264',  # 使用H.264视频编码
                '-preset', 'ultrafast',  # 使用最快的编码预设
                '-crf', '28',  # 稍微降低质量以加快编码速度
                '-c:a', 'aac',  # 使用AAC音频编码
                '-b:a', '128k',  # 音频比特率
                '-movflags', '+faststart',  # 优化网络播放
                '-y',
                str(output_path)
            ]
            
            logger.info(f"执行FFmpeg命令: {' '.join(cmd)}")
            
            # 执行命令 — timeout: ver comentário em extract_clip (mesmo bug de travar sem erro).
            try:
                result = subprocess.run(
                    cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=600,
                )
            except subprocess.TimeoutExpired:
                concat_file.unlink(missing_ok=True)
                logger.error(f"criação de coleção travada (timeout): {output_path}")
                return False

            # 清理临时文件
            concat_file.unlink(missing_ok=True)

            if result.returncode == 0:
                logger.info(f"成功创建合集: {output_path}")
                return True
            else:
                logger.error(f"创建合集失败: {result.stderr}")
                logger.error(f"FFmpeg stdout: {result.stdout}")
                return False

        except Exception as e:
            logger.error(f"视频拼接异常: {str(e)}")
            return False
    
    @staticmethod
    def extract_thumbnail(video_path: Path, output_path: Path, time_offset: int = 5) -> bool:
        """
        从视频中提取缩略图
        
        Args:
            video_path: 视频文件路径
            output_path: 输出缩略图路径
            time_offset: 提取时间点（秒）
            
        Returns:
            是否成功
        """
        try:
            # 确保输出目录存在
            output_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 构建FFmpeg命令
            cmd = [
                'ffmpeg',
                '-i', str(video_path),
                '-ss', str(time_offset),
                '-vframes', '1',
                '-q:v', '2',  # 高质量
                '-y',  # 覆盖输出文件
                str(output_path)
            ]
            
            # 执行命令 — timeout: ver comentário em extract_clip.
            result = subprocess.run(
                cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=30,
            )

            if result.returncode == 0 and output_path.exists():
                logger.info(f"成功提取缩略图: {output_path}")
                return True
            else:
                logger.error(f"提取缩略图失败: {result.stderr}")
                return False

        except subprocess.TimeoutExpired:
            logger.error(f"extração de miniatura travada (timeout): {video_path}")
            return False
        except Exception as e:
            logger.error(f"提取缩略图异常: {str(e)}")
            return False
    
    @staticmethod
    def get_video_info(video_path: Path) -> Dict:
        """
        获取视频信息
        
        Args:
            video_path: 视频文件路径
            
        Returns:
            视频信息字典
        """
        try:
            ffprobe_bin = get_ffprobe_path()
            cmd = [
                ffprobe_bin,
                '-v', 'quiet',
                '-print_format', 'json',
                '-show_format',
                '-show_streams',
                str(video_path)
            ]
            
            # timeout: ver comentário em extract_clip.
            result = subprocess.run(
                cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=30,
            )

            if result.returncode == 0:
                info = json.loads(result.stdout)
                return {
                    'duration': float(info['format']['duration']),
                    'size': int(info['format']['size']),
                    'bitrate': int(info['format']['bit_rate']),
                    'streams': info['streams']
                }
            else:
                logger.error(f"获取视频信息失败: {result.stderr}")
                return {}

        except subprocess.TimeoutExpired:
            logger.error(f"obtenção de informações do vídeo travada (timeout): {video_path}")
            return {}
        except Exception as e:
            logger.error(f"获取视频信息异常: {str(e)}")
            return {}
    
    def batch_extract_clips(self, input_video: Path, clips_data: List[Dict], on_progress: Optional[Callable[[int, int], None]] = None) -> List[Path]:
        """
        批量提取视频片段

        Args:
            input_video: 输入视频路径
            clips_data: 片段数据列表，每个元素包含id、title、start_time、end_time
            on_progress: chamado após CADA corte (sucesso ou falha) com (feito, total) — ver
                simple_pipeline_adapter.py. Sem isso a etapa EXPORT fica em 0% até TODOS os
                cortes terminarem, então um corte real (não travado) de vídeo longo com muitos
                clipes parece indistinguível de um travamento de verdade.

        Returns:
            成功提取的片段路径列表
        """
        # Desempenho: antes os cortes eram feitos um por vez (cada um reencoda o vídeo), o que
        # dominava o tempo total da importação. Agora rodam em paralelo (cada ffmpeg é um
        # processo separado), mantendo a ordem original do resultado.
        import os
        from concurrent.futures import ThreadPoolExecutor, as_completed
        import threading

        total = len(clips_data)
        results: List[Optional[Path]] = [None] * total
        done = 0
        lock = threading.Lock()

        def _work(clip_data: Dict) -> Optional[Path]:
            clip_id = clip_data['id']
            title = clip_data.get('title', f"片段_{clip_id}")
            start_time = clip_data['start_time']
            end_time = clip_data['end_time']
            if isinstance(start_time, (int, float)):
                start_time = VideoProcessor.convert_seconds_to_ffmpeg_time(start_time)
            if isinstance(end_time, (int, float)):
                end_time = VideoProcessor.convert_seconds_to_ffmpeg_time(end_time)
            safe_title = VideoProcessor.sanitize_filename(title)
            output_path = self.clips_dir / f"{clip_id}_{safe_title}.mp4"
            logger.info(f"提取切片 {clip_id}: {start_time} -> {end_time}, 输出: {output_path}")
            if VideoProcessor.extract_clip(input_video, output_path, start_time, end_time):
                logger.info(f"切片 {clip_id} 提取成功")
                return output_path
            logger.error(f"切片 {clip_id} 提取失败")
            return None

        workers = int(os.getenv("AUTOCLIP_CLIP_WORKERS", "0")) or max(1, min(4, (os.cpu_count() or 2) // 2 or 1))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = {pool.submit(_work, c): i for i, c in enumerate(clips_data)}
            for fut in as_completed(futures):
                idx = futures[fut]
                try:
                    results[idx] = fut.result()
                except Exception:
                    logger.error("corte falhou", exc_info=True)
                with lock:
                    done += 1
                    current = done
                if on_progress:
                    try:
                        on_progress(current, total)
                    except Exception:
                        logger.debug("on_progress callback falhou (ignorado)", exc_info=True)

        return [p for p in results if p is not None]
    
    def create_collections_from_metadata(self, collections_data: List[Dict]) -> List[Dict]:
        """
        根据元数据创建合集
        
        Args:
            collections_data: 合集数据列表
            
        Returns:
            成功创建的合集信息列表，包含视频路径和缩略图路径
        """
        successful_collections = []
        
        for collection_data in collections_data:
            collection_id = collection_data['id']
            collection_title = collection_data.get('collection_title', f'合集_{collection_id}')
            clip_ids = collection_data['clip_ids']
            
            # 构建片段路径列表
            clips_list = []
            for clip_id in clip_ids:
                # 查找对应的切片文件
                # 新的文件名格式是: {clip_id}_{title}.mp4
                clip_path = self.clips_dir / f"{clip_id}_*.mp4"
                found_clips = list(self.clips_dir.glob(f"{clip_id}_*.mp4"))
                
                if found_clips:
                    found_clip = found_clips[0]  # 取第一个匹配的文件
                    clips_list.append(found_clip)
                    logger.info(f"找到合集 {collection_id} 的切片: {found_clip.name}")
                else:
                    logger.warning(f"未找到合集 {collection_id} 的切片 {clip_id}")
            
            if clips_list:
                # 使用collection_title作为文件名，并清理不合法的字符
                safe_title = VideoProcessor.sanitize_filename(collection_title)
                output_path = self.collections_dir / f"{safe_title}.mp4"
                
                if VideoProcessor.create_collection(clips_list, output_path):
                    # 生成合集缩略图
                    thumbnail_path = None
                    try:
                        thumbnail_filename = f"{collection_id}_{safe_title}_thumbnail.jpg"
                        thumbnail_path = self.collections_dir / thumbnail_filename
                        
                        # 从视频中提取缩略图（第2秒的帧）
                        thumbnail_success = VideoProcessor.extract_thumbnail(output_path, thumbnail_path, time_offset=2)
                        if thumbnail_success:
                            logger.info(f"合集 {collection_id} 缩略图生成成功: {thumbnail_path}")
                        else:
                            logger.warning(f"合集 {collection_id} 缩略图生成失败")
                            thumbnail_path = None
                    except Exception as e:
                        logger.error(f"生成合集 {collection_id} 缩略图时出错: {e}")
                        thumbnail_path = None
                    
                    # 返回包含视频路径和缩略图路径的信息
                    collection_info = {
                        'collection_id': collection_id,
                        'video_path': str(output_path),
                        'thumbnail_path': str(thumbnail_path) if thumbnail_path else None,
                        'title': collection_title
                    }
                    successful_collections.append(collection_info)
                    logger.info(f"成功创建合集 {collection_id}: {output_path}")
            else:
                logger.warning(f"合集 {collection_id} 没有找到任何有效的切片文件")
        
        return successful_collections