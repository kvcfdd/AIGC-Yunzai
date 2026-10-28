import fs from "node:fs/promises"
import tools from "../tool-registry.js"
import { isMaster, NON_MASTER_MSG, resolveWorkspacePath } from "../workspace.js"

/** 读取上限 */
const READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 51_200

function parsePositiveInteger(value, name) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

/** 校验并填充 read 参数 */
export function parseReadArgs(args) {
  if (typeof args.file_path !== "string" || args.file_path.trim().length === 0) throw new Error("file_path must be a non-empty string")
  const offset = args.offset === undefined ? 1 : parsePositiveInteger(args.offset, "offset")
  const limit = args.limit === undefined ? READ_LIMIT : parsePositiveInteger(args.limit, "limit")
  if (limit > READ_LIMIT) throw new Error(`limit must be less than or equal to ${READ_LIMIT}`)
  return { filePath: args.file_path, offset, limit }
}

tools.register({
  name: "read",
  description: "Read a UTF-8 text file and return line-numbered content. Use fetch_media for images/audio/video and pwsh for binary or oversized files.",
  parameters: {
    type: "object",
    properties: {
      file_path: {
        type: "string",
        description: "Path to read, relative to the project root.",
      },
      offset: {
        type: "number",
        minimum: 1,
        default: 1,
        description: "1-based first line to return.",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: READ_LIMIT,
        default: READ_LIMIT,
        description: "Maximum number of lines to return.",
      },
    },
    required: ["file_path"],
  },
  execute: async (args, ctx) => {
    if (!isMaster(ctx)) return NON_MASTER_MSG

    const { filePath, offset, limit } = parseReadArgs(args)
    const abs = resolveWorkspacePath(filePath)

    let st
    try {
      st = await fs.stat(abs)
    } catch {
      throw new Error(`cannot read "${filePath}": not found`)
    }
    if (!st.isFile()) throw new Error(`cannot read "${filePath}": not a regular file`)

    const buf = await fs.readFile(abs)
    if (buf.includes(0)) throw new Error(`cannot read "${filePath}": not a UTF-8 text file`)

    const text = buf.toString("utf8")
    const lines = text.split(/\r?\n/)
    if (lines.length && lines[lines.length - 1] === "") lines.pop()
    const totalLines = lines.length

    if (totalLines === 0) {
      return `<path>${abs}</path>\n<type>file</type>\n<content>\n(End of file - total 0 lines)\n</content>`
    }
    if (offset > totalLines) throw new Error(`offset ${offset} is out of range for "${filePath}" (${totalLines} lines)`)

    const out = []
    let bytes = 0
    let capped = false
    for (let i = offset - 1; i < lines.length && out.length < limit; i++) {
      let line = lines[i]
      if (line.length > MAX_LINE_LENGTH) line = `${line.slice(0, MAX_LINE_LENGTH)}... (line truncated to ${MAX_LINE_LENGTH} chars)`
      const row = `${i + 1}: ${line}`
      const size = Buffer.byteLength(row, "utf8") + 1
      if (out.length > 0 && bytes + size > MAX_BYTES) {
        capped = true
        break
      }
      out.push(row)
      bytes += size
    }

    const last = offset + out.length - 1
    let footer
    if (!capped && last >= totalLines) footer = `(End of file - total ${totalLines} lines)`
    else if (capped) footer = `(Output capped. Showing lines ${offset}-${last}. Use offset=${last + 1} to continue.)`
    else footer = `(Showing lines ${offset}-${last} of ${totalLines}. Use offset=${last + 1} to continue.)`

    return `<path>${abs}</path>\n<type>file</type>\n<content>\n${out.join("\n")}\n${footer}\n</content>`
  },
})
