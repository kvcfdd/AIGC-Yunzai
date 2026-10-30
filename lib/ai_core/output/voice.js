import cfg from "../config.js"
import { available as isAvailable, listProviders, synthesize } from "./tts/index.js"

/** 当前配置是否有可用的语音合成服务 */
export function available(config = cfg) {
  return isAvailable(config)
}

/** 按 aigc.voice.provider 选择服务商，返回音频 URL 或本地文件路径 */
async function tts(text, config = cfg) {
  return synthesize(text, config)
}

export { listProviders }
export default { tts, available, listProviders }
