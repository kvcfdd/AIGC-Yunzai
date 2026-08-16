# AIGC-Yunzai

- 基于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)

项目仅供学习交流使用，严禁用于任何商业用途和非法行为

---

## 新增

- AI框架集成: ai对话，一些简单的任务实现等
- 定时任务: 定时清理/更新git仓库/代理配置更新(仅Linux)
- 好友申请/群邀请可通知/手动处理
- 渲染器server: 可被非yunzai生态的项目使用，默认挂载到 http://localhost:1134

## 改动

- 适配器: 只保留 `OneBotv11,  GSUIDClient, stdin` 适配器，`GSUIDClient` 直连 `早柚核心`，`OneBotv11` 适配更多接口(移除频道接口)
- 渲染器: 更换为 `playwright`，同时解耦 chromium 与 渲染，chromium 作为公共实例存在，可被插件使用，以减少资源浪费
- 移除: 复读.js, install.js

## AI 简单说明

<details><summary>>>>点击展开<<<</summary>

接入 Gemini 大模型，让 bot 能聊天、能看能听、能干活

| 类型 | 接收 | 发送 |
| ---- | :--: | :--: |
| 文本 | ✅ | ✅ |
| 图片 | ✅ | ✅ |
| 视频 | ✅ | ✅ |
| 文件 | ✅ | ✅ |
| 语音 | ✅ | ✅ |
| 卡片 | ✅(仅部分) | ✅(仅音乐) |

**AI 能做什么**

- 日常聊天：带上下文与小长期记忆，隔天也记得你，至多存在近10天的记忆
- 多模态交互：发图片/视频/文件/语音，它不仅能看还能发
- 联网能力：搜索、浏览网页
- 画图渲染：把 Markdown/HTML 渲染成精美长图
- 干点小事：群管理、点赞互动、定时提醒、后台任务(能通过脚本/命令实现的几乎都可以)
- 主动发言: 群内可主动参考上下文来参与群聊天

## 注意事项

- 当前仅适配Gemini模型，国内环境需代理或反代才能使用
- 后台 Agent 可在宿主机直接执行命令，这意味着 Agent 的能力边界接近 Bot 进程本身：它能访问什么，取决于 Bot 进程的系统权限、运行用户、工作目录和操作系统限制，自行判断安全边界，默认不启用
- 搜索工具当前使用[外置后端](https://github.com/kvcfdd/metasearch)，需自行搭建
- FFmpeg 在AI架构中多处使用，未安装可能会有很多问题，而后台任务时大概率会跑 Python 脚本，未安装也可能有一些问题(它也有可能自己给你装了)

</details>

## 安装教程

> 环境准备：Windows/Linux/MacOS/Android  
> [Node.js(>=v24.16)](https://nodejs.org), [Valkey](https://valkey.io), [Git](https://git-scm.com), [FFmpeg](https://ffmpeg.org), [Python(建议)](https://www.python.org)

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
