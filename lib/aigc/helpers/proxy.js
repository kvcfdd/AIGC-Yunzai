import { ProxyAgent } from "undici"
import cfg from "../../config/config.js"
import log from "./log.js"

let _llmAgent = null
let _llmAgentAddress = ""

function _getAddress() {
  return cfg.aigc?.proxy?.address || ""
}

/** LLM API 请求代理，受 proxy.enable 开关控制 */
export function getLLMDispatcher() {
  const address = _getAddress()
  if (!address || !cfg.aigc?.proxy?.enable) return undefined

  if (_llmAgent && _llmAgentAddress === address) return _llmAgent

  // 地址变更 → 异步关闭旧实例
  if (_llmAgent) {
    const oldAgent = _llmAgent
    oldAgent.close().catch(err => {
      log.debug(`关闭旧代理连接池失败: ${err.message}`)
    })
  }

  _llmAgent = new ProxyAgent(address)
  _llmAgentAddress = address
  return _llmAgent
}

/** Playwright 浏览器代理，由调用方决定是否启用 */
export function getPlaywrightProxy(useProxy) {
  const address = _getAddress()
  if (!address || !useProxy) return undefined
  return { server: address }
}
