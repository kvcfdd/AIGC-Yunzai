/** Redis glob 匹配 —— 用于 keys() 与 scan() 的 MATCH 模式
 *  支持 * ? [abc] [^abc] 与 \ 转义，与 Redis 的 stringmatchlen 语义一致
 */

const BS = String.fromCharCode(92)
const SPECIAL = ".*+?^${}()|[]/-"
const escapeRe = s => [...s].map(ch => (SPECIAL.includes(ch) ? BS + ch : ch)).join("")

export function globToRe(glob) {
  let re = "^"
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]

    if (c === BS && i + 1 < glob.length) {
      re += escapeRe(glob[++i])
      continue
    }
    if (c === "*") {
      re += ".*"
      continue
    }
    if (c === "?") {
      re += "."
      continue
    }
    if (c === "[") {
      let j = i + 1
      let neg = false
      let cls = ""
      if (glob[j] === "^") {
        neg = true
        j++
      }
      for (; j < glob.length && glob[j] !== "]"; j++) cls += (glob[j] === BS || glob[j] === "^" || glob[j] === "]" ? BS : "") + glob[j]
      if (j >= glob.length) {
        re += `${BS}[`
        continue
      }
      re += `[${neg ? "^" : ""}${cls}]`
      i = j
      continue
    }
    re += escapeRe(c)
  }
  return new RegExp(`${re}$`)
}

export function globPrefix(glob) {
  const i = glob.search(/[*?[\]]/)
  return i === -1 ? glob : glob.slice(0, i)
}

export function prefixEnd(prefix) {
  return `${prefix}\u{10FFFF}`
}
