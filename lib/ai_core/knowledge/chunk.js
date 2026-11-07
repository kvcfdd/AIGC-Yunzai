/** 文档分块 — 结构化文档按标题层级切分，普通文本按分隔符递归切分 */

/** 分隔符优先级：段落 → 换行 → 中文/英文句读 → 空格 → 字符 */
const SEPARATORS = ["\n\n", "\n", "。", "！", "？", "；", "，", ". ", ", ", " ", ""]

/** 标题路径前缀上限，避免超长标题把小块撑得过大 */
const MAX_HEADING_PREFIX = 160

function splitRecursive(text, separators, size) {
  const trimmed = String(text || "").trim()
  if (!trimmed) return []
  if (trimmed.length <= size) return [trimmed]

  const index = separators.findIndex(separator => separator && trimmed.includes(separator))
  if (index === -1) {
    const parts = []
    for (let i = 0; i < trimmed.length; i += size) parts.push(trimmed.slice(i, i + size))
    return parts
  }

  const separator = separators[index]
  const rest = separators.slice(index + 1)
  const pieces = trimmed.split(separator)
  const chunks = []
  let buffer = ""

  for (const piece of pieces) {
    if (!piece) continue
    const candidate = buffer ? `${buffer}${separator}${piece}` : piece
    if (candidate.length <= size) {
      buffer = candidate
      continue
    }
    if (buffer) {
      chunks.push(buffer)
      buffer = ""
    }
    if (piece.length > size) chunks.push(...splitRecursive(piece, rest, size))
    else buffer = piece
  }
  if (buffer) chunks.push(buffer)
  return chunks
}

/** 相邻块重叠：把上一块尾部拼到下一块开头，超过块长时放弃重叠 */
function applyOverlap(chunks, size, overlap) {
  if (overlap <= 0 || chunks.length < 2) return chunks
  const out = []
  for (const chunk of chunks) {
    const previous = out.at(-1)
    if (!previous) {
      out.push(chunk)
      continue
    }
    const merged = previous.slice(-overlap) + chunk
    out.push(merged.length <= size ? merged : chunk)
  }
  return out
}

/**
 * 解析 Markdown 标题层级。
 * 围栏代码块（``` / ~~~）内的 # 不是标题，解析前先跳过。
 * 只有标题没有正文的章节不单独成块，其标题会保留在后续子章节的路径中。
 */
export function markdownSections(text) {
  const lines = String(text || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
  const sections = []
  let stack = []
  let current = { headings: [], lines: [] }
  let fence = ""

  const flush = () => {
    const body = current.lines.join("\n").trim()
    if (body) sections.push({ headings: current.headings.filter(Boolean), body })
    current = { headings: [...stack], lines: [] }
  }

  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (!fence) fence = marker
      else if (fence === marker) fence = ""
      current.lines.push(line)
      continue
    }

    if (!fence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
      if (heading) {
        flush()
        const level = heading[1].length
        stack = stack.slice(0, level - 1)
        while (stack.length < level - 1) stack.push("")
        stack[level - 1] = heading[2].trim()
        current = { headings: [...stack], lines: [] }
        continue
      }
    }

    current.lines.push(line)
  }
  flush()
  return sections
}

/**
 * 文档 → 文本块。
 * @param {{ text: string, markdown?: boolean, size?: number, overlap?: number }} opts
 * @returns {{ heading: string, content: string }[]}
 */
export function chunkDocument({ text, markdown = false, size = 512, overlap = 50 } = {}) {
  const normalized = String(text || "")
    .replace(/\r\n?/g, "\n")
    .trim()
  if (!normalized) return []

  const blockSize = Math.max(100, Number(size) || 512)
  const blockOverlap = Math.min(Math.max(0, Number(overlap) || 0), blockSize - 1)

  if (!markdown) {
    return applyOverlap(splitRecursive(normalized, SEPARATORS, blockSize), blockSize, blockOverlap)
      .map(content => content.trim())
      .filter(Boolean)
      .map(content => ({ heading: "", content }))
  }

  const chunks = []
  for (const section of markdownSections(normalized)) {
    const heading = section.headings.join(" > ")
    const prefixText = heading.length > MAX_HEADING_PREFIX ? heading.slice(-MAX_HEADING_PREFIX) : heading
    const prefix = prefixText ? `${prefixText}\n\n` : ""
    // 正文分块长度扣除标题前缀，保证最终块尽量不超过配置值
    const available = Math.max(80, blockSize - prefix.length)
    for (const part of applyOverlap(splitRecursive(section.body, SEPARATORS, available), available, blockOverlap)) {
      const content = `${prefix}${part.trim()}`.trim()
      if (content) chunks.push({ heading, content })
    }
  }
  return chunks
}
