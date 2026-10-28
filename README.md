# AIGC-Yunzai

- 基于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)

项目仅供学习交流使用，严禁用于任何商业用途和非法行为


> 本项目可能失去对部分插件的兼容，建议使用[源库](https://github.com/TimeRainStarSky/Yunzai)  
> 自3.3.0版本后不再依赖Redis

---

## 新增

- AI框架集成: 暂不稳定，不建议使用涅，咕咕中...
- 定时任务: 定时清理/更新git仓库/代理配置更新(仅Linux)
- 好友申请/群邀请可通知/手动处理
- 渲染器server: 可被非yunzai生态的项目使用，默认挂载到 1134 端口

## 改动

- 适配器: 只保留 `OneBotv11,  GSUIDClient, stdin` 适配器，`GSUIDClient` 直连 `早柚核心`，`OneBotv11` 适配更多接口(移除频道接口)
- 渲染器: 更换为 `playwright`，同时解耦 chromium 与 渲染，chromium 作为公共实例存在，可被插件使用，以减少资源浪费
- 移除: 复读.js, install.js, add.js
- 不再依赖Redis

## AI

暂无说明

## 公共实例

<details><summary>实例调用</summary>

Chromium 以单例存在于 `lib/renderer/browser.js`


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


**注意事项**

- 任务结束记得关闭自己的 context，避免上下文堆积
- 所有调用必须经 `browser.runTask()` 进入统一并发队列：超出 `browser.concurrency` 的任务自动排队，任务结束后自动计入重启阈值与空闲回收逻辑

</details>

---

## 安装教程

> 环境准备：Windows/Linux/MacOS/Android  
> [Node.js(>=v24.16)](https://nodejs.org), [Git](https://git-scm.com), [FFmpeg](https://ffmpeg.org)

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
