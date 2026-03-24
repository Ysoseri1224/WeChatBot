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
    """收到文件后异步执行：直接用 extra 路径读取文件，转换为 MD 并保存，回复结果"""
    with _file_process_lock:  # 串行处理，防止并发crash
        # 规范化路径，去除多余空白和不可见字符
        extra_path = os.path.normpath(extra_path.strip()) if extra_path else ""
        extra_dir = str(Path(extra_path).parent) if extra_path else ""

        def _find_file():
            # 1. 直接用 extra 路径
            if extra_path and os.path.isfile(extra_path):
                return extra_path
            # 2. 在 extra 同目录下按文件名（含前缀匹配）搜索
            if extra_dir and os.path.isdir(extra_dir):
                stem = Path(filename).stem
                ext = Path(filename).suffix.lower()
                for f in os.listdir(extra_dir):
                    fp = os.path.join(extra_dir, f)
                    if os.path.isfile(fp) and f.lower().endswith(ext) and Path(f).stem.startswith(stem):
                        LOG.debug(f"兜底找到文件: {fp}")
                        return fp
            return None

        found_path = None
        for _ in range(5):
            found_path = _find_file()
            if found_path:
                break
            time.sleep(1)

        if not found_path:
            LOG.warning(f"文件未找到: {filename} (extra={extra_path})")
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

            # 文件消息(type=49)：跳过，由文件监控线程处理（wcferry处理type=49会导致微信crash）
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
                at_tag = f"@{wcf.get_user_info()['name']}"
                query = content.replace(at_tag, "").strip()

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

            # 有待处理文件：去微信缓存目录按文件名搜索
            if pending and pending["type"] == "file":
                filename = pending.get("filename", "")
                found_path = None
                for root_dir, dirs, files in os.walk(WECHAT_FILE_DIR):
                    for f in files:
                        if f == filename:
                            found_path = os.path.join(root_dir, f)
                            break
                    if found_path:
                        break
                if not found_path:
                    wcf.send_text(f"[未找到文件《{filename}》，请确认文件已下载到本地]", msg.roomid, msg.sender)
                    return
                ext = Path(filename).suffix.lower()
                if ext not in (".docx", ".md", ".pdf", ".txt"):
                    wcf.send_text(f"[不支持 {ext}，支持 docx/md/pdf/txt]", msg.roomid, msg.sender)
                    return
                file_text = extract_file_text(found_path)
                if not file_text:
                    wcf.send_text(f"[文件《{filename}》内容为空或解析失败]", msg.roomid, msg.sender)
                    return
                LOG.info(f"读取文件 {filename}，{len(file_text)} 字符")
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
            if not _file_convert_status:
                # 也列出 FILE_SAVE_DIR 中已有的 md 文件
                existing = [f.stem for f in FILE_SAVE_DIR.iterdir() if f.suffix == ".md"]
                if existing:
                    lines = [f"  ✅ {s}" for s in existing]
                    wcf.send_text(f"📂 已保存的文件（{len(lines)} 个）：\n" + "\n".join(lines), reply_to)
                else:
                    wcf.send_text("[当前无已检测或已保存的文件]", reply_to)
            else:
                status_map = {"converting": "⏳转化中", "done": "✅已完成", "error": "❌失败"}
                lines = []
                for stem, info in _file_convert_status.items():
                    s = status_map.get(info.get("status", ""), "❓")
                    lines.append(f"  {s} {info.get('name', stem)}")
                # 补充 FILE_SAVE_DIR 中早期保存但不在 status 中的文件
                for f in FILE_SAVE_DIR.iterdir():
                    if f.suffix == ".md" and f.stem not in _file_convert_status:
                        lines.append(f"  ✅ {f.name}")
                wcf.send_text(f"📂 文件列表（{len(lines)} 个）：\n" + "\n".join(lines) + "\n\n已完成的可用：读取文件 文件名", reply_to)
            return

        # 读取/总结文件：读取文件 xxx 或 总结文件 xxx[，附加问题]
        m = re.match(r'^(读取|总结|分析|翻译)文件[\s：:]+(.+)$', q)
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
                wcf.send_text(f"[未找到文件《{filename}》，请确认文件名正确]", reply_to)
                return
            ext = Path(found_path).suffix.lower()
            if ext not in CONVERTIBLE_EXTS:
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
            # type=49(文件/链接)会导致微信crash，尽早丢弃，不访问任何其他属性
            if msg.type == 49:
                continue
            LOG.debug(f"收到原始消息 type={msg.type} roomid={msg.roomid} sender={msg.sender} content={str(msg.content)[:80]}")
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
    """后台线程：持续监控微信登录窗口，出现则自动点击登录按钮。"""
    try:
        from pywinauto import Application
    except ImportError:
        LOG.warning("[自动登录] pywinauto 未安装，跳过")
        return
    LOG.info("[自动登录] 后台监控已启动，等待登录窗口...")
    for _ in range(60):  # 最多等60秒
        try:
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
                        return
                except Exception:
                    continue
            # 兜底：发 Enter
            try:
                dlg.set_focus()
                import pywinauto.keyboard as kb
                kb.send_keys('{ENTER}')
                LOG.info("[自动登录] 已发送 Enter 键")
                return
            except Exception:
                pass
        except Exception:
            time.sleep(1)
    LOG.warning("[自动登录] 60秒内未检测到登录窗口")


def _init_wcf():
    """初始化 wcferry 连接，解析白名单群，返回 Wcf 实例"""
    global _global_wcf
    wcf = Wcf()
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

    while True:
        wcf = None
        try:
            # 后台线程监控登录窗口并自动点击（Wcf()会自己启动微信）
            Thread(target=_auto_click_login, daemon=True).start()
            wcf = _init_wcf()

            # 文件监控线程只启动一次（使用 _global_wcf，重连后自动跟随）
            if not _file_watcher_started:
                _file_watcher_started = True
                Thread(target=_file_watcher, daemon=True).start()

            # 重连后：通知群里断线期间检测到的新文件
            if _new_files_pending and group_whitelist_ids:
                status_map = {"converting": "⏳转化中", "done": "✅已完成", "error": "❌失败"}
                lines = []
                for stem in _new_files_pending:
                    info = _file_convert_status.get(stem, {})
                    s = status_map.get(info.get("status", ""), "❓未知")
                    name = info.get("name", stem)
                    lines.append(f"  {s} {name}")
                notice = f"📂 断线期间检测到 {len(lines)} 个新文件：\n" + "\n".join(lines)
                notice += "\n\n已完成的文件可直接使用：读取文件 文件名"
                for room_id in group_whitelist_ids:
                    try:
                        wcf.send_text(notice, room_id)
                    except Exception:
                        pass
                _new_files_pending.clear()

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
