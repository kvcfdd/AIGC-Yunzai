import test from "node:test"
import assert from "node:assert/strict"
import { createDialogue } from "../../lib/ai_core/core/dialogue.js"
import { RequestScheduler } from "../../lib/ai_core/core/request-scheduler.js"
import { CURRENT_TURN, STATUS_BAR } from "../../lib/ai_core/llm/message-builders.js"

globalThis.logger = { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
globalThis.Bot = { gml: new Map(), pickMember: () => null, aigc: { injectMessage() {} }, makeForwardMsg: async forwardMsg => forwardMsg.map(item => item.message?.data?.text ?? "") }
globalThis.segment = { at: qq => ({ type: "at", qq }), record: file => ({ type: "record", file }) }

test("dialogue: 单轮文本回复落盘并发送", async () => {
  const calls = { appended: 0, sent: [] }
  const provider = {
    async chat() {
      return { content: "你好" }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {
      calls.appended++
    },
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const dialogue = createDialogue({
    provider,
    memory,
    tools,
    skills,
    scheduler: new RequestScheduler(),
    config: { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } },
    redis: {},
  })

  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
    sender: { nickname: "U" },
  }
  const reply = async (msg, quote) => {
    calls.sent.push({ msg, quote })
  }

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply })

  assert.equal(calls.appended, 1)
  assert.equal(calls.sent.length, 1)
  assert.equal(calls.sent[0].msg, "你好")
  assert.equal(calls.sent[0].quote, false, "私聊强制不引用")
})

test("dialogue: 落盘后到达的打断不再阻止发送", async () => {
  const calls = { appended: 0, sent: [] }
  const provider = {
    async chat() {
      return { content: "最终回复" }
    },
  }
  let dialogue
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {
      calls.appended++
      dialogue.abort(event)
    },
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
    sender: { nickname: "U" },
  }

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply: async msg => calls.sent.push(msg) })

  assert.equal(calls.appended, 1)
  assert.deepEqual(calls.sent, ["最终回复"], "落盘即本轮结束，之后的打断不影响发送")
})

test("dialogue: 自动分条按顺序发送中间文本与终稿", async () => {
  let round = 0
  const provider = {
    async chat() {
      round++
      if (round === 1)
        return {
          content: "先查一下\n\n马上来",
          tool_calls: [{ id: "c1", type: "function", function: { name: "noop", arguments: "{}" } }],
        }
      return { content: "最终回复\n\n补充一句" }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
  }
  const tools = { getDefinitions: () => [], execute: async () => ({ result: "工具结果" }) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini", auto_split_max_chars: 200 } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    group_id: "g",
    isGroup: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
    sender: { nickname: "U" },
  }
  const sent = []
  const reply = async (msg, quote) => sent.push({ msg, quote })

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply })

  assert.deepEqual(
    sent.map(c => c.msg),
    ["先查一下", "马上来", "最终回复", "补充一句"],
    "中间文本与终稿按连续换行分条，顺序正确且无重复",
  )
  assert.deepEqual(
    sent.map(c => c.quote),
    [false, false, false, false],
    "中间文本不引用，10 秒内返回的终稿也不引用",
  )
})

test("dialogue: 回复耗时超过 10 秒时引用触发消息", async () => {
  const realNow = Date.now
  try {
    let now = realNow()
    Date.now = () => now
    const provider = {
      async chat() {
        now += 10_001
        return { content: "慢回复" }
      },
    }
    const memory = {
      sessionKey: () => ({ self_id: "s", user_id: "u" }),
      getMessages: async () => ({ messages: [], summary: "" }),
      appendRound: async () => {},
    }
    const tools = { getDefinitions: () => [], execute: async () => ({}) }
    const skills = { list: async () => [], get: async () => null }
    const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
    const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
    const event = { self_id: "s", user_id: "u", group_id: "g", isGroup: true, message: [{ type: "text", text: "hi" }], msg: "hi", sender: { nickname: "U" } }
    const sent = []

    await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply: async (msg, quote) => sent.push({ msg, quote }) })

    assert.deepEqual(sent, [{ msg: "慢回复", quote: true }], "超过 10 秒的回复引用触发消息")
  } finally {
    Date.now = realNow
  }
})

