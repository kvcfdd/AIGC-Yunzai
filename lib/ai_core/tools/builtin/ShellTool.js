import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs/promises"
import tools from "../tool-registry.js"
import { isMaster, NON_MASTER_MSG, resolveWorkspacePath, tailBytes, spillStream } from "../workspace.js"

const IS_WIN = process.platform === "win32"
const TOOL_NAME = IS_WIN ? "pwsh" : "bash"
const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT = 64_000
const MAX_BUFFER = 20 * 1024 * 1024
const KILL_GRACE_MS = 2_000
const ENV = { ...process.env, NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" }
const ENCODING_PREAMBLE = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); "

let shell
/** 解析 PowerShell / bash；结果缓存 */
function resolveShell() {
  if (shell) return shell

  if (IS_WIN) {
    for (const file of ["pwsh", "powershell.exe"]) {
      try {
        execFileSync(file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "ignore", timeout: 10_000, windowsHide: true })
        shell = { file, argv: command => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ENCODING_PREAMBLE + command] }
        return shell
      } catch {
        /* try next */
      }
    }
    shell = { file: "powershell.exe", argv: command => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ENCODING_PREAMBLE + command] }
  } else {
    for (const file of ["bash", "/bin/sh"]) {
      try {
        execFileSync(file, ["-c", "true"], { stdio: "ignore", timeout: 5_000 })
        shell = { file, argv: command => ["-c", command] }
        return shell
      } catch {
        /* try next */
      }
    }
    shell = { file: "/bin/sh", argv: command => ["-c", command] }
  }
  return shell
}

/** 单流尾部截断；完整内容 spill 到 temp/tool-output */
async function renderStream(name, text) {
  const { text: tail, truncated } = tailBytes(text, MAX_OUTPUT)
  if (!truncated) return tail
  const spill = await spillStream(name, text).catch(() => null)
  return `${tail}\n[output truncated; full output: ${spill ?? "(unavailable)"}]`
}

/** 启动 shell 并收集输出；中止/超时/超缓冲时结束整棵进程树 */
function runShellProcess(file, argv, { cwd, env, timeout, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ stdout: "", stderr: "", exitCode: 0, exitSignal: null, timedOut: false, aborted: true, bufferFull: false })
      return
    }

    let child
    try {
      child = spawn(file, argv, { cwd, env, windowsHide: true, detached: !IS_WIN })
    } catch (err) {
      reject(err)
      return
    }

    let stdout = ""
    let stderr = ""
    let outBytes = 0
    let errBytes = 0
    let timedOut = false
    let aborted = false
    let bufferFull = false
    let killStarted = false
    let settled = false
    let killTimer = null

    // 结束整个进程树：POSIX 靠独立进程组，Windows 用 taskkill /T
    const killTree = () => {
      if (killStarted || settled) return
      killStarted = true
      if (IS_WIN) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        killer.on("error", () => child.kill())
      } else {
        try {
          process.kill(-child.pid, "SIGTERM")
        } catch {
          child.kill("SIGTERM")
        }
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL")
          } catch {
            child.kill("SIGKILL")
          }
        }, KILL_GRACE_MS)
        killTimer.unref?.()
      }
    }

    const onAbort = () => {
      aborted = true
      killTree()
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeout)

    const cleanup = () => {
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal?.removeEventListener?.("abort", onAbort)
    }

    signal?.addEventListener?.("abort", onAbort, { once: true })

    const collect = (chunk, stream) => {
      if (outBytes + errBytes < MAX_BUFFER) {
        if (stream === "stdout") stdout += chunk
        else stderr += chunk
      }
      if (stream === "stdout") outBytes += Buffer.byteLength(chunk)
      else errBytes += Buffer.byteLength(chunk)
      if (!bufferFull && outBytes + errBytes >= MAX_BUFFER) {
        bufferFull = true
        killTree()
      }
    }

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", chunk => collect(chunk, "stdout"))
    child.stderr.on("data", chunk => collect(chunk, "stderr"))

    child.on("error", err => {
      cleanup()
      reject(err)
    })
    child.on("close", (code, sig) => {
      cleanup()
      resolve({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : 0,
        exitSignal: sig || null,
        timedOut,
        aborted,
        bufferFull,
      })
    })
  })
}

tools.register({
  name: TOOL_NAME,
  description: IS_WIN
    ? "Execute a PowerShell command (`pwsh -Command`) in a fresh process and return stdout/stderr. The default working directory is the bot project root; run `Get-Location` to see the absolute path. Use `workdir` instead of `cd`; prefer read/write/edit for files and glob/grep for search. Long output is truncated and the full output file path is reported."
    : "Execute a bash command (`bash -c`) in a fresh process and return stdout/stderr. The default working directory is the bot project root; run `pwd` to see the absolute path. Use `workdir` instead of `cd`; prefer read/write/edit for files and glob/grep for search. Long output is truncated and the full output file path is reported.",
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: IS_WIN ? "The PowerShell command to execute." : "The bash command to execute.",
      },
      timeoutMs: {
        type: "number",
        minimum: 1000,
        maximum: MAX_TIMEOUT,
        default: DEFAULT_TIMEOUT,
        description: "Timeout in milliseconds.",
      },
      workdir: {
        type: "string",
        description: "Working directory. Defaults to the bot project root.",
      },
    },
    required: ["command"],
  },
  execute: async (args, ctx) => {
    if (!isMaster(ctx)) return NON_MASTER_MSG

    const { command, timeoutMs, workdir } = args
    if (typeof command !== "string" || command.trim().length === 0) throw new Error("invalid command: expected a non-empty string")

    const timeout = Math.min(Math.max(Math.floor(Number(timeoutMs) || DEFAULT_TIMEOUT), 1000), MAX_TIMEOUT)
    const cwd = resolveWorkspacePath(workdir || ".", { allowRoot: true })
    const st = await fs.stat(cwd).catch(() => null)
    if (!st?.isDirectory()) throw new Error(`workdir is not a directory: ${workdir || "."}`)

    const { file, argv } = resolveShell()
    let run
    try {
      run = await runShellProcess(file, argv(command), { cwd, env: ENV, timeout, signal: ctx.signal })
    } catch (err) {
      if (err?.code === "ENOENT") throw new Error(`failed to start ${file}: ${err.message}`)
      throw err
    }

    const out = await renderStream("stdout", run.stdout)
    const errText = await renderStream("stderr", run.stderr)
    let body = out
    if (errText) {
      if (body && !body.endsWith("\n")) body += "\n"
      body += `[stderr]\n${errText}`
    }
    if (!body) body = "(no output)"

    const markers = []
    if (run.timedOut) markers.push(`[timed out after ${timeout}ms]`)
    if (run.aborted) markers.push("[aborted]")
    if (run.bufferFull) markers.push(`[output limit exceeded (${MAX_BUFFER} bytes)]`)
    if (run.exitSignal) markers.push(`[killed by signal: ${run.exitSignal}]`)
    else if (run.exitCode !== 0 && !run.aborted && !run.timedOut) markers.push(`[exit code: ${run.exitCode}]`)

    if (!markers.length) return body
    return `${body}${body.endsWith("\n") ? "" : "\n"}${markers.join("\n")}`
  },
})
