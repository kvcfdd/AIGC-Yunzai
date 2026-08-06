import net from "node:net"
import dns from "node:dns/promises"

/** 检查 IPv4 是否为内网/保留地址 */
export function isPrivateIp(ip) {
  if (!ip) return true
  const v = net.isIP(ip)
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number)
    if (a === 10) return true
    if (a === 127) return true
    if (a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a >= 224) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    return false
  }
  if (v === 6) {
    const lower = ip.toLowerCase()
    if (lower === "::1" || lower === "::") return true
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true
    if (lower.startsWith("ff")) return true
    if (lower.startsWith("::ffff:")) return isPrivateIp(lower.slice(7))
    return false
  }
  return true
}

/** DNS 解析 + 内网检查，防止 SSRF */
export async function isHostnameSafe(hostname) {
  if (!hostname) return false
  const lower = hostname.toLowerCase()
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".local") || lower.endsWith(".internal")) {
    return false
  }
  if (net.isIP(lower)) return !isPrivateIp(lower)
  try {
    const records = await dns.lookup(lower, { all: true })
    for (const r of records) {
      if (isPrivateIp(r.address)) return false
    }
    return true
  } catch {
    return false
  }
}
