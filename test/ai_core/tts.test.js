import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { resolveVoiceConfig, voiceModels, available, synthesize } from "../../lib/ai_core/output/tts/index.js"
import { encode } from "../../lib/ai_core/output/tts/msgpack.js"
import { wavFromPcm } from "../../lib/ai_core/output/tts/util.js"
import wusound from "../../lib/ai_core/output/tts/providers/wusound.js"
import openai from "../../lib/ai_core/output/tts/providers/openai.js"
import deepseek from "../../lib/ai_core/output/tts/providers/deepseek.js"
import gemini from "../../lib/ai_core/output/tts/providers/gemini.js"
import minimax from "../../lib/ai_core/output/tts/providers/minimax.js"
import azure, { buildSsml } from "../../lib/ai_core/output/tts/providers/azure.js"

function withFetch(mock, fn) {
  const original = globalThis.fetch
  globalThis.fetch = mock
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original
    })
}

async function readAndRemove(file) {
  const buf = await fs.readFile(file)
  await fs.rm(file, { force: true })
  return buf
}

test("tts: 配置解析与可用性", () => {
  const voice = {
    models: [
      { name: "wusound", api_key: "k", voice_id: "v" },
      { name: "openai", api_key: "k", voice: "nova" },
    ],
    model_config: "wusound",
  }

  assert.equal(voiceModels(voice)[0].name, "wusound")
  const wusoundCfg = resolveVoiceConfig(voice)
  assert.equal(wusoundCfg.name, "wusound")
  assert.equal(wusoundCfg.opts.api_key, "k")
  assert.equal(wusoundCfg.opts.voice_id, "v")
  assert.equal(wusoundCfg.opts.base_url, "https://v1.wusound.cn")

  const openaiCfg = resolveVoiceConfig({ models: [{ name: "openai", api_key: "k", voice: "nova", headers: { "X-Test": "1" } }] })
  assert.equal(openaiCfg.opts.voice, "nova")
  assert.equal(openaiCfg.opts.model, "tts-1")
  assert.equal(openaiCfg.opts.headers["X-Test"], "1", "嵌套 headers 与默认值合并")

  assert.equal(available({ aigc: { voice } }), true)
  assert.equal(available({ aigc: { voice: { models: [{ name: "wusound", api_key: "k" }] } } }), false)
  assert.equal(available({ aigc: { voice: { models: [{ name: "azure", api_key: "k" }] } } }), true)
  assert.equal(available({ aigc: { voice: { models: [{ name: "nope" }] } } }), false)
  assert.equal(available({ aigc: { voice: { models: [] } } }), false)
})

test("tts: WAV 头", () => {
  const pcm = Buffer.alloc(8, 1)
  const wav = wavFromPcm(pcm)
  assert.equal(wav.subarray(0, 4).toString(), "RIFF")
  assert.equal(wav.subarray(8, 12).toString(), "WAVE")
  assert.equal(wav.readUInt32LE(24), 24000)
  assert.equal(wav.readUInt16LE(22), 1)
  assert.equal(wav.readUInt16LE(34), 16)
  assert.equal(wav.readUInt32LE(40), pcm.length)
  assert.equal(wav.length, 44 + pcm.length)
})

test("tts: msgpack 编码基础类型", () => {
  assert.equal(encode(null).toString("hex"), "c0")
  assert.equal(encode(true).toString("hex"), "c3")
  assert.equal(encode(1).toString("hex"), "01")
  assert.equal(encode("hi").toString("hex"), "a26869")
  assert.equal(encode({ n: 1 }).toString("hex"), "81a16e01")
  assert.equal(encode([1, 2]).toString("hex"), "920102")
})

