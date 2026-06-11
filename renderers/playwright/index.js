import Playwright from "./lib/playwright.js"

/**
 * @param config 本地config.yaml的配置内容
 * @returns renderer 渲染器对象
 */
export default function (config) {
  return new Playwright(config)
}
