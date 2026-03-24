import os
import re
import time
import base64
import logging
import shutil
import subprocess
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from queue import Empty
from threading import Thread, Lock
from dotenv import load_dotenv
from openai import OpenAI
from wcferry import Wcf, WxMsg

load_dotenv()

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler("bot.log", encoding="utf-8"),
    ],
)
LOG = logging.getLogger("WeChatBot")

GROUP_TRIGGER_PREFIX = os.getenv("GROUP_TRIGGER_PREFIX", "").strip()
PRIVATE_CHAT_REPLY = os.getenv("PRIVATE_CHAT_REPLY", "true").lower() == "true"
GROUP_WHITELIST = [g.strip() for g in os.getenv("GROUP_WHITELIST", "").split(",") if g.strip()]
SYSTEM_PROMPT = os.getenv("SYSTEM_PROMPT", "你是一个智能助手，请用中文简洁地回答用户的问题。")
WECHAT_PATH = os.getenv("WECHAT_PATH", "").strip() or None

AI_PROVIDER = os.getenv("AI_PROVIDER", "deepseek").lower().strip()

_PROVIDER_CONFIGS = {
    "gpt":      (os.getenv("GPT_API_KEY"),      os.getenv("GPT_BASE_URL",      "https://api.openai.com/v1"),   os.getenv("GPT_MODEL",      "gpt-4o-mini")),
    "deepseek": (os.getenv("DEEPSEEK_API_KEY"), os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com"),    os.getenv("DEEPSEEK_MODEL", "deepseek-chat")),
    "claude":   (os.getenv("CLAUDE_API_KEY"),   os.getenv("CLAUDE_BASE_URL",   "https://api.anthropic.com/v1"),os.getenv("CLAUDE_MODEL",   "claude-3-5-haiku-20241022")),
    "minimax":  (os.getenv("MINIMAX_API_KEY"),  os.getenv("MINIMAX_BASE_URL",  "https://api.minimax.io/v1"),   os.getenv("MINIMAX_MODEL",  "MiniMax-M2.5-highspeed")),
}

if AI_PROVIDER not in _PROVIDER_CONFIGS:
    raise ValueError(f"未知 AI_PROVIDER: {AI_PROVIDER}，可选: {list(_PROVIDER_CONFIGS.keys())}")

_api_key, _base_url, AI_MODEL = _PROVIDER_CONFIGS[AI_PROVIDER]

client = OpenAI(api_key=_api_key, base_url=_base_url)

conversation_history: dict = {}
group_whitelist_ids: set = set()
group_context_buffer: dict = {}   # roomid -> list of "昵称: 内容" 字符串
group_pending_media: dict = {}    # roomid -> {"type": "image"|"file", "msg": WxMsg, "filename": str}
_file_process_lock = Lock()       # 防止多文件并发处理导致crash
_global_wcf = None                # 全局wcf引用，供文件监控线程使用
_file_watcher_started = False     # 文件监控线程是否已启动
GROUP_CONTEXT_LIMIT = int(os.getenv("GROUP_CONTEXT_LIMIT", "50"))  # 最多保留条数

VISION_PROVIDERS = {"gpt", "claude"}  # 支持图片的供应商
WECHAT_FILE_DIR = os.getenv("WECHAT_FILE_DIR", r"D:\WeChat Files\wxid_amkb0miro4hf22\FileStorage\File")
MEMORY_DIR = Path(os.getenv("MEMORY_DIR", r"D:\Weixin\bot\memory"))
MEMORY_DIR.mkdir(parents=True, exist_ok=True)
FILE_SAVE_DIR = MEMORY_DIR / "files"
FILE_SAVE_DIR.mkdir(parents=True, exist_ok=True)
SOFFICE_PATH = os.getenv("SOFFICE_PATH", r"C:\Program Files\LibreOffice\program\soffice.exe")


def memory_load_all() -> str:
    files = sorted(MEMORY_DIR.glob("*.txt"))
    if not files:
        return ""
    parts = []
    for f in files:
        parts.append(f"=== 记忆：{f.stem} ===\n{f.read_text(encoding='utf-8', errors='ignore').strip()}")
    return "\n\n".join(parts)


def memory_list() -> str:
    files = sorted(MEMORY_DIR.glob("*.txt"))
    if not files:
        return "当前没有任何记忆。"
    lines = []
    for i, f in enumerate(files, 1):
        size = f.stat().st_size
        mtime = datetime.fromtimestamp(f.stat().st_mtime).strftime("%m-%d %H:%M")
        lines.append(f"{i}. {f.name}  ({size}B, {mtime})")
    return "\n".join(lines)


def memory_save(name: str, content: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|]', '_', name.strip())
    if not safe.endswith(".txt"):
        safe += ".txt"
    path = MEMORY_DIR / safe
    path.write_text(content.strip(), encoding="utf-8")
    return safe


def memory_delete(name: str) -> bool:
    safe = re.sub(r'[\\/:*?"<>|]', '_', name.strip())
    if not safe.endswith(".txt"):
        safe += ".txt"
    path = MEMORY_DIR / safe
    if path.exists():
        path.unlink()
        return True
    return False


def memory_read(name: str) -> str:
    safe = re.sub(r'[\\/:*?"<>|]', '_', name.strip())
    if not safe.endswith(".txt"):
        safe += ".txt"
    path = MEMORY_DIR / safe
    if path.exists():
        return path.read_text(encoding="utf-8", errors="ignore").strip()
    return ""


CONVERTIBLE_EXTS = {".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".pdf", ".txt", ".md"}
LIBRE_NEEDED_EXTS = {".doc", ".ppt", ".xls"}


def _soffice_convert(src: Path, out_dir: Path, fmt: str = "docx"):
    if not Path(SOFFICE_PATH).exists():
        LOG.warning(f"LibreOffice 未找到: {SOFFICE_PATH}")
        return None
    try:
        subprocess.run(
            [SOFFICE_PATH, "--headless", "--convert-to", fmt, "--outdir", str(out_dir), str(src)],
            timeout=60, capture_output=True
        )
        stem = src.stem
        result = out_dir / f"{stem}.{fmt}"
        return result if result.exists() else None
    except Exception as e:
        LOG.error(f"LibreOffice 转换失败: {e}")
        return None


def convert_to_markdown(filepath: str) -> tuple[str, bool]:
    """返回 (markdown文本, 是否经过转换)。转换=原格式非原生支持"""
    p = Path(filepath)
    ext = p.suffix.lower()
    converted = False
    try:
        # .doc/.ppt/.xls → LibreOffice 先转
        if ext in LIBRE_NEEDED_EXTS:
            converted = True
            fmt_map = {".doc": "docx", ".ppt": "pptx", ".xls": "xlsx"}
            target_fmt = fmt_map[ext]
            new_p = _soffice_convert(p, p.parent, target_fmt)
            if new_p is None:
                return "", converted
            p = new_p
            ext = p.suffix.lower()

        if ext in (".txt", ".md"):
            return p.read_text(encoding="utf-8", errors="ignore"), converted

        elif ext == ".docx":
            import docx
            doc = docx.Document(str(p))
            lines = []
            for para in doc.paragraphs:
                if not para.text.strip():
                    continue
                style = para.style.name.lower() if para.style else ""
                if "heading 1" in style:
                    lines.append(f"# {para.text}")
                elif "heading 2" in style:
                    lines.append(f"## {para.text}")
                elif "heading 3" in style:
                    lines.append(f"### {para.text}")
                else:
                    lines.append(para.text)
            for table in doc.tables:
                rows = [[cell.text.strip() for cell in row.cells] for row in table.rows]
                if rows:
                    lines.append("| " + " | ".join(rows[0]) + " |")
                    lines.append("|" + "---|" * len(rows[0]))
                    for row in rows[1:]:
                        lines.append("| " + " | ".join(row) + " |")
            return "\n".join(lines), converted

        elif ext in (".xlsx",):
            import openpyxl
            wb = openpyxl.load_workbook(str(p), read_only=True, data_only=True)
            lines = []
            for sheet in wb.sheetnames:
                ws = wb[sheet]
                lines.append(f"## Sheet: {sheet}")
                for row in ws.iter_rows(values_only=True):
                    cells = [str(c) if c is not None else "" for c in row]
                    if any(cells):
                        lines.append("| " + " | ".join(cells) + " |")
            return "\n".join(lines), converted

        elif ext == ".pptx":
            from pptx import Presentation
            prs = Presentation(str(p))
            lines = []
            for i, slide in enumerate(prs.slides, 1):
                lines.append(f"## 第 {i} 页")
                for shape in slide.shapes:
                    if shape.has_text_frame:
                        for para in shape.text_frame.paragraphs:
                            text = para.text.strip()
                            if text:
                                lines.append(text)
            return "\n".join(lines), converted

        elif ext == ".pdf":
            import fitz
            doc = fitz.open(str(p))
            return "\n".join(page.get_text() for page in doc), converted

        else:
            return "", converted

    except Exception as e:
        LOG.error(f"文件转换失败 {filepath}: {e}")
        return "", converted


def extract_file_text(filepath: str) -> str:
    text, _ = convert_to_markdown(filepath)
    return text


def _process_incoming_file(wcf: Wcf, filename: str, extra_path: str, reply_target: str):
    """收到文件后异步执行：等待文件落盘，转换为 MD 并保存，回复结果"""
    with _file_process_lock:  # 串行处理，防止并发crash
        # 规范化路径，去除多余空白和不可见字符
        extra_path = os.path.normpath(extra_path.strip()) if extra_path else ""
        extra_dir = str(Path(extra_path).parent) if extra_path else ""
        stem = Path(filename).stem
        ext_lower = Path(filename).suffix.lower()
        LOG.info(f"[文件处理] 等待文件落盘: {filename} extra={extra_path}")

        def _find_file():
            # 1. 直接用 extra 路径
            if extra_path and os.path.isfile(extra_path):
                return extra_path
            # 2. 在 extra 同目录下按文件名搜索
            if extra_dir and os.path.isdir(extra_dir):
                for f in os.listdir(extra_dir):
                    fp = os.path.join(extra_dir, f)
                    if os.path.isfile(fp) and f.lower().endswith(ext_lower) and Path(f).stem.startswith(stem):
                        return fp
            # 3. 全局搜索 WECHAT_FILE_DIR
            for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                for f in files:
                    if f == filename or (f.lower().endswith(ext_lower) and Path(f).stem.startswith(stem)):
                        candidate = os.path.join(root_dir, f)
                        try:
                            if time.time() - os.path.getmtime(candidate) < 120:
                                return candidate
                        except OSError:
                            continue
            return None

        found_path = None
        for i in range(15):  # 最多等30秒
            found_path = _find_file()
            if found_path:
                LOG.info(f"[文件处理] 第{i+1}次扫描找到: {found_path}")
                break
            time.sleep(2)

        if not found_path:
            LOG.warning(f"[文件处理] 30秒超时未找到: {filename} (extra={extra_path})")
            wcf.send_text(f"[文件《{filename}》下载超时，请重新发送]", reply_target)
            return

        ext = Path(filename).suffix.lower()
        if ext not in CONVERTIBLE_EXTS:
            wcf.send_text(f"[文件格式 {ext} 暂不支持，无法保存]", reply_target)
            return

        LOG.info(f"开始转换文件: {found_path}")
        md_text, was_converted = convert_to_markdown(found_path)
        if not md_text:
            wcf.send_text(f"[文件《{filename}》解析失败，内容为空]", reply_target)
            return

        stem = Path(filename).stem
        save_path = FILE_SAVE_DIR / f"{stem}.md"
        save_path.write_text(md_text, encoding="utf-8")
        LOG.info(f"文件已保存: {save_path}，{len(md_text)} 字符")

        if was_converted:
            wcf.send_text(f"✅ 此文件格式已转换并保存为 {stem}.md\n可用：读取文件 {stem}", reply_target)
        else:
            wcf.send_text(f"✅ 此文件格式支持，已保存 {stem}.md\n可用：读取文件 {stem}", reply_target)


_watched_files: set = set()  # 已处理过的文件路径集合
_file_convert_status: dict = {}  # stem -> {"status": "converting"/"done"/"error", "path": str, "md_path": str}
_new_files_pending: list = []   # 断线期间检测到的新文件，重连后通知用户

# ── 重连后从微信数据库恢复文件 ──
_last_recover_ts_file = MEMORY_DIR / ".last_recover_ts"


def _extract_filename_from_xml(xml_str):
    """从 type=49 消息的 XML 中提取文件名（尝试多个标签）"""
    if not xml_str:
        return ""
    s = xml_str if isinstance(xml_str, str) else str(xml_str)
    # 优先从 <filename> 提取（最准确）
    m = re.search(r'<filename>([^<]+)</filename>', s)
    if m:
        return m.group(1).strip()
    # 其次 <title>
    m = re.search(r'<title>([^<]+)</title>', s)
    if m:
        name = m.group(1).strip()
        if '.' in name:  # 确保是文件名而非链接标题
            return name
    # 最后 <sourcedisplayname>
    m = re.search(r'<sourcedisplayname>([^<]+)</sourcedisplayname>', s)
    if m:
        return m.group(1).strip()
    return ""


def _try_download_from_db(wcf, target_filename):
    """按需下载：查 DB 找匹配文件名的 type=49 消息，调 download_attach 下载。
    返回本地文件路径，失败返回 None。"""
    target_stem = Path(target_filename).stem.lower()
    target_ext = Path(target_filename).suffix.lower()

    try:
        dbs = wcf.get_dbs()
        msg_dbs = [d for d in dbs if d.startswith("MSG")]
        if not msg_dbs:
            LOG.warning("[按需下载] 未找到 MSG 数据库")
            return None

        # 查最近1小时的 type=49 消息
        min_ts = int(time.time()) - 3600
        candidates = []

        for db in msg_dbs:
            try:
                tables = wcf.get_tables(db)
                table_names = [t.get("name", "") for t in tables] if isinstance(tables, list) else []
                for tbl in table_names:
                    if not tbl.startswith("MSG"):
                        continue
                    sql = (
                        f"SELECT localId, MsgSvrID, StrTalker, StrContent, CreateTime "
                        f"FROM {tbl} WHERE Type=49 AND CreateTime>{min_ts} "
                        f"ORDER BY CreateTime DESC LIMIT 50"
                    )
                    try:
                        rows = wcf.query_sql(db, sql)
                        for row in rows:
                            raw = row.get("StrContent", "")
                            if isinstance(raw, bytes):
                                try:
                                    raw = raw.decode("utf-8")
                                except Exception:
                                    raw = raw.decode("utf-8", errors="replace")
                            fname = _extract_filename_from_xml(raw)
                            if not fname:
                                continue
                            f_stem = Path(fname).stem.lower()
                            f_ext = Path(fname).suffix.lower()
                            # 匹配：完全匹配、前缀匹配、包含匹配
                            if (f_stem == target_stem or
                                f_stem.startswith(target_stem) or
                                target_stem in f_stem):
                                if not target_ext or f_ext == target_ext:
                                    candidates.append({
                                        "msg_id": row.get("MsgSvrID", 0) or row.get("localId", 0),
                                        "filename": fname,
                                        "create_time": row.get("CreateTime", 0),
                                    })
                    except Exception as e:
                        LOG.debug(f"[按需下载] 查询 {db}.{tbl} 失败: {e}")
            except Exception as e:
                LOG.debug(f"[按需下载] 读取 {db} 表结构失败: {e}")

        if not candidates:
            LOG.info(f"[按需下载] DB中未找到匹配 {target_filename!r} 的文件消息")
            return None

        # 取最新的一条
        candidates.sort(key=lambda x: x["create_time"], reverse=True)
        best = candidates[0]
        msg_id = best["msg_id"]
        filename = best["filename"]
        LOG.info(f"[按需下载] 找到匹配: {filename} (msg_id={msg_id})，正在下载...")

        ret = wcf.download_attach(msg_id, "", "")
        LOG.info(f"[按需下载] download_attach 返回: {ret}")

        # 等待文件出现（最多30秒）
        stem = Path(filename).stem
        for _ in range(15):
            time.sleep(2)
            for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                for f in files:
                    if f == filename or (Path(f).stem.startswith(stem) and Path(f).suffix.lower() == Path(filename).suffix.lower()):
                        candidate_path = os.path.join(root_dir, f)
                        try:
                            if time.time() - os.path.getmtime(candidate_path) < 300:
                                LOG.info(f"[按需下载] 文件已落盘: {candidate_path}")
                                return candidate_path
                        except OSError:
                            continue

        LOG.warning(f"[按需下载] 30秒内未找到文件: {filename}")
        return None

    except Exception as e:
        LOG.error(f"[按需下载] 失败: {e}", exc_info=True)
        return None


def _recover_files_from_db(wcf, group_ids):
    """重连后查询微信数据库，找到最近的文件消息并下载+转化"""
    try:
        # 读取上次恢复时间戳，避免重复处理
        last_ts = 0
        if _last_recover_ts_file.exists():
            try:
                last_ts = int(_last_recover_ts_file.read_text().strip())
            except Exception:
                pass
        # 至少查最近10分钟
        min_ts = max(last_ts, int(time.time()) - 600)

        dbs = wcf.get_dbs()
        LOG.info(f"[文件恢复] 可用数据库: {dbs}")

        # 找 MSG 相关的数据库
        msg_dbs = [d for d in dbs if d.startswith("MSG")]
        if not msg_dbs:
            LOG.warning("[文件恢复] 未找到 MSG 数据库")
            return

        file_msgs = []
        for db in msg_dbs:
            try:
                # 先查表结构
                tables = wcf.get_tables(db)
                table_names = [t.get("name", "") for t in tables] if isinstance(tables, list) else []
                LOG.info(f"[文件恢复] {db} 的表: {table_names}")

                # 尝试查 MSG 表中 type=49 的最近消息
                for tbl in table_names:
                    if not tbl.startswith("MSG"):
                        continue
                    sql = (
                        f"SELECT localId, MsgSvrID, Type, StrTalker, StrContent, "
                        f"CreateTime, BytesExtra "
                        f"FROM {tbl} WHERE Type=49 AND CreateTime>{min_ts} "
                        f"ORDER BY CreateTime DESC LIMIT 20"
                    )
                    try:
                        rows = wcf.query_sql(db, sql)
                        for row in rows:
                            talker = row.get("StrTalker", "")
                            if group_ids and talker not in group_ids:
                                continue
                            file_msgs.append({
                                "local_id": row.get("localId", 0),
                                "msg_svr_id": row.get("MsgSvrID", 0),
                                "roomid": talker,
                                "content": row.get("StrContent", ""),
                                "create_time": row.get("CreateTime", 0),
                                "bytes_extra": row.get("BytesExtra", b""),
                            })
                    except Exception as e:
                        LOG.debug(f"[文件恢复] 查询 {db}.{tbl} 失败: {e}")
            except Exception as e:
                LOG.debug(f"[文件恢复] 读取 {db} 表结构失败: {e}")

        if not file_msgs:
            LOG.info("[文件恢复] 数据库中未找到最近的文件消息")
            return

        LOG.info(f"[文件恢复] 找到 {len(file_msgs)} 条文件消息")

        # 更新时间戳
        _last_recover_ts_file.write_text(str(int(time.time())))

        for msg_info in file_msgs:
            raw_content = msg_info["content"]
            # DB中StrContent可能是bytes，需要解码
            if isinstance(raw_content, bytes):
                try:
                    raw_content = raw_content.decode("utf-8")
                except Exception:
                    raw_content = raw_content.decode("utf-8", errors="replace")
            LOG.info(f"[文件恢复] StrContent前200字: {str(raw_content)[:200]}")
            filename = _extract_filename_from_xml(raw_content)
            ext = Path(filename).suffix.lower() if filename else ""
            if ext not in CONVERTIBLE_EXTS:
                LOG.debug(f"[文件恢复] 跳过非可转化文件: {filename!r}")
                continue

            roomid = msg_info["roomid"]
            msg_id = msg_info["msg_svr_id"] or msg_info["local_id"]
            LOG.info(f"[文件恢复] 处理文件: {filename} (id={msg_id}, room={roomid})")

            try:
                wcf.send_text(f"⏳ 正在下载文件《{filename}》...", roomid)
                # download_attach: thumb 和 extra 传空串尝试
                ret = wcf.download_attach(msg_id, "", "")
                LOG.info(f"[文件恢复] download_attach 返回: {ret}")

                # 等待文件出现（最多60秒）
                found_path = None
                stem = Path(filename).stem
                for _ in range(30):
                    time.sleep(2)
                    for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                        for f in files:
                            if f == filename or (Path(f).stem.startswith(stem) and Path(f).suffix.lower() == Path(filename).suffix.lower()):
                                candidate = os.path.join(root_dir, f)
                                try:
                                    if time.time() - os.path.getmtime(candidate) < 300:
                                        found_path = candidate
                                        break
                                except OSError:
                                    continue
                        if found_path:
                            break
                    if found_path:
                        break

                if not found_path:
                    LOG.warning(f"[文件恢复] 超时未找到: {filename}")
                    wcf.send_text(f"❌ 文件《{filename}》下载超时", roomid)
                    continue

                LOG.info(f"[文件恢复] 找到文件: {found_path}")
                tmp_path = FILE_SAVE_DIR / Path(found_path).name
                shutil.copy2(found_path, tmp_path)
                md_text, was_converted = convert_to_markdown(str(tmp_path))
                if tmp_path.suffix.lower() not in (".md", ".txt"):
                    tmp_path.unlink(missing_ok=True)
                if not md_text:
                    wcf.send_text(f"❌ 文件《{filename}》解析失败", roomid)
                    continue
                save_path = FILE_SAVE_DIR / f"{Path(found_path).stem}.md"
                save_path.write_text(md_text, encoding="utf-8")
                _file_convert_status[Path(found_path).stem] = {
                    "status": "done", "path": found_path,
                    "md_path": str(save_path), "name": filename
                }
                LOG.info(f"[文件恢复] 完成: {save_path}，{len(md_text)} 字符")
                wcf.send_text(
                    f"✅ 文件《{filename}》已下载并转化（{len(md_text)} 字符）\n"
                    f"可用：读取文件 {Path(found_path).stem}",
                    roomid
                )
            except Exception as e:
                LOG.error(f"[文件恢复] 处理 {filename} 失败: {e}", exc_info=True)
                try:
                    wcf.send_text(f"❌ 文件《{filename}》恢复失败: {e}", roomid)
                except Exception:
                    pass

    except Exception as e:
        LOG.error(f"[文件恢复] 整体失败: {e}", exc_info=True)


def _file_watcher():
    """后台线程：轮询微信缓存目录，检测新文件并静默转换保存。
    转换状态记录到 _file_convert_status，新文件记录到 _new_files_pending。"""
    global _global_wcf
    LOG.info(f"[文件监控] 线程启动，监控目录: {WECHAT_FILE_DIR}")
    start_time = time.time()
    for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
        for f in files:
            _watched_files.add(os.path.join(root_dir, f))
    LOG.info(f"[文件监控] 已索引 {len(_watched_files)} 个现有文件")

    while True:
        try:
            time.sleep(5)
            for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                for f in files:
                    fp = os.path.join(root_dir, f)
                    if fp in _watched_files:
                        continue
                    try:
                        mtime = os.path.getmtime(fp)
                    except OSError:
                        continue
                    if mtime < start_time:
                        _watched_files.add(fp)
                        continue
                    _watched_files.add(fp)
                    ext = Path(f).suffix.lower()
                    if ext not in CONVERTIBLE_EXTS:
                        continue
                    stem = Path(f).stem
                    # 标记为转化中
                    _file_convert_status[stem] = {"status": "converting", "path": fp, "md_path": "", "name": f}
                    _new_files_pending.append(stem)
                    LOG.info(f"[文件监控] 检测到新文件: {f}，开始静默转化")
                    # 等待文件写入完成
                    time.sleep(2)
                    try:
                        tmp_path = FILE_SAVE_DIR / f
                        shutil.copy2(fp, tmp_path)
                        md_text, was_converted = convert_to_markdown(str(tmp_path))
                        if tmp_path.suffix.lower() not in (".md", ".txt"):
                            tmp_path.unlink(missing_ok=True)
                        if not md_text:
                            LOG.warning(f"[文件监控] 文件解析为空: {f}")
                            _file_convert_status[stem]["status"] = "error"
                            continue
                        save_path = FILE_SAVE_DIR / f"{stem}.md"
                        save_path.write_text(md_text, encoding="utf-8")
                        _file_convert_status[stem]["status"] = "done"
                        _file_convert_status[stem]["md_path"] = str(save_path)
                        LOG.info(f"[文件监控] 转化完成: {save_path}，{len(md_text)} 字符")
                    except Exception as e:
                        LOG.error(f"[文件监控] 转化失败 {f}: {e}", exc_info=True)
                        _file_convert_status[stem]["status"] = "error"
        except Exception as e:
            LOG.error(f"[文件监控] 扫描异常: {e}", exc_info=True)
            time.sleep(5)


def ask_ai_with_image(session_id: str, image_path: str, user_text: str, context_lines: list = None) -> str:
    if AI_PROVIDER not in VISION_PROVIDERS:
        return f"[当前模型 {AI_MODEL} 不支持图片，请切换到 gpt 或 claude]"
    try:
        with open(image_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()
        ext = Path(image_path).suffix.lower().strip(".")
        mime = "jpeg" if ext in ("jpg", "jpeg") else ext

        if context_lines:
            context_block = "\n".join(context_lines)
            text_part = f"以下是群里最近的聊天记录供你参考：\n{context_block}\n\n现在有人发了一张图片并问：{user_text or '请描述这张图片'}"
        else:
            text_part = user_text or "请描述这张图片"

        messages = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": [{"type": "text", "text": text_part}, {"type": "image_url", "image_url": {"url": f"data:image/{mime};base64,{img_b64}"}}]}]
        response = client.chat.completions.create(model=AI_MODEL, max_tokens=4096, messages=messages)
        reply = response.choices[0].message.content
        if session_id not in conversation_history:
            conversation_history[session_id] = []
        conversation_history[session_id].append({"role": "user", "content": text_part + " [附图]"})
        conversation_history[session_id].append({"role": "assistant", "content": reply})
        return reply
    except Exception as e:
        LOG.error(f"图片处理失败: {e}")
        return f"[图片处理失败: {e}]"


def ask_ai(session_id: str, user_text: str, context_lines: list = None) -> str:
    if session_id not in conversation_history:
        conversation_history[session_id] = []

    if context_lines:
        context_block = "\n".join(context_lines)
        full_query = f"以下是群里最近的聊天记录供你参考：\n{context_block}\n\n现在有人问你：{user_text}"
    else:
        full_query = user_text

    conversation_history[session_id].append({"role": "user", "content": full_query})

    if len(conversation_history[session_id]) > 40:
        conversation_history[session_id] = conversation_history[session_id][-40:]

    try:
        memory_block = memory_load_all()
        system_content = SYSTEM_PROMPT
        if memory_block:
            system_content += f"\n\n以下是你需要记住的长期记忆：\n{memory_block}"
        response = client.chat.completions.create(
            model=AI_MODEL,
            max_tokens=4096,
            messages=[{"role": "system", "content": system_content}] + conversation_history[session_id],
        )
        reply = response.choices[0].message.content
        conversation_history[session_id].append({"role": "assistant", "content": reply})
        return reply
    except Exception as e:
        LOG.error(f"AI API 调用失败: {e}")
        return f"[AI 暂时不可用: {e}]"


def handle_msg(wcf: Wcf, msg: WxMsg):
    try:
        content = msg.content or ""
        is_group = msg.from_group()
        self_wxid = wcf.get_self_wxid()

        LOG.debug(f"handle_msg: type={msg.type} is_group={is_group} roomid={msg.roomid} sender={msg.sender} is_at={msg.is_at(self_wxid)} content={content[:60]}")

        if msg.from_self():
            return

        # 过滤公众号/服务号，防止回复死循环
        if msg.sender.startswith("gh_") or msg.roomid.startswith("gh_"):
            return

        if is_group:
            if GROUP_WHITELIST and group_whitelist_ids:
                if msg.roomid not in group_whitelist_ids:
                    return

            is_at_me = msg.is_at(self_wxid)
            session_id = msg.roomid
            sender_name = wcf.get_alias_in_chatroom(msg.sender, msg.roomid) or msg.sender

            # 旁听：普通文字消息存缓冲区
            if msg.type == 1 and not is_at_me:
                buf = group_context_buffer.setdefault(msg.roomid, [])
                buf.append(f"{sender_name}: {content}")
                if len(buf) > GROUP_CONTEXT_LIMIT:
                    buf.pop(0)
                return

            # 图片消息：存 pending；若未 @bot 则旁听返回，否则继续触发
            if msg.type == 3:
                group_pending_media[msg.roomid] = {"type": "image", "msg": msg}
                buf = group_context_buffer.setdefault(msg.roomid, [])
                buf.append(f"{sender_name}: [发送了一张图片]")
                if not is_at_me:
                    return

            # type=49(文件/链接)：DLL层会导致微信crash，这里不做处理
            # 文件靠 _file_watcher 自动检测 + 用户 "读取文件" 指令按需读取
            if msg.type == 49:
                return

            if not is_at_me:
                if GROUP_TRIGGER_PREFIX and not content.startswith(GROUP_TRIGGER_PREFIX):
                    return
                elif not GROUP_TRIGGER_PREFIX:
                    return

            # === 以下是 @bot 触发后的处理 ===
            query = content
            if GROUP_TRIGGER_PREFIX and content.startswith(GROUP_TRIGGER_PREFIX):
                query = content[len(GROUP_TRIGGER_PREFIX):].strip()
            elif is_at_me:
                try:
                    at_tag = f"@{wcf.get_user_info()['name']}"
                except Exception:
                    at_tag = ""
                if at_tag and at_tag in content:
                    query = content.replace(at_tag, "").strip()
                else:
                    # 备用：用regex去掉 @xxx 前缀
                    query = re.sub(r'^@\S+\s*', '', content).strip()
            LOG.info(f"[剥离] content={content[:60]!r} → query={query[:60]!r}")

            context_lines = group_context_buffer.pop(msg.roomid, [])
            pending = group_pending_media.pop(msg.roomid, None)
            LOG.info(f"群聊 [{msg.roomid}] 收到: {query[:60]}，上下文 {len(context_lines)} 条，pending={pending and pending['type']}")

            # 有待处理图片
            if pending and pending["type"] == "image":
                pm = pending["msg"]
                os.makedirs("D:\\Weixin\\bot\\downloads", exist_ok=True)
                img_path = wcf.download_image(pm.id, pm.extra, "D:\\Weixin\\bot\\downloads", 30)
                if img_path:
                    LOG.info(f"图片已下载: {img_path}")
                    reply = ask_ai_with_image(session_id, img_path, query, context_lines)
                else:
                    reply = "[图片下载失败，请重试]"
                wcf.send_text(reply, msg.roomid, msg.sender)
                return

            # 有待处理文件：download_attach + 读取内容 → 直接发 AI
            if pending and pending["type"] == "file":
                pm = pending["msg"]
                filename = pending.get("filename", "")
                LOG.info(f"[文件] @bot 触发，处理待读文件: {filename}")
                # 再次触发下载（确保文件落盘）
                try:
                    wcf.download_attach(pm.id, pm.thumb, pm.extra)
                except Exception as e:
                    LOG.warning(f"[文件] download_attach: {e}")
                # 等文件出现（最多15秒）
                found_path = None
                stem = Path(filename).stem
                ext_lower = Path(filename).suffix.lower()
                for _ in range(5):
                    # 1. extra 路径
                    if pm.extra and os.path.isfile(pm.extra):
                        found_path = pm.extra
                        break
                    # 2. WECHAT_FILE_DIR 全局搜
                    for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                        for f in files:
                            if f == filename or (Path(f).stem.startswith(stem) and Path(f).suffix.lower() == ext_lower):
                                candidate = os.path.join(root_dir, f)
                                try:
                                    if time.time() - os.path.getmtime(candidate) < 120:
                                        found_path = candidate
                                        break
                                except OSError:
                                    continue
                        if found_path:
                            break
                    if found_path:
                        break
                    time.sleep(3)
                if not found_path:
                    wcf.send_text(f"[文件《{filename}》尚未下载完成，请稍后重试]", msg.roomid, msg.sender)
                    return
                LOG.info(f"[文件] 找到: {found_path}")
                file_text = extract_file_text(found_path)
                if not file_text:
                    wcf.send_text(f"[文件《{filename}》内容为空或解析失败]", msg.roomid, msg.sender)
                    return
                LOG.info(f"[文件] 读取 {filename}，{len(file_text)} 字符，发给 AI")
                query = f"以下是文件《{filename}》的内容：\n{file_text[:100000]}\n\n{query or '请总结这个文件'}"

        else:
            if not PRIVATE_CHAT_REPLY:
                return
            if msg.type not in (1, 3, 49):
                return
            context_lines = []
            session_id = msg.sender

            if msg.type == 3:
                time.sleep(1)
                img_path = wcf.download_image(msg.id, msg.extra, "D:\\Weixin\\bot\\downloads", 10)
                if img_path:
                    reply = ask_ai_with_image(session_id, img_path, "", [])
                else:
                    reply = "[图片下载失败，请重试]"
                wcf.send_text(reply, msg.sender)
                return

            query = content.strip()
            LOG.info(f"私聊 [{msg.sender}] 收到: {query[:60]}")

        if not query:
            HELP_TEXT = (
                "📋 可用指令：\n"
                "\n"
                "【文件】\n"
                "直接发文件即可，自动识别并转化\n"
                "⚠️ 请逐个发送，发完一个等回复再发下一个\n"
                "列出文件 / ls文件\n"
                "总结文件 文件名[，问题]\n"
                "读取文件 文件名[，问题]\n"
                "分析文件 文件名[，问题]\n"
                "翻译文件 文件名[，问题]\n"
                "\n"
                "【记忆】\n"
                "列出记忆 / ls\n"
                "记住 名字：内容\n"
                "读取记忆 名字\n"
                "删除记忆 名字\n"
                "导入文件为记忆 文件名[，记忆名]\n"
                "\n"
                "【其他】\n"
                "clear / 重置 → 清除对话上下文\n"
                "直接提问 → AI 回答\n"
                "单独 @bot → 显示此帮助"
            )
            wcf.send_text(HELP_TEXT, msg.roomid if is_group else msg.sender)
            return

        # === 记忆指令拦截 ===
        q = query.strip()

        # 清除上下文
        if q in ("clear", "清除上下文", "清空上下文", "重置"):
            conversation_history.pop(session_id, None)
            group_context_buffer.pop(msg.roomid, None) if is_group else None
            group_pending_media.pop(msg.roomid, None) if is_group else None
            wcf.send_text("上下文已清除。", msg.roomid if is_group else msg.sender)
            return

        # 列出记忆
        if q in ("列出记忆", "查看记忆", "ls", "ls memory"):
            wcf.send_text(memory_list(), msg.roomid if is_group else msg.sender)
            return

        # 删除记忆：删除记忆 xxx
        m = re.match(r'^删除记忆[：:\s]+(.+)$', q)
        if m:
            name = m.group(1).strip()
            if memory_delete(name):
                wcf.send_text(f"记忆 {name}.txt 已删除。", msg.roomid if is_group else msg.sender)
            else:
                wcf.send_text(f"未找到记忆 {name}.txt。", msg.roomid if is_group else msg.sender)
            return

        # 读取记忆：读取记忆 xxx
        m = re.match(r'^读取记忆[：:\s]+(.+)$', q)
        if m:
            name = m.group(1).strip()
            content = memory_read(name)
            if content:
                wcf.send_text(f"📄 {name}.txt：\n{content}", msg.roomid if is_group else msg.sender)
            else:
                wcf.send_text(f"未找到记忆 {name}.txt。", msg.roomid if is_group else msg.sender)
            return

        # 导入文件为记忆：导入文件为记忆 文件名[，记忆名]
        m = re.match(r'^导入文件为记忆[\s：:]+(.+)$', q)
        if m:
            raw = m.group(1).strip()
            parts = re.split(r'[，,]\s*', raw, maxsplit=1)
            src_name = parts[0].strip()
            mem_name = parts[1].strip() if len(parts) > 1 else Path(src_name).stem
            # 搜索顺序：FILE_SAVE_DIR → 微信缓存
            found_path = None
            for f in FILE_SAVE_DIR.iterdir():
                if f.stem == src_name or f.name == src_name or f.stem.startswith(src_name) or f.name.startswith(src_name):
                    found_path = str(f)
                    break
            if not found_path:
                for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                    for f in files:
                        if f == src_name or f.startswith(src_name):
                            found_path = os.path.join(root_dir, f)
                            break
                    if found_path:
                        break
            if not found_path:
                wcf.send_text(f"[未找到文件《{src_name}》]", msg.roomid if is_group else msg.sender)
                return
            file_text = extract_file_text(found_path)
            if not file_text:
                wcf.send_text(f"[文件内容为空或解析失败]", msg.roomid if is_group else msg.sender)
                return
            memory_save(mem_name, file_text)
            wcf.send_text(f"✅ 已将《{Path(found_path).name}》保存为记忆「{mem_name}」（{len(file_text)} 字符）", msg.roomid if is_group else msg.sender)
            return

        # 列出文件：列出文件 / ls文件 / 文件列表
        if q in ("列出文件", "ls文件", "文件列表", "ls files"):
            reply_to = msg.roomid if is_group else msg.sender
            seen_stems = set()
            lines = []
            status_map = {"converting": "⏳转化中", "done": "✅", "error": "❌"}
            # 1) 转化状态中的文件
            for stem, info in _file_convert_status.items():
                s = status_map.get(info.get("status", ""), "❓")
                lines.append(f"  {s} {info.get('name', stem)}")
                seen_stems.add(stem)
            # 2) FILE_SAVE_DIR 中已保存的 md 文件
            for f in FILE_SAVE_DIR.iterdir():
                if f.suffix == ".md" and f.stem not in seen_stems:
                    lines.append(f"  ✅ {f.stem}")
                    seen_stems.add(f.stem)
            # 3) WECHAT_FILE_DIR 中可转化但尚未处理的文件（最近20个）
            raw_files = []
            for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                for f in files:
                    p = Path(f)
                    if p.suffix.lower() in CONVERTIBLE_EXTS and p.stem not in seen_stems:
                        fp = os.path.join(root_dir, f)
                        raw_files.append((f, os.path.getmtime(fp)))
            raw_files.sort(key=lambda x: x[1], reverse=True)
            for f, _ in raw_files[:20]:
                lines.append(f"  📄 {f}")
                seen_stems.add(Path(f).stem)
            # 4) DB中最近1小时的文件消息（尚未下载的）
            try:
                min_ts = int(time.time()) - 3600
                msg_dbs = [d for d in wcf.get_dbs() if d.startswith("MSG")]
                for db in msg_dbs:
                    tables = wcf.get_tables(db)
                    tbl_names = [t.get("name", "") for t in tables] if isinstance(tables, list) else []
                    for tbl in tbl_names:
                        if not tbl.startswith("MSG"):
                            continue
                        try:
                            rows = wcf.query_sql(db,
                                f"SELECT StrContent FROM {tbl} WHERE Type=49 AND CreateTime>{min_ts} ORDER BY CreateTime DESC LIMIT 20")
                            for row in rows:
                                raw = row.get("StrContent", "")
                                if isinstance(raw, bytes):
                                    try:
                                        raw = raw.decode("utf-8")
                                    except Exception:
                                        continue
                                fname = _extract_filename_from_xml(raw)
                                if fname and Path(fname).suffix.lower() in CONVERTIBLE_EXTS and Path(fname).stem not in seen_stems:
                                    lines.append(f"  ⬇️ {fname}")
                                    seen_stems.add(Path(fname).stem)
                        except Exception:
                            pass
            except Exception as e:
                LOG.debug(f"[ls文件] DB查询失败: {e}")
            if lines:
                wcf.send_text(f"📂 文件列表（{len(lines)} 个）：\n" + "\n".join(lines) + "\n\n✅=已转化  📄=本地缓存  ⬇️=可从微信下载\n用法：读取文件 文件名", reply_to)
            else:
                wcf.send_text("[当前无已检测或已保存的文件]", reply_to)
            return

        # 读取/总结文件：读取文件 xxx 或 总结文件 xxx[，附加问题]
        # 支持自然语言变体：读取一下文件xxx、帮我读取文件xxx等
        LOG.info(f"[指令匹配] q={q[:80]!r}")
        m = re.match(r'^(?:帮我|请)?\.?(读取|总结|分析|翻译)(?:一下)?文件[\s：:]+(.+)$', q)
        if not m:
            # 备用：更宽松匹配（允许前缀杂字符）
            m = re.search(r'(读取|总结|分析|翻译)文件[\s：:]+(.+)$', q)
            if m:
                LOG.info(f"[指令匹配] 备用regex命中: action={m.group(1)} file={m.group(2)[:40]}")
        if m:
            action = m.group(1).strip()
            raw = m.group(2).strip()
            reply_to = msg.roomid if is_group else msg.sender
            # 逗号/句号后面的内容作为附加问题，前面才是文件名
            parts = re.split(r'[，,。\s]{1,3}(?=[\u4e00-\u9fff])', raw, maxsplit=1)
            filename = parts[0].strip()
            extra_q = parts[1].strip() if len(parts) > 1 else ""

            # 先检查转化状态
            for stem, info in _file_convert_status.items():
                if stem == filename or stem.startswith(filename) or filename in stem:
                    if info["status"] == "converting":
                        wcf.send_text(f"⏳ 文件《{info.get('name', stem)}》正在转化中，请稍后再试", reply_to)
                        return
                    elif info["status"] == "error":
                        wcf.send_text(f"❌ 文件《{info.get('name', stem)}》转化失败，无法读取", reply_to)
                        return
                    break

            found_path = None
            # 优先搜已转换保存的 FILE_SAVE_DIR（.md 文件）
            for f in FILE_SAVE_DIR.iterdir():
                if f.stem == filename or f.name == filename or f.stem.startswith(filename) or f.name.startswith(filename):
                    found_path = str(f)
                    break
            # 再搜微信缓存原始文件
            if not found_path:
                for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                    for f in files:
                        if f == filename or f.startswith(filename):
                            found_path = os.path.join(root_dir, f)
                            break
                    if found_path:
                        break
            if not found_path:
                # 本地没找到，尝试从微信DB按需下载
                wcf.send_text(f"⏳ 正在从微信下载《{filename}》...", reply_to)
                found_path = _try_download_from_db(wcf, filename)
                if found_path:
                    # 下载成功，复制并转化保存
                    tmp_path = FILE_SAVE_DIR / Path(found_path).name
                    shutil.copy2(found_path, tmp_path)
                    md_text, _ = convert_to_markdown(str(tmp_path))
                    if tmp_path.suffix.lower() not in (".md", ".txt"):
                        tmp_path.unlink(missing_ok=True)
                    if md_text:
                        save_path = FILE_SAVE_DIR / f"{Path(found_path).stem}.md"
                        save_path.write_text(md_text, encoding="utf-8")
                        found_path = str(save_path)
                        LOG.info(f"[按需下载] 转化保存: {save_path}")
                    else:
                        wcf.send_text(f"❌ 文件《{filename}》下载后解析失败", reply_to)
                        return
                else:
                    wcf.send_text(f"[未找到文件《{filename}》，请确认文件名正确，或文件已过期]", reply_to)
                    return
            ext = Path(found_path).suffix.lower()
            if ext not in CONVERTIBLE_EXTS and ext != ".md":
                wcf.send_text(f"[不支持 {ext} 格式]", reply_to)
                return
            file_text = extract_file_text(found_path)
            if not file_text:
                wcf.send_text(f"[文件内容为空或解析失败]", reply_to)
                return
            LOG.info(f"读取文件 {found_path}，{len(file_text)} 字符")
            task = extra_q if extra_q else f"请{action}这个文件"
            query = f"以下是文件《{Path(found_path).name}》的内容：\n{file_text[:100000]}\n\n{task}"

        # 保存记忆：记住 xxx（让AI生成内容保存）或 记住 名字：内容
        m = re.match(r'^记住[：::\s]+([^：:]+)[：:](.+)$', q, re.DOTALL)
        if m:
            name = m.group(1).strip()
            content = m.group(2).strip()
            saved = memory_save(name, content)
            wcf.send_text(f"相关记忆已保存到 {saved}。", msg.roomid if is_group else msg.sender)
            return

        time.sleep(0.5)
        reply = ask_ai(session_id, query, context_lines if is_group else None)
        LOG.info(f"回复 [{session_id}]: {reply[:80]}")

        if is_group:
            wcf.send_text(reply, msg.roomid, msg.sender)
        else:
            wcf.send_text(reply, msg.sender)

    except Exception as e:
        LOG.error(f"处理消息出错: {e}", exc_info=True)


def safe_handle(wcf: Wcf, msg: WxMsg):
    try:
        handle_msg(wcf, msg)
    except Exception as e:
        LOG.error(f"handle_msg 未捕获异常: {e}", exc_info=True)


def recv_loop(wcf: Wcf):
    LOG.info("消息接收循环已启动")
    empty_count = 0
    HEARTBEAT_INTERVAL = 10  # 连续10次Empty后检测心跳
    while wcf.is_receiving_msg():
        try:
            msg = wcf.get_msg()
            empty_count = 0  # 收到消息，重置计数
            LOG.debug(f"收到原始消息 type={msg.type} roomid={msg.roomid} sender={msg.sender}")
            if msg.type == 49:
                LOG.debug("type=49 跳过（DLL层crash风险）")
                continue
            Thread(target=safe_handle, args=(wcf, msg), daemon=True).start()
        except Empty:
            empty_count += 1
            if empty_count >= HEARTBEAT_INTERVAL:
                empty_count = 0
                # 心跳：检查 WeChat.exe 进程是否存活（比 wcf API 快得多）
                result = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq WeChat.exe", "/NH"],
                    capture_output=True, text=True, timeout=5
                )
                if "WeChat.exe" not in result.stdout:
                    LOG.warning("心跳检测：WeChat.exe 进程不存在，微信已退出")
                    return
        except Exception as e:
            LOG.error(f"接收消息出错: {e}", exc_info=True)


def _auto_click_login():
    """后台线程：监控微信登录窗口自动点击登录，同时监控 WxInitSDK 注入失败弹窗自动关闭。"""
    try:
        from pywinauto import Application, Desktop
    except ImportError:
        LOG.warning("[自动登录] pywinauto 未安装，跳过")
        return
    LOG.info("[自动登录] 后台监控已启动，等待登录窗口...")
    login_clicked = False
    for _ in range(60):
        try:
            # 优先检测"注入失败"弹窗并自动关闭
            try:
                for win in Desktop(backend='uia').windows():
                    if 'WxInitSDK' in win.window_text() or '注入失败' in win.window_text():
                        try:
                            btn = win.child_window(title='确定', control_type='Button')
                            if btn.exists(timeout=0):
                                btn.click_input()
                                LOG.warning("[自动登录] 已关闭「注入失败」弹窗")
                        except Exception:
                            try:
                                win.close()
                            except Exception:
                                pass
            except Exception:
                pass

            if login_clicked:
                time.sleep(1)
                continue

            # 检测微信登录窗口
            app = Application(backend='uia').connect(path='WeChat.exe', timeout=2)
            dlg = app.window(title='微信')
            if not dlg.exists(timeout=1):
                time.sleep(1)
                continue
            for btn_name in ['进入微信', '登录', '登錄', 'Enter WeChat', 'Log In']:
                try:
                    btn = dlg.child_window(title=btn_name, control_type='Button')
                    if btn.exists(timeout=1):
                        btn.click_input()
                        LOG.info(f"[自动登录] 已点击「{btn_name}」按钮")
                        login_clicked = True
                        break
                except Exception:
                    continue
            if not login_clicked:
                try:
                    dlg.set_focus()
                    import pywinauto.keyboard as kb
                    kb.send_keys('{ENTER}')
                    LOG.info("[自动登录] 已发送 Enter 键")
                    login_clicked = True
                except Exception:
                    pass
        except Exception:
            time.sleep(1)
    LOG.info("[自动登录] 监控线程结束")


def _kill_wechat():
    """强制结束所有 WeChat 相关进程 + 释放 wcferry 端口，确保注入前环境干净"""
    # 第一轮：wmic 删除所有 WeChat 相关进程（比 taskkill 更彻底）
    try:
        subprocess.run(
            ['wmic', 'process', 'where', "name like '%WeChat%'", 'delete'],
            capture_output=True, timeout=10
        )
    except Exception:
        pass
    # 第二轮：taskkill 兜底
    for proc_name in ["WeChat.exe", "WeChatUtility.exe", "WeChatPlayer.exe",
                       "WeChatBrowser.exe", "WeChatAppEx.exe"]:
        try:
            subprocess.run(["taskkill", "/F", "/IM", proc_name, "/T"],
                           capture_output=True, timeout=5)
        except Exception:
            pass
    # 释放 wcferry 占用的端口（10086/10087）
    for port in [10086, 10087]:
        try:
            r = subprocess.run(
                ["netstat", "-ano", "-p", "TCP"],
                capture_output=True, text=True, timeout=5
            )
            for line in r.stdout.splitlines():
                if f":{port}" in line and ("LISTENING" in line or "ESTABLISHED" in line):
                    parts = line.split()
                    pid = parts[-1]
                    if pid.isdigit() and int(pid) > 0:
                        subprocess.run(["taskkill", "/F", "/PID", pid],
                                       capture_output=True, timeout=5)
                        LOG.info(f"[清理] 已杀死占用端口 {port} 的进程 PID={pid}")
        except Exception:
            pass
    # 等待进程完全退出
    time.sleep(5)
    # 验证是否清理干净
    r = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq WeChat.exe", "/NH"],
        capture_output=True, text=True, timeout=5
    )
    if "WeChat.exe" in r.stdout:
        LOG.warning("[清理] WeChat.exe 仍在运行，再次强杀...")
        subprocess.run(["taskkill", "/F", "/IM", "WeChat.exe"], capture_output=True, timeout=5)
        time.sleep(3)
    LOG.info("[清理] 微信进程和端口清理完成")


class _WcfInitError(Exception):
    """Wcf() 初始化失败（注入失败或连接失败）时抛出，防止 os._exit 杀死进程"""
    pass


def _init_wcf():
    """初始化 wcferry 连接，解析白名单群，返回 Wcf 实例。
    Monkey-patch os._exit 防止 wcferry 注入失败时杀死整个进程，改为可重试的异常。"""
    global _global_wcf
    _real_exit = os._exit

    def _fake_exit(code):
        raise _WcfInitError(f"wcferry 调用了 os._exit({code})，已拦截")

    os._exit = _fake_exit
    try:
        wcf = Wcf()
    finally:
        os._exit = _real_exit  # 无论成功失败都恢复

    wcf.enable_receiving_msg()
    _global_wcf = wcf
    LOG.info(f"微信连接成功，当前账号 wxid: {wcf.get_self_wxid()}")
    info = wcf.get_user_info()
    LOG.info(f"账号昵称: {info.get('name')}  微信号: {info.get('wxid')}")

    if GROUP_WHITELIST:
        group_whitelist_ids.clear()
        contacts = wcf.get_contacts()
        for c in contacts:
            if c.get('name') in GROUP_WHITELIST:
                group_whitelist_ids.add(c.get('wxid'))
                LOG.info(f"白名单群: {c.get('name')} -> {c.get('wxid')}")
        if not group_whitelist_ids:
            LOG.warning(f"未找到白名单群 {GROUP_WHITELIST}，将监听所有群（请确认群名正确）")
    else:
        LOG.info("未设置 GROUP_WHITELIST，将响应所有群的触发词消息")
    return wcf


def main():
    global _global_wcf, _file_watcher_started
    LOG.info(f"正在启动 wcferry，AI 供应商: {AI_PROVIDER} ({AI_MODEL})")
    LOG.info("请确保微信 3.9.x 已登录...")

    RECONNECT_INTERVAL = 10  # 断开后每隔10秒尝试重连
    WECHAT_EXE = os.getenv("WECHAT_EXE", r"D:\vx3.9\WeChat\WeChat.exe")
    MAX_INJECT_RETRIES = 3   # 注入最多尝试次数

    while True:
        wcf = None
        try:
            for attempt in range(1, MAX_INJECT_RETRIES + 1):
                # 检查微信是否在运行
                r = subprocess.run(
                    ["tasklist", "/FI", "IMAGENAME eq WeChat.exe", "/NH"],
                    capture_output=True, text=True, timeout=5
                )
                wechat_running = "WeChat.exe" in r.stdout

                if not wechat_running:
                    if attempt > 1:
                        _kill_wechat()  # 清理残留
                    LOG.info(f"[注入] 微信未运行，手动启动: {WECHAT_EXE}")
                    subprocess.Popen([WECHAT_EXE], shell=False)
                    Thread(target=_auto_click_login, daemon=True).start()
                    LOG.info("[注入] 等待微信启动和登录（30秒）...")
                    time.sleep(30)
                else:
                    LOG.info("[注入] 微信已在运行")
                    Thread(target=_auto_click_login, daemon=True).start()

                try:
                    LOG.info(f"[注入] 第 {attempt}/{MAX_INJECT_RETRIES} 次尝试...")
                    wcf = _init_wcf()
                    break  # 注入成功
                except _WcfInitError as e:
                    LOG.warning(f"[注入] 第 {attempt} 次失败: {e}")
                    _kill_wechat()  # 失败后清理，为下一次做准备
                    if attempt >= MAX_INJECT_RETRIES:
                        raise

            # 文件监控线程只启动一次（使用 _global_wcf，重连后自动跟随）
            if not _file_watcher_started:
                _file_watcher_started = True
                Thread(target=_file_watcher, daemon=True).start()

            # 重连后：查微信数据库恢复 crash 前的文件消息
            Thread(target=_recover_files_from_db, args=(wcf, group_whitelist_ids), daemon=True).start()

            recv_loop(wcf)
            # recv_loop 正常退出 = wcferry 断开（微信crash或退出）
            LOG.warning("⚠️ 消息接收循环退出，微信可能已断开")

        except KeyboardInterrupt:
            LOG.info("收到 Ctrl+C，正在退出...")
            break
        except Exception as e:
            LOG.error(f"wcferry 连接异常: {e}", exc_info=True)
        finally:
            _global_wcf = None
            if wcf:
                try:
                    wcf.disable_receiving_msg()
                except Exception:
                    pass
                try:
                    wcf.cleanup()
                except Exception:
                    pass

        LOG.info(f"⏳ {RECONNECT_INTERVAL} 秒后尝试重新连接微信...")
        time.sleep(RECONNECT_INTERVAL)


if __name__ == "__main__":
    main()