test("dialogue: 工具执行中插话后按插话时刻重新计时", async () => {
  const realNow = Date.now
  try {
    let now = realNow()
    Date.now = () => now
    let releaseTool
    const toolGate = new Promise(resolve => (releaseTool = resolve))
    let toolStarted
    const toolStartedP = new Promise(resolve => (toolStarted = resolve))
    let calls = 0
    const provider = {
      async chat() {
        calls++
        if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: "{}" } }] }
        return { content: "最终回复" }
      },
    }
    const tools = {
      getDefinitions: () => [],
      execute: async name => {
        toolStarted()
        await toolGate
        return { name, result: "工具结果" }
      },
    }
    const memory = {
      sessionKey: () => ({ self_id: "s", user_id: "u" }),
      getMessages: async () => ({ messages: [], summary: "" }),
      appendRound: async () => {},
    }
    const skills = { list: async () => [], get: async () => null }
    const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
    const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
    const event = { self_id: "s", user_id: "u", group_id: "g", isGroup: true, message: [{ type: "text", text: "第一条" }], msg: "第一条", sender: { nickname: "U" } }
    const sent = []
    const reply = async (msg, quote) => sent.push({ msg, quote })

    const first = dialogue.run({ event: { ...event }, userMsg: "第一条", isAmbient: false, reply })
    await toolStartedP
    now += 30_000
    await dialogue.run({ event: { ...event, message: [{ type: "text", text: "第二条" }], msg: "第二条" }, userMsg: "第二条", isAmbient: false, reply })
    releaseTool()
    await first

    assert.deepEqual(sent, [{ msg: "最终回复", quote: false }], "插话后 10 秒内返回，按插话时刻计时不引用")
  } finally {
    Date.now = realNow
  }
})

test("dialogue: 工具执行中追加消息不打断本轮", async () => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  let started
  const startedP = new Promise(resolve => (started = resolve))
  let calls = 0
  const provider = {
    async chat() {
      calls++
      if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: "{}" } }] }
      return { content: "最终回复" }
    },
  }
  const tools = {
    getDefinitions: () => [],
    execute: async name => {
      started()
      await gate
      return { name, result: "工具结果" }
    },
  }
  let appended
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async (sid, msgs) => {
      appended = msgs
    },
  }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "第一条" }],
    msg: "第一条",
    sender: { nickname: "U" },
  }
  const sent = []
  const reply = async msg => sent.push(msg)

  const first = dialogue.run({ event: { ...event }, userMsg: "第一条", isAmbient: false, reply })
  await startedP
  const secondResult = await dialogue.run({ event: { ...event, message: [{ type: "text", text: "第二条" }], msg: "第二条" }, userMsg: "第二条", isAmbient: false, reply })
  assert.equal(secondResult, false, "追加消息不启动新请求")
  release()
  await first

  assert.equal(calls, 2, "没有打断重发")
  assert.equal(sent.length, 1)
  assert.equal(sent[0], "最终回复")
  assert.deepEqual(
    appended.map(m => m.role),
    ["user", "assistant", "tool", "user", "assistant"],
  )
  assert.equal(appended[3].content, "第二条")
})

test("dialogue: 模型生成中插话打断旧请求，用旧+新输入和新环境上下文重发", async () => {
  let calls = 0
  const seen = []
  let started
  const startedP = new Promise(resolve => (started = resolve))
  const provider = {
    async chat(messages, opts) {
      calls++
      seen.push(messages)
      if (calls === 1) {
        started()
        await new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"))
          if (opts.signal.aborted) abort()
          else opts.signal.addEventListener("abort", abort, { once: true })
        })
      }
      return { content: "最终回复" }
    },
  }
  let appended
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async (sid, msgs) => {
      appended = msgs
    },
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "第一条" }],
    msg: "第一条",
    sender: { nickname: "U" },
  }
  const sent = []
  const reply = async msg => sent.push(msg)

  const first = dialogue.run({ event: { ...event }, userMsg: "第一条", isAmbient: false, reply })
  await startedP
  await dialogue.run({ event: { ...event, message: [{ type: "text", text: "第二条" }], msg: "第二条" }, userMsg: "第二条", isAmbient: false, reply })
  const firstResult = await first

  assert.equal(firstResult, false, "旧请求被中止且不发送")
  assert.equal(calls, 2, "旧模型请求中止后重新发起一次")
  assert.deepEqual(
    seen[1].filter(m => m.role === "user").map(m => m.content),
    ["第一条", "第二条"],
    "新请求包含旧+新 user",
  )
  assert.ok(seen[1].findLast(m => m.role === "user")?.runtime_context, "新请求带新的环境上下文")
  assert.equal(sent.length, 1)
  assert.equal(sent[0], "最终回复")
  assert.deepEqual(
    appended.map(m => m.role),
    ["user", "user", "assistant"],
  )
  assert.equal(appended[0].content, "第一条")
  assert.equal(appended[1].content, "第二条")
})

