import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"

const events = []
const botEm = (name, data) => events.push({ name, data })

globalThis.Bot = {
  adapter: [],
  bots: {},
  uin: [],
  stat: {},
  makeLog() {},
  String(value) {
    if (typeof value === "string") return value
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  },
  mkdir: async dir => fs.mkdir(dir, { recursive: true }),
  em: botEm,
}

const { QQBotInstance } = await import("../../plugins/adapter/QQBot.js")

function makeAdapter() {
  const adapter = new QQBotInstance({ appid: "10086" })
  adapter.appid = "10086"
  adapter.selfId = "10086"
  adapter.nickname = "测试机器人"
  adapter.replyText = false
  adapter.passiveReply = true
  adapter.sdk = {
    self_id: "10086",
    group: () => ({ botState: async () => null, info: async () => ({ group_name: "测试群" }) }),
    user: () => ({ send: async () => ({ id: "S0" }) }),
  }
  return adapter
}

function groupEvent(extra = {}) {
  return {
    message_type: "group",
    sub_type: "normal",
    group_id: "G1",
    id: "M1",
    message_id: "M1",
    user_id: "U1",
    timestamp: "2026-11-20T20:00:00Z",
    sender: { user_openid: "U1", user_name: "用户", member_nickname: "群昵称", avatar: "//example.com/u.png", permissions: ["admin"] },
    message: [{ type: "text", data: { text: "#测试" } }],
    mentions: [],
    raw_message: "#测试",
    toJSON() {
      return { id: this.id, group_id: this.group_id }
    },
    ...extra,
  }
}

test("QQBot: 群消息转换与 atBot", async () => {
  const adapter = makeAdapter()
  events.length = 0
  adapter.getGroupName = async () => "测试群"
  adapter.refreshGroupState = () => {}

  const event = groupEvent({
    group_name: "测试群",
    message: [
      { type: "at", data: { user_id: "10086", username: "测试机器人" } },
      { type: "text", data: { text: " #帮助" } },
      { type: "image", data: { url: "//example.com/a.jpg", name: "a.jpg" } },
      { type: "face", data: { id: 14 } },
    ],
    mentions: [{ id: "10086", username: "测试机器人", is_you: true }],
    raw_message: "<at,user=10086> #帮助<image>",
  })
  await adapter.handleGroupMessage(event)

  assert.equal(events.length, 1)
  const data = events[0].data
  assert.equal(events[0].name, "message.group.normal")
  assert.equal(data.self_id, "10086")
  assert.equal(data.group_id, "G1")
  assert.equal(data.user_id, "U1")
  assert.equal(data.group_name, "测试群")
  assert.equal(data.sender.role, "admin")
  assert.ok(data.message.some(item => item.type === "at" && item.qq === "10086"))
  assert.equal(data.message.find(item => item.type === "image").url, "https://example.com/a.jpg")
  assert.equal(data.message.find(item => item.type === "face").id, 14)
  assert.equal(adapter.gml.get("G1").get("U1").role, "admin")
  assert.equal(adapter.passivePools.get("group:G1")[0].id, "M1")

  adapter.gml.get("G1").set("10086", { role: "owner" })
  const group = adapter.pickGroup("G1")
  assert.equal(group.is_owner, true)
  assert.equal(group.is_admin, true)
})

test("QQBot: 群消息按 sub_type 判定 atBot", async () => {
  const adapter = makeAdapter()
  adapter.getGroupName = async () => "测试群"
  adapter.refreshGroupState = () => {}

  events.length = 0
  await adapter.handleGroupMessage(groupEvent({ group_name: "测试群", sub_type: "normal", message: [{ type: "text", data: { text: "普通消息" } }] }))
  assert.ok(!events[0].data.message.some(item => item.type === "at" && item.qq === "10086"))

  events.length = 0
  await adapter.handleGroupMessage(groupEvent({ group_name: "测试群", sub_type: "at", message: [{ type: "text", data: { text: "普通消息" } }] }))
  assert.ok(events[0].data.message.some(item => item.type === "at" && item.qq === "10086"))
})

