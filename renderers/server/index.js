import ServerRenderer from "./lib/ServerRenderer.js"

/**
 * 独立 HTTP 渲染服务
 * @returns renderer 渲染器对象
 */
export default function () {
  return new ServerRenderer()
}