test("dialogue: 工具返回后的模型请求中插话也会打断，保留工具上下文并追加新 user", async () => {
  let calls = 0
  const seen = []
  let secondStarted
  const secondStartedP = new Promise(resolve => (secondStarted = resolve))
  const provider = {
    async chat(messages, opts) {
      calls++
      seen.push(messages)
      if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }
      if (calls === 2) {
        secondStarted()
        await new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"))
          if (opts.signal.aborted) abort()
          else opts.signal.addEventListener("abort", abort, { once: true })
        })
      }
      return { content: "最终回复" }
    },
  }
  let appended
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async (sid, msgs) => {
      appended = msgs
    },
  }
  const tools = {
    getDefinitions: () => [{ type: "function", function: { name: "f", parameters: {} } }],
    execute: async name => ({ name, result: "工具结果" }),
  }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "第一条" }],
    msg: "第一条",
    sender: { nickname: "U" },
  }
  const sent = []
  const reply = async msg => sent.push(msg)

  const first = dialogue.run({ event: { ...event }, userMsg: "第一条", isAmbient: false, reply })
  await secondStartedP
  await dialogue.run({ event: { ...event, message: [{ type: "text", text: "第二条" }], msg: "第二条" }, userMsg: "第二条", isAmbient: false, reply })
  const firstResult = await first

  assert.equal(firstResult, false, "旧请求被中止且不发送")
  assert.equal(calls, 3, "工具后的第二次模型请求被中止，新请求重新发起")
  assert.ok(
    seen[1].some(m => m.role === "tool"),
    "旧请求的第二次模型请求带工具结果",
  )
  const carriedUsers = seen[2].filter(m => m.role === "user")
  assert.deepEqual(
    carriedUsers.map(m => m.content),
    ["第一条", "第二条"],
    "新请求包含旧 user 和新 user",
  )
  assert.equal(carriedUsers[0][CURRENT_TURN], undefined, "被合并的旧 user 恢复时间前缀")
  assert.equal(carriedUsers[1][CURRENT_TURN], true, "最新 user 携带环境上下文")
  assert.ok(
    seen[2].some(m => m.role === "tool"),
    "旧工具结果保留在新请求中",
  )
  assert.ok(
    seen[2].some(m => m.role === "assistant" && m.tool_calls?.length),
    "旧工具调用保留在新请求中",
  )
  assert.equal(sent.length, 1)
  assert.equal(sent[0], "最终回复")
  assert.deepEqual(
    appended.map(m => m.role),
    ["user", "assistant", "tool", "user", "assistant"],
  )
  assert.equal(appended[0].content, "第一条")
  assert.equal(appended[3].content, "第二条")
})

test("dialogue: 工具阶段插话后模型阶段再插话，保留工具上下文且只保留最新环境", async () => {
  let calls = 0
  const seen = []
  let toolStarted
  const toolStartedP = new Promise(resolve => (toolStarted = resolve))
  let releaseTool
  const toolGate = new Promise(resolve => (releaseTool = resolve))
  let secondStarted
  const secondStartedP = new Promise(resolve => (secondStarted = resolve))
  const provider = {
    async chat(messages, opts) {
      calls++
      seen.push(messages)
      if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }
      if (calls === 2) {
        secondStarted()
        await new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"))
          if (opts.signal.aborted) abort()
          else opts.signal.addEventListener("abort", abort, { once: true })
        })
      }
      return { content: "最终回复" }
    },
  }
  let appended
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async (sid, msgs) => {
      appended = msgs
    },
  }
  const tools = {
    getDefinitions: () => [{ type: "function", function: { name: "f", parameters: {} } }],
    execute: async name => {
      toolStarted()
      await toolGate
      return { name, result: "工具结果" }
    },
  }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "第一条" }],
    msg: "第一条",
    sender: { nickname: "U" },
  }
  const sent = []
  const reply = async msg => sent.push(msg)

  const first = dialogue.run({ event: { ...event }, userMsg: "第一条", isAmbient: false, reply })
  await toolStartedP
  const secondResult = await dialogue.run({ event: { ...event, message: [{ type: "text", text: "第二条" }], msg: "第二条" }, userMsg: "第二条", isAmbient: false, reply })
  assert.equal(secondResult, false, "工具阶段追加不启动新请求")
  releaseTool()
  await secondStartedP
  await dialogue.run({ event: { ...event, message: [{ type: "text", text: "第三条" }], msg: "第三条" }, userMsg: "第三条", isAmbient: false, reply })
  const firstResult = await first

  assert.equal(firstResult, false, "旧请求被中止且不发送")
  assert.equal(calls, 3, "工具后的模型请求被中止，新请求重新发起")
  assert.deepEqual(
    seen[2].filter(m => m.role === "user").map(m => m.content),
    ["第一条", "第二条", "第三条"],
    "新请求保留旧 user 和工具阶段插入的 user",
  )
  assert.ok(
    seen[2].some(m => m.role === "tool"),
    "旧工具结果保留",
  )
  const users = seen[2].filter(m => m.role === "user")
  assert.equal(users.find(m => m.content === "第二条")?.runtime_context, undefined, "旧插入 user 的环境不保留")
  assert.ok(users.find(m => m.content === "第三条")?.runtime_context, "最新 user 带新环境")
  assert.equal(sent.length, 1)
  assert.equal(sent[0], "最终回复")
  assert.deepEqual(
    appended.map(m => m.role),
    ["user", "assistant", "tool", "user", "user", "assistant"],
  )
  assert.equal(appended[3].content, "第二条")
  assert.equal(appended[4].content, "第三条")
})