test("QQBot: 发送时兼容 OneBot 段并抑制自身 at", async () => {
  const adapter = makeAdapter()
  const calls = []
  adapter.sendEntities = async (target, elements, context) => {
    calls.push({ target, elements, source: context?.provider?.next() })
    return { id: `S${calls.length}` }
  }
  adapter.rememberMessage("group", "G2", { message_id: "M2", msg_idx: "REFIDX_SELF" })

  await adapter.sendTo({ kind: "group", id: "G2" }, [
    { type: "text", data: { text: "hi" } },
    { type: "at", data: { qq: "U2" } },
    { type: "at", data: { qq: "10086" } },
    { type: "face", id: 14 },
  ])

  assert.equal(calls.length, 1)
  assert.deepEqual(
    calls[0].elements.map(item => item.type),
    ["text", "at", "face"],
  )
  assert.equal(calls[0].elements[1].data.user_id, "U2")
  assert.equal(calls[0].source.id, "M2")

  await adapter.sendTo({ kind: "group", id: "G2" }, [
    { type: "text", data: "gscore" },
    { type: "at", data: "U2" },
  ])
  assert.deepEqual(
    calls[1].elements.map(item => item.type),
    ["text", "at"],
  )
  assert.equal(calls[1].elements[0].data.text, "gscore")
  assert.equal(calls[1].elements[1].data.user_id, "U2")
})

test("QQBot: 引用索引与媒体分开发送", async () => {
  const adapter = makeAdapter()
  const calls = []
  adapter.sendEntities = async (target, elements, context) => {
    calls.push({ target, elements, source: context?.provider?.next() })
    return { id: `S${calls.length}` }
  }
  adapter.rememberMessage("c2c", "U3", { message_id: "M3" })

  const ret = await adapter.sendTo({ kind: "c2c", id: "U3" }, [{ type: "reply", id: "REFIDX_OTHER" }, "hello", { type: "image", file: Buffer.from([0x89, 0x50, 0x4e, 0x47]) }])

  assert.equal(calls.length, 2)
  assert.equal(calls[0].elements[0].type, "reply")
  assert.equal(calls[0].elements[0].data.ref_idx, "REFIDX_OTHER")
  assert.equal(calls[1].elements[0].type, "image")
  assert.equal(calls[0].source.id, "M3")
  assert.deepEqual(ret.message_id, ["S1", "S2"])
})

test("QQBot: Markdown 开关与回退", async () => {
  const adapter = makeAdapter()
  const calls = []
  adapter.sendEntities = async (target, elements) => {
    calls.push(elements)
    if (elements.some(item => item.type === "markdown")) throw new Error("不允许发送原生 markdown")
    return { id: "OK" }
  }

  adapter.replyText = false
  await adapter.sendTo({ kind: "c2c", id: "U4" }, [{ type: "markdown", data: { content: "hello" } }])
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0].type, "markdown")
  assert.equal(calls[1][0].type, "text")

  calls.length = 0
  adapter.replyText = true
  await adapter.sendTo({ kind: "c2c", id: "U4" }, [{ type: "markdown", data: { content: "hello" } }])
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0].type, "text")
  assert.equal(calls[0][0].data.text, "hello")
})

test("QQBot: 音频转腾讯 silk 后发送", async () => {
  const sampleRate = 24000
  const pcm = Buffer.alloc(sampleRate / 10)
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  const wav = Buffer.concat([header, pcm])

  const adapter = makeAdapter()
  const calls = []
  adapter.sendEntities = async (target, elements) => {
    calls.push(elements)
    return { id: "OK" }
  }
  await adapter.sendTo({ kind: "c2c", id: "U5" }, [{ type: "record", file: wav, name: "voice.wav" }])

  assert.equal(calls.length, 1)
  const audio = calls[0][0]
  assert.equal(audio.type, "audio")
  assert.equal(audio.data.name, "voice.silk")
  assert.equal(audio.data.file[0], 0x02)
  assert.equal(audio.data.file.subarray(1, 10).toString(), "#!SILK_V3")
})

