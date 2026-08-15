import path from "node:path"

/** 路径解析基准为 当前目录；相对路径基于 当前目录 */
export function resolvePath(p) {
  return path.isAbsolute(p) ? path.resolve(p) : path.resolve(process.cwd(), p)
}

/** 递归扫描时跳过的目录 */
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".cache", "target", ".bg"])

/** glob → 正则: 星号不跨目录, 双星号任意深度, 问号单字符
 *  双星号加斜杠作为前缀时可省略 — 让 "双星-斜杠-星号" 也能匹配根目录文件 */
export function globToRegExp(glob) {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?"
          i += 2
        } else {
          re += ".*"
          i++
        }
      } else {
        re += "[^/\\\\]*"
      }
    } else if (c === "?") {
      re += "[^/\\\\]"
    } else if ("\\^$+{}[]()|.".includes(c)) {
      re += "\\" + c
    } else {
      re += c
    }
  }
  return new RegExp("^" + re + "$")
}
