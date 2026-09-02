import Playwright from "./lib/playwright.js"

/**
 * 渲染参数 config/config/renderer.yaml
 * @returns renderer 渲染器对象
 */
export default function () {
  return new Playwright()
}
