import test from "node:test"
import assert from "node:assert/strict"
import { applyMediaPathMarkers, prepareForPersist } from "../../lib/ai_core/memory/persist.js"

test("serialize: 用户消息占位符替换为本地路径", () => {
  const m = {
    role: "user",
    content: "[图片](http://example.com/a.png)",
    images: ["data:image/png;base64,x"],
    image_paths: ["/tmp/a.png"],
  }
  applyMediaPathMarkers(m)
  assert.equal(m.content, "[图片](/tmp/a.png)")
})

test("serialize: 无路径标记为已过期", () => {
  const m = { role: "user", content: "[图片]", images: ["[图像异常]"], image_paths: [null] }
  applyMediaPathMarkers(m)
  assert.equal(m.content, "[图片已过期]")
})

test("serialize: 工具消息超长内容裁剪头尾并标注省略字数", () => {
  const content = "a".repeat(5000) + "b".repeat(1000) + "z".repeat(3000)
  const m = { role: "tool", content }
  prepareForPersist(m)
  const marker = "...(已省略3887字符)..."
  assert.equal(m.content, "a".repeat(4089) + marker + "z".repeat(1024))
})

test("serialize: 工具消息未超长时保持不变", () => {
  const content = "x".repeat(8192)
  const m = { role: "tool", content }
  prepareForPersist(m)
  assert.equal(m.content, content)
})

test("serialize: 用户/助手消息不做工具结果裁剪", () => {
  const content = "x".repeat(9000)
  for (const role of ["user", "assistant"]) {
    const m = { role, content }
    prepareForPersist(m)
    assert.equal(m.content, content)
  }
})

test("serialize: 文件只保留 file_paths", () => {
  const m = {
    role: "tool",
    content: "ok",
    file_paths: ["/tmp/f.txt"],
  }
  prepareForPersist(m)
  assert.equal(m.content, "ok")
  assert.deepEqual(m.file_paths, ["/tmp/f.txt"])
})
