import { ProxyAgent } from "undici"
import cfg from "../../config/config.js"
import log from "./log.js"

let _agent = null
let _agentAddress = ""

function _getAddress() {
  return cfg.aigc?.proxy?.address || ""
}

/** 获取或创建缓存的 ProxyAgent 实例，地址变更时自动替换旧实例 */
function _getOrCreateAgent() {
  const address = _getAddress()
  if (!address) return null

  if (_agent && _agentAddress === address) return _agent

  // 地址变更 → 异步关闭旧实例
  if (_agent) {
    const oldAgent = _agent
    oldAgent.close().catch(err => {
      log.debug(`关闭旧代理连接池失败: ${err.message}`)
    })
  }

  _agent = new ProxyAgent(address)
  _agentAddress = address
  return _agent
}

/** LLM API 请求代理，受 proxy.enable 开关控制 */
export function getLLMDispatcher() {
  if (!cfg.aigc?.proxy?.enable) return undefined
  return _getOrCreateAgent()
}

/** 图片下载代理。只要配置了代理地址就走，不受开关控制（用于 pixiv 等被墙站点） */
export function getDownloadDispatcher() {
  return _getOrCreateAgent()
}

/** Playwright 浏览器代理，由调用方决定是否启用 */
export function getPlaywrightProxy(useProxy) {
  const address = _getAddress()
  if (!address || !useProxy) return undefined
  return { server: address }
}