test("dialogue: 正常结束不中止 signal，后台子代理可继续", async () => {
  let seen
  const provider = {
    async chat(messages, opts) {
      seen = opts.signal
      return { content: "ok" }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
    sender: { nickname: "U" },
  }

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply: async () => {} })

  assert.ok(seen, "provider 收到本轮 signal")
  assert.equal(seen.aborted, false, "正常结束后 signal 不中止")
})

test("dialogue: 本轮异常结束中止 signal", async () => {
  let seen
  const provider = {
    async chat(messages, opts) {
      seen = opts.signal
      throw new Error("boom")
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
    sender: { nickname: "U" },
  }

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply: async () => {} })

  assert.ok(seen, "provider 收到本轮 signal")
  assert.equal(seen.aborted, true, "异常结束后 signal 被中止")
})

test("dialogue: no_reply 不发送正文也不转发过程", async () => {
  const calls = { sent: [], appended: 0 }
  const provider = {
    async chat() {
      return {
        content: "no_reply",
        reasoning_content: "不需要回复",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 },
      }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {
      calls.appended++
    },
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini", show_thinking: true } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
    sender: { nickname: "U" },
  }

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply: async (msg, quote) => calls.sent.push({ msg, quote }) })

  assert.equal(calls.appended, 1, "no_reply 仍完整落盘")
  assert.equal(calls.sent.length, 0, "no_reply 不发送任何消息")
})

test("dialogue: 旁听不转发过程", async () => {
  const calls = { sent: [] }
  const provider = {
    async chat() {
      return {
        content: "路过说一句",
        reasoning_content: "旁听思考",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 },
      }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini", show_thinking: true } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const event = {
    self_id: "s",
    user_id: "u",
    group_id: "g",
    isGroup: true,
    message: [{ type: "text", text: "闲聊" }],
    msg: "闲聊",
    sender: { nickname: "U" },
  }

  await dialogue.run({ event, userMsg: "闲聊", isAmbient: true, reply: async (msg, quote) => calls.sent.push({ msg, quote }) })

  assert.equal(calls.sent.length, 1, "旁听只发正文，不转发过程")
  assert.equal(calls.sent[0].msg, "路过说一句")
})

