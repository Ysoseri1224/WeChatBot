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

### v1.0.0 (2026-03-25)

#### 重大更新：文件读取功能完整可用

经过多轮调试和架构调整，文件读取功能终于跑通了完整链路：用户发送文件 → 微信缓存落盘 → bot 检测/搜索 → 转化为 Markdown → 缓存 → 发送给 AI 回答。这个版本标志着 bot 从"能对话"升级为"能读文件的助手"。

**探索历程：**

这个功能的实现走了不少弯路。最初的设想很简单：拦截 type=49 消息 → 调用 `download_attach` 下载 → 解析内容 → 发给 AI。但 wcferry 的 DLL 注入层在接收 type=49 消息时会导致微信在 5-10 秒后崩溃，这个问题在 Python 层完全无法阻止（即使 `recv_loop` 中直接 `continue` 跳过也会 crash）。

于是尝试了多种方案：
1. **JSON 持久化方案**：收到 type=49 后立即将消息元数据存入 JSON 文件，crash 后重连时读取并下载。但 crash 来得太快，JSON 往往还没写完微信就退出了。
2. **数据库恢复方案**：crash 后查询微信本地数据库找到未处理的 type=49 消息，再调用 `download_attach`。能查到消息但下载成功率不稳定（缺少 `thumb` 和 `extra` 字段）。
3. **Pending 模式**：模仿图片处理的 pending 模式，收到文件时存入内存，@bot 时再处理。但 type=49 的 crash 使得 pending 数据也保不住。
4. **最终方案——完全脱离 type=49**：`recv_loop` 彻底跳过 type=49 消息，文件靠后台监控线程自动检测 + 用户按需指令读取。不再试图"拦截"文件消息，而是直接从微信缓存目录和数据库中"捞"文件。

**关键 bug 修复过程：**

即使架构确定后，`读取文件` 指令仍然不工作。逐步排查发现了三个叠加的问题：
- **文件名拆分 bug**：正则表达式 `[\s，,。]{1,3}(?=[\u4e00-\u9fff])` 会把 `2023英文科技写作` 拆成 `2023` + `英文科技写作`（空格后跟中文字符触发了拆分）。改为只在逗号处分割。
- **PermissionError**：转化完成后删除临时 `.docx` 副本时，Windows 文件锁还没释放，导致 `unlink` 抛异常并中断整个 `handle_msg`。加 `try/except` 兜住。
- **已转化文件去重**：`FILE_SAVE_DIR` 中残留的 `.docx` 副本（因上述 PermissionError 删除失败）被当成"已转化"文件，与微信缓存中的同名文件重复匹配，用户无法选择。改为 `FILE_SAVE_DIR` 只识别 `.md/.txt`。
- **AI 拒绝读取**：文件内容已成功传给 AI，但 GPT 看到"文件"二字就条件反射回复"我无法读取文件"。修改 prompt 明确标注内容已由系统提取，禁止 AI 说无法读取。

#### 新增功能
- **按需文件读取**（`读取文件`/`总结文件`/`分析文件`/`翻译文件`）：三级搜索（已转化缓存 → 微信本地缓存 → 数据库下载），多匹配时列出文件名和时间戳让用户精确选择
- **自动格式转化与缓存**：首次读取 `.docx`/`.pptx`/`.pdf` 等格式时自动转为 Markdown 并缓存到 `memory/files/`，后续读取直接使用缓存
- **`ls文件`/`列出文件`指令**：展示所有可用文件（✅已转化 📄本地缓存 ⬇️可从微信下载）

#### 架构变更
- `recv_loop` 彻底跳过 type=49 消息（DLL 层 crash 无法阻止）
- 移除 `_process_incoming_file`（废弃的即时处理函数）
- 移除 `_file_process_lock`（不再需要文件处理串行锁）
- 移除 pending file handler（type=49 已跳过，不会再有 pending 文件）
- 文件读取指令改为严格命令格式，去掉模糊自然语言匹配

#### Bug 修复
- 修复文件名拆分正则把空格+中文误识别为分隔符的 bug
- 修复 `tmp_path.unlink` 在 Windows 下因文件锁抛 `PermissionError` 导致整个消息处理中断
- 修复 `FILE_SAVE_DIR` 中残留 `.docx` 与微信缓存重复匹配的问题
- 修复 AI 收到文件内容后仍回复"无法读取文件"的 prompt 问题

---

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
