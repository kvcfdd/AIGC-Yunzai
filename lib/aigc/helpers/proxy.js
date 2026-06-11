import { ProxyAgent } from "undici"
import cfg from "../../config/config.js"

function _getAddress() {
  return cfg.aigc?.proxy?.address || ""
}

/** 图片/文件下载代理，有地址就走，不受开关控制 */
export function getDownloadDispatcher() {
  const address = _getAddress()
  if (!address) return undefined
  return new ProxyAgent(address)
}

/** LLM API 请求代理，受 proxy.enable 开关控制 */
export function getLLMDispatcher() {
  const address = _getAddress()
  if (!address || !cfg.aigc?.proxy?.enable) return undefined
  return new ProxyAgent(address)
}

/** Playwright 浏览器代理，由调用方决定是否启用 */
export function getPlaywrightProxy(useProxy) {
  const address = _getAddress()
  if (!address || !useProxy) return undefined
  return { server: address }
}
