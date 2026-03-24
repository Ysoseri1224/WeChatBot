# WeChatBot

基于 [wcferry](https://github.com/lich0821/WeChatFerry) 的微信群聊 AI 机器人，支持多 AI 供应商、文件读取、长期记忆。

## 环境要求

- 微信 PC 版 3.9.12.51（安装到固定路径）
- Python 3.10+
- wcferry 39.5.2.0

## 快速开始

```powershell
# 1. 克隆仓库
git clone https://github.com/Ysoseri1224/WeChatBot
cd WeChatBot

# 2. 创建虚拟环境
python -m venv venv
.\venv\Scripts\activate

# 3. 安装依赖
pip install wcferry python-dotenv openai python-docx pymupdf openpyxl python-pptx

# 4. 配置环境变量
copy .env.example .env
# 编辑 .env 填入 API Key 和微信文件路径

# 5. 启动（需要管理员权限，微信已登录）
.\venv\Scripts\python.exe bot.py
```

## 功能

### 触发方式
在白名单群里 `@机器人昵称` 即可触发（昵称取决于登录的微信小号）。

### 指令列表

以下示例中 `@bot` 代表你的机器人昵称。

| 指令 | 说明 |
|------|------|
| `@bot`（空） | 显示帮助菜单 |
| `@bot 你好` | 普通 AI 对话 |
| `@bot 总结文件 文件名[，问题]` | 读取已保存文件并总结 |
| `@bot 读取文件 文件名[，问题]` | 读取文件并按问题回答 |
| `@bot 分析文件 文件名` | 分析文件内容 |
| `@bot 翻译文件 文件名` | 翻译文件内容 |
| `@bot 列出记忆` / `@bot ls` | 列出所有长期记忆文件 |
| `@bot 记住 名字：内容` | 保存长期记忆 |
| `@bot 读取记忆 名字` | 查看某条记忆 |
| `@bot 删除记忆 名字` | 删除某条记忆 |
| `@bot clear` / `@bot 重置` | 清除当前对话上下文 |

### 文件自动处理

群里发送文件后，bot 会**自动**（无需 @）：
1. 等待文件出现在微信本地缓存目录
2. 转换为 Markdown 格式并保存到 `memory/files/`
3. 回复保存结果

之后可用 `@bot 总结文件 文件名` 进行提问。

### 支持的文件格式

| 格式 | 处理方式 |
|------|----------|
| `.pdf` | 直接提取文本 |
| `.docx` | 段落/标题/表格 → Markdown |
| `.xlsx` | 每个 Sheet → Markdown 表格 |
| `.pptx` | 每页文字提取 |
| `.doc` / `.ppt` / `.xls` | 需要 LibreOffice，自动转换后处理 |
| `.txt` / `.md` | 直接读取 |

> `.doc`/`.ppt`/`.xls` 需安装 [LibreOffice](https://www.libreoffice.org/)，并在 `.env` 中配置 `SOFFICE_PATH`。

### AI 供应商
在 `.env` 中修改 `AI_PROVIDER` 切换：
- `gpt` — OpenAI GPT-4o-mini
- `deepseek` — DeepSeek Chat
- `claude` — Anthropic Claude Haiku
- `minimax` — MiniMax M2.5

## 开机自启

以管理员身份运行一次：
```powershell
.\install_autostart.ps1
```

## 注意事项

- 需要微信 **3.9.12.51** 版本，其他版本不兼容
- 必须以**管理员身份**运行
- `.env` 文件含 API Key，已加入 `.gitignore`，**切勿提交**
- 处理 `.doc`/`.ppt`/`.xls` 需额外安装 LibreOffice 并配置 `SOFFICE_PATH`
- 公众号/服务号消息会被自动过滤，防止回复死循环

---

## CHANGELOG

### v0.4.0 (2026-03-24)

#### 重大变更：文件处理架构重写

**问题背景（type=49 crash 完整调试记录）：**

微信群聊中发送文件（docx/xlsx/pptx 等）时，wcferry 接收到的 type=49 消息会导致微信在 5-10 秒后崩溃（Pipe callback event 2）。这是 wcferry DLL 注入层的问题，Python 层无法阻止。

调试过程：
1. 最初发现发送 pptx 文件导致 bot 异常退出，怀疑是文件解析逻辑导致
2. 添加 `threading.Lock` 串行化文件处理 → 仍然 crash
3. 将异步 Thread 改为同步处理 → 仍然 crash（单文件也 crash）
4. 将 `_process_incoming_file` 中所有逻辑移除，type=49 收到后直接 return → 仍然 crash
5. 在 `recv_loop` 中 type=49 消息甚至不读取 `msg.content` 等属性直接 continue → 仍然 crash
6. 最终确认：crash 发生在 wcferry DLL 内部接收 type=49 消息时，与 Python 代码完全无关

**解决方案：**

- **文件系统监控线程**：不再依赖 type=49 消息拦截，改为后台线程每 5 秒轮询微信缓存目录（`WECHAT_FILE_DIR`），检测新文件并自动转换保存
- **type=49 静默跳过**：在 `recv_loop` 最早位置丢弃 type=49 消息，减少对微信的影响
- **自动恢复重连**：`main()` 改为无限循环，wcferry 断开后自动等待 10 秒重连，文件监控线程独立运行不受影响
- **复制后处理**：文件先复制到 `memory/files/` 再转换，不锁定微信缓存中的原始文件

#### 新增功能
- `导入文件为记忆 文件名[，记忆名]`：将已保存的文件内容直接导入为长期记忆
- 文件监控自动检测 + 转换 + 群通知（替代 type=49 消息拦截）
- wcferry 断开后自动重连（微信 crash 后重启即可恢复）

#### Bug 修复
- 修复 Python 3.9 下 `Path | None` 类型注解不兼容的问题（改用无返回值注解）
- 修复 `msg.extra` 路径规范化问题（`os.path.normpath` + `strip()`）
- 修复多文件并发处理导致的 crash（根本原因为 wcferry DLL 层问题，非并发问题）

### v0.3.0 (2026-03-24)
- 收到文件时自动解析并保存为 Markdown，无需 @bot 触发
- 新增 `docx`/`xlsx`/`pptx` 原生转 Markdown 支持
- 新增 `.doc`/`.ppt`/`.xls` 通过 LibreOffice 转换后处理
- `读取文件` 指令优先搜索已转换保存的 `memory/files/` 目录
- 新增 `clear`/`重置` 指令清除对话上下文
- 修复发送不支持格式文件（如 pptx）时导致微信闪退的问题
- 过滤公众号/服务号（`gh_` 前缀）消息，防止回复死循环

### v0.2.0 (2026-03-23)
- 新增长期记忆功能（`记住`/`列出记忆`/`读取记忆`/`删除记忆`）
- 记忆自动注入 AI system prompt
- `max_tokens` 提升至 4096，文件内容截断扩展至 100000 字符
- 新增 `@bot`（空消息）显示帮助菜单
- 修复 `install_autostart.ps1` 兼容性问题，改用 `schtasks`
- 新增 `run.bat` 双击启动脚本

### v0.1.0 (2026-03-22)
- 初始版本：wcferry 群聊 AI 机器人
- 支持 gpt/deepseek/claude/minimax 多供应商切换
- 群聊旁听缓冲区 + @bot 触发
- PDF/DOCX/MD/TXT 文件读取（按文件名搜索微信缓存）
- 图片发给视觉模型（GPT/Claude）
