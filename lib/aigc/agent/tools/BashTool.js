import agentTools from "../registry.js"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import log from "../../helpers/log.js"

const DEFAULT_TIMEOUT_S = 120
const MAX_TIMEOUT_S = 300
const MAX_OUTPUT_CHARS = 5000
const MAX_OUTPUT_TAIL = 300

/**
 * 当前平台的 shell 配置，探测一次后缓存。
 * Windows: 优先 PowerShell 7 → 降级 Windows PowerShell 5.1 → cmd 仅兜底
 * 其他: bash
 */
let shellCfg = null
function getShell() {
  if (shellCfg) return shellCfg
  if (process.platform === "win32") {
    if (spawnSync("where.exe", ["pwsh"], { stdio: "ignore", windowsHide: true }).status === 0) {
      shellCfg = { name: "pwsh", args: ["-NoProfile", "-Command"] }
    } else if (!spawnSync("powershell.exe", ["-NoProfile", "-Command", "$null"], { stdio: "ignore", windowsHide: true }).error) {
      shellCfg = { name: "powershell.exe", args: ["-NoProfile", "-Command"] }
    } else {
      shellCfg = { name: "cmd.exe", args: ["/d", "/s", "/c"] }
    }
  } else {
    shellCfg = { name: "bash", args: ["-c"] }
  }
  return shellCfg
}

/**
 * 不可逆破坏性命令黑名单 — 启发式匹配，拦截最灾难性的操作。
 * 命中直接拒绝，Agent 会改用安全方式完成目标。
 * 软约束策略：除此之外的命令全机可执行。
 */
