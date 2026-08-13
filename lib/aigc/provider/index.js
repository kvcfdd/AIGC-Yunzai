import { GeminiAdapter } from "./gemini/adapter.js"

/** LLM Provider 工厂 — 目前仅适配 Gemini，未来接入新后端时在此扩展 */
export function createProvider(name = "gemini") {
  if (name !== "gemini") throw new Error(`Unsupported LLM provider: ${name}`)
  return new GeminiAdapter()
}

export default createProvider()
