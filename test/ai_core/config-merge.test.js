import test from "node:test"
import assert from "node:assert/strict"
import cfg from "../../lib/config/config.js"

/** 临时替换配置读取方法，测试结束后恢复 */
function withConfig(defaults, user, fn) {
  const originalDef = cfg.getdefSet
  const originalUser = cfg.getConfig
  cfg.getdefSet = () => defaults
  cfg.getConfig = () => user
  try {
    return fn()
  } finally {
    cfg.getdefSet = originalDef
    cfg.getConfig = originalUser
  }
}

test("config merge: 默认层与用户层浅合并，用户值覆盖默认值", () => {
  withConfig({ a: 1, nested: { x: 1, y: 2 }, list: [1], keep: "default" }, { a: 9, nested: { y: 3 }, list: [9] }, () => {
    assert.deepEqual(cfg.getAllCfg("test"), {
      a: 9,
      nested: { y: 3 },
      list: [9],
      keep: "default",
    })
  })
})

test("config merge: 用户文件缺失时完全使用默认值", () => {
  withConfig({ a: 1, nested: { b: 2 } }, undefined, () => {
    assert.deepEqual(cfg.getAllCfg("test"), { a: 1, nested: { b: 2 } })
  })
})

test("config merge: 群级覆盖按 default / bot:default / group / bot:group 叠加", () => {
  const original = cfg.getAllCfg
  cfg.getAllCfg = () => ({
    default: { groupCD: 500, onlyReplyAt: 0 },
    "9:default": { onlyReplyAt: 1 },
    100: { groupCD: 1000 },
    "9:100": { onlyReplyAt: 2 },
  })
  try {
    assert.deepEqual(cfg.getGroup("9", "100"), { groupCD: 1000, onlyReplyAt: 2 })
    assert.deepEqual(cfg.getGroup("9", "200"), { groupCD: 500, onlyReplyAt: 1 })
  } finally {
    cfg.getAllCfg = original
  }
})