test("tts: 悟声返回音频 URL", async () => {
  const calls = []
  const result = await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify({ data: { audio: "https://audio.test/a.mp3" } }), { status: 200 })
    },
    () => wusound.tts("你好", { ...wusound.defaults, api_key: "k", voice_id: "v" }),
  )
  assert.equal(result, "https://audio.test/a.mp3")
  assert.match(calls[0].url, /\/api\/tts\/simple-generate$/)
  assert.equal(JSON.parse(calls[0].init.body).voiceId, "v")
})

test("tts: OpenAI 字节落盘", async () => {
  const calls = []
  const file = await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(Buffer.from("audio-bytes"), { status: 200 })
    },
    () => openai.tts("你好", { ...openai.defaults, api_key: "k" }),
  )
  try {
    assert.match(calls[0].url, /\/audio\/speech$/)
    assert.equal(calls[0].init.headers.Authorization, "Bearer k")
    assert.equal(JSON.parse(calls[0].init.body).input, "你好")
    assert.equal((await readAndRemove(file)).toString(), "audio-bytes")
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("tts: DeepSeek 参数与音频落盘", async () => {
  const calls = []
  const file = await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(Buffer.from("wav-bytes"), { status: 200 })
    },
    () => deepseek.tts("你好", { ...deepseek.defaults, api_key: "k" }),
  )
  try {
    assert.match(calls[0].url, /\/v1\/tools\/tts$/)
    assert.equal(calls[0].init.headers.Authorization, "Bearer k")
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.text, "你好")
    assert.equal(body.voice_id, "stella")
    assert.equal(body.format, "wav")
    assert.equal(body.filter_markdown, true)
    assert.equal((await readAndRemove(file)).toString(), "wav-bytes")
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("tts: DeepSeek PCM 包装为 WAV", async () => {
  const pcm = Buffer.from([0, 1, 2, 3])
  const file = await withFetch(
    async () => new Response(pcm, { status: 200 }),
    () => deepseek.tts("你好", { ...deepseek.defaults, api_key: "k", format: "pcm" }),
  )
  try {
    const buf = await readAndRemove(file)
    assert.equal(buf.subarray(0, 4).toString(), "RIFF")
    assert.equal(buf.readUInt32LE(24), 24000)
    assert.equal(buf.length, 44 + pcm.length)
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("tts: MiniMax 十六进制音频落盘", async () => {
  const hex = Buffer.from("mini").toString("hex")
  const file = await withFetch(
    async () => new Response(JSON.stringify({ base_resp: { status_code: 0 }, data: { audio: hex } }), { status: 200 }),
    () => minimax.tts("你好", { ...minimax.defaults, api_key: "k" }),
  )
  try {
    assert.equal((await readAndRemove(file)).toString(), "mini")
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("tts: Gemini PCM 包装为 WAV", async () => {
  const pcm = Buffer.from([0, 1, 2, 3])
  const file = await withFetch(
    async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString("base64") } }] } }] }), { status: 200 }),
    () => gemini.tts("你好", { ...gemini.defaults, api_key: "k" }),
  )
  try {
    const buf = await readAndRemove(file)
    assert.equal(buf.subarray(0, 4).toString(), "RIFF")
    assert.equal(buf.length, 44 + pcm.length)
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("tts: 未知服务商与空文本报错", async () => {
  await assert.rejects(() => synthesize("hi", { aigc: { voice: { models: [{ name: "nope" }] } } }), /未知语音合成服务商/)
  await assert.rejects(() => synthesize("  ", { aigc: { voice: {} } }), /不能为空/)
})

test("tts: Azure SSML 转义与风格", () => {
  const ssml = buildSsml("a & <b>", {
    voice: "zh-CN-YunxiaNeural",
    style: "cheerful",
    role: "Boy",
    rate: "1",
    volume: "100",
    lang: "zh-CN",
  })
  assert.match(ssml, /voice name='zh-CN-YunxiaNeural'/)
  assert.match(ssml, /mstts:express-as style='cheerful' role='Boy'/)
  assert.match(ssml, /a &amp; &lt;b&gt;/)
  assert.equal(typeof azure.tts, "function")
})
