import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildPersistentMemoryContext, updatePersistentMemory } from "../../lib/ai_core/memory/persistent-store.js"

async function setup(t) {
  // 记忆目录固定为 <cwd>/data/aigc/memory；测试切到临时目录隔离
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-mem-"))
  const prev = process.cwd()
  process.chdir(dir)
  t.after(async () => {
    process.chdir(prev)
    await fs.rm(dir, { recursive: true, force: true })
  })
}

const userEvent = { self_id: "9", user_id: "1", isGroup: true, group_id: "100", isMaster: false }
const masterEvent = { ...userEvent, isMaster: true }

test("persistent: 写入用户/群/全局并注入", async t => {
  await setup(t)
  await updatePersistentMemory({ scope: "user", content: "喜欢简洁回答", event: userEvent })
  await updatePersistentMemory({ scope: "group", content: "群规：不刷屏", event: userEvent })
  await updatePersistentMemory({ scope: "global", content: "部署在 Windows", event: masterEvent })

  const ctx = await buildPersistentMemoryContext(userEvent)
  assert.match(ctx, /<persistent_memory>/)
  assert.match(ctx, /用户画像/)
  assert.match(ctx, /喜欢简洁回答/)
  assert.match(ctx, /群画像/)
  assert.match(ctx, /群规：不刷屏/)
  assert.match(ctx, /全局记忆/)
  assert.match(ctx, /部署在 Windows/)
})

test("persistent: 去重、删除与权限", async t => {
  await setup(t)
  const first = await updatePersistentMemory({ scope: "user", content: "喜欢简洁回答", event: userEvent })
  assert.match(first, /已写入/)

  const again = await updatePersistentMemory({ scope: "user", content: "喜欢简洁回答", event: userEvent })
  assert.match(again, /无需重复/)

  await updatePersistentMemory({ scope: "user", action: "remove", content: "喜欢简洁回答", event: userEvent })
  const ctx = await buildPersistentMemoryContext(userEvent)
  assert.doesNotMatch(ctx, /喜欢简洁回答/)

  await assert.rejects(() => updatePersistentMemory({ scope: "global", content: "x", event: userEvent }), /bot_owner/)
})

test("persistent: 旁听不注入个人画像", async t => {
  await setup(t)
  await updatePersistentMemory({ scope: "user", content: "私密偏好", event: userEvent })
  await updatePersistentMemory({ scope: "group", content: "群规", event: userEvent })

  const ambient = await buildPersistentMemoryContext(userEvent, { isAmbient: true })
  assert.doesNotMatch(ambient, /私密偏好/)
  assert.match(ambient, /群规/)

  const normal = await buildPersistentMemoryContext(userEvent)
  assert.match(normal, /私密偏好/)
})

test("persistent: 文件超限拒绝写入并回传现有条目", async t => {
  await setup(t)
  const first = Array.from({ length: 5 }, (_, i) => `${i}${"甲".repeat(299)}`).join("\n")
  const second = Array.from({ length: 5 }, (_, i) => `${i}${"乙".repeat(299)}`).join("\n")
  await updatePersistentMemory({ scope: "user", content: first, event: userEvent })
  await assert.rejects(
    () => updatePersistentMemory({ scope: "user", content: second, event: userEvent }),
    err => /记忆文件已满/.test(err.message) && /当前条目/.test(err.message) && err.message.includes("甲".repeat(299)),
  )
})

test("persistent: 群画像/全局画像 1500 字上限，注入不再限制总量", async t => {
  await setup(t)
  const lines = char => Array.from({ length: 5 }, (_, i) => `${i}${char.repeat(289)}`).join("\n")
  const extra = `0${"乙".repeat(289)}`

  // 用户画像 ~1770 字
  await updatePersistentMemory({ scope: "user", content: lines("甲"), event: userEvent })
  await updatePersistentMemory({ scope: "user", content: extra, event: userEvent })
  // 群画像、全局画像各 ~1470 字
  await updatePersistentMemory({ scope: "group", content: lines("丙"), event: userEvent })
  await updatePersistentMemory({ scope: "global", content: lines("丁"), event: masterEvent })

  // 三类合计已超过 4000，仍应完整注入
  const ctx = await buildPersistentMemoryContext(userEvent)
  assert.match(ctx, /用户画像 \[\d+% — \d+\/2000 字\]/)
  assert.match(ctx, /群画像 \[\d+% — \d+\/1500 字\]/)
  assert.match(ctx, /全局记忆 \[\d+% — \d+\/1500 字\]/)
  assert.match(ctx, /甲{10}/)
  assert.match(ctx, /丙{10}/)
  assert.match(ctx, /丁{10}/)

  // 群/全局超过 1500 后拒绝
  await assert.rejects(() => updatePersistentMemory({ scope: "group", content: extra, event: userEvent }), /记忆文件已满/)
  await assert.rejects(() => updatePersistentMemory({ scope: "global", content: extra, event: masterEvent }), /记忆文件已满/)
})

test("persistent: 拒绝疑似密钥", async t => {
  await setup(t)
  await assert.rejects(() => updatePersistentMemory({ scope: "user", content: "key=sk-abcdefghijklmnopqrstuvwx", event: userEvent }), /密钥/)
})

test("persistent: replace 按唯一子串更新条目", async t => {
  await setup(t)
  await updatePersistentMemory({ scope: "user", content: "用户所有编辑器都偏好深色主题", event: userEvent })

  const replaced = await updatePersistentMemory({
    scope: "user",
    action: "replace",
    oldText: "深色主题",
    content: "用户 VS Code 用浅色主题，终端用深色主题",
    event: userEvent,
  })
  assert.match(replaced, /已更新/)

  const ctx = await buildPersistentMemoryContext(userEvent)
  assert.match(ctx, /VS Code 用浅色主题/)
  assert.doesNotMatch(ctx, /所有编辑器都偏好深色主题/)
})

test("persistent: replace 子串不唯一时报错", async t => {
  await setup(t)
  await updatePersistentMemory({ scope: "user", content: "编辑器用深色主题", event: userEvent })
  await updatePersistentMemory({ scope: "user", content: "终端用深色主题", event: userEvent })

  await assert.rejects(() => updatePersistentMemory({ scope: "user", action: "replace", oldText: "深色主题", content: "统一用暗色", event: userEvent }), /匹配到 2 条/)
})

test("persistent: 空记忆注入写入引导，有记忆后只注入内容", async t => {
  await setup(t)
  const empty = await buildPersistentMemoryContext(userEvent)
  assert.match(empty, /当前没有长期记忆/)
  assert.match(empty, /memory_update/)

  await updatePersistentMemory({ scope: "user", content: "喜欢简洁回答", event: userEvent })
  const filled = await buildPersistentMemoryContext(userEvent)
  assert.doesNotMatch(filled, /当前没有长期记忆/)
  assert.match(filled, /喜欢简洁回答/)
  assert.match(filled, /\d+% — \d+\/2000 字/)
})

test("persistent: 照抄注入格式的 '- ' 前缀也能写入和删除", async t => {
  await setup(t)
  await updatePersistentMemory({ scope: "user", content: "- 喜欢简洁回答", event: userEvent })

  const ctx = await buildPersistentMemoryContext(userEvent)
  assert.match(ctx, /- 喜欢简洁回答/)
  assert.doesNotMatch(ctx, /- - /)

  await updatePersistentMemory({ scope: "user", action: "remove", content: "- 喜欢简洁回答", event: userEvent })
  const after = await buildPersistentMemoryContext(userEvent)
  assert.doesNotMatch(after, /喜欢简洁回答/)
})
