# AIGC-Yunzai

- 基于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)

项目仅供学习交流使用，严禁用于任何商业用途和非法行为

---

## 新增

- AI框架集成: ai对话，一些简单的任务实现等
- 定时任务: 定时清理/更新git仓库/代理配置更新(仅Linux)
- 好友申请/群邀请可通知/手动处理
- 渲染器server: 可被非yunzai生态的项目使用，默认挂载到 1134 端口

## 改动

- 适配器: 只保留 `OneBotv11,  GSUIDClient, stdin` 适配器，`GSUIDClient` 直连 `早柚核心`，`OneBotv11` 适配更多接口(移除频道接口)
- 渲染器: 更换为 `playwright`，同时解耦 chromium 与 渲染，chromium 作为公共实例存在，可被插件使用，以减少资源浪费 (需注意: 使用[ZZZ-Plugin](https://github.com/ZZZure/ZZZ-Plugin)插件时需要将渲染精度调整至50，不然协议端会爆炸的...)
- 移除: 复读.js, install.js, add.js

## AI

<details><summary>简要说明</summary>

接入 Gemini 大模型，让 bot 能聊天、能看能听、能干活

| 类型 | 接收  |   发送    |
| ---- | :---: | :-------: |
| 文本 |   ✅   |     ✅     |
| 图片 |   ✅   |     ✅     |
| 视频 |   ✅   |     ✅     |
| 文件 |   ✅   |     ✅     |
| 语音 |   ✅   |     ✅     |
| 卡片 |   ✅   | ⚠️(仅音乐) |

**AI 能做什么**

- 日常聊天：带上下文与小长期记忆，隔天也记得你，至多存在近10天的记忆
- 多模态交互：发图片/视频/文件/语音，它不仅能看还能发
- 联网能力：搜索、浏览网页
- 画图渲染：把 Markdown/HTML 渲染成精美长图
- 干点小事：群管理、点赞互动、定时提醒、后台任务(理论上能通过脚本/命令实现的几乎都可以)
- 主动发言: 群内可主动参考上下文来参与群聊天
- 自我防御: 能自己选择不回复或拉黑
- 正则触发: 通过 skills 与内置工具搭配可让ai直接代替用户通过正则触发插件功能，且结果对ai可见，插件方0修改即可做到插件即工具，仅需自行编写一个 SKILL.md 放到对应插件目录下，含name: 插件名，description: 插件功能描述(100字以内)，tools: run_cmd 即可 (尽可能只写立即返回图片/文本类的功能)，agent 的 skills 放到 `config\skills\xxx\SKILL.md`，该 skills 是后台跑任务用的，自行参考主流实现(仅支持name，description，tools这三个字段)


**插件 SKILL.md 示例**

```md
---
name: yuki-plugin
description: 提供B站查询/开关动态B站推送等功能
tools: run_cmd
---

# yuki-plugin

本插件提供B站查询/开关动态B站推送等功能

## 仅 群主 或 bot owner (master) 可用

| 指令                   | 说明                                                        |
| ---------------------- | ----------------------------------------------------------- |
| `#B站up主昵称：<名称>` | (示例 `#B站up主昵称：鸣潮`) 搜索B站up主获取UID              |
| `#B站订阅列表`         | 查看本群订阅了哪些up主的动态推送                            |
| `#订阅B站推送<UID>`    | (示例 `#订阅B站推送123456789`) 为本群订阅指定up主的动态推送 |
| `#取消B站推送<UID>`    | (示例 `#取消B站推送123456789`) 为本群取消指定up主的动态推送 |
```

## 注意事项

- 一点小特性: 它在未回复前是可以被打断的，比如连续发送几条消息，它都是可以同时接受并一次回复的，但会消耗掉对应次数的请求次数，因此免费层级需要自备多个不同项目的key供轮询使用，否则容易429
- 当前仅适配Gemini API，支持Gemini3系列和gemma系列(不推荐)，不兼容3系以下，国内环境需代理或反代才能使用
- [高危且不稳定] 后台 Agent 可在宿主机直接执行命令，这意味着 Agent 的能力边界接近 Bot 进程本身：它能访问什么，取决于 Bot 进程的系统权限、运行用户、工作目录和操作系统限制，自行判断安全边界，默认不启用
- 搜索工具当前使用[外置后端](https://github.com/kvcfdd/metasearch)，需自行搭建，建议使用主流搜索源提供的MCP接入
- FFmpeg 在AI架构中多处使用，未安装可能会有很多问题，而后台任务时大概率会跑 Python 脚本，未安装也可能有一些问题(它也有可能自己给你装了)
- 插件 skills 仅给ai提供指令参考，不能内置除 SKILL.md 外的其它文件

推荐使用[锅巴插件](https://github.com/kvcfdd/guoba-plugin)进行配置

</details>

## 公共实例

<details><summary>实例调用</summary>

Chromium 以单例存在于 `lib/renderer/browser.js`

**方式一：队列任务**

经 `browser.runTask()` 进入统一并发队列：超出 `browser.concurrency` 的任务自动排队，任务结束后自动计入重启阈值与空闲回收逻辑

```js
import browser from "../../../lib/renderer/browser.js" // 相对路径按自身位置调整

return browser.runTask(async () => {
  let context = null
  try {
    const chromium = await browser.getBrowser()
    context = await chromium.newContext({ viewport: { width: 1080, height: 720 } })
    const page = await context.newPage()
    // ...页面操作与截图...
  } finally {
    if (context) await context.close().catch(() => {})
  }
})
```

**方式二：直连实例**

```js
import browser from "../../../lib/renderer/browser.js"

browser.startTask() // 必须与 endTask 成对出现
let context = null
try {
  const chromium = await browser.getBrowser()
  // ...渲染逻辑...
} finally {
  if (context) await context.close().catch(() => {})
  browser.endTask()
}
```

**直连与队列的区别**

|               | 队列任务 `runTask`                          | 直连实例                          |
| ------------- | ------------------------------------------- | --------------------------------- |
| 并发限制      | 受 `browser.concurrency` 槽位限制，超出排队 | 不受限，可叠加在队列任务之上      |
| 重启/回收计数 | 任务结束自动计入                            | 需手动 `startTask`/`endTask` 计入 |

**注意事项**

- 实例只会在活跃计数为 0 时才会被重启或空闲回收关停。直连时必须成对调用 `startTask`/`endTask`，才能保证使用期间实例不被关停；若只取实例不计数，实例可能在使用中途被重启/回收
- 直连方式不受并发槽限制，高峰期会与队列任务叠加多个 Chromium 上下文，内存占用自行评估
- 任务结束关闭自己的 context，避免上下文堆积

</details>

---

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
