import test from "node:test"
import assert from "node:assert/strict"
import { RequestScheduler } from "../../lib/ai_core/core/request-scheduler.js"

test("request-scheduler: 按用户存取并条件删除", () => {
  const c = new RequestScheduler()
  const e = { self_id: "1", user_id: "2" }
  const controller = new AbortController()
  const req = { controller, isAmbient: false, injected: false, pendingTurns: [], group_id: null, done: Promise.resolve() }
  c.set(e, req)
  assert.equal(c.get(e), req)
  assert.equal(c.requestKey(e), "1:2")

  c.delete(e, new AbortController())
  assert.equal(c.get(e), req, "非同一 controller 不应删除")

  c.delete(e, controller)
  assert.equal(c.get(e), undefined)
})

test("request-scheduler: hasActive 按群判断进行中的请求", () => {
  const c = new RequestScheduler()
  const e = { self_id: "1", user_id: "2" }
  assert.equal(c.hasActive("g1"), false)

  const controller = new AbortController()
  c.set(e, { controller, isAmbient: true, injected: false, group_id: "g1", done: Promise.resolve() })
  assert.equal(c.hasActive("g1"), true)
  assert.equal(c.hasActive("g2"), false)
  assert.equal(c.lastFinishedAt("g1"), 0)

  c.delete(e, controller)
  assert.equal(c.hasActive("g1"), false)
  assert.ok(c.lastFinishedAt("g1") > 0, "请求结束后记录时间")

  // 私聊请求不记录群结束时间
  const e2 = { self_id: "1", user_id: "3" }
  const c2 = new AbortController()
  c.set(e2, { controller: c2, isAmbient: false, injected: false, group_id: null, done: Promise.resolve() })
  c.delete(e2, c2)
  assert.equal(c.lastFinishedAt("g1") > 0, true)
})

test("request-scheduler: abort / abortAmbient / abortAll", () => {
  const c = new RequestScheduler()
  const e1 = { self_id: "1", user_id: "2" }
  const e2 = { self_id: "1", user_id: "3" }
  const c1 = new AbortController()
  const c2 = new AbortController()
  const c3 = new AbortController()
  c.set(e1, { controller: c1, isAmbient: true, injected: false, group_id: "g1", done: Promise.resolve() })
  c.set(e2, { controller: c2, isAmbient: true, injected: false, group_id: "g1", done: Promise.resolve() })

  assert.equal(c.abortAmbient("g2"), false)
  assert.equal(c.abortAmbient("g1"), true)
  assert.equal(c1.signal.aborted, true)
  assert.equal(c2.signal.aborted, false)

  c.set({ self_id: "1", user_id: "4" }, { controller: c3, isAmbient: false, injected: false, group_id: null, done: Promise.resolve() })
  const keys = c.abortAll()
  assert.deepEqual(keys.sort(), ["1:2", "1:3", "1:4"])
  assert.equal(c3.signal.aborted, true)
})