test("dialogue: 注入唤醒不转发过程，普通对话转发", async () => {
  const calls = { sent: [] }
  const provider = {
    async chat() {
      return {
        content: "你好",
        reasoning_content: "思考",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cached_tokens: 0, reasoning_tokens: 0 },
      }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini", show_thinking: true } }
  const reply = async (msg, quote) => {
    calls.sent.push({ msg, quote })
  }
  const baseEvent = {
    self_id: "s",
    user_id: "u",
    isGroup: false,
    isPrivate: true,
    message: [{ type: "text", text: "hi" }],
    msg: "hi",
    sender: { nickname: "U" },
  }

  const normal = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  await normal.run({ event: { ...baseEvent }, userMsg: "hi", isAmbient: false, reply })
  const forwarded = calls.sent.find(c => Array.isArray(c.msg))
  assert.ok(forwarded, "普通对话应转发过程")
  assert.equal(forwarded.msg[0], "思考")
  assert.ok(forwarded.msg.at(-1).startsWith("Token: "))

  calls.sent.length = 0
  const injected = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  await injected.run({ event: { ...baseEvent, _injected: true, _inject_source: "agent" }, userMsg: "hi", isAmbient: false, reply })
  assert.equal(calls.sent.length, 1, "注入唤醒只发正文，不转发过程")
  assert.equal(calls.sent[0].msg, "你好")
})

test("dialogue: 跨群消息在工具执行中合并进本轮，不打断工具", async () => {
  let releaseTool
  const toolGate = new Promise(resolve => (releaseTool = resolve))
  let toolStarted
  const toolStartedP = new Promise(resolve => (toolStarted = resolve))
  let calls = 0
  const seen = []
  const provider = {
    async chat(messages) {
      calls++
      seen.push(messages)
      if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: "{}" } }] }
      return { content: "最终回复" }
    },
  }
  let persisted
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async (sid, msgs) => {
      persisted = msgs
    },
  }
  const tools = {
    getDefinitions: () => [{ type: "function", function: { name: "slow", parameters: {} } }],
    execute: async name => {
      toolStarted()
      await toolGate
      return { name, result: "工具结果" }
    },
  }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const sentA = []
  const sentB = []
  const mkEvent = (gid, text) => ({ self_id: "s", user_id: "u", group_id: gid, group_name: gid, isGroup: true, message: [{ type: "text", text }], msg: text, sender: { nickname: "U" } })

  const first = dialogue.run({ event: mkEvent("gA", "第一条"), userMsg: "第一条", isAmbient: false, reply: async msg => sentA.push(msg) })
  await toolStartedP
  const appended = await dialogue.run({ event: mkEvent("gB", "第二条"), userMsg: "第二条", isAmbient: false, reply: async msg => sentB.push(msg) })
  assert.equal(appended, false, "跨群消息追加，不启动新请求")
  releaseTool()
  await first

  assert.equal(calls, 2, "原请求继续执行，没有打断重发")
  assert.deepEqual(sentB, ["最终回复"], "回复发往追加消息所在会话")
  assert.deepEqual(sentA, [], "原会话不再回复")
  assert.deepEqual(
    persisted.map(m => m.role),
    ["user", "assistant", "tool", "user", "assistant"],
  )
  assert.deepEqual(
    persisted.filter(m => m.role === "user").map(m => m.content),
    ["第一条", "第二条"],
  )
  const firstMsg = seen[1].find(m => m.content === "第一条")
  const appendedMsg = seen[1].find(m => m.content === "第二条")
  assert.ok(appendedMsg, "第二次模型请求包含跨群追加消息")
  assert.equal(firstMsg[CURRENT_TURN], undefined, "已暂存的 user 恢复时间/会话前缀")
  assert.equal(firstMsg.group_name, "gA")
  assert.equal(appendedMsg[CURRENT_TURN], true, "最新 user 携带环境上下文")
  assert.match(appendedMsg.runtime_context, /gB/, "环境上下文来自追加消息的 event")
})

test("dialogue: 追加消息与工具返回同时发生时消息不丢失", async () => {
  let releaseTool
  const toolGate = new Promise(resolve => (releaseTool = resolve))
  let toolStarted
  const toolStartedP = new Promise(resolve => (toolStarted = resolve))
  let calls = 0
  const seen = []
  const provider = {
    async chat(messages) {
      calls++
      seen.push(messages)
      if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: "{}" } }] }
      return { content: "最终回复" }
    },
  }
  let persisted
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async (sid, msgs) => {
      persisted = msgs
    },
  }
  const tools = {
    getDefinitions: () => [{ type: "function", function: { name: "slow", parameters: {} } }],
    execute: async name => {
      toolStarted()
      await toolGate
      return { name, result: "工具结果" }
    },
  }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const mkEvent = (gid, text) => ({ self_id: "s", user_id: "u", group_id: gid, group_name: gid, isGroup: true, message: [{ type: "text", text }], msg: text, sender: { nickname: "U" } })

  const first = dialogue.run({ event: mkEvent("gA", "第一条"), userMsg: "第一条", isAmbient: false, reply: async () => {} })
  await toolStartedP
  // 不 await 追加调用，紧接着放行工具，制造 drain 与追加入队的竞态
  const appended = dialogue.run({ event: mkEvent("gB", "第二条"), userMsg: "第二条", isAmbient: false, reply: async () => {} })
  releaseTool()
  await Promise.all([first, appended])

  assert.deepEqual(
    persisted.filter(m => m.role === "user").map(m => m.content),
    ["第一条", "第二条"],
    "追加消息没有被 drain 竞态丢掉",
  )
  assert.ok(
    seen[1].some(m => m.content === "第二条"),
    "下一次模型请求包含追加消息",
  )
})

