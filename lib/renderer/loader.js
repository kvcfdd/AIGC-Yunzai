import fs from "node:fs"
import lodash from "lodash"
import Renderer from "./Renderer.js"

/** 全局变量 Renderer */
global.Renderer = Renderer

/**
 * 加载渲染器
 */
class RendererLoader {
  constructor() {
    this.renderers = new Map()
    this.dir = "renderers"
  }

  static async init() {
    const render = new RendererLoader()
    await render.load()
    return render
  }

  async load() {
    const subFolders = fs.readdirSync(this.dir, { withFileTypes: true }).filter(dirent => dirent.isDirectory())
    for (const subFolder of subFolders) {
      const name = subFolder.name
      try {
        const rendererFn = (await import(`../../${this.dir}/${name}/index.js`)).default
        const renderer = rendererFn()
        if (!renderer.id || !renderer.type || !renderer.render || !lodash.isFunction(renderer.render)) {
          logger.warn("渲染后端 " + (renderer.id || subFolder.name) + " 不可用")
        }
        this.renderers.set(renderer.id, renderer)
        logger.info(`加载渲染后端 ${renderer.id}`)
      } catch (err) {
        logger.error(`渲染后端 ${name} 加载失败`)
        logger.error(err)
      }
    }
  }

  getRenderer() {
    return this.renderers.get("playwright") || {}
  }
}

export default await RendererLoader.init()
