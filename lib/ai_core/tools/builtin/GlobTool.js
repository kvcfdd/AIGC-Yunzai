import fs from "node:fs/promises"
import tools from "../tool-registry.js"
import { isMaster, resolveSearchRoots, displayPath } from "../workspace.js"
import { walkFiles, matchesGlob } from "../../helpers/walk-files.js"

const MAX_RESULTS = 100
const MAX_SCAN = 10_000

tools.register({
  name: "glob",
  description: `Find files by path pattern (not file contents; use grep for that). Hidden files included; node_modules/VCS directories skipped; up to ${MAX_RESULTS} paths.`,
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern, e.g. "**/*.js" or "src/**/*.test.js". A pattern without "/" matches the basename at any depth.',
      },
      path: {
        type: "string",
        description: "Directory to search. Defaults to the project root.",
      },
    },
    required: ["pattern"],
  },
  execute: async (args, ctx) => {
    const { pattern, path: searchPath } = args
    if (typeof pattern !== "string" || pattern.trim().length === 0) throw new Error("pattern must be a non-empty string")

    const master = isMaster(ctx)
    const explicit = typeof searchPath === "string" && searchPath.trim().length > 0
    const roots = resolveSearchRoots(ctx, searchPath)

    const matched = []
    let invalid = null
    let scanned = 0
    let stopped = false
    for (const root of roots) {
      if (stopped || invalid) break
      const st = await fs.stat(root).catch(() => null)
      if (!st?.isDirectory()) {
        if (master || explicit) throw new Error(`path is not a directory: ${searchPath || "."}`)
        continue
      }
      const res = await walkFiles(root, {
        maxFiles: MAX_SCAN - scanned,
        onFile: async (abs, rel) => {
          if (invalid) return
          try {
            if (matchesGlob(rel, pattern)) matched.push(abs)
          } catch (err) {
            invalid = err
          }
        },
      })
      scanned += res.seen
      if (res.stopped || scanned >= MAX_SCAN) stopped = true
    }
    if (invalid) throw new Error(`invalid glob pattern: ${invalid.message}`)
    if (!matched.length) return "No files found"

    const entries = await Promise.all(
      matched.map(async abs => {
        try {
          const s = await fs.stat(abs)
          return { abs, mtime: s.mtimeMs }
        } catch {
          return { abs, mtime: 0 }
        }
      }),
    )
    entries.sort((a, b) => a.mtime - b.mtime || a.abs.localeCompare(b.abs))
    const paths = entries.map(e => displayPath(e.abs))

    if (paths.length <= MAX_RESULTS) return paths.join("\n")
    return `${paths.slice(0, MAX_RESULTS).join("\n")}\n\n(Showing ${MAX_RESULTS} of ${paths.length} paths${stopped ? " (scan capped)" : ""}. Narrow the pattern or path to see more.)`
  },
})
