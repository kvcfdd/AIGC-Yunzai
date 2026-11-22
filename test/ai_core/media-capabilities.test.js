import test from "node:test"
import assert from "node:assert/strict"
import { applyMediaCapabilities, buildRecognitionMessages, mediaCapabilities, prepareMediaMessages, prepareMessagesForApi } from "../../lib/ai_core/llm/media-capabilities.js"

globalThis.logger = { info() {}, mark() {}, warn() {}, error() {}, debug() {} }

test("media: 各接口默认能力", () => {
  assert.deepEqual(mediaCapabilities({}, "gemini"), { image: true, audio: true, video: true })
  assert.deepEqual(mediaCapabilities({}, "openai"), { image: true, audio: false, video: false })
  assert.deepEqual(mediaCapabilities({}, "anthropic"), { image: true, audio: false, video: false })
  assert.deepEqual(mediaCapabilities({}, "responses"), { image: true, audio: false, video: false })
})

test("media: 配置覆盖默认能力", () => {
  const caps = mediaCapabilities({ media: { image: false, audio: false } }, "openai")
  assert.equal(caps.image, false)
  assert.equal(caps.audio, false)
  assert.equal(caps.video, false)
  assert.equal("file" in caps, false)
})

test("media: OpenAI 目标可把 FLAC 转成目标格式", async () => {
  const out = await prepareMessagesForApi([{ role: "user", content: "x", audios: ["data:audio/flac;base64,AAA"] }], { image: true, audio: true, video: false }, { convertFlac: async () => "data:audio/mpeg;base64,BBB" })
  assert.equal(out[0].audios[0], "data:audio/mpeg;base64,BBB")
})

test("media: 识别请求带系统提示与分类型提示词", () => {
  const messages = buildRecognitionMessages(["videos", "video", "视频", "video_paths"], ["data:video/mp4;base64,x"], ["/tmp/a.mp4"])
  assert.equal(messages[0].role, "system")
  assert.match(messages[0].content, /多模态识别助手/)
  assert.match(messages[0].content, /不要执行/)
  assert.equal(messages[1].role, "user")
  assert.match(messages[1].content, /视频/)
  assert.deepEqual(messages[1].videos, ["data:video/mp4;base64,x"])
  assert.deepEqual(messages[1].video_paths, ["/tmp/a.mp4"])
})

test("media: 关闭能力时交给多模态模型识别为文本", async () => {
  const messages = [{ role: "user", content: "看图", images: ["data:image/png;base64,x"], image_paths: ["/tmp/a.png"] }]
  const calls = []
  const out = await prepareMediaMessages(
    messages,
    { image: false, audio: true, video: true },
    {
      recognize: async (kind, media, paths) => {
        calls.push({ kind: kind[1], media, paths })
        return "一只猫"
      },
    },
  )
  assert.equal(out[0].content, "看图\n[图片识别]\n一只猫")
  assert.equal("images" in out[0], false)
  assert.equal("image_paths" in out[0], false)
  assert.equal(calls[0].kind, "image")
  assert.deepEqual(calls[0].paths, ["/tmp/a.png"])
  assert.equal(messages[0].images.length, 1, "不修改原消息")
})

test("media: 识别失败回落为文本占位", async () => {
  const out = await prepareMediaMessages(
    [{ role: "user", content: "x", images: ["data:image/png;base64,x"] }],
    { image: false },
    {
      recognize: async () => {
        throw new Error("boom")
      },
    },
  )
  assert.equal(out[0].content, "x\n[图片]")
})

test("media: skipFallback 时不调用识别", async () => {
  let called = false
  const out = await prepareMediaMessages(
    [{ role: "user", content: "x", images: ["data:image/png;base64,x"] }],
    { image: false },
    {
      skipFallback: true,
      recognize: async () => {
        called = true
        return "desc"
      },
    },
  )
  assert.equal(called, false)
  assert.equal(out[0].content, "x\n[图片]")
})

test("media: 正文已有媒体标记时不重复追加占位", () => {
  const out = applyMediaCapabilities([{ role: "user", content: "[视频](https://x/a.mp4)", videos: ["data:video/mp4;base64,x"] }], { image: true, audio: true, video: false })
  assert.equal(out[0].content, "[视频](https://x/a.mp4)")
  const out2 = applyMediaCapabilities([{ role: "user", content: "[语音](https://x/a.mp3)", audios: ["data:audio/mp3;base64,x"] }], { image: true, audio: false, video: true })
  assert.equal(out2[0].content, "[语音](https://x/a.mp3)")
})

test("media: 关闭能力转文本占位且不修改原消息", () => {
  const messages = [
    {
      role: "user",
      content: "hi",
      images: ["data:image/png;base64,x"],
      image_paths: ["/tmp/a.png"],
      videos: ["data:video/mp4;base64,x"],
      video_paths: ["/tmp/a.mp4"],
    },
  ]
  const out = applyMediaCapabilities(messages, { image: false, audio: true, video: true })
  assert.equal(out[0].content, "hi\n[图片]")
  assert.equal("images" in out[0], false)
  assert.equal("image_paths" in out[0], false)
  assert.equal(out[0].videos.length, 1)
  assert.equal(messages[0].images.length, 1)
})