test("dialogue: 旁听触发不打断进行中的对话，也不继承其上下文", async () => {
  let release
  const gate = new Promise(resolve => (release = resolve))
  let started
  const startedP = new Promise(resolve => (started = resolve))
  let calls = 0
  const seen = []
  const provider = {
    async chat(messages) {
      calls++
      seen.push(messages)
      started()
      await gate
      return { content: "主对话回复" }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const sent = []
  const reply = async msg => sent.push(msg)
  const privateEvent = { self_id: "s", user_id: "u", isPrivate: true, message: [{ type: "text", text: "私密内容" }], msg: "私密内容", sender: { nickname: "U" } }
  const groupEvent = { self_id: "s", user_id: "u", group_id: "g", isGroup: true, message: [{ type: "text", text: "群聊内容" }], msg: "群聊内容", sender: { nickname: "U" } }

  const first = dialogue.run({ event: privateEvent, userMsg: "私密内容", isAmbient: false, reply })
  await startedP
  const ambient = await dialogue.run({ event: groupEvent, userMsg: "[旁听系统触发]", isAmbient: true, reply })
  assert.equal(ambient, false, "旁听触发直接跳过")
  assert.equal(calls, 1, "没有发起旁听请求")
  assert.equal(
    seen[0].some(m => String(m.content || "").includes("[旁听系统触发]")),
    false,
    "主对话请求未被旁听消息污染",
  )
  release()
  await first
  assert.deepEqual(sent, ["主对话回复"], "主对话未被打断")
})

test("dialogue: 工具执行中同群与跨群消息都合并进本轮", async () => {
  let releaseTool
  const toolGate = new Promise(resolve => (releaseTool = resolve))
  let toolStarted
  const toolStartedP = new Promise(resolve => (toolStarted = resolve))
  let calls = 0
  const seen = []
  const provider = {
    async chat(messages) {
      calls++
      seen.push(messages)
      if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "slow", arguments: "{}" } }] }
      return { content: "最终回复" }
    },
  }
  let persisted
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async (sid, msgs) => {
      persisted = msgs
    },
  }
  const tools = {
    getDefinitions: () => [{ type: "function", function: { name: "slow", parameters: {} } }],
    execute: async name => {
      toolStarted()
      await toolGate
      return { name, result: "工具结果" }
    },
  }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const reply = async () => {}
  const mkEvent = (gid, text) => ({ self_id: "s", user_id: "u", group_id: gid, group_name: gid, isGroup: true, message: [{ type: "text", text }], msg: text, sender: { nickname: "U" } })

  const first = dialogue.run({ event: mkEvent("gA", "第一条"), userMsg: "第一条", isAmbient: false, reply })
  await toolStartedP
  const same = await dialogue.run({ event: mkEvent("gA", "第二条"), userMsg: "第二条", isAmbient: false, reply })
  assert.equal(same, false, "同群消息追加")
  const cross = await dialogue.run({ event: mkEvent("gB", "第三条"), userMsg: "第三条", isAmbient: false, reply })
  assert.equal(cross, false, "跨群消息也追加")
  releaseTool()
  await first

  assert.equal(calls, 2, "两次追加都没有打断本轮")
  assert.deepEqual(
    persisted.filter(m => m.role === "user").map(m => m.content),
    ["第一条", "第二条", "第三条"],
    "两条追加消息都保留",
  )
  assert.deepEqual(
    persisted.map(m => m.role),
    ["user", "assistant", "tool", "user", "user", "assistant"],
  )
  assert.equal(seen[1].find(m => m.content === "第一条")[CURRENT_TURN], undefined, "已暂存 user 恢复前缀")
  assert.equal(seen[1].find(m => m.content === "第二条")[CURRENT_TURN], undefined, "较早的追加 user 恢复前缀")
  assert.equal(seen[1].find(m => m.content === "第三条")[CURRENT_TURN], true, "最新 user 携带环境上下文")
})

