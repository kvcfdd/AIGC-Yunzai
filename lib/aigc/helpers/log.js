import cfg from "../../config/config.js"

const log = {
  get _name() { return cfg.aigc?.bot_name || "AIGC" },
  info(msg) { logger.info(`[${this._name}] ${msg}`) },
  mark(msg) { logger.mark(`[${this._name}] ${msg}`) },
  warn(msg) { logger.warn(`[${this._name}] ${msg}`) },
  error(msg) { logger.error(`[${this._name}] ${msg}`) },
  debug(msg) { logger.debug(`[${this._name}] ${msg}`) },
}

export default log
