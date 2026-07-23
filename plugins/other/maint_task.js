import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import YAML from "yaml"
import cfg from "../../lib/config/config.js"

let busy = false

export class maintTask extends plugin {
  constructor() {
    super({
      name: "资源维护",
      dsc: "定时Git更新仓库、文件清理、代理订阅更新",
      event: "message",
      priority: 5000,
      rule: [
        {
          reg: /^#?(手动|立即)维护$/,
          fnc: "manualRun",
          permission: "master",
        },
      ],
    })
  }

  init() {
    const c = cfg.maint_task || {}
    this.task = [
      {
        name: "资源维护",
        cron: c.cron || "0 20 4 * * *",
        fnc: () => this._execute(false),
      },
    ]
  }

  async manualRun() {
    const c = cfg.maint_task || {}
    if (c.enable === false) return false
    if (busy) return this.reply("正在执行中，请稍候…", true)
    await this.reply("⏳ 系统维护中 (Git更新 + 缓存清理 + 代理更新)...", true)
    await this._execute(true, this.e)
  }

  async _execute(isManual, e = null) {
    const c = cfg.maint_task || {}
    if (c.enable === false) return false
    busy = true
    const stats = { git: { ok: 0, fail: 0 }, clean: { ok: 0, fail: 0, fileCount: 0 } }
    const errParams = []
    const gitCmd = "git fetch --all && git reset --hard @{u}"
    const gitPaths = c.git_paths || ["."]
    const timeout = c.timeout || 120000
    for (const dir of gitPaths) {
      const cwd = path.isAbsolute(dir) ? dir : path.resolve(dir)
      if (!existsSync(cwd)) {
        stats.git.fail++
        continue
      }
      const ret = await Bot.exec(gitCmd, { cwd, timeout })
      if (ret.error) {
        stats.git.fail++
        errParams.push(`Git: ${path.basename(dir)}`)
        logger.error(`[${this.name}] Git ${path.basename(dir)}: ${ret.error.message}`)
      } else {
        stats.git.ok++
      }
    }

    const cleanPaths = c.clean_paths || ["data/aigc"]
    for (const dir of cleanPaths) {
      const target = path.isAbsolute(dir) ? dir : path.resolve(dir)
      if (existsSync(target)) {
        try {
          const n = await this._cleanFiles(target)
          stats.clean.fileCount += n
          stats.clean.ok++
        } catch (err) {
          stats.clean.fail++
          errParams.push(`清理: ${path.basename(dir)}`)
          logger.error(`[${this.name}] Clean ${dir}: ${err.message}`)
        }
      }
    }

    let proxyMsg = ""
    if (c.mihomo?.enable) {
      const ret = await this._mihomoUpdate(c.mihomo)
      proxyMsg = ` | 代理:${ret.msg}`
      if (!ret.ok) {
        errParams.push(`代理: ${ret.msg}`)
        logger.error(`[${this.name}] 代理更新失败: ${ret.msg}`)
      }
    }

    const logText = `维护完成 | Git成功:${stats.git.ok} 失败:${stats.git.fail} | ` + `清理目录:${stats.clean.ok} (删文件:${stats.clean.fileCount})${proxyMsg}`

    if (stats.git.fail > 0 || stats.clean.fail > 0 || errParams.some(p => p.startsWith("代理:"))) logger.error(`[${this.name}] ${logText}`)
    else logger.mark(`[${this.name}] ${logText}`)

    if (isManual && e) {
      let reply = `✅ ${logText.replace(/ \| /g, "\n")}`
      if (errParams.length) reply += `\n❌ 失败项:\n${errParams.join("\n")}`
      await e.reply(reply)
    }

    busy = false
  }

  async _cleanFiles(dirPath) {
    let count = 0
    let items = []
    try {
      items = await fs.readdir(dirPath, { withFileTypes: true })
    } catch (err) {
      logger.warn(`[${this.name}] 无法读取 ${dirPath}: ${err.message}`)
      return 0
    }
    for (const item of items) {
      const full = path.join(dirPath, item.name)
      if (item.isDirectory()) {
        count += await this._cleanFiles(full)
      } else {
        try {
          await fs.unlink(full)
          count++
        } catch (err) {
          logger.debug(`[${this.name}] 跳过文件 ${full}: ${err.message}`)
        }
      }
    }
    return count
  }

  async _mihomoUpdate(mihomo) {
    const tmpFile = path.join(os.tmpdir(), `mihomo_${Date.now()}.yaml`)
    const cmd = `curl -s -A "clash-verge/2.5.1" -o ${tmpFile} "${mihomo.sub_url}"`

    const { error: dlErr } = await Bot.exec(cmd, { timeout: 30000 })
    if (dlErr) return { ok: false, msg: `下载失败: ${dlErr.message}` }

    let fileStr, config
    try {
      fileStr = await fs.readFile(tmpFile, "utf8")
      config = YAML.parse(fileStr)
    } catch (err) {
      return { ok: false, msg: `YAML解析失败: ${err.message}` }
    } finally {
      await fs.unlink(tmpFile).catch(() => {})
    }

    const regex = new RegExp(mihomo.exclude_regex || "$^", "i")
    let removed = 0

    if (config.proxies) {
      const len = config.proxies.length
      config.proxies = config.proxies.filter(p => !regex.test(p.name))
      removed = len - config.proxies.length
    }

    if (config["proxy-groups"])
      config["proxy-groups"].forEach(g => {
        if (g.proxies) g.proxies = g.proxies.filter(name => !regex.test(name))
      })
    config.mode = "rule"
    config.rules = ["MATCH,♻️自动选择"]
    try {
      await fs.writeFile(mihomo.config_path, YAML.stringify(config))
    } catch (err) {
      return { ok: false, msg: `写入失败: ${err.message}` }
    }

    const svc = mihomo.service_name || "mihomo"
    const { error: restartErr } = await Bot.exec(`systemctl restart ${svc}`)
    if (restartErr) return { ok: false, msg: `重启失败: ${restartErr.message}` }
    return { ok: true, removed, msg: `成功(拦截${removed}个节点)` }
  }
}
