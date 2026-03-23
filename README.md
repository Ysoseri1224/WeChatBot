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
pip install wcferry python-dotenv openai python-docx pymupdf

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
| `@bot 总结文件 文件名[，问题]` | 读取微信缓存中的文件并总结 |
| `@bot 读取文件 文件名[，问题]` | 读取文件并按问题回答 |
| `@bot 分析文件 文件名` | 分析文件内容 |
| `@bot 翻译文件 文件名` | 翻译文件内容 |
| `@bot 列出记忆` / `@bot ls` | 列出所有长期记忆文件 |
| `@bot 记住 名字：内容` | 保存长期记忆 |
| `@bot 读取记忆 名字` | 查看某条记忆 |
| `@bot 删除记忆 名字` | 删除某条记忆 |

### 支持的文件格式
- PDF、DOCX、TXT、MD

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
