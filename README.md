# AIGC-Yunzai

- 基于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)
- 融合了 AI 对话引擎，让机器人由 LLM 驱动

## 主要改动

- **AI 对话引擎** — 完整的 LLM + 工具调用 + MCP 外部工具协议 + PCP 插件能力协议，支持知识库，长期记忆(LLM自控,这个得随缘)等...
- **PCP 协议** — 插件功能自动暴露为 LLM 可调用的工具，LLM 可以以此触发对应功能(需插件方适配)
- **NapCat 适配器** — 针对NCQQ适配
- **公共浏览器实例** — 迁移至playwright渲染器，增加一个给其它非云崽生态项目使用的渲染器，以及LLM工具中使用的浏览器皆为同一个实例，以降低资源消耗

## 安装

> 环境准备：Windows/Linux/MacOS/Android  
> [Node.js(>=v23.11)](https://nodejs.org), [Valkey](https://valkey.io), [Git](https://git-scm.com)

```bash
# 克隆
git clone https://github.com/kvcfdd/AIGC-Yunzai
cd AIGC-Yunzai

# 安装依赖
npm i -g pnpm
pnpm i

# 安装Playwright浏览器  Windows
npx playwright install chromium
# 安装Playwright浏览器  Linux
npx playwright install --with-deps chromium

# 启动
node app
```

推荐使用[锅巴插件](https://github.com/kvcfdd/guoba-plugin)配置

## WebSocket

<details>
<summary>展开查看</summary>

```bash
# 原版OneBotv11
ws://localhost:2536/OneBotv11

# NapCat版
ws://localhost:2536/NapCat
```

</details>

## AI 内置工具

<details>
<summary>展开查看 12 个内置工具</summary>

| 工具           | 说明                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `search`       | 搜索互联网，支持网页/图片/音乐/视频(需搭建[搜索服务](https://github.com/kvcfdd/metasearch)) |
| `browse`       | 抓取网页提取正文内容                                                                        |
| `fetch_image`  | 将图片转为 LLM 可识别的格式，可传 referer 防防盗链                                          |
| `send_image`   | 下载图片并发送到聊天                                                                        |
| `send_media`   | 发送网易云音乐卡片或 B 站视频(需配置B站ck)                                                  |
| `render`       | 渲染 Markdown/HTML 为图片或视频                                                             |
| `query`        | 查询 Bot 主人或指定用户的身份信息                                                           |
| `group_admin`  | 群管理：踢人、禁言、设管理、改名片、公告等                                                  |
| `interact`     | 互动：点赞、戳一戳、柴郡猫表情包                                                            |
| `memory`       | 管理用户长期记忆，支持保存和删除                                                            |
| `block`        | 将用户加入黑名单                                                                            |
| `enable_voice` | 启用语音回复(一次性，需配置key)                                                             |

</details>

## PCP 插件能力协议

<details>
<summary>展开查看 PCP 协议说明</summary>

在插件构造函数中声明 `tools[]`，方法自动暴露为 LLM 可调用的 Function Calling 工具。LLM 会根据描述决定何时调用、传入什么参数，你的方法只管实现功能逻辑。

### 快速开始

```js
export class MyPlugin extends plugin {
  constructor() {
    super({
      name: "我的插件",
      tools: [
        {
          fnc: "myTool",                       // 方法名
          description: "工具描述，LLM 据此判断何时调用",
          params: {                             // 可选，简化格式自动展开为 JSON Schema
            target: { type: "number", desc: "目标QQ", required: true },
            scope:  { type: "string", desc: "范围", enum: ["basic", "full"] },
          },
          permission: "all",                    // all(默认) / admin / owner / master
        },
      ]
    })
  }

  async myTool(args, ctx) {
    // this.e     — 当前消息事件上下文，可直接 this.reply() 发送消息
    // args       — LLM 传入的参数，如 { target: 123456, scope: "full" }
    // ctx        — 工具调用上下文

    // 发送图片 LLM 也能看到——桥接层自动提取并回传
    await this.reply(segment.image("path/to/img.png"))

    return "结果"  // 字符串 → LLM 转述给用户
  }
}
```

### 声明字段

| 字段          | 必填 | 说明                                                                                                |
| ------------- | ---- | --------------------------------------------------------------------------------------------------- |
| `fnc`         | ✅    | 插件方法名                                                                                          |
| `description` | ✅    | 工具描述，LLM 根据此描述判断何时调用、如何填参                                                      |
| `params`      | ❌    | `{ key: { type, desc, enum?, optional?, default?, items? } }`，自动展开为 JSON Schema               |
| `permission`  | ❌    | `"all"`(默认) / `"admin"` / `"owner"` / `"master"`，权限不足 LLM 会收到提示                         |
| `reply`       | ❌    | 设为 `true` 表示 handler 自行 `this.reply()`，返回值固定为 `"[已发送]"`；不设也行——桥接层会自动检测 |

### 返回值

| 返回值                  | 效果                                                           |
| ----------------------- | -------------------------------------------------------------- |
| `"字符串"`              | 返回给 LLM，LLM 转述给用户                                     |
| `this.reply()` 后不返回 | 自动返回 `"[已发送]"`（检测到 reply 调用）                     |
| 发送图片 + 不返回       | 自动返回 `{ images: [...], text: "[已发送]" }`，LLM 可看到图片 |


</details>

---

## 致谢

| Nickname                                                     | Contribution       |
| ------------------------------------------------------------ | ------------------ |
| [Yunzai-Bot](https://gitee.com/le-niao/Yunzai-Bot)           | 乐神的 Yunzai-Bot  |
| [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai) | 喵喵的 Miao-Yunzai |
| [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)     | TRSS-Yunzai        |
