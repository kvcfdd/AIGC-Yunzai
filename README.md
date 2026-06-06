# AIGC-Yunzai

- 基于 [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)
- 融合了 AI 对话引擎，让机器人由 LLM 驱动

## 主要改动

- **AI 对话引擎** — 完整的 LLM + 工具调用 + MCP 外部工具协议 + PCP 插件能力协议，支持知识库(不建议超过500条)，长期记忆(LLM自控,这个得随缘)等...
- **PCP 协议** — 插件功能自动暴露为 LLM 可调用的工具，LLM 可以以此触发对应功能(需插件方适配)
- **OneBotv11 适配器** — 针对NCQQ适配
- **公共浏览器实例** — 迁移至playwright渲染器，增加一个给其它非云崽生态项目使用的渲染器，以及LLM工具中使用的浏览器皆为同一个实例

## 安装

> 环境准备：Windows/Linux/MacOS/Android  
> [Node.js(>=v23.11)](https://nodejs.org), [Valkey](https://valkey.io), [Git](https://git-scm.com)

```bash
# 克隆
git clone https://github.com/kvcfdd/AIGC-Yunzai
cd AIGC-Yunzai

# 安装依赖
pnpm i

# 安装Playwright浏览器
npx playwright install chromium

# 启动
node app
```

推荐使用[锅巴插件](https://github.com/kvcfdd/guoba-plugin)配置

## AI 内置工具

<details>
<summary>展开查看 11 个内置工具</summary>

| 工具           | 说明                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------- |
| `search`       | 搜索互联网，支持网页/图片/音乐/视频(需搭建[搜索服务](https://github.com/kvcfdd/metasearch)) |
| `browse`       | 抓取网页提取正文内容                                                                        |
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

在插件构造函数中声明 `tools[]`，PCP 自动识别并注册为 LLM 可调用的 Function Calling 工具。与 MCP 对称——MCP 发现外部工具，PCP 发现本地插件能力，共享同一个 ToolRegistry

### 快速开始

```js
export class MyPlugin extends plugin {
  constructor() {
    super({
      name: "我的插件",
      rule: [
        { reg: /^#命令/, fnc: "myCmd" }       // 用户触发
      ],
      tools: [
        {
          fnc: "myTool",                       // LLM 调用
          description: "工具描述，LLM 靠此判断何时调用",
        }
      ]
    })
  }

  async myTool(args, ctx) {
    // args  — LLM 传入的已解析参数对象
    // ctx.event — 原始消息事件，包含 user_id、group_id、reply() 等所有上下文
    // this.reply() 可直接发送消息（需在声明中设 reply: true）
    return "结果"  // 字符串返回给 LLM，LLM 转述给用户
  }
}
```

### 完整示例

```js
export class MyPlugin extends plugin {
  constructor() {
    super({
      name: "示例",
      tools: [
        {
          fnc: "getInfo",
          description: "获取指定用户的详细信息",
          params: {
            target:  { type: "number", desc: "目标QQ号", required: true },
            scope:   { type: "string", desc: "查询范围", enum: ["basic", "full"], optional: true },
            force:   { type: "boolean", desc: "是否强制刷新缓存", optional: true },
          },
          permission: "admin",
        },
        {
          fnc: "sendReport",
          description: "生成并发送统计报告",
          reply: true,                             // handler 自行发送，返回值被抑制
        },
      ]
    })
  }

  async getInfo(args, ctx) {
    // 有返回值的模式 —— LLM 拿到结果后自行组织语言回复
    const { target, scope = "basic", force = false } = args
    return `用户 ${target} 的基本信息: ...`
  }

  async sendReport(args, ctx) {
    // reply 模式 —— 插件自行渲染图片/文件并发送
    const img = await this.renderImg("myPlugin", "report", {})
    await this.reply(img)
    return null  // 返回值被 PCP 抑制为 "[已发送]"
  }
}
```

### 声明字段

| 字段          | 必填 | 说明                                                                                                                |
| ------------- | ---- | ------------------------------------------------------------------------------------------------------------------- |
| `fnc`         | ✅    | 插件上的方法名，LLM 调用时执行                                                                                      |
| `description` | ✅    | 工具描述，LLM 根据此描述判断何时调用该工具。务必清晰准确                                                            |
| `params`      | ❌    | 参数定义，简化格式，PCP 自动展开为 OpenAI Function Calling 的 JSON Schema                                           |
| `permission`  | ❌    | `"all"`(默认) / `"admin"` / `"owner"` / `"master"`。权限不足时 LLM 会收到错误提示                                   |
| `reply`       | ❌    | `true` 时 handler 自行通过 `this.reply()` 发送消息，返回值被抑制为 `[已发送]`。默认为 `false`，即返回值直接交给 LLM |

### params 简化格式

PCP 将简化格式自动展开为标准 JSON Schema（`type`、`properties`、`description`、`enum`、`required[]`）。

支持的字段：

```js
params: {
  // 基础类型
  target:   { type: "number", desc: "目标QQ号", required: true },
  reason:   { type: "string", desc: "操作理由", optional: true },
  force:    { type: "boolean", desc: "是否强制执行", default: false },
  count:    { type: "integer", desc: "数量" },

  // 枚举
  scope:    { type: "string", desc: "统计范围", enum: ["global", "user", "group"] },
  game:     { type: "string", desc: "游戏", enum: ["gs", "sr"] },

  // 数组
  ids:      { type: "array", items: "number", desc: "批量QQ号" },

  // 嵌套对象
  filter:   { type: "object", properties: {
               star: { type: "integer", desc: "星级筛选" },
               elem: { type: "string", desc: "元素筛选" }
             }, optional: true },
}
```

展开规则：
- `type` / `desc` → JSON Schema `type` / `description`
- `enum` → JSON Schema `enum`
- `default` → JSON Schema `default`
- 未标 `optional` 或 `required: true` → 加入 `required[]`
- `type: "array"` + `items` → `{ type: "array", items: { type: "..." } }`
- `type: "object"` + `properties` → 递归展开嵌套
- 完全不写 `params` → 自动生成无参工具 `{ type: "object", properties: {} }`

### Handler 方法

方法的 `this` 指向 PCP 自动创建的插件实例，**`this.e` 已自动设置为原始消息事件**，可直接使用 `this.reply()`、`this.renderImg()` 等基类方法

```js
async myHandler(args, ctx) {
  // args      — LLM 传入的已解析参数对象
  // ctx.event — 原始消息事件，字段包括:
  //   user_id, group_id, self_id, isGroup, isPrivate, isMaster
  //   reply(msg), recall()
  //   msg, img, at, atBot
  //   sender, group, friend
  //   runtime (Miyoushe 运行时，含 UID/绑定信息)

  // 返回字符串 → LLM 视为工具结果，自行组织语言回复用户
  return "查询完成: ..."

  // 或: 调用 this.reply() + 返回字符串 → 两者同时生效
  // 适用于先发图再让 LLM 补充说明的场景
}
```

**reply 模式**（`reply: true`）适用于需要插件自行渲染图片/视频/文件的场景：

```js
async sendImage(args, ctx) {
  // 渲染图片并发送
  const img = await this.renderImg("myPlugin", "tpl", data)
  await this.reply(img)
  // 返回值被桥接层替换为 "[已发送]"，LLM 不会看到
}
```

### 权限模型

`permission` 字段与插件的 `rule` 权限一致：

| 值         | 含义               | 校验规则                                          |
| ---------- | ------------------ | ------------------------------------------------- |
| `"all"`    | 所有人可用（默认） | 无校验                                            |
| `"admin"`  | 群管理员           | 群聊 + 发送者是管理员或群主；私聊不可用           |
| `"owner"`  | 群主               | 群聊 + 发送者是群主；私聊不可用                   |
| `"master"` | bot 主人           | 发送者在 `config/other.yaml` 的 `masterQQ` 列表中 |

master 拥有所有权限。权限不足时，LLM 会收到 `"仅 xx 可用"` 的提示，由 LLM 决定如何告知用户

### 协议架构

```
启动时:
  PluginLoader.loadPlugin()
    → 创建插件实例，扫描 tools[]
    → Bot.emit("plugin:loaded", { key, className, instance })
      → PcpManager 接收事件
        → bridge.expandToolDef()
          ├─ 生成 name:   "{插件名}_{fnc}"
          ├─ 展开 params: → JSON Schema
          ├─ 生成 execute: → 权限校验 + new ClassName() + handler 调用
          └─ ToolRegistry.register()
            → LLM 对话时随 tool_defs 一并发送

运行时:
  LLM tool_calls → ToolRegistry.execute()
    → PCP 生成的 execute wrapper
      ├─ ctx.event 权限校验
      ├─ new ClassName() 实例化
      ├─ inst.e = e 设置上下文
      └─ handler(args, ctx) 调用插件方法

热更新:
  插件文件变更 → Loader 重载 → emit "plugin:loaded"(同一 key)
    → PcpManager: 先 unregister 旧工具 → 再 register 新工具
```

### 实际案例

**状态统计**（`plugins/system/status.js`）：

```js
tools: [
  {
    fnc: "getStatus",
    description: "获取机器人运行状态：版本、在线时长、内存使用、系统信息",
    permission: "master",
  },
  {
    fnc: "getStats",
    description: "查询消息统计数据（收发量、用户数、群数）",
    params: {
      scope:  { type: "string", desc: "统计范围", enum: ["global", "user", "group"] },
      target: { type: "number", desc: "用户或群号，scope=user/group 时指定", optional: true },
    },
    permission: "master",
  },
]

async getStatus() {
  return `—— AIGC Yunzai v${cfg.package.version} ——\n运行时间：${Bot.getTimeDiff()}\n内存：${...}MB`
}

async getStats(args) {
  const { scope = "global", target } = args || {}
  // ... 构造查询参数，调用已有逻辑
  return await this.getCount(cmd)
}
```

### 注意事项

- **工具名唯一性**：工具名由 `{插件名}_{fnc}` 自动生成并做清理（去特殊字符、限 64 字符），冲突时自动加 hash 后缀
- **`this.e` 上下文**：handler 中的 `this.e` 是 PCP 桥接层自动设置的原始消息事件，支持 `this.reply()` 等所有基类方法
- **构造器子对象陷阱**：PCP 桥接层以 `new ClassName()` 无参实例化插件，**构造器中传入子对象的 `e` 此时为 `undefined`**。若插件在构造器内 `this.xxx = new SubModel(e)` 创建了依赖事件上下文的子对象，需在 handler 的 PCP 分支手动同步 `this.xxx.e = this.e`，否则子对象内部访问 `this.e.xxx` 会抛出 `Cannot read properties of undefined`
- **并发**：`Promise.all` 并发执行多个 tool call，建议 handler 中通过 `{ ...ctx.event }` 创建独立事件副本避免竞态
- **返回值**：非 `reply` 模式下，`return null` 或 `return undefined` 会被转换为 `"[完成]"`；正常返回字符串则直接交给 LLM
- **非 reply 模式也可 reply**：即使没设 `reply: true`，handler 内部仍可调用 `this.reply()` 直接发消息（如发图），同时返回字符串给 LLM
- **`reply: true` 遗漏陷阱**：若 handler 的核心输出是 `this.reply()` 发出的图片/文件，**必须设 `reply: true`**，否则 LLM 拿到的是方法返回值（如 `true`/`undefined`），看不到有效结果可能反复调用同一工具造成死循环


**PCP为随意命名，无任何歧义，且处于尝试阶段，如需使用建议自己改改尝试即可**

</details>

---

## 致谢

| Nickname                                                     | Contribution       |
| ------------------------------------------------------------ | ------------------ |
| [Yunzai-Bot](https://gitee.com/le-niao/Yunzai-Bot)           | 乐神的 Yunzai-Bot  |
| [Miao-Yunzai](https://github.com/yoimiya-kokomi/Miao-Yunzai) | 喵喵的 Miao-Yunzai |
| [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai)     | TRSS-Yunzai        |