test("QQBot: 文件上传后按被动回复发送", async () => {
  const adapter = makeAdapter()
  const uploads = []
  const posts = []
  adapter.sdk = {
    self_id: "10086",
    group: () => ({
      upload: async (file, options) => {
        uploads.push({ file, options })
        return { file_info: "FILE_INFO", file_uuid: "FILE_UUID", ttl: 0 }
      },
    }),
    request: {
      post: async (endpoint, payload) => {
        posts.push({ endpoint, payload })
        return { data: { id: "FILE_MSG" } }
      },
    },
  }
  adapter.rememberMessage("group", "G3", { message_id: "M3" })

  const ret = await adapter.sendTo({ kind: "group", id: "G3" }, [{ type: "file", file: Buffer.from("data"), name: "a.txt" }])
  assert.equal(uploads.length, 1)
  assert.deepEqual(uploads[0].options, { fileType: 4, fileName: "a.txt", sendMessage: false })
  assert.equal(posts[0].endpoint, "/v2/groups/G3/messages")
  assert.equal(posts[0].payload.msg_id, "M3")
  assert.equal(posts[0].payload.msg_type, 7)
  assert.equal(posts[0].payload.media.file_info, "FILE_INFO")
  assert.equal(ret.message_id, "FILE_MSG")
})

test("QQBot: 使用 SDK 构建发送载荷", async () => {
  const adapter = makeAdapter()
  const { Bot: SDKBot, ReceiverMode } = await import("qq-official-bot")
  const client = new SDKBot({ appid: "20000", secret: "secret", mode: ReceiverMode.WEBSOCKET, intents: ["GROUP_AND_C2C_EVENT"], logLevel: "off", handleProcessErrors: false })
  const posts = []
  client.request.post = async (url, data) => {
    posts.push({ url, data })
    return { data: { id: "SEND" } }
  }
  adapter.sdk = client
  adapter.replyText = false
  adapter.rememberMessage("group", "G8", { message_id: "SRC" })

  const ret = await adapter.sendTo({ kind: "group", id: "G8" }, ["hi", { type: "at", qq: "U8" }])
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, "/v2/groups/G8/messages")
  assert.equal(posts[0].data.msg_id, "SRC")
  assert.equal(posts[0].data.msg_type, 2)
  assert.match(posts[0].data.content, /hi/)
  assert.match(posts[0].data.content, /<qqbot-at-user id="U8" \/>/)
  assert.equal(ret.message_id, "SEND")
})

test("QQBot: SDK 事件解析与适配器监听", async () => {
  const adapter = makeAdapter()
  const { Bot: SDKBot, ReceiverMode } = await import("qq-official-bot")
  const client = new SDKBot({ appid: "10086", secret: "secret", mode: ReceiverMode.WEBSOCKET, intents: ["GROUP_AND_C2C_EVENT"], logLevel: "off", handleProcessErrors: false })
  adapter.sdk = client
  adapter.getGroupName = async () => "SDK群"
  adapter.refreshGroupState = () => {}
  adapter.bindEvents()
  events.length = 0

  client.dispatchEvent("GROUP_AT_MESSAGE_CREATE", {
    op: 0,
    s: 1,
    t: "GROUP_AT_MESSAGE_CREATE",
    id: "EV1",
    d: {
      id: "SDK_MSG",
      group_openid: "G9",
      content: '<qqbot-at-user id="BOT" /> #指令',
      timestamp: "2026-11-20T20:00:00Z",
      author: { id: "U9", member_openid: "U9", username: "用户", avatar: "//example.com/u.png" },
      mentions: [{ id: "BOT", member_openid: "BOT", username: "测试机器人", is_you: true }],
    },
  })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.equal(events.length, 1)
  const data = events[0].data
  assert.equal(data.group_id, "G9")
  assert.equal(data.user_id, "U9")
  assert.equal(data.message_id, "SDK_MSG")
  assert.ok(data.message.some(item => item.type === "at" && item.qq === "10086"))
  assert.match(data.message.find(item => item.type === "text").text, /#指令/)
  assert.ok(!data.message.some(item => item.type === "text" && item.text.includes("<qqbot-at-user")))
})