const BLOCKED_PATTERNS = [
  // rm 递归删除根目录 / 家目录 / 用户主目录 (如 rm -rf /、rm -rf /*、rm -rf ~)
  /\brm\s+-[a-z]*r[a-z]*f\s+\/(?:\s|\*|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f\s+~(?:\s|\*|$)/i,
  /\brm\s+-[a-z]*r[a-z]*f\s+\/home\/[^\s]+(?:\s|$)/i,
  // Windows 全盘删除 (git bash 的 rm -rf C:\ 与 cmd 的 rmdir /s /q C:\)
  /\brm\s+-[a-z]*r[a-z]*f\s+[a-z]:\\/i,
  /\brmdir\s+\/s(?:\s+\/q)?\s+[a-z]:\\/i,
  /\bdel\s+\/f\s+\/s\s+\/q\s+[a-z]:\s*\\/i,
  // 磁盘/分区级操作
  /\bmkfs(?:\s|\.)/i,
  /\bfdisk(?:\s|$)/i,
  /\bformat\s+[a-z]:/i,
  /\bdd\b[^|;&\n]*\bof=\/dev\//i,
  // 系统控制
  /\b(shutdown|reboot|halt|poweroff)(?:\s|$)/i,
  // 根目录级权限破坏
  /\bchmod\s+-R\s+[0-7]{3,4}\s+\//i,
]

function isBlocked(command) {
  const c = command.toLowerCase().trim()
  return BLOCKED_PATTERNS.some(re => re.test(c))
}

/**
 * 子进程输出解码: 优先 UTF-8; 出现替换符说明是 Windows 控制台代码页(GBK)字节,
 * 回退用 gbk 解码
 */
const gbkDecoder = (() => {
  try {
    return new TextDecoder("gbk")
  } catch {
    return null
  }
})()

function decodeOutput(buf) {
  const utf8 = buf.toString("utf-8")
  if (!utf8.includes("�") || !gbkDecoder) return utf8
  try {
    const gbk = gbkDecoder.decode(buf)
    return gbk.includes("�") ? utf8 : gbk
  } catch {
    return utf8
  }
}

agentTools.register({
  name: "bash",
  description: `执行 shell 命令 — 本地操作核心工具，可安装/运行脚本、处理文件、调用 CLI、git 等。

- 安全准则: 禁止执行任何有害系统的命令！
- 默认在 当前目录执行，文件路径一律使用绝对路径
- 长任务设 background: true 后台运行，输出写入日志文件，返回日志路径
- 不要运行等待键盘输入的交互式命令(安装/初始化带 -y 等非交互参数)，防止任务卡死
- 查看/搜索/修改文件用 file_view/file_search/file_edit，本工具用于它们覆盖不了的场景`,

  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "要执行的 shell 命令" },
      timeout: {
        type: "number",
        description: `超时秒数，默认 ${DEFAULT_TIMEOUT_S}s，最大 ${MAX_TIMEOUT_S}s。长时间任务请用 background: true 后台运行`,
      },
      workdir: {
        type: "string",
        description: "执行目录，默认 当前目录",
      },
      background: {
        type: "boolean",
        description: "true=后台运行(立即返回，不等待)。输出写入日志文件，返回日志路径供轮询查看",
      },
    },
    required: ["command"],
  },

  execute: async (args, ctx) => {
    const { command, timeout, workdir, background } = args
    if (!command || typeof command !== "string") return "缺少命令参数 (command)"

    if (isBlocked(command)) {
      log.warn(`[Agent-Bash] 拦截破坏性命令: ${command.slice(0, 120)}`)
      return "命令已被安全策略拦截: 该命令属于不可逆的破坏性操作，请改用安全的方式完成目标。"
    }

    const timeoutS = Math.min(Math.max(Number(timeout) || DEFAULT_TIMEOUT_S, 1), MAX_TIMEOUT_S)
    // 默认在 当前目录执行，与聊天侧 send 工具的路径解析基准保持一致；工作区文件用绝对路径访问
    const baseDir = process.cwd()
    const cwd = workdir ? (path.isAbsolute(workdir) ? path.resolve(workdir) : path.resolve(baseDir, workdir)) : baseDir

    // 后台运行: 脱离父进程，输出重定向到日志文件
    if (background === true) {
      const bgDir = path.join(baseDir, ".bg")
      fs.mkdirSync(bgDir, { recursive: true })
      const logPath = path.join(bgDir, `bg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.log`)
      const outFd = fs.openSync(logPath, "a")
      const shell = getShell()
      const child = spawn(shell.name, [...shell.args, command], {
        cwd,
        detached: true,
        stdio: ["ignore", outFd, outFd],
        windowsHide: true,
      })
      child.on("exit", code => {
        try {
          fs.appendFileSync(logPath, `\n[进程已退出, exit code: ${code}]\n`)
        } catch {}
      })
      child.unref()
      log.info(`[Agent-Bash] 后台启动 PID ${child.pid}: ${command.slice(0, 150)}`)
      return `任务已在后台启动 (PID: ${child.pid})\n日志文件: ${logPath}\n查看进度用: tail -n 50 "${logPath}"，进程结束时日志末尾会出现 [进程已退出] 标记。`
    }

    log.info(`[Agent-Bash] (${timeoutS}s) ${command.slice(0, 200)}${command.length > 200 ? "..." : ""}`)

    // 前台执行: 显式 spawn 所选 shell 并传参，输出流式收集，超时 kill
    const shell = getShell()
    const result = await new Promise(resolve => {
      const child = spawn(shell.name, [...shell.args, command], {
        cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })

      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutS * 1000)

      const bufs = {
        stdout: { head: [], tail: [], total: 0 },
        stderr: { head: [], tail: [], total: 0 },
      }
      const feed = (stream, d) => {
        const s = bufs[stream]
        s.total += d.length
        let headLen = 0
        for (const b of s.head) headLen += b.length
        if (headLen < MAX_OUTPUT_CHARS) s.head.push(d.subarray(0, MAX_OUTPUT_CHARS - headLen))
        s.tail.push(d)
        let tLen = 0
        for (const b of s.tail) tLen += b.length
        while (tLen > MAX_OUTPUT_TAIL) {
          const first = s.tail[0]
          const drop = tLen - MAX_OUTPUT_TAIL
          if (first.length <= drop) {
            s.tail.shift()
            tLen -= first.length
          } else {
            s.tail[0] = first.subarray(drop)
            tLen = MAX_OUTPUT_TAIL
          }
        }
      }
      const assemble = stream => {
        const s = bufs[stream]
        if (s.total <= MAX_OUTPUT_CHARS) return Buffer.concat(s.head)
        return Buffer.concat([...s.head, Buffer.from(`\n...[${Math.max(0, s.total - MAX_OUTPUT_CHARS - MAX_OUTPUT_TAIL)} 字节已省略]`), ...s.tail])
      }
      for (const stream of ["stdout", "stderr"]) {
        child[stream]?.on("data", d => feed(stream, d))
      }

      child.on("error", err => {
        clearTimeout(timer)
        resolve({ code: err.code === "ENOENT" ? 127 : 1, timedOut: false, outBuf: Buffer.alloc(0), errBuf: Buffer.from(String(err?.message || err)) })
      })
      child.on("close", code => {
        clearTimeout(timer)
        resolve({ code: code ?? 1, timedOut, outBuf: assemble("stdout"), errBuf: assemble("stderr") })
      })
    })

    const out = decodeOutput(result.outBuf).trimEnd()
    const err = decodeOutput(result.errBuf).trimEnd()

    if (result.timedOut) {
      return `执行超时 (${timeoutS}s)，进程已终止。请优化命令或改用后台方式运行。\n\n$ ${command}\n\n${out || "(无输出)"}`
    }
    if (result.code !== 0) {
      return `命令失败 (exit code: ${result.code})\n\n$ ${command}\n\n${err || out || "(无输出)"}\n\n请根据错误修正后重试。`
    }
    if (!out && !err) return `命令执行成功 (exit code: 0)，无输出。\n\n$ ${command}`
    return `命令执行成功 (exit code: 0)\n\n$ ${command}\n\n${err ? `[stderr]\n${err}\n\n` : ""}${out}`
  },
})
