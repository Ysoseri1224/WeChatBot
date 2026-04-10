# WeChatBot

基于 [wcferry](https://github.com/lich0821/WeChatFerry) 的微信群聊 AI 机器人，支持多 AI 供应商、文件读取、长期记忆、笔记、日程提醒。

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
| `@bot 列出文件` / `@bot ls文件` | 列出所有可读文件 |
| `@bot 总结文件 文件名[，问题]` | 读取已保存文件并总结 |
| `@bot 读取文件 文件名[，问题]` | 读取文件并按问题回答 |
| `@bot 分析文件 文件名` | 分析文件内容 |
| `@bot 翻译文件 文件名` | 翻译文件内容 |
| `@bot 新增笔记 名称，内容` | 保存一条笔记 |
| `@bot 列出笔记` | 列出所有笔记 |
| `@bot 查看笔记 名称` | 查看某条笔记（支持模糊匹配） |
| `@bot 创建日程 DD/MM/YY HH:MM 名称[，内容]` | 创建日程（不带参数时回复格式模板） |
| `@bot 列出日程` | 列出所有日程 |
| `@bot 查询日程 名称/日期/周几` | 按名称、日期或星期查询 |
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

公众号/服务号（`gh_` 前缀）消息会被自动过滤。

### 日程提醒

日程存于 `memory/schedules.db`（SQLite），提醒时间基于北京时间（UTC+8）：

- 每天 **07:00** 发送当日所有日程到白名单群
- 日程时间**前 1 小时**再提醒一次

群消息中出现时间关键词（"下周/明天/后天/月/号/点"等）时，bot 会自动询问是否创建日程，确认格式：`@bot DD/MM/YY,HH:MM,周X`，群内任何人发都算。

### 笔记

笔记以 txt 格式存于 `memory/notes/`，支持模糊名称匹配。

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
- `gpt` — OpenAI
- `deepseek` — DeepSeek
- `claude` — Anthropic Claude
- `minimax` — MiniMax

## 开机自启

以管理员身份运行一次：
```powershell
.\install_autostart.ps1
```

## 注意事项

- 需要微信 **3.9.12.51** 版本，其他版本不兼容
- 必须以**管理员身份**运行
- 处理 `.doc`/`.ppt`/`.xls` 需额外安装 LibreOffice 并配置 `SOFFICE_PATH`

---

## CHANGELOG

### v1.1.0 (2026-03-26)

#### 笔记与日程

这个版本加了两块独立功能：笔记和日程，顺带把群消息里的时间自动检测也做了。

**笔记**很简单，`新增笔记 名称，内容` 存成 txt，`查看笔记` 支持模糊匹配，没什么可说的。

**日程**稍微复杂一些，主要在存储格式和查询上花了点时间。最终选了 SQLite——年月日时分周各存一个字段，查询时可以自由组合，比如只发"3月"或"周五"都能匹配，txt/json 做不到这一点。提醒逻辑是一个每分钟检查一次的后台线程，每天 07:00 发当日日程，日程前 1 小时再发一次，用字段记录是否已发防重复。时区显式用 UTC+8，不依赖系统设置。

**时间自动检测**：群里任何消息先过一遍正则（"下周/明天/后天/月/号/点"等关键词），命中了才异步调 AI 提取规范化时间，避免每条消息都花 API。提取到多个时间点时全部列出让用户选，5 分钟内无人确认自动清理 pending 状态。确认格式 `@W. DD/MM/YY,HH:MM,周X`，任何群成员发都算。

#### 新增指令
- `新增笔记 名称，内容` / `列出笔记` / `查看笔记 名称`
- `创建日程 DD/MM/YY HH:MM 名称[，内容]`（不带参数时回复格式模板）
- `列出日程` / `查询日程 名称/日期/周几`

#### 其他
- `memory/notes/` 目录存笔记，`memory/schedules.db` 存日程
- 帮助菜单同步更新

---

### v1.1.1 (2026-04-10)

#### HTTP 推送服务（Sub Recorder 集成）

新增轻量 HTTP 推送接口，使 Sub Recorder 等外部服务可直接向微信发送通知消息，无需额外依赖，仅使用 Python 标准库。

- **`POST /notify`**：接受 JSON `{"to": "wxid/群id", "msg": "消息内容", "token": "..."}` 推送消息到指定接收方
- **`GET /health`**：返回当前微信连接状态与消息队列长度
- **消息队列 + 重试 worker**：推送入队后由独立线程发送；微信断开时消息不丢失，自动等待重连后重发（容量 200 条）
- **`run.bat` 守护循环**：bot 退出后自动等待 5 秒重启
- **`.env` 配置项**：`PUSH_PORT`（监听端口，默认 5700）、`PUSH_TOKEN`（鉴权 Token，可选）

**Sub Recorder 配置方式：** 通知设置 → 添加「微信 Bot」渠道，推送地址填 `http://127.0.0.1:5700/notify`（Docker 内改用 `host.docker.internal`）。

---

### v1.0.0 (2026-03-25)

#### 文件读取功能跑通

这个版本把文件读取的完整流程串起来了：用户发文件 → 微信缓存落盘 → bot 搜索匹配 → 转成 Markdown → 缓存 → 喂给 AI。

**折腾过程：**

一开始想的很直接：拦截 type=49 消息 → `download_attach` 下载 → 解析 → 发 AI。结果发现 wcferry 的 DLL 在收到 type=49 时会让微信在几秒后崩溃，Python 层根本拦不住，哪怕 `recv_loop` 里直接 `continue` 也照崩不误。

然后试了几条路，都不太行：
1. **存 JSON**：收到 type=49 马上把消息信息写 JSON，crash 后重连再下载。但微信崩得太快，JSON 经常写一半就断了。
2. **查数据库**：crash 后查微信本地 DB 找漏掉的 type=49 消息，再下载。能查到，但 `thumb` 和 `extra` 字段拿不到，下载不稳定。
3. **Pending 模式**：学图片的处理方式，收到文件先存内存，等 @bot 再处理。但 crash 一来内存里的数据也没了。
4. **绕开 type=49**：最后想明白了，不拦消息了。`recv_loop` 跳过 type=49，文件交给后台监控线程自动检测，或者用户用 `读取文件` 指令直接从微信缓存目录和数据库里找。


#### 新增
- `读取文件`/`总结文件`/`分析文件`/`翻译文件` 指令：依次搜已转化缓存 → 微信本地缓存 → 数据库下载；多个匹配时列出文件名和时间让用户选
- 首次读取 `.docx`/`.pptx`/`.pdf` 等格式时自动转 Markdown 并缓存到 `memory/files/`，下次直接用缓存
- `ls文件`/`列出文件` 指令：展示所有可读文件（✅已转化 📄本地缓存 ⬇️可从微信下载）

#### 代码清理
- `recv_loop` 跳过 type=49（DLL 层 crash 没办法）
- 删掉 `_process_incoming_file`、`_file_process_lock`、pending file handler 等不再用的代码
- 文件指令改成严格格式匹配，去掉模糊匹配

#### Bug 修复
- 文件名拆分正则误把空格+中文当分隔符
- `tmp_path.unlink` 在 Windows 下文件锁未释放时炸掉 `handle_msg`
- `FILE_SAVE_DIR` 残留 `.docx` 和微信缓存重复匹配

### v0.4.0 (2026-03-24)

#### 文件处理方式改写

微信发送文件（docx/xlsx/pptx 等）时，wcferry 接收到 type=49 消息会导致微信在几秒后崩溃，根源在 DLL 注入层，Python 层无论如何处理都拦不住。排查后确认与代码逻辑无关，解决方法只能是绕开：不再拦截 type=49 消息，改用文件系统监控线程替代。

**方案：**

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
