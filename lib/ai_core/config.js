import cfg from "../config/config.js"

/** AIGC 配置访问器 — 各层统一从这里读取，避免 cfg.aigc 访问散落各处 */
export const getAigc = () => cfg.aigc || {}
export const getMaster = () => cfg.master || {}
export const getAllAigc = () => cfg.getAllCfg("aigc")
export const setAigc = (key, value) => cfg.setConfig("aigc", key, value)

export default cfg
