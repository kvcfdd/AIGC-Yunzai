const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]

const PERIODS = [
  [0, 6, "凌晨"],
  [6, 9, "早晨"],
  [9, 11, "上午"],
  [11, 13, "中午"],
  [13, 17, "下午"],
  [17, 19, "傍晚"],
  [19, 23, "晚上"],
  [23, 24, "深夜"],
]

/**
 * 格式化时间
 * @param {Date} d
 * @param {"compact"|"full"} style  compact=展示用(YYYY-MM-DD HH:MM:SS)  full=自然语言用(含星期时段)
 */
export function formatDate(d, style = "compact") {
  const pad = n => String(n).padStart(2, "0")
  const y = d.getFullYear()
  const mo = pad(d.getMonth() + 1)
  const day = pad(d.getDate())
  const h = pad(d.getHours())
  const mi = pad(d.getMinutes())

  if (style === "compact") {
    return `${y}-${mo}-${day} ${h}:${mi}:${pad(d.getSeconds())}`
  }

  return `${y}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${PERIODS.find(([lo, hi]) => d.getHours() >= lo && d.getHours() < hi)?.[2] || "深夜"} ${d.getHours()}:${mi}`
}

/** 消息时间 → 标准格式: YYYY-MM-DD HH:mm:ss */
export function formatMsgTime(ms) {
  const d = new Date(ms)
  const pad = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 获取本地当前时间 */
export function now() {
  return new Date()
}
