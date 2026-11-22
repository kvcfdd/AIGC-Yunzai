import test from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import sharp from "sharp"
import { imageFileToDataUris } from "../../lib/ai_core/media/ingest.js"
import { isAnimatedFrames } from "../../lib/ai_core/media/animated.js"

globalThis.logger = { info() {}, mark() {}, warn() {}, error() {}, debug() {} }

const hasFfmpeg = await new Promise(resolve => execFile("ffmpeg", ["-version"], err => resolve(!err)))
const runFfmpeg = args => new Promise((resolve, reject) => execFile("ffmpeg", args, err => (err ? reject(err) : resolve())))

async function makeImage(dir, name, width, height) {
  const file = path.join(dir, name)
  await sharp({ create: { width, height, channels: 3, background: "#888" } })
    .png()
    .toFile(file)
  return file
}

async function firstMeta(uris) {
  const buf = Buffer.from(uris[0].split(",")[1], "base64")
  return sharp(buf).metadata()
}

test("image: 宽度不超过 1536 时不缩放，高度不参与限制", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-image-"))
  try {
    const tall = await makeImage(dir, "tall.png", 1000, 2000)
    const m = await firstMeta(await imageFileToDataUris(tall))
    assert.equal(m.width, 1000)
    assert.equal(m.height, 2000)

    const narrow = await makeImage(dir, "narrow.png", 10, 1000)
    const n = await firstMeta(await imageFileToDataUris(narrow))
    assert.equal(n.width, 10)
    assert.equal(n.height, 1000)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("image: 动画 GIF 均匀抽取最多 10 帧并标记为同一张动图", { skip: !hasFfmpeg && "ffmpeg 不可用" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-gif-"))
  try {
    const gif = path.join(dir, "anim.gif")
    await runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc=size=120x80:rate=10:duration=2", "-y", gif])
    const frames = await imageFileToDataUris(gif)
    assert.equal(isAnimatedFrames(frames), true)
    assert.equal(frames.length, 10)
    const m = await firstMeta(frames)
    assert.equal(m.width, 120)
    assert.equal(m.height, 80)
  } finally {
    // Windows 上 sharp/ffmpeg 可能短暂占用源文件，清理失败不影响断言
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("image: 静态 GIF 不标记为动图", { skip: !hasFfmpeg && "ffmpeg 不可用" }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-gif-"))
  try {
    const gif = path.join(dir, "static.gif")
    await runFfmpeg(["-v", "error", "-f", "lavfi", "-i", "testsrc=size=120x80:rate=1:duration=1", "-frames:v", "1", "-y", gif])
    const frames = await imageFileToDataUris(gif)
    assert.equal(isAnimatedFrames(frames), false)
    assert.equal(frames.length, 1)
  } finally {
    // Windows 上 sharp/ffmpeg 可能短暂占用源文件，清理失败不影响断言
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test("image: 仅宽度超过 1536 时按宽度等比压缩", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-image-"))
  try {
    const wide = await makeImage(dir, "wide.png", 2000, 1000)
    const m = await firstMeta(await imageFileToDataUris(wide))
    assert.equal(m.width, 1536)
    assert.equal(m.height, 768)

    // 超长图会被切段，但每段宽度仍只由宽度上限决定
    const huge = await makeImage(dir, "huge.png", 3000, 6000)
    const h = await firstMeta(await imageFileToDataUris(huge))
    assert.equal(h.width, 1536)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
