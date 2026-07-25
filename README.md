# AIGC-Yunzai

- 基于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)
- 融合了 AI 对话引擎(仅Gemini)，让机器人由 LLM 驱动
  
项目仅供学习交流使用，严禁用于任何商业用途和非法行为

## 安装教程

> 环境准备：Windows/Linux/MacOS/Android  
> [Node.js(>=v23.11)](https://nodejs.org), [Valkey](https://valkey.io), [Git](https://git-scm.com)

1. Git Clone 项目

```sh
git clone --depth=1 https://github.com/kvcfdd/AIGC-Yunzai.git
```

2. 安装 [pnpm](https://pnpm.io/zh/installation) 和依赖以及Playwright浏览器

```sh
cd AIGC-Yunzai
npm i -g pnpm
pnpm i
npx playwright install chromium
```

3. 前台运行

| 操作 | 命令          |
| ---- | ------------- |
| 启动 | node .        |
| 停止 | node . stop   |
| 守护 | node . daemon |

4. 使用 [pm2](https://pm2.keymetrics.io) 后台运行

| 操作 | 命令       |
| ---- | ---------- |
| 启动 | pnpm start |
| 停止 | pnpm stop  |
| 日志 | pnpm log   |

5. 开机自启

```sh
pnpm start
pnpm pm2 save
pnpm pm2 startup
```

6. 启动协议端(OneBotv11)，选择反向 WebSocket 配置

```yaml
ws://localhost:2536/OneBotv11
```

7. 设置主人：发送 `#设置主人`，日志获取验证码并发送


---

## 致谢

| Nickname                                                     | Contribution       |
| ------------------------------------------------------------ | ------------------ |
| [Yunzai-Bot](https://gitee.com/le-niao/Yunzai-Bot)           | 乐神的 Yunzai-Bot  |
| [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai) | 喵喵的 Miao-Yunzai |
| [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)     | TRSS-Yunzai        |
