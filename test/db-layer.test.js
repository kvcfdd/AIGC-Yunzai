import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import { createClient } from "../lib/redis/index.js"

const require = createRequire(import.meta.url)

/** 负索引与越界语义的参考实现 */
function expectedRange(all, start, stop) {
  let s = Number(start)
  let e = Number(stop)
  if (!Number.isFinite(s) || !Number.isFinite(e)) return []
  if (s < 0) s = Math.max(all.length + s, 0)
  if (e < 0) e = all.length + e
  if (s > e || s >= all.length) return []
  return all.slice(s, e + 1)
}

test("redis: zRange / lRange 区间语义与负索引一致", () => {
  const client = createClient(":memory:")
  const all = ["a", "b", "c", "d", "e", "f"]
  client.zAdd(
    "z",
    all.map((value, i) => ({ value, score: i + 1 })),
  )
  client.rPush("l", all)

  for (const [s, e] of [
    [0, 0],
    [1, 4],
    [2, 100],
    [-2, -1],
    [-100, 2],
    [0, -1],
    [3, 2],
    [100, 200],
  ]) {
    assert.deepEqual(client.zRange("z", s, e), expectedRange(all, s, e), `zRange ${s},${e}`)
    assert.deepEqual(client.lRange("l", s, e), expectedRange(all, s, e), `lRange ${s},${e}`)
  }
  client.close()
})

test("redis: 批量写入返回语义不变", () => {
  const client = createClient(":memory:")
  assert.equal(client.hSet("h", { a: 1, b: 2 }), 2)
  assert.equal(client.hSet("h", { b: 3, c: 4 }), 1)
  assert.deepEqual({ ...client.hGetAll("h") }, { a: "1", b: "3", c: "4" })
  assert.equal(client.sAdd("s", ["x", "y", "x"]), 2)
  assert.equal(client.sRem("s", "x", "z"), 1)
  assert.deepEqual(client.sMembers("s"), ["y"])
  assert.equal(
    client.zAdd("z", [
      { value: "a", score: 1 },
      { value: "b", score: 2 },
    ]),
    2,
  )
  assert.equal(client.lPush("l", ["a", "b"]), 2)
  assert.deepEqual(client.lRange("l", 0, -1), ["b", "a"])
  client.close()
})

test("redis: multi 内复用写事务", async () => {
  const client = createClient(":memory:")
  const out = await client.multi().set("a", "1").hSet("h", "f", "v").sAdd("s", "m").exec()
  assert.deepEqual(out, ["OK", 1, 1])
  assert.equal(client.get("a"), "1")
  client.close()
})

test("sqlite3 垫片: 共享连接不被 close 关闭，命名参数兼容 : 与 @ 前缀", async () => {
  const sqlite3 = require("../lib/modules/sqlite3/index.js")
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yunzai-sqlite3-"))
  const file = path.join(dir, "shared.db")
  const first = new sqlite3.Database(file)
  const second = new sqlite3.Database(file)
  const shared = second._db

  first.exec("create table t(a, b)")
  first.close()
  assert.equal(second._db, shared, "close 不应替换或关闭共享连接")
  assert.equal(shared.open, true)

  await new Promise((resolve, reject) => second.run("insert into t values (:a, @b)", { ":a": 1, "@b": 2 }, err => (err ? reject(err) : resolve())))
  const row = await new Promise(resolve => second.get("select a, b from t", (err, row) => resolve(err || row)))
  assert.deepEqual(row, { a: 1, b: 2 })

  // 共享连接按设计存活到进程退出，测试收尾时手动释放
  second.close()
  shared.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
