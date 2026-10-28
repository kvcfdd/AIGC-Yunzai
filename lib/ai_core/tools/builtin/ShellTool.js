import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs/promises"
import tools from "../tool-registry.js"
import { isMaster, NON_MASTER_MSG, resolveWorkspacePath, tailBytes, spillStream } from "../workspace.js"

const execFileAsync = promisify(execFile)
const IS_WIN = process.platform === "win32"
const TOOL_NAME = IS_WIN ? "pwsh" : "bash"
const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT = 64_000
const MAX_BUFFER = 20 * 1024 * 1024
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
    let stdout = ""
    let stderr = ""
    let exitCode = 0
    let signal = null
    let timedOut = false
    let aborted = false

    try {
      const res = await execFileAsync(file, argv(command), {
        cwd,
        timeout,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        signal: ctx.signal,
        env: ENV,
      })
      stdout = res.stdout
      stderr = res.stderr
    } catch (err) {
      if (err?.code === "ENOENT") throw new Error(`failed to start ${file}: ${err.message}`)
      stdout = err?.stdout || ""
      stderr = err?.stderr || ""
      aborted = err?.name === "AbortError"
      timedOut = !aborted && err?.killed === true
      signal = err?.signal || null
      exitCode = typeof err?.code === "number" ? err.code : 0
    }

    const out = await renderStream("stdout", stdout)
    const errText = await renderStream("stderr", stderr)
    let body = out
    if (errText) {
      if (body && !body.endsWith("\n")) body += "\n"
      body += `[stderr]\n${errText}`
    }
    if (!body) body = "(no output)"

    const markers = []
    if (timedOut) markers.push(`[timed out after ${timeout}ms]`)
    if (aborted) markers.push("[aborted]")
    if (signal) markers.push(`[killed by signal: ${signal}]`)
    else if (exitCode !== 0) markers.push(`[exit code: ${exitCode}]`)

    if (!markers.length) return body
    return `${body}${body.endsWith("\n") ? "" : "\n"}${markers.join("\n")}`
  },
})