test("dialogue: 打断合并时丢弃旧请求的轮次状态栏", async () => {
  let calls = 0
  const seen = []
  let secondStarted
  const secondStartedP = new Promise(resolve => (secondStarted = resolve))
  const provider = {
    async chat(messages, opts) {
      calls++
      seen.push(messages)
      if (calls === 1) return { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] }
      if (calls === 2) {
        secondStarted()
        await new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"))
          if (opts.signal.aborted) abort()
          else opts.signal.addEventListener("abort", abort, { once: true })
        })
      }
      return { content: "最终回复" }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "u" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
  }
  const tools = {
    getDefinitions: () => [{ type: "function", function: { name: "f", parameters: {} } }],
    execute: async name => ({ name, result: "工具结果" }),
  }
  const skills = { list: async () => [], get: async () => null }
  const config = { aigc: { models: [{ name: "test", model: "test-model" }], model_config: "test", adapter: "gemini" } }
  const dialogue = createDialogue({ provider, memory, tools, skills, scheduler: new RequestScheduler(), config, redis: {} })
  const reply = async () => {}
  const mkEvent = (gid, text) => ({ self_id: "s", user_id: "u", group_id: gid, group_name: gid, isGroup: true, message: [{ type: "text", text }], msg: text, sender: { nickname: "U" } })

  const first = dialogue.run({ event: mkEvent("gA", "第一条"), userMsg: "第一条", isAmbient: false, reply })
  await secondStartedP
  const second = dialogue.run({ event: mkEvent("gB", "第二条"), userMsg: "第二条", isAmbient: false, reply })
  await Promise.all([first, second])

  const carriedTool = seen[2].find(m => m.role === "tool")
  assert.ok(carriedTool, "新请求保留工具结果")
  assert.equal(carriedTool.content, "工具结果")
  assert.equal(carriedTool[STATUS_BAR], undefined, "旧状态栏不随合并进入新请求")
})

test("dialogue: 使用 API 返回的输入 token 与摘要上下文", async () => {
  const seen = []
  const appendCalls = []
  const provider = {
    async chat(messages, opts) {
      seen.push(messages)
      return { content: "ok", usage: { prompt_tokens: 1000 } }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "trim" }),
    getMessages: async (_self_id, _user_id) => ({ messages: [{ role: "user", content: "旧消息" }], summary: "旧摘要" }),
    getContextModelMessages: async () => [{ role: "user", content: "旧消息" }],
    appendRound: async (_sid, msgs, opts) => {
      appendCalls.push({ msgs, opts })
    },
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const dialogue = createDialogue({
    provider,
    memory,
    tools,
    skills,
    scheduler: new RequestScheduler(),
    config: { aigc: { models: [{ name: "test", model: "test-model", context_window: 1000 }], model_config: "test", adapter: "gemini" } },
    redis: {},
  })

  const text = "你好"
  const event = { self_id: "s", user_id: "trim", isGroup: false, isPrivate: true, message: [{ type: "text", text }], msg: text, sender: { nickname: "U" } }
  const reply = async () => {}

  await dialogue.run({ event, userMsg: text, isAmbient: false, reply })

  assert.ok(
    seen[0].some(m => m.role === "user" && m.content.includes("旧消息")),
    "请求保留加载的上下文历史",
  )
  assert.ok(
    seen[0].some(m => m.role === "user"),
    "请求保留 user 消息",
  )
  assert.equal(appendCalls.length, 1)
  assert.ok(appendCalls[0].opts.contextMsgs, "实际上下文以 localPending 落盘")
})

test("dialogue: 轮末压缩在回复之后触发，下一轮先等待压缩", async () => {
  const events = []
  let compaction = null
  const provider = {
    async chat() {
      return { content: "ok", usage: { prompt_tokens: 1000 } }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "post" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => events.push("persist"),
    awaitCompaction: async () => {
      if (compaction) events.push("await")
      return compaction
    },
    beginCompaction: (_s, _u, promise) => {
      events.push("begin")
      compaction = promise
      return promise
    },
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const dialogue = createDialogue({
    provider,
    memory,
    tools,
    skills,
    scheduler: new RequestScheduler(),
    config: { aigc: { models: [{ name: "test", model: "test-model", context_window: 1000 }], model_config: "test", adapter: "gemini" } },
    redis: {},
  })
  const event = { self_id: "s", user_id: "post", isGroup: false, isPrivate: true, message: [{ type: "text", text: "hi" }], msg: "hi", sender: { nickname: "U" } }
  const reply = async () => events.push("reply")

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply })
  assert.deepEqual(events, ["begin", "persist", "reply"], "落盘前先登记压缩屏障，落盘后压缩，回复不等待压缩")

  events.length = 0
  await dialogue.run({ event, userMsg: "again", isAmbient: false, reply })
  assert.equal(events[0], "await", "下一轮先等待压缩完成")
})

