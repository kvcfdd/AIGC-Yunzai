import fs from "node:fs/promises"
import tools from "../tool-registry.js"
import { isMaster, NON_MASTER_MSG, resolveWorkspacePath, displayPath } from "../workspace.js"
import { walkFiles, matchesGlob } from "../../helpers/walk-files.js"

const MAX_MATCHES = 250
const MAX_LINE = 2000
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_SCAN = 5000

/** include 只能是单个正向 glob */
function validateInclude(include) {
  if (typeof include !== "string" || include.trim().length === 0) throw new Error("include must be a non-empty glob when given")
  if (include.startsWith("!")) throw new Error('include must be a positive glob filter; negated patterns ("!…") are not supported')
  let depth = 0
  for (const ch of include) {
    if (ch === "{") depth++
    else if (ch === "}") depth = Math.max(0, depth - 1)
    else if (ch === "," && depth === 0) throw new Error("include must be one glob, not a comma-separated list (use {a,b} alternation instead)")
  }
}

tools.register({
  name: "grep",
  description: "Search file contents with a JavaScript regular expression (not file names; use glob for that). Results grouped by file; node_modules/VCS directories skipped.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "JavaScript regular expression to search for.",
      },
      path: {
        type: "string",
        description: "File or directory to search. Defaults to the project root.",
      },
      include: {
        type: "string",
        description: 'One positive glob filter (e.g. "*.ts", "*.{js,jsx}"); not a list, no negation.',
      },
    },
    required: ["pattern"],
  },
  execute: async (args, ctx) => {
    if (!isMaster(ctx)) return NON_MASTER_MSG

    const { pattern, path: searchPath, include } = args
    if (typeof pattern !== "string" || pattern.length === 0) throw new Error("pattern must be a non-empty string")
    if (include !== undefined) validateInclude(include)

    let re
    try {
      re = new RegExp(pattern)
    } catch (err) {
      throw new Error(`invalid regular expression: ${err.message}`)
    }

    const root = resolveWorkspacePath(searchPath || ".", { allowRoot: true })
    const st = await fs.stat(root).catch(() => null)
    if (!st) throw new Error(`cannot search "${searchPath || "."}": not found`)

    const matches = []
    let total = 0

    const scanFile = async abs => {
      let s
      try {
        s = await fs.stat(abs)
      } catch {
        return
      }
      if (!s.isFile() || s.size > MAX_FILE_BYTES) return

      let buf
      try {
        buf = await fs.readFile(abs)
      } catch {
        return
      }
      if (buf.includes(0)) return

      const lines = buf.toString("utf8").split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue
        total++
        if (matches.length < MAX_MATCHES) {
          const text = lines[i].length > MAX_LINE ? `${lines[i].slice(0, MAX_LINE)}...` : lines[i]
          matches.push({ path: displayPath(abs), line: i + 1, text })
        }
      }
    }

    if (st.isDirectory()) {
      await walkFiles(root, {
        maxFiles: MAX_SCAN,
        onFile: async (abs, rel) => {
          if (include && !matchesGlob(rel, include)) return
          await scanFile(abs)
        },
      })
    } else if (st.isFile()) {
      await scanFile(root)
    }

    if (!total) return "No matches found"

    const byFile = new Map()
    for (const m of matches) {
      const list = byFile.get(m.path) || []
      list.push(m)
      byFile.set(m.path, list)
    }
    const sections = [...byFile].map(([p, list]) => `${p}\n${list.map(m => `Line ${m.line}: ${m.text}`).join("\n")}`)
    const header = total > matches.length ? `Found ${matches.length} of ${total} matches` : `Found ${total} match${total === 1 ? "" : "es"}`
    const body = `${header}\n\n${sections.join("\n\n")}`
    return total > matches.length ? `${body}\n\n(Showing first ${matches.length} matches. Narrow pattern, path, or include to see more.)` : body
  },
})
