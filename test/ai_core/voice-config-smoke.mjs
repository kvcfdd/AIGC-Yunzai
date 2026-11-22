import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import YAML from "yaml"

globalThis.logger = {
  blue: value => value,
  logger: { mark: () => {}, info: () => {}, warn: () => {}, error: console.error, debug: () => {}, trace: () => {} },
}
globalThis.redis = {
  async get() {
    return null
  },
  async set() {
    return "OK"
  },
  async del() {
    return 1
  },
}

const repo = process.cwd()
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-config-"))
fs.cpSync(path.join(repo, "config/default_config"), path.join(dir, "config/default_config"), { recursive: true })
fs.cpSync(path.join(repo, "config/default_config"), path.join(dir, "config/config"), { recursive: true })
const botFile = path.join(dir, "config/config/bot.yaml")
fs.writeFileSync(botFile, fs.readFileSync(botFile, "utf8").replace(/^file_watch:.*$/m, "file_watch: false"))
process.chdir(dir)

const { getConfig, saveConfig, getRaw } = await import("../../lib/webui/store.js")

// 1. 读取默认配置
let config = await getConfig("core:aigc")
assert.deepEqual(Object.keys(config.effective.voice), ["model_config", "models"])
assert.equal(config.effective.voice.models[0].api, "wusound")
assert.deepEqual(config.choices["voice.model_config"], ["wusound"])
assert.equal(config.types["voice.models"].itemType, "object")

// 2. 保存语音模型
const models = [
  { name: "my-tts", api: "openai", proxy: false, api_key: "test-key", base_url: "https://api.openai.com/v1", model: "tts-1", voice: "alloy", response_format: "wav", speed: 1, timeout_ms: 20000, headers: {} },
]
await saveConfig("core:aigc", { voice: { models, model_config: "my-tts" } })
const raw = YAML.parse(getRaw("core:aigc").content)
assert.equal(raw.voice.models[0].api, "openai")
assert.equal(raw.voice.models[0].api_key, "test-key")
assert.equal(raw.voice.model_config, "my-tts")

// 3. 重新读取
config = await getConfig("core:aigc")
assert.equal(config.effective.voice.models[0].name, "my-tts")
assert.equal(config.effective.voice.model_config, "my-tts")
assert.deepEqual(config.choices["voice.model_config"], ["my-tts"])

// 4. 多 Key 解析
const { resolveVoiceConfig } = await import("../../lib/ai_core/output/tts/index.js")
const resolved = resolveVoiceConfig({ model_config: "multi", models: [{ name: "multi", api: "openai", api_keys: "k1, k2; k1" }] })
assert.deepEqual(resolved.keys, ["k1", "k2"])
assert.equal(resolved.opts.api_key, "k1")

console.log("voice config smoke OK", dir)
try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}
process.exit(0)