test("dialogue: 落盘期间触发的新对话也等待压缩结束", async () => {
  let releasePersist
  let persistCalls = 0
  let getMessagesCalls = 0
  let pendingCompaction = null
  const provider = {
    async chat() {
      return { content: "ok", usage: { prompt_tokens: 1000 } }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "barrier" }),
    getMessages: async () => {
      getMessagesCalls++
      return { messages: [], summary: "" }
    },
    appendRound: async () => {
      persistCalls++
      if (persistCalls === 1) await new Promise(resolve => (releasePersist = resolve))
    },
    beginCompaction: (_s, _u, promise) => {
      pendingCompaction = Promise.resolve(promise)
    },
    awaitCompaction: () => pendingCompaction || Promise.resolve(),
    setSessionTokens: () => {},
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const dialogue = createDialogue({
    provider,
    memory,
    tools,
    skills,
    scheduler: new RequestScheduler(),
    config: { aigc: { models: [{ name: "test", model: "test-model", context_window: 1000 }], model_config: "test", adapter: "gemini" } },
    redis: {},
  })
  const event = { self_id: "s", user_id: "barrier", isGroup: false, isPrivate: true, message: [{ type: "text", text: "hi" }], msg: "hi", sender: { nickname: "U" } }
  const reply = async () => {}

  const runA = dialogue.run({ event, userMsg: "A", isAmbient: false, reply })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.ok(releasePersist, "A 已进入落盘阶段")
  const before = getMessagesCalls

  const runB = dialogue.run({ event, userMsg: "B", isAmbient: false, reply })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(getMessagesCalls, before, "压缩屏障未放行时不读取上下文")

  releasePersist()
  await Promise.all([runA, runB])
  assert.equal(getMessagesCalls, before + 1, "压缩结束后新对话才进入")
})

test("dialogue: 旁听不写入主会话 token 计数", async () => {
  let writes = 0
  const provider = {
    async chat() {
      return { content: "ok", usage: { prompt_tokens: 1000 } }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "ambient" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
    getSessionTokens: () => 999,
    setSessionTokens: () => {
      writes++
    },
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const dialogue = createDialogue({
    provider,
    memory,
    tools,
    skills,
    scheduler: new RequestScheduler(),
    config: { aigc: { models: [{ name: "test", model: "test-model", context_window: 1000 }], model_config: "test", adapter: "gemini" } },
    redis: {},
  })
  const event = { self_id: "s", user_id: "ambient", group_id: "g", group_name: "G", isGroup: true, message: [{ type: "text", text: "hi" }], msg: "hi", sender: { nickname: "U" } }

  await dialogue.run({ event, userMsg: "hi", isAmbient: true, reply: async () => {} })
  assert.equal(writes, 0, "旁听不覆盖主会话 token 计数")
})

test("dialogue: 轮末压缩不阻塞回复", async () => {
  let release
  const hanging = new Promise(r => {
    release = r
  })
  let replied = false
  let begun = false
  const provider = {
    async chat() {
      return { content: "ok", usage: { prompt_tokens: 1000 } }
    },
  }
  const memory = {
    sessionKey: () => ({ self_id: "s", user_id: "nonblock" }),
    getMessages: async () => ({ messages: [], summary: "" }),
    appendRound: async () => {},
    beginCompaction: () => {
      begun = true
      return hanging
    },
    awaitCompaction: () => (begun ? hanging : Promise.resolve()),
  }
  const tools = { getDefinitions: () => [], execute: async () => ({}) }
  const skills = { list: async () => [], get: async () => null }
  const dialogue = createDialogue({
    provider,
    memory,
    tools,
    skills,
    scheduler: new RequestScheduler(),
    config: { aigc: { models: [{ name: "test", model: "test-model", context_window: 1000 }], model_config: "test", adapter: "gemini" } },
    redis: {},
  })
  const event = { self_id: "s", user_id: "nonblock", isGroup: false, isPrivate: true, message: [{ type: "text", text: "hi" }], msg: "hi", sender: { nickname: "U" } }

  await dialogue.run({ event, userMsg: "hi", isAmbient: false, reply: async () => (replied = true) })
  assert.equal(replied, true, "回复不被压缩阻塞")
  release()
})
