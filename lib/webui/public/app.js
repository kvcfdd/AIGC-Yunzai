const API = "/yunzai/api"
const THEME_KEY = "yunzai-config-theme"
const EXPANDED_KEY = "yunzai-config-expanded"
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)"
const ACRONYMS = new Set(["api", "id", "url", "qq", "uid", "mcp", "tts", "ai", "http", "https", "ui", "db", "gsuid"])
const KEY_LABELS = {
  enable: "启用",
  inject: "注入",
  model_config: "模型配置",
  adapter: "请求适配器",
  model: "模型",
  probability: "概率",
  provider: "提供方",
  max_results: "最大条数",
  keys: "密钥",
  url: "地址",
  servers: "服务器",
  timeout_ms: "超时 (ms)",
  retry_count: "重试次数",
  max_output_tokens: "输出上限",
  base_url: "接口地址",
  api_keys: "API Key",
  api_key: "API Key",
  whitelist: "白名单",
  blacklist: "黑名单",
  prefix_filter: "前缀过滤",
  dimensions: "维度",
  batch_size: "批量",
  max_input_chars: "文本截断",
  top_k: "Top K",
  min_similarity: "相似度下限",
  backfill_limit: "回填上限",
  name: "名称",
  version: "版本",
  description: "描述",
  prompt: "提示词",
  system_prompt: "系统提示词",
  bot_name: "机器人名称",
}

function storedExpanded() {
  try {
    const value = JSON.parse(localStorage.getItem(EXPANDED_KEY) || "null")
    if (Array.isArray(value)) return new Set(value)
  } catch {}
  return new Set(["core"])
}

const state = {
  data: null,
  bot: null,
  name: null,
  view: "home",
  dashboard: { data: null, loading: false, error: "", filters: null, request: 0, loaded: false },
  config: null,
  mode: "form",
  dirty: new Map(),
  raw: null,
  rawDirty: false,
  search: "",
  theme: "light",
  expanded: storedExpanded(),
  openItem: null,
  newArrayItem: null,
  dialogResolve: null,
  dialogTimer: null,
  toastTimer: null,
  toastHideTimer: null,
  saveTimer: null,
  gateIntro: false,
  editorTarget: null,
  editorTimer: null,
  focusListItem: null,
  draftListItem: null,
  removals: new Set(),
  openSections: new Set(),
  miaoThemeEdit: "",
  miaoThemeEditFile: null,
  miaoThemeCreateFile: null,
  miaoStyleTheme: "",
  miaoStyleDraft: null,
}

const CRON_WEEKDAYS = [
  { value: 1, label: "一" },
  { value: 2, label: "二" },
  { value: 3, label: "三" },
  { value: 4, label: "四" },
  { value: 5, label: "五" },
  { value: 6, label: "六" },
  { value: 0, label: "日" },
]
const CRON_MODE_LABELS = Object.fromEntries(CRON_WEEKDAYS.map(day => [day.value, `周${day.label}`]))
const CRON_MODES = [
  { value: "minute", label: "按分钟" },
  { value: "hour", label: "按小时" },
  { value: "day", label: "每天" },
  { value: "week", label: "每周" },
  { value: "month", label: "每月" },
  { value: "custom", label: "自定义" },
]
const VOICE_PROVIDER_LABELS = {
  wusound: "悟声 Wusound",
  openai: "OpenAI 兼容",
  gemini: "Gemini TTS",
  minimax: "MiniMax T2A",
  elevenlabs: "ElevenLabs",
  azure: "Azure 语音",
  volcengine: "火山引擎",
  mimo: "MiMo TTS",
  fishaudio: "FishAudio",
  dashscope: "阿里云百炼",
}

const MCP_TYPE_OPTIONS = [
  { value: "http", label: "Streamable HTTP", description: "连接远程 MCP 的 HTTP 端点" },
  { value: "sse", label: "SSE", description: "兼容旧版 SSE 传输" },
  { value: "stdio", label: "stdio", description: "启动本地子进程作为 MCP 服务" },
]

const MCP_TEMPLATES = {
  http: () => ({ type: "http", url: "", headers: {}, timeout_ms: 30000, protocol_mode: "legacy" }),
  sse: () => ({ type: "sse", url: "", headers: {}, timeout_ms: 30000 }),
  stdio: () => ({ type: "stdio", command: "", args: [], env: {}, cwd: "", timeout_ms: 30000 }),
}

const MODEL_API_OPTIONS = [
  { value: "gemini", label: "Gemini", description: "原生 Gemini Interactions 接口，支持思考等级" },
  { value: "openai", label: "OpenAI 兼容", description: "Chat Completions，兼容 DeepSeek / Qwen 等服务商" },
  { value: "anthropic", label: "Anthropic", description: "Claude Messages 接口，支持提示词缓存" },
  { value: "responses", label: "OpenAI Responses", description: "OpenAI Responses API" },
]

const MODEL_TEMPLATES = {
  gemini: () => ({
    base_url: "https://generativelanguage.googleapis.com",
    proxy: false,
    api_keys: "",
    model: "",
    thinking_level: "high",
    max_output_tokens: 65536,
    retry_count: 0,
  }),
  openai: () => ({
    base_url: "https://api.openai.com/v1",
    proxy: false,
    headers: {},
    timeout_ms: 300000,
    api_keys: "",
    model: "",
    max_output_tokens: 65536,
    max_tokens_field: "max_tokens",
    retry_count: 0,
    media: { image: true, audio: true, video: false, file: true },
    extra_body: {},
  }),
  anthropic: () => ({
    base_url: "https://api.anthropic.com",
    proxy: false,
    headers: {},
    api_version: "2023-06-01",
    timeout_ms: 300000,
    api_keys: "",
    model: "",
    max_output_tokens: 65536,
    retry_count: 0,
    media: { image: true, audio: false, video: false, file: true },
    extra_body: {},
  }),
  responses: () => ({
    base_url: "https://api.openai.com/v1",
    proxy: false,
    headers: {},
    timeout_ms: 300000,
    api_keys: "",
    model: "",
    max_output_tokens: 65536,
    retry_count: 0,
    media: { image: true, audio: false, video: false, file: true },
    extra_body: {},
  }),
}

let viewTransitionToken = 0

const $ = selector => document.querySelector(selector)
const content = () => $("#content")
const sidebarOpen = () => document.body.classList.contains("sidebar-open")
const reduceMotion = () => !!window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches

function saveExpanded() {
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...state.expanded]))
  } catch {}
}

function syncSearchUI() {
  const input = $("#config-search")
  if (!input) return
  const hasValue = !!input.value
  const clear = $("#config-search-clear")
  if (clear) clear.hidden = !hasValue
  input.closest(".search")?.classList.toggle("has-value", hasValue)
}

function focusSearch() {
  const input = $("#config-search")
  if (!input) return
  if (window.matchMedia("(max-width: 820px)").matches) setSidebar(true)
  input.focus()
  input.select()
}

function setSidebar(open) {
  document.body.classList.toggle("sidebar-open", open)
  const toggle = $("#sidebar-toggle")
  if (toggle) {
    toggle.setAttribute("aria-expanded", String(open))
    toggle.setAttribute("aria-label", open ? "关闭配置列表" : "打开配置列表")
  }
  const backdrop = $("#sidebar-backdrop")
  if (backdrop) backdrop.hidden = !open
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&")
}

function isObj(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function clone(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value))
}

function fmtNum(value) {
  return Number(value || 0).toLocaleString("zh-CN")
}

function humanize(key) {
  return String(key)
    .split(/[_-]+/)
    .filter(Boolean)
    .map(word => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ")
}

function shortLabel(comment, key) {
  if (comment) {
    const first = String(comment)
      .split(/[；;。]\s*|，|,|（|\(|—|:\s|：/)
      .map(part => part.trim())
      .find(Boolean)
    if (first && first.length <= 26) return first
  }
  return KEY_LABELS[key] || humanize(key)
}

function labelFor(path, key, comment) {
  return state.config?.labels?.[path] || (key && state.config?.keyLabels?.[key]) || shortLabel(comment, key)
}

function hintFor(path, key, comment) {
  return state.config?.hints?.[path] || comment || (key && state.config?.keyComments?.[key]) || ""
}

function choicesFor(path, key) {
  let options = state.config?.choices?.[path] || (key && state.config?.keyChoices?.[key]) || []
  if (key === "model_config" && state.name === "core:aigc") {
    const models = currentValue("models", state.config?.effective?.models)
    if (Array.isArray(models)) {
      const names = models.map(item => item?.name).filter(name => typeof name === "string" && name.trim())
      options = [...new Set([...options, ...names])]
    }
  }
  return Array.isArray(options) ? options : []
}

function isJsonKey(key) {
  return Array.isArray(state.config?.jsonKeys) && state.config.jsonKeys.includes(key)
}

function isCronField(key) {
  return Array.isArray(state.config?.cronKeys) && state.config.cronKeys.includes(key)
}

function isKeyListField(key) {
  return isSecret(key) || key === "api_keys" || key === "keys"
}

function showAsKeyField(key, value) {
  if (!isKeyListField(key)) return false
  if (typeof value === "number" || typeof value === "boolean" || isObj(value)) return false

  return key === "api_keys" || key === "keys" || Array.isArray(value)
}

function isSwitch01(key) {
  return Array.isArray(state.config?.switchKeys) && state.config.switchKeys.includes(key)
}

function multiOptionsFor(key) {
  if (state.name === "core:group" && (key === "enable" || key === "disable")) {
    return (state.data?.features || []).map(name => ({ value: name, label: name }))
  }
  if (state.name === "core:other" && (key === "whiteGroup" || key === "blackGroup")) {
    return (state.data?.groups || []).map(group => ({ value: group.group_id, label: `${group.group_name}（${group.group_id}）` }))
  }
  if (state.name === "core:aigc" && key === "group_whitelist") {
    return (state.data?.groups || []).map(group => ({ value: group.group_id, label: `${group.group_name}（${group.group_id}）` }))
  }
  return null
}

function groupDisplay(id) {
  const group = (state.data?.groups || []).find(item => String(item.group_id) === String(id))
  return group?.group_name ? `${group.group_name}（${id}）` : String(id)
}

function botDisplay(id) {
  const bot = (state.data?.bots || []).find(item => String(item.self_id) === String(id))
  return bot?.nickname ? `${bot.nickname}（${id}）` : String(id)
}

function groupSectionLabel(key) {
  const parts = String(key).split(":")
  if (parts.length === 2 && parts[1] === "default") return `机器人 ${botDisplay(parts[0])} 的默认设置`
  if (parts.length === 2) return `${botDisplay(parts[0])} · 群 ${groupDisplay(parts[1])}`
  return `群 ${groupDisplay(parts[0])}`
}

function numericLimit(path, key) {
  return state.config?.limits?.[path] || (key && state.config?.keyLimits?.[key]) || null
}

function rangeLabel(limit) {
  if (!limit) return ""
  const { min, max } = limit
  if (min != null && max != null) return `${min}–${max}`
  if (min != null) return `≥ ${min}`
  if (max != null) return `≤ ${max}`
  return ""
}

function getPath(object, dotted) {
  let current = object
  for (const key of String(dotted).split(".")) {
    if (current == null) return undefined
    current = current[key]
  }
  return current
}

function setPath(object, dotted, value) {
  const parts = String(dotted).split(".")
  let current = object
  for (let index = 0; index < parts.length - 1; index++) {
    const key = parts[index]
    if (!isObj(current[key])) current[key] = {}
    current = current[key]
  }
  current[parts[parts.length - 1]] = value
}

function currentValue(path, fallback) {
  return state.dirty.has(path) ? state.dirty.get(path) : fallback
}

function arrayItemTypeClient(value) {
  if (!value.length) return ""
  const types = new Set(value.map(item => (Array.isArray(item) ? "array" : item === null ? "null" : typeof item)))
  return types.size === 1 ? [...types][0] : "mixed"
}

function infoForValue(value) {
  if (Array.isArray(value)) return { type: "array", itemType: arrayItemTypeClient(value) }
  if (isObj(value)) return { type: "object" }
  if (value === null || value === undefined) return { type: "any" }
  return { type: typeof value }
}

function valueKind(value, key, info = {}) {
  if (typeof value === "boolean") return "开关"
  if (typeof value === "number") return "数字"
  if (typeof value === "string") return isLongText(key, value) ? "多行文本" : "文本"
  if (Array.isArray(value)) {
    const itemType = info.itemType || (value.length ? typeof value[0] : "")
    if (itemType === "object") return "对象列表"
    if (!info.forceList && (itemType === "array" || itemType === "mixed" || itemType === "object" || (!value.length && !listLike(key)))) return "JSON 数组"
    return "列表"
  }
  if (value === null || value === undefined) return info.type === "list" ? "列表" : "空值"
  if (info.jsonObject) return "JSON 对象"
  return "对象"
}

function itemLabel(item, index) {
  return String(item?.name || item?.type || item?.id || item?.title || `第 ${index + 1} 项`)
}

function emptyLike(value) {
  if (Array.isArray(value)) return []
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, emptyLike(item)]))
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value
  return ""
}

function pruneEmptyListValues(value) {
  if (Array.isArray(value)) {
    return value.filter(item => item !== null && item !== undefined && !(typeof item === "string" && item.trim() === "")).map(item => (isObj(item) || Array.isArray(item) ? pruneEmptyListValues(item) : item))
  }
  if (isObj(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = pruneEmptyListValues(item)
    return out
  }
  return value
}

function buildPatch() {
  const patch = {}
  for (const [path, value] of state.dirty) setPath(patch, path, pruneEmptyListValues(value))
  return patch
}

function isDirty() {
  return state.dirty.size > 0 || state.rawDirty || state.removals.size > 0
}

function setDirty(path, value) {
  const old = getPath(state.config?.effective, path)
  if (JSON.stringify(old) === JSON.stringify(value)) state.dirty.delete(path)
  else state.dirty.set(path, value)
  renderDirty()
}

function renderDirty() {
  const home = state.view === "home"
  const dirty = !home && isDirty()
  const el = $("#dirty")
  if (el) el.hidden = home || !dirty
  const button = $("#save")
  if (!button || button.classList.contains("is-saving")) return
  button.hidden = home
  if (home) return
  button.disabled = !dirty
  if (dirty) {
    button.classList.remove("is-saved")
    button.textContent = "保存"
  } else if (!button.classList.contains("is-saved")) {
    button.textContent = "保存"
  }
}

function checkIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"></path></svg>`
}

function alertIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7.5v6M12 17.2v.3"></path></svg>`
}

function infoIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 10.5V17M12 7v.2"></path></svg>`
}

function warningIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4.5 21 20H3L12 4.5Z"></path><path d="M12 10v4.5M12 17.3v.2"></path></svg>`
}

function toast(message, kind = "success") {
  const el = $("#toast")
  const icon = $("#toast-icon")
  const text = $("#toast-text")
  if (icon) icon.innerHTML = kind === "error" ? alertIcon() : checkIcon()
  if (text) text.textContent = message
  el.classList.toggle("error", kind === "error")
  el.hidden = false
  clearTimeout(state.toastTimer)
  clearTimeout(state.toastHideTimer)
  requestAnimationFrame(() => el.classList.add("show"))
  state.toastTimer = setTimeout(() => {
    el.classList.remove("show")
    state.toastHideTimer = setTimeout(() => {
      el.hidden = true
    }, 190)
  }, 2600)
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {}
  if (body !== undefined) headers["Content-Type"] = "application/json"
  const res = await fetch(API + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  })
  if (res.status === 401) {
    showLogin()
    throw new Error("需要登录")
  }
  const data = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function keyIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="3.2"></circle><path d="M11.2 12H20M17 12v3M14 12v2"></path></svg>`
}

function eyeIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12s3.3-5.2 9.2-5.2S21.2 12 21.2 12s-3.3 5.2-9.2 5.2S2.8 12 2.8 12Z"></path><circle cx="12" cy="12" r="2.6"></circle></svg>`
}

function eyeOffIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 4 16 16M9.9 5.2A10.6 10.6 0 0 1 12 5c5.9 0 9.2 7 9.2 7a17.3 17.3 0 0 1-3.2 4.1M6.2 6.7A16.8 16.8 0 0 0 2.8 12s3.3 7 9.2 7a10.8 10.8 0 0 0 4-.8"></path><path d="M10.2 10.2a2.6 2.6 0 0 0 3.6 3.6"></path></svg>`
}

function showLogin(message = "") {
  setSidebar(false)
  $("#app").hidden = true
  const gate = $("#gate")
  gate.hidden = false
  gate.classList.toggle("gate-intro", !state.gateIntro)
  state.gateIntro = true
  const form = $("#gate-form")
  const bot = state.bot
  const icon = bot?.avatar ? `<div class="app-icon large has-image"><img src="${esc(bot.avatar)}" alt="${esc(bot.nickname || bot.self_id || "Bot")}" referrerpolicy="no-referrer" /></div>` : `<div class="app-icon large"><span></span><span></span><span></span></div>`
  const title = bot?.nickname || "Yunzai"
  form.innerHTML = `<div class="gate-head">${icon}<h1>${esc(title)}</h1><p>配置控制台</p></div><label class="login-field" for="login-key"><span class="login-label">密钥</span><span class="login-input-wrap"><span class="login-key-icon">${keyIcon()}</span><input id="login-key" type="password" placeholder="输入密钥" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="go" required /><button class="login-eye" type="button" aria-label="显示密钥">${eyeIcon()}</button></span></label>${message ? `<p class="gate-error">${esc(message)}</p>` : ""}<button class="button primary wide login-submit" type="submit">登录</button>`
  const card = form.closest(".gate-card")
  card?.classList.remove("shake")
  if (message) {
    void card?.offsetWidth
    card?.classList.add("shake")
  }
  form.querySelector(".app-icon img")?.addEventListener("error", () => {
    const box = form.querySelector(".app-icon")
    if (!box) return
    box.classList.remove("has-image")
    box.innerHTML = "<span></span><span></span><span></span>"
  })
  const input = form.querySelector("#login-key")
  const eye = form.querySelector(".login-eye")
  eye?.addEventListener("click", () => {
    const visible = input.type === "password"
    input.type = visible ? "text" : "password"
    eye.classList.toggle("on", visible)
    eye.setAttribute("aria-label", visible ? "隐藏密钥" : "显示密钥")
    eye.innerHTML = visible ? eyeOffIcon() : eyeIcon()
    input.focus()
  })
  form.onsubmit = async event => {
    event.preventDefault()
    const key = input?.value?.trim()
    if (!key) return
    try {
      const res = await fetch(`${API}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }), credentials: "same-origin" })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.ok === false) throw new Error(data.error || "登录失败")
      $("#gate").hidden = true
      $("#app").hidden = false
      await loadState()
    } catch (err) {
      showLogin(err.message)
    }
  }
  input?.focus()
}

async function boot() {
  initTheme()
  const session = await fetch(`${API}/session`, { credentials: "same-origin" })
    .then(res => res.json())
    .catch(() => ({ authenticated: false }))
  state.bot = session.bot || null
  if (!session.authenticated) {
    showLogin()
    return
  }
  $("#app").hidden = false
  try {
    await loadState()
  } catch (err) {
    if ($("#gate").hidden) throw err
  }
}

async function loadState() {
  const data = await api("/state")
  state.data = data
  state.bot = data.system?.bot || state.bot
  $("#gate").hidden = true
  $("#app").hidden = false
  renderBrand()
  if (!state.name || !data.configs.some(config => config.name === state.name)) {
    state.name = data.configs.find(config => config.name === "core:aigc")?.name || data.configs[0]?.name || null
  }
  await loadConfig(state.name)
  renderSidebar()
  renderFooter()
  syncSearchUI()
  animateContentIn()
}

async function loadConfig(name) {
  if (!name) {
    state.config = null
    state.name = null
    renderAll()
    return
  }
  const savedMode = state.mode
  state.mode = "form"
  state.dirty.clear()
  state.removals.clear()
  state.openSections.clear()
  state.rawDirty = false
  state.raw = null
  state.draftListItem = null
  state.miaoThemeEdit = ""
  state.miaoThemeEditFile = null
  state.miaoThemeCreateFile = null
  state.miaoStyleTheme = ""
  state.miaoStyleDraft = null
  const data = await api(`/config?name=${encodeURIComponent(name)}`)
  state.name = name
  state.config = data.config
  state.expanded.add(groupIdFor(state.config))
  if (savedMode === "yaml") state.mode = "yaml"
  if (state.mode === "yaml") await loadRaw(name)
  renderAll()
}

async function loadRaw(name) {
  const data = await api(`/raw?name=${encodeURIComponent(name)}`)
  state.raw = { name, content: data.content, defaultContent: data.defaultContent }
  state.rawDirty = false
}

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY)
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches
  state.theme = stored === "dark" || stored === "light" ? stored : prefersDark ? "dark" : "light"
  applyTheme()
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.theme === "dark" ? "#000000" : "#f5f5f7")
  for (const button of document.querySelectorAll("[data-theme-toggle]")) {
    button.setAttribute("aria-label", state.theme === "dark" ? "切换到浅色模式" : "切换到深色模式")
    button.innerHTML = state.theme === "dark" ? sunIcon() : moonIcon()
  }
}

function toggleTheme() {
  state.theme = state.theme === "dark" ? "light" : "dark"
  localStorage.setItem(THEME_KEY, state.theme)
  applyTheme()
}

function sunIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2.5v2.2M12 19.3v2.2M4.5 12H2.3M21.7 12h-2.2M5.6 5.6 4 4M20 20l-1.6-1.6M18.4 5.6 20 4M4 20l1.6-1.6"></path></svg>`
}

function moonIcon() {
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 14.1A8.3 8.3 0 0 1 9.9 3.8 8.5 8.5 0 1 0 20.2 14.1Z"></path></svg>`
}

function pluginDisplay(name) {
  if (!name) return "未识别插件"
  return name
    .replace(/-plugin$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, char => char.toUpperCase())
}

function groupIdFor(config) {
  if (!config) return ""
  if (config.group === "core") return "core"
  if (config.group === "extra") return "extra"
  return `plugin:${config.plugin || "unknown"}`
}

function renderBrand() {
  const icon = document.querySelector(".brand .app-icon")
  const subtitle = $("#brand-subtitle")
  const bot = state.data?.system?.bot
  if (subtitle) subtitle.textContent = bot?.nickname ? `${bot.nickname} · 配置` : "配置"
  if (!icon) return
  if (bot?.avatar) {
    icon.classList.add("has-image")
    icon.innerHTML = `<img src="${esc(bot.avatar)}" alt="${esc(bot.nickname || bot.self_id || "Bot")}" referrerpolicy="no-referrer" />`
    icon.querySelector("img")?.addEventListener("error", () => {
      icon.classList.remove("has-image")
      icon.innerHTML = "<span></span><span></span><span></span>"
    })
  } else {
    icon.classList.remove("has-image")
    icon.innerHTML = "<span></span><span></span><span></span>"
  }
}

function renderSidebar() {
  if (!state.data) return
  const home = $("#home-nav")
  if (home) {
    const active = state.view === "home"
    home.classList.toggle("active", active)
    home.setAttribute("aria-current", active ? "page" : "false")
  }
  const query = state.search.trim().toLowerCase()
  const matches = config => !query || `${config.label} ${config.name} ${config.plugin} ${config.file}`.toLowerCase().includes(query)

  const groups = []
  const core = state.data.configs.filter(config => config.group === "core")
  if (core.length) groups.push({ id: "core", label: "本体", items: core })
  const plugins = new Map()
  for (const config of state.data.configs) {
    if (config.group !== "plugin") continue
    const key = config.plugin || "unknown"
    if (!plugins.has(key)) plugins.set(key, { id: `plugin:${key}`, label: pluginDisplay(key), items: [] })
    plugins.get(key).items.push({ ...config, sidebarLabel: config.label.split(" · ").slice(1).join(" · ") || config.label })
  }
  groups.push(...[...plugins.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN")))
  const extra = state.data.configs.filter(config => config.group === "extra")
  if (extra.length) groups.push({ id: "extra", label: "其他", items: extra })

  const html = groups
    .map(group => {
      const items = group.items.filter(matches)
      if (!items.length) return ""
      const open = query ? true : state.expanded.has(group.id)
      const panelId = `group-${group.id.replace(/[^A-Za-z0-9_-]/g, "-")}`
      return `<section class="config-group">
        <button class="group-toggle" type="button" data-group="${esc(group.id)}" aria-expanded="${open}" aria-controls="${panelId}"><span class="group-chevron"></span><span class="group-title">${esc(group.label)}</span><span class="group-count">${items.length}</span></button>
        <div class="group-items ${open ? "" : "collapsed"}" id="${panelId}"><div class="group-items-inner">${items
          .map(config => {
            const active = state.view === "config" && config.name === state.name
            return `<button class="config-item ${active ? "active" : ""}" type="button" data-name="${esc(config.name)}" aria-current="${active ? "page" : "false"}">
              <span class="config-dot ${config.group}"></span>
              <span class="config-meta"><span class="config-name">${esc(config.sidebarLabel || config.label)}</span><span class="config-file">${esc(config.file)}</span></span>
            </button>`
          })
          .join("")}</div></div>
      </section>`
    })
    .join("")
  $("#config-groups").innerHTML = html || `<div class="sidebar-empty">${emptyIcon()}<p>${query ? `没有匹配 “${esc(state.search.trim())}” 的配置` : "没有可编辑的配置"}</p>${query ? `<button class="inline-button" type="button" data-action="clear-search">清除搜索</button>` : ""}</div>`
  syncSearchUI()
}

function renderFooter() {
  if (!state.data) return
  const { system, plugins, configs } = state.data
  const version = system.version ? ` · Yunzai v${esc(system.version)}` : ""
  $("#sidebar-foot").innerHTML = `
    <div class="status"><span class="status-dot ${system.online ? "online" : ""}"></span>${system.online ? "在线" : "离线"}${version}</div>
    <div class="foot-meta">${plugins.length} 个插件 · ${configs.length} 个配置文件</div>
    <div class="foot-actions"><button class="icon-button" data-theme-toggle type="button"></button><a href="https://github.com/kvcfdd/AIGC-Yunzai" target="_blank" rel="noreferrer">AIGC-Yunzai</a></div>`
  applyTheme()
}

function renderAll() {
  renderSidebar()
  renderToolbar()
  renderContent()
  renderDirty()
}

function renderToolbar() {
  const config = state.config
  const home = state.view === "home"
  document.querySelector(".toolbar")?.classList.toggle("is-home", home)
  $("#config-title").textContent = home ? "主页" : config?.label || "配置"
  $("#config-path").textContent = home ? "" : config?.file || ""
  const pathRow = $("#config-path")?.closest(".path-row")
  if (pathRow) pathRow.hidden = home
  const description = $("#config-description")
  if (description) {
    const text = home ? "系统状态、消息收发与 Token 用量统计" : config?.description || ""
    description.textContent = text
    description.title = text
    description.hidden = !text
  }
  const copy = $("#copy-path")
  if (copy) copy.hidden = home || !config?.file
  const segmented = document.querySelector(".segmented")
  if (segmented) segmented.hidden = home
  const save = $("#save")
  if (save) save.hidden = home
  document.title = `${home ? "主页" : config?.label || "配置"} · Yunzai`
  if (home) return
  segmented?.setAttribute("data-mode", state.mode)
  for (const button of document.querySelectorAll(".segmented [data-mode]")) {
    const active = button.dataset.mode === state.mode
    button.classList.toggle("active", active)
    button.setAttribute("aria-selected", String(active))
  }
  const sourceButton = document.querySelector('.segmented [data-mode="yaml"]')
  if (sourceButton) sourceButton.textContent = config?.special === "miao-help" ? "源码" : "YAML"
}

function animateContentIn() {
  if (reduceMotion()) return
  content().animate(
    [
      { opacity: 0, transform: "translateY(6px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 220, easing: EASE_OUT },
  )
}

function renderContent() {
  if (state.editorTarget) closeEditor()
  if (!state.data) {
    content().innerHTML = `<div class="empty">正在连接…</div>`
    return
  }
  if (state.view === "home") {
    renderDashboard()
    return
  }
  if (!state.config) {
    content().innerHTML = `<div class="empty">${emptyIcon()}<h2>没有配置文件</h2><p>在 config/default_config 或 config 下添加 YAML 后刷新。</p><button class="button" type="button" data-action="refresh-state">重新加载</button></div>`
    return
  }
  const overridable = state.config.file?.startsWith("plugins/") || state.config.file?.startsWith("data/")
  const skipWarnings = state.config.special === "miao-help" && state.mode === "form"
  const warnings = !skipWarnings && state.config.warning?.length ? `<div class="note-card warn">${warningIcon()}<div class="note-stack">${state.config.warning.map(item => `<p>${esc(item)}</p>`).join("")}</div></div>` : ""
  const note = state.config.special === "miao-help" ? "" : overridable ? `<div class="note-card warn">${warningIcon()}<p>插件更新可能覆盖此文件；修改后可能需要重启。</p></div>` : ""
  content().innerHTML = warnings + note + (state.mode === "yaml" ? renderRaw() : renderForm())
  state.newArrayItem = null
  if (state.config.special === "miao-help" && state.mode === "form") requestAnimationFrame(fitMiaoPreview)
}

const DASH_MAX_DAYS = 30
const DASH_CHANNELS = [
  { key: "main", label: "主模型", color: "var(--blue)" },
  { key: "ambient", label: "水群", color: "var(--purple)" },
  { key: "multimodal", label: "多模态识别", color: "var(--green)" },
  { key: "agent", label: "子代理", color: "var(--orange)" },
  { key: "audit", label: "安全审计", color: "var(--red)" },
  { key: "default", label: "其他", color: "var(--tertiary)" },
]
const DASH_CHANNEL_MAP = Object.fromEntries(DASH_CHANNELS.map(channel => [channel.key, channel]))

function dashDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
}

function dashboardFilters() {
  if (!state.dashboard.filters) {
    const to = new Date()
    const from = new Date()
    from.setDate(from.getDate() - 6)
    state.dashboard.filters = { bot: "", from: dashDay(from), to: dashDay(to) }
  }
  return state.dashboard.filters
}

/** 起止日期最多 30 天；超出时保留结束日期前的 30 天 */
function dashClampFilters(filters) {
  const from = new Date(`${filters.from}T00:00:00`)
  const to = new Date(`${filters.to}T00:00:00`)
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return
  if (from > to) {
    const fromValue = filters.from
    filters.from = filters.to
    filters.to = fromValue
  }
  const start = new Date(`${filters.from}T00:00:00`)
  const end = new Date(`${filters.to}T00:00:00`)
  const span = Math.round((end - start) / 86400000) + 1
  if (span > DASH_MAX_DAYS) {
    const clamped = new Date(end)
    clamped.setDate(clamped.getDate() - (DASH_MAX_DAYS - 1))
    filters.from = dashDay(clamped)
  }
}

function dashChannel(key) {
  return DASH_CHANNEL_MAP[key] || { key, label: key || "其他", color: "var(--tertiary)" }
}

function dashBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  const units = ["KB", "MB", "GB", "TB"]
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit++
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function dashDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0))
  const days = Math.floor(value / 86400)
  const hours = Math.floor((value % 86400) / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  if (days) return `${days} 天 ${hours} 小时`
  if (hours) return `${hours} 小时 ${minutes} 分`
  if (minutes) return `${minutes} 分`
  return `${value} 秒`
}

function dashCompact(value) {
  const number = Number(value) || 0
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}m`
  if (number >= 1000) return `${(number / 1000).toFixed(number >= 10_000 ? 0 : 1)}k`
  if (number > 0 && number < 10) return String(Math.round(number * 10) / 10)
  return String(Math.round(number))
}

function dashNiceMax(value) {
  const number = Math.max(1, Number(value) || 1)
  const power = Math.pow(10, Math.floor(Math.log10(number)))
  const normalized = number / power
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * power
}

function dashPercent(value, total) {
  if (!total) return 0
  return Math.max(0, Math.min(100, (Number(value) / Number(total)) * 100))
}

function dashLegend(items) {
  return `<div class="chart-legend">${items.map(item => `<span class="chart-legend-item"><i style="background:${item.color}"></i>${esc(item.label)}</span>`).join("")}</div>`
}

function dashLineChart(series, defs) {
  const width = 720
  const height = 220
  const pad = { left: 46, right: 14, top: 16, bottom: 28 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const max = dashNiceMax(Math.max(1, ...series.flatMap(item => defs.map(def => Number(item[def.key]) || 0))))
  const x = index => (series.length <= 1 ? pad.left + plotW / 2 : pad.left + (index * plotW) / (series.length - 1))
  const y = value => pad.top + plotH - (value / max) * plotH
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(part => {
      const value = max * part
      return `<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" class="dash-grid-line"/><text x="${pad.left - 8}" y="${y(value) + 3.5}" text-anchor="end" class="dash-axis-text">${dashCompact(value)}</text>`
    })
    .join("")
  const labelStep = Math.max(1, Math.ceil(series.length / 8))
  const xLabels = series.map((item, index) => (index % labelStep === 0 || index === series.length - 1 ? `<text x="${x(index)}" y="${height - 7}" text-anchor="middle" class="dash-axis-text">${esc(item.date.slice(5))}</text>` : "")).join("")
  const pointsFor = (def, item, index) => `${x(index)},${y(Number(item[def.key]) || 0)}`
  const areas = defs
    .map(def => {
      if (!series.length) return ""
      const line = `M${series.map((item, index) => pointsFor(def, item, index)).join(" L")}`
      const area = `${line} L${x(series.length - 1)},${pad.top + plotH} L${x(0)},${pad.top + plotH} Z`
      return `<path d="${area}" style="fill:${def.color};pointer-events:none" opacity="0.1"></path>`
    })
    .join("")
  const lines = defs
    .map(def => {
      if (!series.length) return ""
      const line = `M${series.map((item, index) => pointsFor(def, item, index)).join(" L")}`
      return `<path d="${line}" fill="none" style="stroke:${def.color};pointer-events:none" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"></path>`
    })
    .join("")
  const dots = defs.map(def => series.map((item, index) => `<circle cx="${x(index)}" cy="${y(Number(item[def.key]) || 0)}" r="3.5" style="fill:${def.color};stroke:var(--card)"><title>${esc(item.date)} ${esc(def.label)}：${fmtNum(item[def.key])}</title></circle>`).join("")).join("")
  return `<svg class="dash-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="趋势图">${grid}${xLabels}${areas}${lines}${dots}</svg>`
}

function dashStackedBars(series, channels) {
  const width = 720
  const height = 240
  const pad = { left: 46, right: 14, top: 16, bottom: 28 }
  const plotW = width - pad.left - pad.right
  const plotH = height - pad.top - pad.bottom
  const active = channels.filter(channel => channel.total > 0)
  const totalFor = item => active.reduce((sum, channel) => sum + (Number(item.channels?.[channel.channel]?.input) || 0) + (Number(item.channels?.[channel.channel]?.output) || 0), 0)
  const max = dashNiceMax(Math.max(1, ...series.map(totalFor)))
  const slot = series.length ? plotW / series.length : plotW
  const barW = Math.max(3, Math.min(34, slot * 0.56))
  const x = index => pad.left + slot * index + (slot - barW) / 2
  const y = value => pad.top + plotH - (value / max) * plotH
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map(part => {
      const value = max * part
      return `<line x1="${pad.left}" y1="${y(value)}" x2="${width - pad.right}" y2="${y(value)}" class="dash-grid-line"/><text x="${pad.left - 8}" y="${y(value) + 3.5}" text-anchor="end" class="dash-axis-text">${dashCompact(value)}</text>`
    })
    .join("")
  const labelStep = Math.max(1, Math.ceil(series.length / 8))
  const xLabels = series.map((item, index) => (index % labelStep === 0 || index === series.length - 1 ? `<text x="${x(index) + barW / 2}" y="${height - 7}" text-anchor="middle" class="dash-axis-text">${esc(item.date.slice(5))}</text>` : "")).join("")
  const bars = series
    .map((item, index) => {
      let base = pad.top + plotH
      const rects = active
        .map(channel => {
          const bucket = item.channels?.[channel.channel] || {}
          const value = (Number(bucket.input) || 0) + (Number(bucket.output) || 0)
          if (!value) return ""
          const barHeight = (value / max) * plotH
          base -= barHeight
          return `<rect x="${x(index)}" y="${base}" width="${barW}" height="${Math.max(0.5, barHeight)}" rx="1.5" style="fill:${dashChannel(channel.channel).color}"><title>${esc(item.date)} ${esc(dashChannel(channel.channel).label)}：${fmtNum(value)}</title></rect>`
        })
        .join("")
      return rects
    })
    .join("")
  return `<svg class="dash-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Token 类型趋势">${grid}${xLabels}${bars}</svg>`
}

function dashDonut(channels) {
  const items = channels.filter(channel => channel.total > 0)
  const total = items.reduce((sum, channel) => sum + channel.total, 0)
  const radius = 54
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const segments = items
    .map(channel => {
      const fraction = total ? channel.total / total : 0
      const dash = `${fraction * circumference} ${circumference}`
      const rotation = offset * 360 - 90
      offset += fraction
      return `<circle cx="70" cy="70" r="${radius}" fill="none" stroke-width="15" stroke-dasharray="${dash}" transform="rotate(${rotation} 70 70)" style="stroke:${dashChannel(channel.channel).color}"><title>${esc(dashChannel(channel.channel).label)}：${fmtNum(channel.total)}</title></circle>`
    })
    .join("")
  return `<svg class="dash-donut" viewBox="0 0 140 140" role="img" aria-label="Token 类型分布">
    <circle cx="70" cy="70" r="${radius}" fill="none" stroke-width="15" class="dash-donut-track"></circle>
    ${segments}
    <text x="70" y="66" text-anchor="middle" class="dash-donut-value">${dashCompact(total)}</text>
    <text x="70" y="84" text-anchor="middle" class="dash-donut-label">Token</text>
  </svg>`
}

function dashEmpty(text) {
  return `<div class="dash-empty">${esc(text)}</div>`
}

function dashboardBody(data) {
  if (!data) return ""
  const tokens = data.tokens?.totals || { input: 0, output: 0, cacheHit: 0, total: 0 }
  const channels = data.tokens?.channels || []
  const system = data.system || {}
  const activeChannels = channels.filter(channel => channel.total > 0)
  const rangeLabel = data.range ? (data.range.from === data.range.to ? data.range.from : `${data.range.from} ~ ${data.range.to}`) : ""

  const messageSeries = data.messages?.series || []
  const tokenSeries = data.tokens?.series || []
  const hasMessageData = messageSeries.some(item => (Number(item.received) || 0) + (Number(item.sent) || 0) > 0)
  const daily = new Map()
  for (const item of messageSeries) daily.set(item.date, { ...(daily.get(item.date) || {}), ...item })
  for (const item of tokenSeries) daily.set(item.date, { ...(daily.get(item.date) || {}), ...item })
  const dailyRows = [...daily.values()]
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(item => `<tr><td>${esc(item.date)}</td><td>${fmtNum(item.received)}</td><td>${fmtNum(item.sent)}</td><td>${fmtNum(item.input)}</td><td>${fmtNum(item.output)}</td><td>${fmtNum(item.cacheHit)}</td></tr>`)
    .join("")

  const channelRows = channels.length ? channels.map(channel => `<tr><td><span class="dash-channel"><i style="background:${dashChannel(channel.channel).color}"></i>${esc(dashChannel(channel.channel).label)}</span></td><td>${fmtNum(channel.input)}</td><td>${fmtNum(channel.output)}</td><td>${fmtNum(channel.cacheHit)}</td><td>${fmtNum(channel.total)}</td></tr>`).join("") : `<tr><td colspan="5" class="dash-table-empty">暂无 Token 数据</td></tr>`

  const cpu = system.cpu || {}
  const memory = system.memory || {}
  const processMemory = memory.process || {}
  const db = system.db || {}
  const load = Array.isArray(cpu.load) ? cpu.load.map(value => Number(value).toFixed(2)).join(" / ") : "-"

  const systemCards = `
    <section class="card">
      <header class="card-head"><h2>运行状态</h2><p>基础信息</p></header>
      <div class="dash-metrics dash-metrics-strip">
        <div class="dash-metric"><span>版本</span><strong>${system.version ? `v${esc(system.version)}` : "-"}</strong></div>
        <div class="dash-metric"><span>进程运行</span><strong>${dashDuration(system.uptime?.process)}</strong></div>
        <div class="dash-metric"><span>系统运行</span><strong>${dashDuration(system.uptime?.system)}</strong></div>
        <div class="dash-metric"><span>Node</span><strong>${esc(system.node || "-")}</strong></div>
        <div class="dash-metric"><span>群 / 好友</span><strong>${fmtNum(system.counts?.groups)} / ${fmtNum(system.counts?.friends)}</strong></div>
      </div>
    </section>
    <section class="card">
      <header class="card-head"><h2>系统资源</h2><p>${esc(system.platform || "")} ${esc(system.arch || "")}${system.hostname ? ` · ${esc(system.hostname)}` : ""}</p></header>
      <div class="dash-resource dash-resource-grid">
        <div class="dash-resource-row"><div class="dash-resource-head"><span>CPU</span><strong>${cpu.usage == null ? "-" : `${cpu.usage.toFixed(1)}%`}</strong></div><div class="dash-bar"><i style="width:${cpu.usage == null ? 0 : Math.min(100, cpu.usage)}%"></i></div><div class="dash-resource-meta">${esc(cpu.model || "未知")} · ${fmtNum(cpu.cores)} 核 · Load ${esc(load)}</div></div>
        <div class="dash-resource-row"><div class="dash-resource-head"><span>系统内存</span><strong>${memory.usage == null ? "-" : `${Number(memory.usage).toFixed(1)}%`}</strong></div><div class="dash-bar"><i style="width:${memory.usage == null ? 0 : Math.min(100, memory.usage)}%"></i></div><div class="dash-resource-meta">${dashBytes(memory.used)} / ${dashBytes(memory.total)}</div></div>
        <div class="dash-resource-row"><div class="dash-resource-head"><span>进程内存</span><strong>${dashBytes(processMemory.rss)}</strong></div><div class="dash-bar"><i style="width:${dashPercent(processMemory.heapUsed, processMemory.heapTotal)}%"></i></div><div class="dash-resource-meta">Heap ${dashBytes(processMemory.heapUsed)} / ${dashBytes(processMemory.heapTotal)} · External ${dashBytes(processMemory.external)}</div></div>
        <div class="dash-resource-row"><div class="dash-resource-head"><span>数据目录</span><strong>${dashBytes(db.size)}</strong></div><div class="dash-resource-meta">${esc(db.file || "")}${db.wal ? ` · WAL ${dashBytes(db.wal)}` : ""}</div></div>
      </div>
    </section>`

  return `
    ${systemCards}

    <section class="card dash-chart-card">
      <header class="card-head dash-chart-head">
        <div><h2>消息收发</h2><p>${esc(rangeLabel)}</p></div>
        ${dashLegend([
          { label: "接收", color: "var(--blue)" },
          { label: "发送", color: "var(--green)" },
        ])}
      </header>
      <div class="dash-chart">${
        hasMessageData
          ? dashLineChart(messageSeries, [
              { key: "received", label: "接收", color: "var(--blue)" },
              { key: "sent", label: "发送", color: "var(--green)" },
            ])
          : dashEmpty("暂无消息数据")
      }</div>
    </section>

    <section class="card dash-chart-card">
      <header class="card-head dash-chart-head">
        <div><h2>Token 用量趋势</h2><p>${esc(rangeLabel)} · 按调用类型堆叠</p></div>
        ${dashLegend(activeChannels.length ? activeChannels.map(channel => dashChannel(channel.channel)) : [{ label: "暂无数据", color: "var(--tertiary)" }])}
      </header>
      <div class="dash-chart">${tokenSeries.length && activeChannels.length ? dashStackedBars(tokenSeries, activeChannels) : dashEmpty("暂无 Token 数据")}</div>
    </section>

    <div class="dash-grid">
      <section class="card dash-token-card">
        <header class="card-head"><h2>Token 类型分布</h2><p>输入 + 输出 Token</p></header>
        <div class="dash-donut-wrap">
          ${dashDonut(activeChannels)}
          <div class="dash-channel-list">${activeChannels.length ? activeChannels.map(channel => `<div class="dash-channel-row"><span class="dash-channel"><i style="background:${dashChannel(channel.channel).color}"></i>${esc(dashChannel(channel.channel).label)}</span><span>${fmtNum(channel.total)}</span><span class="dash-channel-pct">${dashPercent(channel.total, tokens.total).toFixed(1)}%</span></div>`).join("") : dashEmpty("暂无数据")}</div>
        </div>
      </section>
      <section class="card">
        <header class="card-head"><h2>Token 类型明细</h2><p>缓存命中已包含在输入中</p></header>
        <div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>类型</th><th>输入</th><th>输出</th><th>缓存命中</th><th>合计</th></tr></thead><tbody>${channelRows}</tbody></table></div>
      </section>
    </div>

    <section class="card">
      <header class="card-head"><h2>每日明细</h2><p>${esc(rangeLabel)}</p></header>
      <div class="dash-table-wrap"><table class="dash-table"><thead><tr><th>日期</th><th>接收</th><th>发送</th><th>输入 Token</th><th>输出 Token</th><th>缓存命中</th></tr></thead><tbody>${dailyRows || `<tr><td colspan="6" class="dash-table-empty">暂无数据</td></tr>`}</tbody></table></div>
    </section>

  `
}

function renderDashboard() {
  const filters = dashboardFilters()
  const bots = state.data?.bots?.length ? state.data.bots : state.dashboard.data?.system?.bots || []
  const botOptions = [`<option value="">全部机器人</option>`]
    .concat(
      bots.map(item => {
        const id = String(item.self_id ?? "")
        const label = item.nickname ? `${item.nickname} · ${id}` : id
        return `<option value="${esc(id)}"${filters.bot === id ? " selected" : ""}>${esc(label)}</option>`
      }),
    )
    .join("")
  const loading = state.dashboard.loading
  content().innerHTML = `
    <div class="dashboard">
      <section class="dash-filter-card">
        <label class="dash-field"><span>机器人</span><select id="dash-bot">${botOptions}</select></label>
        <label class="dash-field"><span>开始日期</span><input id="dash-from" type="date" value="${esc(filters.from)}" /></label>
        <label class="dash-field"><span>结束日期</span><input id="dash-to" type="date" value="${esc(filters.to)}" /></label>
        <div class="dash-presets" role="group" aria-label="快捷日期">
          <button type="button" data-dash-days="0">今天</button>
          <button type="button" data-dash-days="7">近 7 天</button>
          <button type="button" data-dash-days="30">近 30 天</button>
        </div>
        <button id="dash-refresh" class="button" type="button"${loading ? " disabled" : ""}>${loading ? "刷新中…" : "刷新"}</button>
        <span class="dash-filter-note">最多查询近 ${DASH_MAX_DAYS} 天</span>
      </section>
      ${state.dashboard.error ? `<div class="note-card warn">${warningIcon()}<p>${esc(state.dashboard.error)}</p></div>` : ""}
      ${loading && !state.dashboard.data ? `<div class="dash-loading"><span></span><span></span><span></span><span></span></div>` : dashboardBody(state.dashboard.data)}
    </div>`
  bindDashboard()
  if (!state.dashboard.loaded && !state.dashboard.loading) loadDashboard()
}

function bindDashboard() {
  const root = content()
  root.querySelector("#dash-bot")?.addEventListener("change", event => {
    dashboardFilters().bot = event.target.value
    loadDashboard()
  })
  const from = root.querySelector("#dash-from")
  const to = root.querySelector("#dash-to")
  const applyRange = () => {
    const filters = dashboardFilters()
    if (from?.value) filters.from = from.value
    if (to?.value) filters.to = to.value
    dashClampFilters(filters)
    if (from) from.value = filters.from
    if (to) to.value = filters.to
    loadDashboard()
  }
  from?.addEventListener("change", applyRange)
  to?.addEventListener("change", applyRange)
  root.querySelectorAll("[data-dash-days]").forEach(button => {
    button.addEventListener("click", () => {
      const days = Number(button.dataset.dashDays)
      const filters = dashboardFilters()
      const end = new Date()
      const start = new Date()
      start.setDate(start.getDate() - (days > 0 ? days - 1 : 0))
      filters.from = dashDay(start)
      filters.to = dashDay(end)
      dashClampFilters(filters)
      loadDashboard()
    })
  })
  root.querySelector("#dash-refresh")?.addEventListener("click", () => loadDashboard())
}

async function loadDashboard() {
  if (state.view !== "home") return
  const filters = dashboardFilters()
  const request = ++state.dashboard.request
  state.dashboard.loading = true
  state.dashboard.error = ""
  renderDashboard()
  const params = new URLSearchParams({ from: filters.from, to: filters.to })
  if (filters.bot) params.set("bot", filters.bot)
  try {
    const data = await api(`/dashboard?${params.toString()}`)
    if (request !== state.dashboard.request) return
    state.dashboard.data = data
    state.dashboard.loaded = true
  } catch (err) {
    if (request !== state.dashboard.request) return
    state.dashboard.error = err.message
  } finally {
    if (request !== state.dashboard.request) return
    state.dashboard.loading = false
    if (state.view === "home") renderDashboard()
  }
}

async function switchHome() {
  if (state.view === "home") {
    if (state.dashboard.loading) return
    loadDashboard()
    return
  }
  if (isDirty() && !(await confirmDialog("放弃未保存的修改？", "当前配置有未保存的修改，切换后会丢失。", "放弃修改"))) return
  if (window.matchMedia("(max-width: 820px)").matches) setSidebar(false)
  state.view = "home"
  renderAll()
  window.scrollTo(0, 0)
  if (state.dashboard.loaded) loadDashboard()
}

const MIAO_STYLE_FIELDS = [
  ["fontColor", "主文字颜色"],
  ["descColor", "描述文字颜色"],
  ["contBgColor", "面板底色"],
  ["headerBgColor", "分组标题底色"],
  ["rowBgColor1", "奇数行底色"],
  ["rowBgColor2", "偶数行底色"],
  ["fontShadow", "主文字阴影"],
  ["descShadow", "描述文字阴影"],
]

const MIAO_THEME_BASE_STYLE = {
  fontColor: "#ceb78b",
  descColor: "#eee",
  contBgColor: "rgba(43, 52, 61, 0.8)",
  headerBgColor: "rgba(34, 41, 51, .4)",
  rowBgColor1: "rgba(34, 41, 51, .2)",
  rowBgColor2: "rgba(34, 41, 51, .4)",
  fontShadow: "none",
  descShadow: "none",
  contBgBlur: 3,
}

function miaoHelpCfg() {
  const cfg = { ...(state.config?.effective?.helpCfg || {}) }
  for (const [path, value] of state.dirty) if (path.startsWith("helpCfg.")) cfg[path.slice(8)] = value
  return cfg
}

function miaoHelpGroups() {
  const groups = currentValue("helpList", state.config?.effective?.helpList)
  return Array.isArray(groups) ? clone(groups) : []
}

function miaoPreviewTheme(cfg) {
  const themes = state.config?.themes || []
  if (state.miaoStyleTheme) {
    const overrideTheme = themes.find(item => item.name === state.miaoStyleTheme)
    if (overrideTheme) return overrideTheme
  }
  const names = themes.map(item => item.name)
  const exclude = Array.isArray(cfg.themeExclude) ? cfg.themeExclude.map(String) : cfg.themeExclude ? [String(cfg.themeExclude)] : ["default"]
  let picked = []
  if (Array.isArray(cfg.theme)) picked = cfg.theme.map(String).filter(name => names.includes(name))
  else if (cfg.theme === "all" || cfg.theme == null) picked = names.slice()
  else if (typeof cfg.theme === "string" && names.includes(cfg.theme)) picked = [cfg.theme]
  if (exclude.length) picked = picked.filter(name => !exclude.includes(name))
  if (!picked.length) picked = names.includes("default") ? ["default"] : names.slice(0, 1)
  return themes.find(item => item.name === picked[0]) || { name: "default", main: "", bg: "", style: {} }
}

function miaoPreviewStyle(cfg, theme) {
  const base = { ...(theme?.style || {}), ...(state.miaoStyleDraft?.theme === theme?.name ? state.miaoStyleDraft.style : {}) }
  const pick = key => base[key] ?? cfg[key] ?? MIAO_THEME_BASE_STYLE[key]
  return {
    fontColor: pick("fontColor"),
    descColor: pick("descColor"),
    contBgColor: pick("contBgColor"),
    headerBgColor: pick("headerBgColor"),
    rowBgColor1: pick("rowBgColor1"),
    rowBgColor2: pick("rowBgColor2"),
    fontShadow: pick("fontShadow"),
    descShadow: pick("descShadow"),
    blur: cfg.bgBlur === false ? "none" : `blur(${base.contBgBlur ?? cfg.contBgBlur ?? 3}px)`,
  }
}

function helpIconPosition(icon) {
  const x = (icon - 1) % 10
  const y = (icon - x - 1) / 10
  return `background-position:-${x * 50}px -${y * 50}px`
}

function renderMiaoCell(item, gi, ii, iconUrl) {
  const icon = Math.max(0, Math.floor(Number(item.icon) || 0))
  const iconStyle = icon ? helpIconPosition(icon) : "display:none"
  return `<div class="hp-td" data-hp-cell><span class="hp-icon" style="background-image:url('${esc(iconUrl)}');${iconStyle}"></span><input class="hp-icon-input" type="number" min="0" step="1" value="${icon}" data-hp-group="${gi}" data-hp-item="${ii}" data-hp-field="icon" aria-label="图标编号" /><strong class="hp-title-text" contenteditable="plaintext-only" data-placeholder="命令" data-hp-group="${gi}" data-hp-item="${ii}" data-hp-field="title" spellcheck="false">${esc(item.title || "")}</strong><span class="hp-desc" contenteditable="plaintext-only" data-placeholder="说明" data-hp-group="${gi}" data-hp-item="${ii}" data-hp-field="desc" spellcheck="false">${esc(item.desc || "")}</span><button class="hp-remove" type="button" data-action="miao-remove-item" data-group="${gi}" data-item="${ii}" title="删除该帮助项">×</button></div>`
}

function renderMiaoPreviewGroup(group, gi, colCount, iconUrl) {
  const list = Array.isArray(group.list) ? group.list : []
  const rows = []
  for (let start = 0; start < list.length; start += colCount) {
    const cells = list.slice(start, start + colCount)
    const empties = Array.from({ length: colCount - cells.length }, () => `<div class="hp-td is-empty"></div>`).join("")
    rows.push(`<div class="hp-tr">${cells.map((item, offset) => renderMiaoCell(item, gi, start + offset, iconUrl)).join("")}${empties}</div>`)
  }
  const auth = group.auth === "master" ? "master" : ""
  return `<div class="hp-cont"><div class="hp-group" contenteditable="plaintext-only" data-placeholder="分组名称" data-hp-group="${gi}" data-hp-field="group" spellcheck="false">${esc(group.group || "")}</div>${rows.length ? `<div class="hp-table">${rows.join("")}</div>` : ""}<div class="hp-tools"><button class="inline-button" type="button" data-action="miao-add-item" data-group="${gi}">+ 添加帮助项</button><select class="hp-auth" data-hp-group="${gi}" data-hp-field="auth" aria-label="分组权限"><option value=""${auth ? "" : " selected"}>所有人</option><option value="master"${auth ? " selected" : ""}>仅主人</option></select><button class="inline-button" type="button" data-action="miao-remove-group" data-group="${gi}">删除分组</button></div></div>`
}

function renderMiaoPreviewHtml(cfg, groups) {
  const theme = miaoPreviewTheme(cfg)
  const style = miaoPreviewStyle(cfg, theme)
  const colCount = Math.min(5, Math.max(parseInt(cfg.colCount) || 3, 2))
  const colWidth = Math.min(500, Math.max(parseInt(cfg.colWidth) || 265, 100))
  const width = Math.min(2500, Math.max(800, colCount * colWidth + 30))
  const bg = theme.bg || (state.config?.themes || []).find(item => item.name === "default")?.bg || ""
  const main = theme.main || ""
  const iconUrl = state.config?.iconUrl || ""
  const groupsHtml = groups.map((group, gi) => renderMiaoPreviewGroup(group, gi, colCount, iconUrl)).join("")
  const vars = `--hp-font:${style.fontColor};--hp-desc:${style.descColor};--hp-cont:${style.contBgColor};--hp-head:${style.headerBgColor};--hp-row1:${style.rowBgColor1};--hp-row2:${style.rowBgColor2};--hp-font-shadow:${style.fontShadow};--hp-desc-shadow:${style.descShadow};--hp-blur:${style.blur};--hp-cols:${colCount}`
  const styleAttr = `width:${width}px;${vars};background-image:url('${bg}')`
  return `<div class="help-preview" data-help-preview-width="${width}" style="${esc(styleAttr)}"><div class="help-preview-main" style="${esc(`background-image:url('${main}')`)}"><div class="help-preview-head"><div class="hp-title">${esc(cfg.title || "使用帮助")}</div><div class="hp-label">${esc(cfg.subTitle || "Yunzai-Bot & Miao-Plugin")}</div></div>${groupsHtml || `<div class="help-preview-empty">还没有帮助内容，点击下方「添加分组」开始。</div>`}</div></div>`
}

function fitMiaoPreview() {
  const shell = content().querySelector(".help-preview-shell")
  const outer = shell?.querySelector("#help-preview")
  const preview = outer?.querySelector(".help-preview")
  if (!shell || !outer || !preview) return
  const width = Number(preview.dataset.helpPreviewWidth) || 0
  const available = shell.clientWidth
  if (!width || !available) return
  const fit = available / width
  const compact = window.matchMedia("(max-width: 820px)").matches
  const scale = Math.min(1, Math.max(fit, compact ? 0.65 : 0))
  const scaledWidth = Math.ceil(width * scale)
  const scrollable = scaledWidth > available
  preview.style.zoom = ""
  preview.style.transform = `scale(${scale})`
  preview.style.transformOrigin = "top left"
  preview.style.marginLeft = scrollable ? "0" : `${Math.max(0, (available - scaledWidth) / 2)}px`
  preview.style.marginRight = "0"
  outer.style.width = `${scrollable ? scaledWidth : available}px`
  outer.style.height = `${Math.ceil(preview.offsetHeight * scale)}px`
  outer.style.overflow = "hidden"
  shell.style.overflowX = scrollable ? "auto" : "hidden"
  const hint = content().querySelector(".help-preview-scroll-hint")
  if (hint) hint.hidden = !scrollable
}

function refreshMiaoPreview() {
  const container = content().querySelector("#help-preview")
  if (!container) return
  container.innerHTML = renderMiaoPreviewHtml(miaoHelpCfg(), miaoHelpGroups())
  requestAnimationFrame(fitMiaoPreview)
}

function renderMiaoField(label, control, hint = "") {
  return `<div class="field"><div class="field-info"><label>${esc(label)}</label>${hint ? `<p>${esc(hint)}</p>` : ""}</div><div class="field-control">${control}</div></div>`
}

function renderMiaoSettings(cfg, themes) {
  const themeAll = cfg.theme === "all" || cfg.theme == null
  const themeList = Array.isArray(cfg.theme) ? cfg.theme.map(String) : typeof cfg.theme === "string" && cfg.theme !== "all" ? [cfg.theme] : []
  const excluded = Array.isArray(cfg.themeExclude) ? cfg.themeExclude.map(String) : cfg.themeExclude ? [String(cfg.themeExclude)] : ["default"]
  const themeChecks = themes.map(item => `<label class="multi-option"><input type="checkbox" data-miao-theme="${esc(item.name)}" ${themeAll || themeList.includes(item.name) ? "checked" : ""}/><span class="multi-check"></span><span class="multi-text">${esc(item.name)}</span></label>`).join("")
  const excludeChecks = themes.map(item => `<label class="multi-option"><input type="checkbox" data-miao-theme-exclude="${esc(item.name)}" ${excluded.includes(item.name) ? "checked" : ""}/><span class="multi-check"></span><span class="multi-text">${esc(item.name)}</span></label>`).join("")
  const previewTheme = miaoPreviewTheme(cfg)
  const previewStyle = { ...(previewTheme?.style || {}), ...(state.miaoStyleDraft?.theme === previewTheme?.name ? state.miaoStyleDraft.style : {}) }
  const blurValue = previewStyle.contBgBlur ?? MIAO_THEME_BASE_STYLE.contBgBlur
  const blurControl = `<div class="miao-blur-row"><label class="switch"><input type="checkbox" data-miao-cfg="bgBlur" ${cfg.bgBlur === false ? "" : "checked"}/><span class="switch-track"><span class="switch-knob"></span></span></label><span class="miao-blur-label">面板模糊度</span><input class="input mono miao-blur-input" type="number" min="0" max="10" step="0.5" data-miao-blur data-miao-blur-theme="${esc(previewTheme?.name || "")}" value="${esc(blurValue)}" ${previewTheme?.custom ? "" : "disabled"} />${previewTheme?.custom ? "" : `<span class="control-hint">当前主题不可修改</span>`}</div>`
  return `<section class="card"><header class="card-head"><h2>帮助设置</h2><p>标题、主题与布局；配色和背景由主题皮肤提供。</p></header><div class="card-body">${renderMiaoField("帮助标题", `<input class="input" data-miao-cfg="title" value="${esc(cfg.title ?? "")}" placeholder="喵喵帮助" spellcheck="false" />`)}${renderMiaoField("帮助副标题", `<input class="input" data-miao-cfg="subTitle" value="${esc(cfg.subTitle ?? "")}" placeholder="Yunzai-Bot & Miao-Plugin" spellcheck="false" />`)}${renderMiaoField(
    "表格列数",
    `<input class="input mono" type="number" min="2" max="5" step="1" data-miao-cfg="colCount" value="${esc(cfg.colCount ?? 3)}" />`,
    "2-5 列",
  )}${renderMiaoField("单列宽度", `<input class="input mono" type="number" min="100" max="500" step="1" data-miao-cfg="colWidth" value="${esc(cfg.colWidth ?? 265)}" />`, "100-500")}${renderMiaoField(
    "主题皮肤",
    `<div class="help-theme-grid"><label class="multi-option"><input type="checkbox" data-miao-theme-all ${themeAll ? "checked" : ""}/><span class="multi-check"></span><span class="multi-text">全部主题（随机）</span></label>${themeChecks}</div>`,
    themes.length ? "勾选参与随机的主题；全部勾选时等同 all（新主题也会加入）" : "未发现可用主题",
  )}${renderMiaoField("排除主题", `<div class="help-theme-grid">${excludeChecks || `<span class="control-hint">暂无主题</span>`}</div>`, "选中后不会参与随机")}${renderMiaoField("内容面板毛玻璃", blurControl, "作用于分组/表格面板的毛玻璃，不是整页背景图；模糊度属于当前预览主题，随下方「保存配色」保存")}${renderMiaoThemeStyleInline(cfg, themes)}</div></section>`
}

const MIAO_SHADOW_PRESETS = [
  ["none", "无"],
  ["0px 0px 1px rgba(0, 0, 0, .9)", "描边"],
  ["0px 0px 4px rgba(0, 0, 0, .35)", "柔和阴影"],
  ["1px 1px 3px rgba(0, 0, 0, .6)", "普通阴影"],
  ["1px 1px 4px rgba(0, 0, 0, .9)", "强阴影"],
]

function parseCssColor(value) {
  const text = String(value || "").trim()
  let match = /^#([0-9a-f]{3,8})$/i.exec(text)
  if (match) {
    let hex = match[1]
    if (hex.length === 3 || hex.length === 4)
      hex = hex
        .split("")
        .map(char => char + char)
        .join("")
    if (hex.length !== 6 && hex.length !== 8) return null
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    }
  }
  match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(text)
  if (!match) return null
  const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0))
  const alpha = match[4] == null ? 1 : match[4].endsWith("%") ? Number(match[4]) / 100 : Number(match[4])
  return {
    r: Math.round(clamp(match[1], 0, 255)),
    g: Math.round(clamp(match[2], 0, 255)),
    b: Math.round(clamp(match[3], 0, 255)),
    a: clamp(alpha, 0, 1),
  }
}

function colorToHex(color) {
  const hex = value =>
    Math.round(clampNumber(value, 0, 255))
      .toString(16)
      .padStart(2, "0")
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`
}

function colorToCss(color) {
  if (color.a >= 0.999) return colorToHex(color)
  return `rgba(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)}, ${Number(color.a.toFixed(3))})`
}

function renderMiaoColorControl(key, value) {
  const color = parseCssColor(value) || { r: 0, g: 0, b: 0, a: 1 }
  const hex = colorToHex(color)
  const alpha = Math.round(color.a * 100)
  return `<div class="miao-color-control" data-miao-color="${esc(key)}"><input type="color" class="miao-color-picker" data-miao-color-picker value="${hex}" aria-label="${esc(key)} 颜色" /><div class="miao-color-alpha"><input type="range" min="0" max="100" step="1" value="${alpha}" data-miao-color-alpha aria-label="${esc(key)} 透明度" /><span class="miao-color-alpha-value">${alpha}%</span></div><input class="input mono miao-color-value" data-miao-theme-style="${esc(key)}" data-miao-color-value value="${esc(value ?? "")}" spellcheck="false" /></div>`
}

function renderMiaoShadowControl(key, value) {
  const current = String(value ?? "none")
  const preset = MIAO_SHADOW_PRESETS.some(([presetValue]) => presetValue === current)
  const options = MIAO_SHADOW_PRESETS.map(([presetValue, label]) => `<option value="${esc(presetValue)}" ${presetValue === current ? "selected" : ""}>${esc(label)}</option>`).join("")
  return `<div class="miao-shadow-control" data-miao-shadow-control="${esc(key)}"><div class="select-wrap"><select class="input select" data-miao-shadow="${esc(key)}" aria-label="${esc(key)} 类型">${options}<option value="__custom" ${preset ? "" : "selected"}>自定义</option></select></div><input class="input mono" data-miao-theme-style="${esc(key)}" data-miao-shadow-custom value="${esc(current)}" placeholder="0px 0px 1px rgba(0,0,0,.9)" spellcheck="false" ${preset ? "hidden" : ""} /></div>`
}

function renderMiaoThemeStyleInline(cfg, themes) {
  const theme = miaoPreviewTheme(cfg)
  if (!theme?.name) return ""
  const options = themes.map(item => `<option value="${esc(item.name)}" ${state.miaoStyleTheme === item.name ? "selected" : ""}>${esc(item.name)}${item.custom ? "" : "（默认，不可编辑）"}</option>`).join("")
  const select = `<div class="select-wrap miao-style-select"><select class="input select" data-miao-style-theme aria-label="编辑主题"><option value="" ${state.miaoStyleTheme ? "" : "selected"}>跟随主题皮肤选择</option>${options}</select></div>`
  if (!theme.custom) {
    return `<div class="field"><div class="field-info"><label>主题配色</label><p>默认主题不可修改；选择或创建一个自定义主题后，可在这里调整配色。</p></div><div class="field-control">${select}</div></div>`
  }
  const style = state.miaoStyleDraft?.theme === theme.name ? { ...(theme.style || {}), ...state.miaoStyleDraft.style } : theme.style || {}
  const fields = MIAO_STYLE_FIELDS.map(([key, label]) => {
    const value = style[key] ?? MIAO_THEME_BASE_STYLE[key] ?? ""
    const control = key === "fontShadow" || key === "descShadow" ? renderMiaoShadowControl(key, value) : renderMiaoColorControl(key, value)
    return `<div class="help-style-field"><span>${esc(label)}</span>${control}</div>`
  }).join("")
  return `<div class="field"><div class="field-info"><label>主题配色</label><p>切换编辑主题会加载对应 config.js 并用于预览（不写入随机选择）；保存后写回该主题。</p></div><div class="field-control"><div class="miao-theme-style-inline" data-miao-theme-style-theme="${esc(theme.name)}">${select}<div class="help-style-grid">${fields}</div><div class="miao-theme-actions"><button class="button" type="button" data-action="miao-theme-style-save" data-theme="${esc(theme.name)}">保存配色</button></div></div></div></div>`
}

function miaoThemeStatus(cfg, name) {
  const excluded = Array.isArray(cfg.themeExclude) ? cfg.themeExclude.map(String) : cfg.themeExclude ? [String(cfg.themeExclude)] : ["default"]
  if (excluded.includes(name)) return "已排除"
  const theme = cfg.theme
  if (theme === "all" || theme == null) return "已加入随机池"
  if (Array.isArray(theme)) return theme.map(String).includes(name) ? "已加入随机池" : "未加入随机池"
  return String(theme) === name ? "已加入随机池" : "未加入随机池"
}

function renderMiaoThemeEditor(theme) {
  const file = state.miaoThemeEditFile
  return `<div class="miao-theme-editor" data-miao-theme-editor="${esc(theme.name)}"><div class="field"><div class="field-info"><label>主题名称</label></div><div class="field-control"><input class="input" data-miao-theme-name value="${esc(theme.name)}" spellcheck="false" /></div></div><div class="field"><div class="field-info"><label>主图（main.png）</label><p>${file ? `已选择：${esc(file.name)}` : "选择新图片后保存生效"}</p></div><div class="field-control"><div class="miao-theme-bg-edit"><div class="miao-theme-thumb" style="${esc(`background-image:url('${theme.main}')`)}"></div><label class="inline-button upload">更换主图<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-miao-theme-file hidden /></label></div></div></div><p class="control-hint">配色在「帮助设置 → 主题配色」中选择该主题后调整。</p><div class="miao-theme-actions"><button class="button" type="button" data-action="miao-theme-save" data-theme="${esc(theme.name)}">保存主题</button><button class="inline-button" type="button" data-action="miao-theme-cancel">取消</button></div></div>`
}

function renderMiaoThemeManager(cfg, themes) {
  const custom = themes.filter(theme => theme.custom)
  const rows = custom
    .map(theme => {
      const active = state.miaoThemeEdit === theme.name
      return `<div class="miao-theme-item"><div class="miao-theme-row"><div class="miao-theme-thumb" style="${esc(`background-image:url('${theme.main}')`)}"></div><div class="miao-theme-meta"><strong>${esc(theme.name)}</strong><span>${esc(miaoThemeStatus(cfg, theme.name))}</span></div><button class="inline-button" type="button" data-action="miao-theme-edit" data-theme="${esc(theme.name)}">${active ? "收起" : "编辑"}</button><button class="inline-button danger" type="button" data-action="miao-theme-delete" data-theme="${esc(theme.name)}">删除</button></div>${active ? renderMiaoThemeEditor(theme) : ""}</div>`
    })
    .join("")
  const file = state.miaoThemeCreateFile
  return `<section class="card"><header class="card-head"><h2>自定义主题</h2><p>上传图片作为主题主图（main.png）创建主题；背景会回退到默认主题，主题可参与随机选择。</p></header><div class="card-body"><div class="miao-theme-list">${rows || `<p class="control-hint">还没有自定义主题。</p>`}</div><div class="miao-theme-create"><input class="input" data-miao-theme-create placeholder="新主题名称（字母/数字/-/_）" autocomplete="off" spellcheck="false" /><label class="inline-button upload">选择主图<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-miao-theme-create-file hidden /></label><span class="control-hint">${file ? esc(file.name) : "未选择图片"}</span><button class="button" type="button" data-action="miao-theme-create">创建主题</button><button class="inline-button" type="button" data-action="miao-theme-refresh">刷新列表</button></div></div></section>`
}

function renderMiaoHelpForm() {
  const config = state.config
  const cfg = miaoHelpCfg()
  const themes = config.themes || []
  const warning = config.warning?.length ? `<div class="note-card warn">${warningIcon()}<p>${esc(config.warning.join("；"))}</p></div>` : ""
  const preview = `<div class="help-preview-shell"><div id="help-preview">${renderMiaoPreviewHtml(cfg, miaoHelpGroups())}</div></div>`
  const actions = `<div class="help-preview-actions"><button class="button" type="button" data-action="miao-add-group">+ 添加分组</button><span class="control-hint">直接点击预览中的文字即可修改；悬停单元格可改图标编号或删除。</span><span class="control-hint help-preview-scroll-hint" hidden>可左右滑动查看完整预览</span></div>`
  return `${warning}<div class="note-card">${infoIcon()}<p>首次保存会生成 help.js；源码模式可保留注释。</p></div>${renderMiaoSettings(cfg, themes)}${renderMiaoThemeManager(cfg, themes)}${renderCard("帮助内容", "", preview + actions)}`
}

function groupKeyRank(key) {
  const text = String(key)
  if (text === "default") return 0
  if (text.endsWith(":default")) return 1
  if (text.includes(":")) return 3
  return 2
}

function renderForm() {
  const config = state.config
  if (config.special === "miao-help") return renderMiaoHelpForm()
  const effective = { ...(config.effective || {}) }

  for (const [path, value] of state.dirty) if (!path.includes(".") && isObj(value)) effective[path] = value
  const entries = Object.entries(effective)
  if (!entries.length) {
    return `<div class="card"><div class="empty">${emptyIcon()}<h2>这个配置还没有内容</h2><p>切换到 YAML 模式可以直接写入。</p></div></div>`
  }
  const scalar = []
  const objects = []
  for (const [key, value] of entries) {
    if (isObj(value) && !isJsonKey(key) && Object.keys(value).length) objects.push([key, value])
    else scalar.push([key, value])
  }
  if (state.name === "core:group") objects.sort((a, b) => groupKeyRank(a[0]) - groupKeyRank(b[0]))
  const parts = []
  if (scalar.length) parts.push(renderCard("常规", "", scalar.map(([key, value]) => renderRow([key], key, value)).join("")))
  for (const [key, value] of objects) {
    if (state.name === "core:group" && state.removals.has(key)) continue
    if (state.name === "core:aigc" && key === "voice" && isObj(value?.providers)) {
      parts.push(...renderVoiceParts(value))
      continue
    }
    parts.push(renderObjectCard([key], key, value))
  }
  if (state.name === "core:group") parts.push(renderGroupAddCard())
  return parts.join("")
}

function renderVoiceParts(voice) {
  const parts = []
  const providers = voice.providers
  const rest = {}
  for (const [key, value] of Object.entries(voice)) if (key !== "providers") rest[key] = value
  const path = "voice"
  const comment = state.config.comments[path] || ""
  const label = labelFor(path, "voice", comment)
  const hint = hintFor(path, "voice", comment)
  if (Object.keys(rest).length) parts.push(renderCard(label, hint !== label ? hint : "", renderObjectRows(rest, ["voice"])))
  const current = String(rest.provider || "")
  for (const [name, provider] of Object.entries(providers)) {
    if (!isObj(provider)) continue
    parts.push(renderSectionCard(`voice.providers.${name}`, name === current ? `${VOICE_PROVIDER_LABELS[name] || name} · 当前` : VOICE_PROVIDER_LABELS[name] || name, name === current ? "当前使用中的语音提供方" : "", renderObjectRows(provider, ["voice", "providers", name])))
  }
  return parts
}

function renderGroupAddCard() {
  return `<section class="card"><header class="card-head"><h2>单独设置</h2><p>为指定机器人或群添加覆盖默认的配置段。</p></header><div class="card-body"><div class="group-add"><button class="button" type="button" data-action="add-group-section">+ 添加单独设置</button></div></div></section>`
}

function renderObjectCard(prefix, key, value) {
  const path = prefix.join(".")
  const comment = state.config.comments[path] || ""
  const section = state.name === "core:group" && prefix.length === 1 && key !== "default"
  const label = section ? groupSectionLabel(key) : labelFor(path, key, comment).replace(/开关$/, "").trim() || KEY_LABELS[key] || humanize(key)
  let hint = hintFor(path, key, comment)
  if (section && (!hint || hint === label)) hint = "仅对该范围内的会话生效，未填写的项沿用默认设置"
  const tools = section ? `<div class="group-section-tools"><button class="inline-button danger" type="button" data-action="remove-group-section" data-key="${esc(key)}">删除该设置</button></div>` : ""
  const body = tools + renderObjectRows(value, prefix)
  const text = hint && hint !== label ? hint : ""
  if (state.name === "core:group" && prefix.length === 1) return renderSectionCard(key, label, text, body)
  return renderCard(label, text, body)
}

function renderObjectRows(object, prefix) {
  const rows = []
  for (const [key, value] of Object.entries(object)) {
    if (isObj(value) && !isJsonKey(key) && Object.keys(value).length) {
      const path = [...prefix, key].join(".")
      const comment = state.config.comments[path] || ""
      const hint = hintFor(path, key, comment)
      const label = labelFor(path, key, comment)
      rows.push(`<div class="subgroup"><div class="subgroup-head"><h3>${esc(label)}</h3>${hint && hint !== label ? `<p>${esc(hint)}</p>` : ""}</div>${renderObjectRows(value, [...prefix, key])}</div>`)
    } else {
      rows.push(renderRow([...prefix, key], key, value))
    }
  }
  return rows.join("")
}

function renderCard(title, hint, rows) {
  return `<section class="card"><header class="card-head"><h2>${esc(title)}</h2>${hint ? `<p>${esc(hint)}</p>` : ""}</header><div class="card-body">${rows}</div></section>`
}

function renderSectionCard(key, title, hint, rows) {
  const open = state.openSections.has(key)
  return `<details class="card section-card" data-section-key="${esc(key)}" ${open ? "open" : ""}><summary class="card-head section-head"><span class="section-title"><h2>${esc(title)}</h2>${hint ? `<p>${esc(hint)}</p>` : ""}</span><span class="section-chevron"></span></summary><div class="card-body">${rows}</div></details>`
}

function renderRow(prefix, key, value) {
  const path = prefix.join(".")
  const typeHint = state.config?.typeHints?.[path]
  const info = { ...(state.config.types[path] || {}), ...(typeHint ? { type: typeHint } : {}) }
  if (typeHint === "list") info.forceList = true
  const comment = state.config.comments[path] || ""
  const label = labelFor(path, key, comment)
  const current = currentValue(path, value)
  const choices = choicesFor(path, key)
  if (choices.length) info.choices = choices
  if (state.config?.emptyChoices?.[path]) info.allowEmpty = true
  if (key === "api") info.required = true
  if (isObj(current) && (isJsonKey(key) || !Object.keys(current).length)) info.jsonObject = true
  if (isSwitch01(key) && typeof current === "number") info.switch01 = true
  const multi = multiOptionsFor(key)
  if (multi) info.multiOptions = multi
  const limit = numericLimit(path, key)
  if (limit) info.limit = limit
  const kind = multi ? "多选" : showAsKeyField(key, current) ? "密钥" : isCronField(key) && !choices.length && (current == null || typeof current === "string") ? "定时" : choices.length ? "选择" : info.switch01 ? "开关" : valueKind(current, key, info)
  const id = `f-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`
  const hint = hintFor(path, key, comment)
  return `<div class="field" data-field="${esc(path)}">
    <div class="field-info"><label for="${id}">${esc(label)}<span class="type-badge">${kind}</span></label><span class="field-key">${esc(path)}</span>${hint && hint !== label ? `<p>${esc(hint)}</p>` : ""}</div>
    <div class="field-control">${renderControl(id, path, key, current, info)}</div>
  </div>`
}

function isSecret(key) {
  if (/^max_/i.test(key)) return false
  return /(^|_)(?:api_?keys?|keys?|tokens?|secret|password|passwd|authorization|cookie)$/i.test(key)
}

function isLongText(key, value) {
  return typeof value === "string" && (value.includes("\n") || value.length > 120 || /prompt|description|content|comment|help|reply|message|template|script/i.test(key))
}

function listLike(key) {
  return /(list|keys|prefixes|filters)$/i.test(key)
}

function renderSelect(id, value, info, common) {
  const options = info.choices.map(option => (option && typeof option === "object" ? { value: option.value, label: option.label ?? option.value } : { value: option, label: String(option) })).filter(option => option.value !== undefined && option.value !== null)
  const numeric = typeof value === "number" || info.type === "number" || options.some(option => typeof option.value === "number")
  const kind = numeric ? "number" : "string"
  const current = value === null || value === undefined ? "" : String(value)
  const known = options.some(option => String(option.value) === current)
  const parts = []
  if (kind === "string" && info.required) {
    if (!current) parts.push(`<option value="" selected disabled>请选择</option>`)
  } else if (kind === "string" && info.allowEmpty) {
    parts.push(`<option value=""${current ? "" : " selected"}>默认（留空）</option>`)
  } else if (kind === "string" && !current) {
    parts.push(`<option value="" selected disabled>请选择</option>`)
  }
  if (current && !known) parts.push(`<option value="${esc(current)}" selected>${esc(current)}（当前值）</option>`)
  for (const option of options) {
    const optionValue = String(option.value)
    const optionLabel = option.label === undefined || option.label === null ? optionValue : String(option.label)
    parts.push(`<option value="${esc(optionValue)}"${optionValue === current ? " selected" : ""}>${esc(optionLabel)}</option>`)
  }
  return `<div class="select-wrap"><select class="input select" id="${id}" ${common} data-kind="${kind}">${parts.join("")}</select></div>`
}

function pad2(value) {
  return String(Math.max(0, Math.round(Number(value) || 0))).padStart(2, "0")
}

function clampNumber(value, min, max) {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return min
  return Math.min(max, Math.max(min, number))
}

function splitCron(expr) {
  const parts = String(expr || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (parts.length === 6) return { sec: parts[0], rest: parts.slice(1), six: true }
  if (parts.length === 5) return { sec: "0", rest: parts, six: false }
  return null
}

function parseCron(expr) {
  const raw = String(expr ?? "").trim()
  if (!raw) return { mode: "custom", raw, six: false }
  const split = splitCron(raw)
  if (!split) return { mode: "custom", raw, six: false }
  const [min, hour, dom, month, dow] = split.rest
  const base = { raw, six: split.six, sec: split.sec }
  const isNumber = value => /^\d+$/.test(value)
  let match
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return { ...base, mode: "minute", interval: 1 }
  if ((match = /^\*\/(\d+)$/.exec(min)) && hour === "*" && dom === "*" && month === "*" && dow === "*") return { ...base, mode: "minute", interval: Number(match[1]) || 1 }
  if (isNumber(min) && hour === "*" && dom === "*" && month === "*" && dow === "*") return { ...base, mode: "hour", minute: Number(min), interval: 1 }
  if (isNumber(min) && (match = /^\*\/(\d+)$/.exec(hour)) && dom === "*" && month === "*" && dow === "*") return { ...base, mode: "hour", minute: Number(min), interval: Number(match[1]) || 1 }
  if (isNumber(min) && isNumber(hour) && dom === "*" && month === "*" && dow === "*") return { ...base, mode: "day", minute: Number(min), hour: Number(hour) }
  if (isNumber(min) && isNumber(hour) && dom === "*" && month === "*" && /^[\d,]+$/.test(dow)) {
    return {
      ...base,
      mode: "week",
      minute: Number(min),
      hour: Number(hour),
      weekdays: dow
        .split(",")
        .map(Number)
        .filter(day => day >= 0 && day <= 6),
    }
  }
  if (isNumber(min) && isNumber(hour) && /^[\d,]+$/.test(dom) && month === "*" && dow === "*") {
    return {
      ...base,
      mode: "month",
      minute: Number(min),
      hour: Number(hour),
      days: dom
        .split(",")
        .map(Number)
        .filter(day => day >= 1 && day <= 31),
    }
  }
  return { ...base, mode: "custom" }
}

function describeCron(expr) {
  const raw = String(expr ?? "").trim()
  if (!raw) return "未设置（不会执行）"
  const parsed = parseCron(raw)
  const time = `${pad2(parsed.hour ?? 0)}:${pad2(parsed.minute ?? 0)}`
  switch (parsed.mode) {
    case "minute":
      return parsed.interval > 1 ? `每 ${parsed.interval} 分钟` : "每分钟"
    case "hour":
      return parsed.interval > 1 ? `每 ${parsed.interval} 小时（第 ${parsed.minute} 分）` : `每小时（第 ${parsed.minute} 分）`
    case "day":
      return `每天 ${time}`
    case "week":
      return `每周${(parsed.weekdays || []).map(day => CRON_MODE_LABELS[day]).join("、") || "日"} ${time}`
    case "month":
      return `每月 ${(parsed.days || []).join("、") || "1"} 日 ${time}`
    default:
      return "自定义表达式"
  }
}

function cronDetail(parsed) {
  const hour = parsed.hour ?? 4
  const minute = parsed.minute ?? 0
  const time = `${pad2(hour)}:${pad2(minute)}`
  switch (parsed.mode) {
    case "minute":
      return `<label class="cron-field">每 <input class="input cron-number" type="number" min="1" max="59" step="1" value="${parsed.interval || 1}" data-cron-field="interval" /> 分钟执行</label>`
    case "hour":
      return `<label class="cron-field">每 <input class="input cron-number" type="number" min="1" max="23" step="1" value="${parsed.interval || 1}" data-cron-field="hourInterval" /> 小时</label><label class="cron-field">第 <input class="input cron-number" type="number" min="0" max="59" step="1" value="${minute}" data-cron-field="minute" /> 分执行</label>`
    case "day":
      return `<label class="cron-field">每天 <input class="input cron-time" type="time" value="${time}" data-cron-field="time" /></label>`
    case "week":
      return `<label class="cron-field"><input class="input cron-time" type="time" value="${time}" data-cron-field="time" /></label><div class="cron-weekdays">${CRON_WEEKDAYS.map(day => `<label class="cron-weekday"><input type="checkbox" data-cron-field="weekday" value="${day.value}" ${(parsed.weekdays || [1]).includes(day.value) ? "checked" : ""} /><span>${day.label}</span></label>`).join("")}</div>`
    case "month":
      return `<label class="cron-field"><input class="input cron-time" type="time" value="${time}" data-cron-field="time" /></label><label class="cron-field">每月第 <input class="input cron-number" type="number" min="1" max="31" step="1" value="${parsed.days?.[0] || 1}" data-cron-field="day" /> 天</label>`
    default:
      return `<p class="cron-hint">自定义表达式：直接编辑下方表达式（分 时 日 月 周）。</p>`
  }
}

function renderCron(id, value, common) {
  const parsed = parseCron(value)
  return `<div class="cron-control" data-cron>
    <div class="cron-builder">
      <div class="cron-mode-row"><div class="select-wrap"><select class="input select cron-mode" data-cron-mode aria-label="定时频率">${CRON_MODES.map(item => `<option value="${item.value}"${item.value === parsed.mode ? " selected" : ""}>${item.label}</option>`).join("")}</select></div><span class="cron-hint" data-cron-hint>${esc(describeCron(value))}</span></div>
      <div class="cron-detail" data-cron-detail>${cronDetail(parsed)}</div>
    </div>
    <div class="control-row cron-expr-row"><span class="cron-expr-label">表达式</span><input class="input mono cron-expr" id="${id}" ${common} data-kind="string" data-cron-expr value="${esc(value ?? "")}" placeholder="分 时 日 月 周" spellcheck="false" /></div>
  </div>`
}

function cronValues(control) {
  const parsed = parseCron(control.querySelector("[data-cron-expr]")?.value || "")
  const read = field => control.querySelector(`[data-cron-field="${field}"]`)
  const number = field => {
    const input = read(field)
    const value = input ? Number(input.value) : NaN
    return Number.isFinite(value) ? value : undefined
  }
  let hour = parsed.hour ?? 4
  let minute = parsed.minute ?? 0
  const timeInput = read("time")
  if (timeInput?.value) {
    const [h, m] = timeInput.value.split(":").map(Number)
    if (Number.isFinite(h)) hour = h
    if (Number.isFinite(m)) minute = m
  }
  const minuteInput = number("minute")
  if (minuteInput != null) minute = minuteInput
  const weekdays = [...control.querySelectorAll('[data-cron-field="weekday"]:checked')].map(input => Number(input.value))
  return { hour, minute, interval: number("interval"), hourInterval: number("hourInterval"), day: number("day"), weekdays, six: parsed.six, sec: parsed.sec || "0" }
}

function cronExpression(mode, values) {
  const minute = clampNumber(values.minute ?? 0, 0, 59)
  const hour = clampNumber(values.hour ?? 0, 0, 23)
  let fields
  if (mode === "minute") {
    const interval = clampNumber(values.interval ?? 1, 1, 59)
    fields = [interval > 1 ? `*/${interval}` : "*", "*", "*", "*", "*"]
  } else if (mode === "hour") {
    const interval = clampNumber(values.hourInterval ?? 1, 1, 23)
    fields = [String(minute), interval > 1 ? `*/${interval}` : "*", "*", "*", "*"]
  } else if (mode === "day") {
    fields = [String(minute), String(hour), "*", "*", "*"]
  } else if (mode === "week") {
    const days = [...new Set(values.weekdays || [])].sort((a, b) => a - b)
    fields = [String(minute), String(hour), "*", "*", days.length ? days.join(",") : "*"]
  } else if (mode === "month") {
    fields = [String(minute), String(hour), String(clampNumber(values.day ?? 1, 1, 31)), "*", "*"]
  } else {
    return null
  }
  return (values.six ? [values.sec || "0", ...fields] : fields).join(" ")
}

function updateCronHint(control, expr) {
  const hint = control?.querySelector("[data-cron-hint]")
  if (hint) hint.textContent = describeCron(expr)
}

function updateCronFromBuilder(control) {
  if (!control) return
  const mode = control.querySelector("[data-cron-mode]")?.value || "custom"
  const expr = control.querySelector("[data-cron-expr]")
  if (!expr) return
  const values = cronValues(control)
  if (mode === "week" && !values.weekdays.length) {
    values.weekdays = [1]
    const first = control.querySelector('[data-cron-field="weekday"][value="1"]')
    if (first) first.checked = true
  }
  const next = cronExpression(mode, values)
  if (next == null) return
  if (expr.value !== next) {
    expr.value = next
    handleEdit(expr)
  }
  updateCronHint(control, next)
}

function changeCronMode(control) {
  if (!control) return
  const mode = control.querySelector("[data-cron-mode]")?.value || "custom"
  const parsed = parseCron(control.querySelector("[data-cron-expr]")?.value || "")
  const values = cronValues(control)
  const keep = parsed.mode === mode
  const next = {
    ...parsed,
    mode,
    minute: values.minute ?? 0,
    hour: values.hour ?? 4,
    interval: keep ? parsed.interval || 1 : 1,
    weekdays: keep && parsed.weekdays?.length ? parsed.weekdays : [1],
    days: keep && parsed.days?.length ? parsed.days : [1],
  }
  const detail = control.querySelector("[data-cron-detail]")
  if (detail) detail.innerHTML = cronDetail(next)
  updateCronFromBuilder(control)
}

function syncCronFromExpression(control) {
  if (!control) return
  const expr = control.querySelector("[data-cron-expr]")
  const parsed = parseCron(expr?.value || "")
  const select = control.querySelector("[data-cron-mode]")
  if (select) select.value = parsed.mode
  const detail = control.querySelector("[data-cron-detail]")
  if (detail) detail.innerHTML = cronDetail(parsed)
  updateCronHint(control, expr?.value || "")
}

function renderJsonObject(id, value, common) {
  const object = isObj(value) ? value : {}
  const text = JSON.stringify(object, null, 2)
  const count = Object.keys(object).length
  const sensitive = /"(?:api_?keys?|keys?|token|secret|password|authorization|cookie)"\s*:/i.test(text)
  return `<details class="json-control"><summary class="json-summary"><span>JSON 对象 · ${count} 个键</span><span class="json-summary-hint">${sensitive ? "含敏感字段，展开编辑" : "展开编辑"}</span></summary><textarea class="input textarea mono ${sensitive ? "secret" : ""}" id="${id}" ${common} data-kind="json" rows="${Math.min(16, Math.max(4, text.split("\n").length))}" spellcheck="false">${esc(text)}</textarea><div class="json-tools"><span>键名不固定，可直接增删</span><span class="json-actions">${sensitive ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""}<button class="inline-button" type="button" data-action="format-json" data-target="${id}">格式化</button></span></div></details>`
}

function renderMultiSelect(path, key, value, info, common, context) {
  const options = info.multiOptions.map(option => (option && typeof option === "object" ? { value: option.value, label: option.label ?? String(option.value) } : { value: option, label: String(option) }))
  const selected = Array.isArray(value) ? value : value == null || value === "" ? [] : [value]
  const known = new Set(options.map(option => String(option.value)))
  const extras = selected.filter(item => !known.has(String(item))).map(item => ({ value: item, label: String(item), extra: true }))
  const all = [...options, ...extras]
  const owner = context ? `${context.arrayPath}#${context.itemIndex}#${context.itemPath}` : path
  const rows = all
    .map(option => {
      const checked = selected.some(item => String(item) === String(option.value))
      const type = typeof option.value === "number" ? "number" : "string"
      return `<label class="multi-option${option.extra ? " is-extra" : ""}"><input type="checkbox" data-multi-option data-multi-value="${esc(option.value)}" data-multi-type="${type}" ${checked ? "checked" : ""}/><span class="multi-check"></span><span class="multi-text">${esc(option.label)}</span>${option.extra ? `<span class="multi-extra">已选</span>` : ""}</label>`
    })
    .join("")
  const search = all.length > 8 ? `<input class="input multi-search" data-multi-search placeholder="搜索选项…" autocomplete="off" spellcheck="false" />` : ""
  const empty = all.length ? "" : `<p class="control-hint">暂无可选项，可在下方手动添加。</p>`
  return `<div class="multi-select" data-multi ${common} data-multi-owner="${esc(owner)}"><div class="multi-toolbar">${search}<span class="multi-count">已选 ${selected.length} 项</span></div><div class="multi-list">${rows}${empty}</div><div class="multi-manual"><input class="input" data-multi-input placeholder="手动添加 ID 或名称" autocomplete="off" spellcheck="false" /><button class="inline-button" type="button" data-action="multi-add">添加</button></div></div>`
}

function renderListEditor(path, key, value, info, common, context) {
  const owner = context ? `${context.arrayPath}#${context.itemIndex}#${context.itemPath}` : path
  const listAttrs = context ? `data-list-array-path="${esc(context.arrayPath)}" data-list-item-index="${context.itemIndex}" data-list-item-path="${esc(context.itemPath)}"` : `data-list-path="${esc(path)}"`
  const itemType = info.itemType || (value.length ? typeof value[0] : "string")
  const type = itemType === "number" ? "number" : itemType === "boolean" ? "boolean" : "string"
  const prefix = `li-${owner.replace(/[^A-Za-z0-9_-]/g, "-")}`
  const row = (item, index, draft = false) => {
    const controlId = `${prefix}-${index}`
    const attrs = `${listAttrs} data-list-owner="${esc(owner)}" data-list-index="${index}" data-list-type="${type}"${draft ? ' data-list-draft="1"' : ""}`
    const control = type === "boolean" ? `<label class="switch"><input id="${controlId}" type="checkbox" ${attrs} data-kind="bool" ${item ? "checked" : ""}/><span class="switch-track"><span class="switch-knob"></span></span></label>` : `<input class="input mono" id="${controlId}" type="${type === "number" ? "number" : "text"}" ${attrs} data-kind="${type === "number" ? "number" : "string"}" value="${draft ? "" : esc(item)}" spellcheck="false" />`
    return `<div class="list-item${draft ? " is-draft" : ""}"><span class="list-index">${index + 1}</span>${control}<button class="inline-button" type="button" data-action="remove-list-item" ${attrs}>${draft ? "取消" : "删除"}</button></div>`
  }
  const rows = value.map((item, index) => row(item, index)).join("")
  const draft = state.draftListItem?.owner === owner && state.draftListItem.index === value.length ? row(null, value.length, true) : ""
  const empty = value.length || draft ? "" : `<p class="control-hint">还没有项目，点击下方添加。</p>`
  return `<div class="list-editor" data-list-owner="${esc(owner)}">${rows}${draft}${empty}<button class="inline-button add-item" type="button" data-action="add-list-item" ${listAttrs} data-list-type="${type}">+ 添加一项</button></div>`
}

function renderControl(id, path, key, value, info, context = null) {
  const common = context ? `data-array-path="${esc(context.arrayPath)}" data-item-index="${context.itemIndex}" data-item-path="${esc(context.itemPath)}"` : `data-path="${esc(path)}"`
  const secret = isSecret(key)
  if (showAsKeyField(key, value)) {
    const text = Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value)
    const count = text.split(/[,;\s]+/).filter(Boolean).length
    const reveal = secret ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""
    return `<div class="control-stack"><textarea class="input textarea mono ${secret ? "secret" : ""}" id="${id}" ${common} data-kind="string" rows="3" placeholder="多个密钥用逗号、分号或换行分隔" spellcheck="false">${esc(text)}</textarea><div class="control-tools"><span>${count} 个密钥 · ${fmtNum(text.length)} 字符</span>${reveal}</div></div>`
  }
  if (Array.isArray(info.multiOptions)) {
    return renderMultiSelect(path, key, value, info, common, context)
  }
  if (Array.isArray(info.choices) && info.choices.length && !secret && (value === null || value === undefined || typeof value === "string" || typeof value === "number")) {
    return renderSelect(id, value, info, common)
  }
  if (isCronField(key) && !secret && (value === null || value === undefined || typeof value === "string")) {
    return renderCron(id, value, common)
  }
  if (isObj(value)) {
    return renderJsonObject(id, value, common)
  }
  if (typeof value === "boolean") {
    return `<label class="switch"><input id="${id}" type="checkbox" ${common} data-kind="bool" ${value ? "checked" : ""}/><span class="switch-track"><span class="switch-knob"></span></span></label>`
  }
  if (info.switch01) {
    return `<label class="switch"><input id="${id}" type="checkbox" ${common} data-kind="switch01" ${value ? "checked" : ""}/><span class="switch-track"><span class="switch-knob"></span></span></label>`
  }
  if (typeof value === "number") {
    const limit = info.limit || {}
    const { min, max } = limit
    const step = limit.step ?? (Number.isInteger(value) ? 1 : "any")
    const attrs = `${min != null ? ` min="${esc(min)}"` : ""}${max != null ? ` max="${esc(max)}"` : ""} step="${esc(step)}"`
    const data = `${min != null ? ` data-min="${esc(min)}"` : ""}${max != null ? ` data-max="${esc(max)}"` : ""}`
    const hint = rangeLabel(limit)
    return `<div class="control-row number-row"><input class="input mono" id="${id}" type="number" ${common} data-kind="number" value="${esc(value)}"${attrs}${data} />${hint ? `<span class="range-hint">${esc(hint)}</span>` : ""}</div>`
  }
  if (typeof value === "string") {
    if (isLongText(key, value) && !secret) {
      const text = String(value)
      const lines = text.split("\n").length
      const rows = key === "system_prompt" ? Math.min(24, Math.max(10, lines + 1)) : Math.min(12, Math.max(4, lines + 1))
      return `<div class="control-stack"><textarea class="input textarea mono${key === "system_prompt" ? " prompt-editor" : ""}" id="${id}" ${common} data-kind="string" rows="${rows}">${esc(value)}</textarea><div class="control-tools"><span>${lines} 行 · ${fmtNum(text.length)} 字符</span><button class="inline-button" type="button" data-action="expand" data-target="${id}">放大编辑</button></div></div>`
    }
    const type = secret ? "password" : "text"
    const reveal = secret ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""
    const urlAttrs = info.httpUrl ? ` data-validate="http-url" aria-required="true" placeholder="https://…"` : ""
    return `<div class="control-row"><input class="input ${secret ? "secret-input" : ""}" id="${id}" type="${type}" ${common} data-kind="string" value="${esc(value)}" spellcheck="false"${urlAttrs} />${reveal}</div>`
  }
  if (Array.isArray(value)) {
    const itemType = info.itemType || (value.length ? typeof value[0] : "")
    if (!context && itemType === "object" && value.every(isObj)) return renderObjectArray(path, key, value)
    const primitive = value.every(item => item === null || typeof item === "string" || typeof item === "number" || typeof item === "boolean")
    const asJson = !primitive || (!info.forceList && (itemType === "object" || itemType === "array" || itemType === "mixed" || (!value.length && !listLike(key))))
    if (asJson) {
      const jsonText = JSON.stringify(value, null, 2)
      const sensitive = /"(?:api_?keys?|keys?|token|secret|password|authorization|cookie)"\s*:/i.test(jsonText)
      return `<details class="json-control"><summary class="json-summary"><span>JSON · ${value.length} 项</span><span class="json-summary-hint">${sensitive ? "含敏感字段，展开编辑" : "展开编辑"}</span></summary><textarea class="input textarea mono ${sensitive ? "secret" : ""}" id="${id}" ${common} data-kind="json" rows="${Math.min(16, Math.max(6, jsonText.split("\n").length))}" spellcheck="false">${esc(jsonText)}</textarea><div class="json-tools"><span>JSON 数组</span><span class="json-actions">${sensitive ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""}<button class="inline-button" type="button" data-action="format-json" data-target="${id}">格式化</button></span></div></details>`
    }
    return renderListEditor(path, key, value, info, common, context)
  }
  if (value === null || value === undefined) {
    if (info.type === "list") {
      return renderListEditor(path, key, [], info, common, context)
    }
    if (info.httpUrl) {
      return `<div class="control-row"><input class="input" id="${id}" type="text" ${common} data-kind="string" data-validate="http-url" aria-required="true" value="" placeholder="https://…" spellcheck="false" /></div><p class="control-hint">必填，需以 http:// 或 https:// 开头。</p>`
    }
    const type = secret ? "password" : "text"
    const reveal = secret ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""
    return `<div class="control-row"><input class="input" id="${id}" type="${type}" ${common} data-kind="any" value="" placeholder="空值" spellcheck="false" />${reveal}</div><p class="control-hint">空值；可填字符串，或 JSON 数组/对象。</p>`
  }
  return `<input class="input" id="${id}" ${common} data-kind="string" value="${esc(value)}" />`
}

function itemHint(item) {
  return String(item?.model || item?.type || item?.adapter || item?.command || item?.url || "")
}

function renderObjectArray(path, key, value) {
  const items = value
    .map((item, index) => {
      const open = state.openItem?.path === path && state.openItem.index === index
      const fresh = state.newArrayItem?.path === path && state.newArrayItem?.index === index
      return `<details class="array-item ${fresh ? "is-new" : ""}" data-array-path="${esc(path)}" data-index="${index}" ${open ? "open" : ""}><summary class="array-item-head"><span class="array-item-title">${esc(itemLabel(item, index))}</span><span class="array-item-hint">${esc(itemHint(item))}</span><span class="array-chevron"></span></summary><div class="array-item-body"><div class="array-item-tools"><button class="inline-button" type="button" data-action="remove-array-item" data-array-path="${esc(path)}" data-index="${index}">删除</button></div>${renderArrayItemFields(item, path, index, "")}</div></details>`
    })
    .join("")
  return `<div class="array-editor">${items}<button class="inline-button add-item" type="button" data-action="add-array-item" data-array-path="${esc(path)}">+ 添加一项</button></div>`
}

function renderArrayItemFields(item, arrayPath, index, itemPath) {
  if (!isObj(item)) return renderArrayField(arrayPath, index, itemPath, "", item)
  const parts = []
  for (const [key, value] of Object.entries(item)) {
    const full = itemPath ? `${itemPath}.${key}` : key
    if (isObj(value) && !isJsonKey(key) && Object.keys(value).length) {
      const path = `${arrayPath}.${full}`
      const indexedPath = `${arrayPath}.${index}.${full}`
      const comment = state.config?.comments?.[indexedPath] || state.config?.comments?.[path] || ""
      const label = labelFor(path, key, comment)
      const hint = hintFor(path, key, comment)
      parts.push(`<div class="array-subgroup"><h4>${esc(label)}</h4>${hint && hint !== label ? `<p class="subgroup-hint">${esc(hint)}</p>` : ""}${renderArrayItemFields(value, arrayPath, index, full)}</div>`)
    } else {
      parts.push(renderArrayField(arrayPath, index, itemPath, key, value))
    }
  }
  return parts.join("")
}

function renderArrayField(arrayPath, index, itemPath, key, value) {
  const full = itemPath ? `${itemPath}.${key}` : key
  const id = `af-${arrayPath.replace(/[^A-Za-z0-9_-]/g, "-")}-${index}-${full.replace(/[^A-Za-z0-9_-]/g, "-")}`
  const lookupPath = full ? `${arrayPath}.${full}` : ""
  const indexedPath = full ? `${arrayPath}.${index}.${full}` : ""
  const info = infoForValue(value)
  const typeHint = lookupPath ? state.config?.typeHints?.[lookupPath] : ""
  if (typeHint && (value === null || value === undefined)) info.type = typeHint
  if (typeHint === "list") info.forceList = true
  const choices = lookupPath ? choicesFor(lookupPath, key) : []
  if (choices.length) info.choices = choices
  if (lookupPath && state.config?.emptyChoices?.[lookupPath]) info.allowEmpty = true
  if (key === "api") info.required = true
  if (arrayPath === "mcp.servers" && key === "url") info.httpUrl = true
  if (isObj(value) && (isJsonKey(key) || !Object.keys(value).length)) info.jsonObject = true
  if (isSwitch01(key) && typeof value === "number") info.switch01 = true
  const multi = multiOptionsFor(key)
  if (multi) info.multiOptions = multi
  const limit = numericLimit(lookupPath, key)
  if (limit) info.limit = limit
  const kind = multi ? "多选" : showAsKeyField(key, value) ? "密钥" : isCronField(key) && !choices.length && (value == null || typeof value === "string") ? "定时" : choices.length ? "选择" : info.switch01 ? "开关" : valueKind(value, key, info)
  const comment = full ? state.config?.comments?.[indexedPath] || state.config?.comments?.[lookupPath] || "" : ""
  const label = key ? labelFor(lookupPath, key, comment) : `第 ${index + 1} 项`
  const hint = key ? hintFor(lookupPath, key, comment) : ""
  const context = { arrayPath, itemIndex: index, itemPath: full }
  return `<div class="field array-field"><div class="field-info"><label for="${id}">${esc(label)}<span class="type-badge">${kind}</span></label><span class="field-key">${esc(full)}</span>${hint && hint !== label ? `<p>${esc(hint)}</p>` : ""}</div><div class="field-control">${renderControl(id, "", key, value, info, context)}</div></div>`
}

function readControl(element) {
  const kind = element.dataset.kind
  if (kind === "bool") return { ok: true, value: element.checked }
  if (kind === "switch01") return { ok: true, value: element.checked ? 1 : 0 }
  if (kind === "number") {
    if (element.value.trim() === "") return { ok: false, message: "数字不能为空" }
    const number = Number(element.value)
    if (!Number.isFinite(number)) return { ok: false, message: "数字格式不正确" }
    return { ok: true, value: number }
  }
  if (kind === "list") {
    const type = element.dataset.itemType || "string"
    const items = element.value
      .split(/\r?\n/)
      .map(item => item.trim())
      .filter(Boolean)
    if (type === "number") {
      const numbers = items.map(Number)
      if (numbers.some(number => !Number.isFinite(number))) return { ok: false, message: "列表里有非数字项" }
      return { ok: true, value: numbers }
    }
    if (type === "boolean") return { ok: true, value: items.map(item => item === "true") }
    return { ok: true, value: items }
  }
  if (kind === "json") {
    try {
      const value = JSON.parse(element.value)
      return { ok: true, value }
    } catch (err) {
      return { ok: false, message: `JSON 格式错误：${err.message}` }
    }
  }
  if (kind === "any") {
    const text = element.value.trim()
    if (!text) return { ok: true, value: null }
    if (/^[[{]/.test(text)) {
      try {
        return { ok: true, value: JSON.parse(text) }
      } catch (err) {
        return { ok: false, message: `JSON 格式错误：${err.message}` }
      }
    }
    if (text === "true" || text === "false") return { ok: true, value: text === "true" }
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return { ok: true, value: Number(text) }
    return { ok: true, value: text }
  }
  return { ok: true, value: element.value }
}

function clampNumberInput(element) {
  const min = element.dataset.min === undefined ? null : Number(element.dataset.min)
  const max = element.dataset.max === undefined ? null : Number(element.dataset.max)
  if (min == null && max == null) return
  const value = Number(element.value)
  if (!Number.isFinite(value)) return
  const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, value))
  if (clamped === value) return
  element.value = String(clamped)
  handleEdit(element)
}

function clampAllNumberInputs() {
  for (const element of content().querySelectorAll('input[data-kind="number"][data-min], input[data-kind="number"][data-max]')) clampNumberInput(element)
}

function checkHttpUrl(input) {
  const item = input.closest("details.array-item")
  if (item?.querySelector('select[data-item-path="type"]')?.value === "stdio") {
    input.classList.remove("invalid")
    return true
  }
  const value = input.value.trim()
  const ok = /^https?:\/\/\S+$/i.test(value)
  input.classList.toggle("invalid", !ok)
  if (ok && input.value !== value) {
    input.value = value
    handleEdit(input)
  }
  return ok
}

function listOwner(element) {
  const arrayPath = element.dataset.listArrayPath
  if (arrayPath) return `${arrayPath}#${element.dataset.listItemIndex}#${element.dataset.listItemPath || ""}`
  return element.dataset.listPath || ""
}

function listControlId(owner, index) {
  return `li-${owner.replace(/[^A-Za-z0-9_-]/g, "-")}-${index}`
}

function listTarget(element) {
  const arrayPath = element.dataset.listArrayPath || ""
  if (arrayPath) {
    const arrayIndex = Number(element.dataset.listItemIndex)
    const itemPath = element.dataset.listItemPath || ""
    const array = clone(state.dirty.get(arrayPath) ?? getPath(state.config.effective, arrayPath) ?? [])
    const raw = itemPath ? getPath(array[arrayIndex], itemPath) : array[arrayIndex]
    return { arrayPath, arrayIndex, itemPath, array, list: Array.isArray(raw) ? clone(raw) : [] }
  }
  const path = element.dataset.listPath || ""
  const raw = state.dirty.get(path) ?? getPath(state.config.effective, path)
  return { path, list: Array.isArray(raw) ? clone(raw) : [] }
}

function commitList(target) {
  if (target.arrayPath) {
    if (target.itemPath) setPath(target.array[target.arrayIndex], target.itemPath, target.list)
    else target.array[target.arrayIndex] = target.list
    setDirty(target.arrayPath, target.array)
    return
  }
  if (target.path) setDirty(target.path, target.list)
}

function handleListEdit(element) {
  const type = element.dataset.listType || "string"
  const draft = element.dataset.listDraft === "1"
  let value = element.value
  if (type === "number") {
    if (element.value.trim() === "") {
      if (draft) return

      value = null
    } else {
      value = Number(element.value)
      if (!Number.isFinite(value)) {
        if (!draft) element.classList.add("invalid")
        return
      }
    }
  } else if (type === "boolean") {
    value = element.checked
  }
  element.classList.remove("invalid")
  const target = listTarget(element)
  if (draft) {
    if (value === "" || value === null) return
    element.dataset.listDraft = "0"
    state.draftListItem = null
    target.list.push(value)
    commitList(target)
    return
  }
  const index = Number(element.dataset.listIndex)
  if (index < 0 || index >= target.list.length) return
  target.list[index] = value
  commitList(target)
}

function addListItem(button) {
  const target = listTarget(button)
  const owner = listOwner(button)
  if (target.arrayPath) state.openItem = { path: target.arrayPath, index: target.arrayIndex }
  state.draftListItem = { owner, index: target.list.length }
  state.focusListItem = listControlId(owner, target.list.length)
  renderContent()
  requestAnimationFrame(() => {
    const node = document.getElementById(state.focusListItem)
    state.focusListItem = null
    if (!node) return
    node.focus()
    node.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" })
  })
}

function removeListItem(button) {
  if (button.dataset.listDraft === "1") {
    state.draftListItem = null
    renderContent()
    return
  }
  const target = listTarget(button)
  const index = Number(button.dataset.listIndex)
  if (index < 0 || index >= target.list.length) return
  target.list.splice(index, 1)
  if (target.arrayPath) state.openItem = { path: target.arrayPath, index: target.arrayIndex }
  commitList(target)
  renderContent()
}

function commitFieldValue(element, value) {
  if (element.dataset.arrayPath) {
    const arrayPath = element.dataset.arrayPath
    const index = Number(element.dataset.itemIndex)
    const itemPath = element.dataset.itemPath || ""
    const array = clone(state.dirty.get(arrayPath) ?? getPath(state.config.effective, arrayPath) ?? [])
    if (!Array.isArray(array) || !isObj(array[index])) return
    if (itemPath) setPath(array[index], itemPath, value)
    else array[index] = value
    setDirty(arrayPath, array)
    return
  }
  setDirty(element.dataset.path, value)
}

function handleEdit(element) {
  const result = readControl(element)
  element.classList.toggle("invalid", !result.ok)
  if (!result.ok) return
  commitFieldValue(element, result.value)
}

function multiValues(box) {
  return [...box.querySelectorAll("[data-multi-option]:checked")].map(input => (input.dataset.multiType === "number" ? Number(input.dataset.multiValue) : input.dataset.multiValue))
}

function handleMultiToggle(input) {
  const box = input.closest("[data-multi]")
  if (!box) return
  const values = multiValues(box)
  const count = box.querySelector(".multi-count")
  if (count) count.textContent = `已选 ${values.length} 项`
  commitFieldValue(box, values)
}

function addMultiValue(button) {
  const box = button.closest("[data-multi]")
  const input = box?.querySelector("[data-multi-input]")
  const text = input?.value.trim()
  if (!text) return
  const values = multiValues(box)
  for (const token of text.split(/[,，\s]+/).filter(Boolean)) {
    const value = /^\d+$/.test(token) ? Number(token) : token
    if (!values.some(item => String(item) === String(value))) values.push(value)
  }
  input.value = ""
  commitFieldValue(box, values)
  renderContent()
}

function filterMultiOptions(input) {
  const box = input.closest("[data-multi]")
  if (!box) return
  const query = input.value.trim().toLowerCase()
  for (const option of box.querySelectorAll(".multi-option")) option.hidden = !!query && !option.textContent.toLowerCase().includes(query)
}

async function removeGroupSection(key) {
  if (!key || key === "default" || !state.config) return
  const exists = Object.prototype.hasOwnProperty.call(state.config.effective, key)
  const ok = await confirmDialog("删除单独设置？", exists ? `将删除「${groupSectionLabel(key)}」的覆盖设置，保存后生效。` : `将移除尚未保存的「${groupSectionLabel(key)}」。`, "删除")
  if (!ok) return
  for (const path of [...state.dirty.keys()]) if (path === key || path.startsWith(`${key}.`)) state.dirty.delete(path)
  if (exists) {
    state.removals.add(key)
    toast("已标记删除，保存后生效")
  } else {
    state.removals.delete(key)
    toast("已移除该设置")
  }
  renderContent()
  renderDirty()
}

async function addGroupSection() {
  if (!state.config) return
  const bots = state.data?.bots || []
  const groups = state.data?.groups || []
  const type = await chooseDialog("添加单独设置", "选择配置生效的范围。", [
    { value: "bot", label: "机器人单独设置", description: "该机器人下所有群共用的设置" },
    { value: "group", label: "群单独设置", description: "所有机器人在该群的设置" },
    { value: "both", label: "机器人群单独设置", description: "指定机器人在指定群的设置" },
  ])
  if (!type) return
  let botId = ""
  let groupId = ""
  if (type === "bot" || type === "both") {
    if (bots.length) {
      botId = await chooseDialog(
        "选择机器人",
        "选择该设置适用的机器人。",
        bots.map(item => ({ value: item.self_id, label: item.nickname ? `${item.nickname}（${item.self_id}）` : item.self_id })),
      )
      if (!botId) return
    } else {
      botId = await textDialog("机器人账号", "当前没有已连接的机器人，请手动输入机器人账号。", "例如 114514")
      if (!botId) return
      if (!/^[\w-]+$/.test(String(botId))) return toast("机器人账号格式不正确", "error")
    }
  }
  if (type === "group" || type === "both") {
    const candidates = type === "both" ? groups.filter(group => (group.bot_ids || []).some(id => String(id) === String(botId))) : groups
    if (candidates.length) {
      groupId = await chooseDialog(
        "选择群",
        "选择该设置适用的群。",
        candidates.map(group => ({ value: group.group_id, label: `${group.group_name}（${group.group_id}）` })),
      )
      if (!groupId) return
    } else {
      groupId = await textDialog("群号", "没有从在线机器人获取到群列表，请手动输入群号。", "例如 123456789")
      if (!groupId) return
      if (!/^\d+$/.test(String(groupId))) return toast("群号必须是数字", "error")
    }
  }
  const key = type === "bot" ? `${botId}:default` : type === "group" ? String(groupId) : `${botId}:${groupId}`
  if (state.removals.has(key)) {
    state.removals.delete(key)
    renderContent()
    return toast("已恢复该设置")
  }
  if (Object.prototype.hasOwnProperty.call(state.config.effective, key) || state.dirty.has(key)) return toast("该设置已存在", "error")
  const base = isObj(state.config.effective.default) ? clone(state.config.effective.default) : {}
  state.openSections.add(key)
  setDirty(key, base)
  renderContent()
  requestAnimationFrame(() => {
    const label = groupSectionLabel(key)
    const target = [...content().querySelectorAll(".card")].find(card => card.querySelector(".card-head h2")?.textContent === label)
    target?.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" })
  })
}

function revealSecret(button) {
  const target = document.getElementById(button.dataset.target)
  if (!target) return
  if (target.tagName === "INPUT") {
    target.type = target.type === "password" ? "text" : "password"
    button.textContent = target.type === "password" ? "显示" : "隐藏"
  } else {
    target.classList.toggle("revealed")
    button.textContent = target.classList.contains("revealed") ? "隐藏" : "显示"
  }
}

function formatJson(button) {
  const target = document.getElementById(button.dataset.target)
  if (!target) return
  try {
    target.value = JSON.stringify(JSON.parse(target.value), null, 2)
    handleEdit(target)
  } catch (err) {
    toast(`JSON 格式错误：${err.message}`, "error")
  }
}

function syncEditorMeta() {
  const area = $("#editor-area")
  const meta = $("#editor-meta")
  if (!area || !meta) return
  const text = area.value
  meta.textContent = `${text.split(/\r?\n/).length} 行 · ${fmtNum(text.length)} 字符`
}

function openEditor(target) {
  const overlay = $("#editor")
  const area = $("#editor-area")
  if (!overlay || !area || !target) return
  state.editorTarget = target
  const field = target.closest(".field")
  const label = field?.querySelector(".field-info label")
  const title = $("#editor-title")
  if (title) title.textContent = label ? label.childNodes[0]?.textContent?.trim() || "编辑文本" : "编辑文本"
  area.value = target.value
  syncEditorMeta()
  overlay.hidden = false
  requestAnimationFrame(() => {
    overlay.classList.add("open")
    area.focus()
  })
}

function closeEditor() {
  const overlay = $("#editor")
  if (!overlay || overlay.hidden) return
  overlay.classList.remove("open")
  const target = state.editorTarget
  state.editorTarget = null
  state.editorTimer && clearTimeout(state.editorTimer)
  state.editorTimer = setTimeout(() => {
    if (!state.editorTarget) overlay.hidden = true
  }, 180)
  target?.focus?.()
}

function arrayDraft(path) {
  return clone(state.dirty.get(path) ?? getPath(state.config.effective, path) ?? [])
}

function uniqueName(base, array) {
  const names = new Set((Array.isArray(array) ? array : []).map(item => (typeof item?.name === "string" ? item.name.trim() : "")).filter(Boolean))
  let name = base
  let suffix = 2
  while (names.has(name)) name = `${base}-${suffix++}`
  return name
}

function modelTemplate(type, array) {
  const template = MODEL_TEMPLATES[type] || MODEL_TEMPLATES.gemini
  return { name: uniqueName(type, array), adapter: type, ...template() }
}

function mcpTemplate(type, array) {
  const template = MCP_TEMPLATES[type] || MCP_TEMPLATES.http
  return { name: uniqueName(type, array), ...template() }
}

async function addArrayItem(path) {
  const array = arrayDraft(path)
  if (!Array.isArray(array)) return
  let item
  if (state.name === "core:aigc" && path === "models") {
    const type = await chooseDialog("添加模型配置", "先选择请求适配器，之后只会生成该适配器支持的配置项。", MODEL_API_OPTIONS)
    if (!type) return
    item = modelTemplate(type, array)
  } else if (state.name === "core:aigc" && path === "mcp.servers") {
    const type = await chooseDialog("添加 MCP 服务器", "先选择连接类型，之后只会生成该类型支持的配置项。", MCP_TYPE_OPTIONS)
    if (!type) return
    item = mcpTemplate(type, array)
  } else {
    item = array.length && isObj(array[0]) ? emptyLike(array[0]) : {}
  }
  array.push(item)
  const index = array.length - 1
  state.openItem = { path, index }
  state.newArrayItem = { path, index }
  setDirty(path, array)
  renderContent()
  requestAnimationFrame(() => {
    const target = content().querySelector(`details.array-item[data-array-path="${cssEscape(path)}"][data-index="${index}"]`)
    target?.scrollIntoView({ block: "start", behavior: reduceMotion() ? "auto" : "smooth" })
  })
}

function removeArrayItem(path, index) {
  const array = arrayDraft(path)
  if (!Array.isArray(array)) return
  array.splice(index, 1)
  setDirty(path, array)
  renderContent()
}

function handleMiaoCfgInput(element) {
  const key = element.dataset.miaoCfg
  if (!key) return
  let value
  if (element.type === "checkbox") value = element.checked
  else if (element.type === "number") {
    if (element.value.trim() === "") return
    value = Number(element.value)
    if (!Number.isFinite(value)) return
    const min = element.min === "" ? null : Number(element.min)
    const max = element.max === "" ? null : Number(element.max)
    if (min != null) value = Math.max(min, value)
    if (max != null) value = Math.min(max, value)
    if (String(value) !== element.value) element.value = String(value)
  } else value = element.value
  setDirty(`helpCfg.${key}`, value)
  refreshMiaoPreview()
}

function setMiaoThemeAll(input) {
  setDirty("helpCfg.theme", input.checked ? "all" : [])
  renderContent()
}

function setMiaoThemeItem() {
  const themes = state.config?.themes || []
  const checked = [...content().querySelectorAll("[data-miao-theme]:checked")].map(input => input.dataset.miaoTheme)
  setDirty("helpCfg.theme", themes.length && checked.length === themes.length ? "all" : checked)
  renderContent()
}

function setMiaoThemeExclude() {
  const checked = [...content().querySelectorAll("[data-miao-theme-exclude]:checked")].map(input => input.dataset.miaoThemeExclude)
  setDirty("helpCfg.themeExclude", checked)
  renderContent()
}

function applyMiaoThemeResult(result) {
  if (Array.isArray(result?.themes)) state.config.themes = result.themes
  if (state.miaoStyleTheme && !(state.config.themes || []).some(theme => theme.name === state.miaoStyleTheme)) state.miaoStyleTheme = ""
  if (state.miaoStyleDraft && !(state.config.themes || []).some(theme => theme.name === state.miaoStyleDraft.theme)) state.miaoStyleDraft = null
  const cfg = state.config?.effective?.helpCfg
  if (!result?.helpCfg || !cfg) return
  if (result.helpCfg.theme !== undefined) {
    cfg.theme = result.helpCfg.theme
    state.dirty.delete("helpCfg.theme")
  }
  if (result.helpCfg.themeExclude !== undefined) {
    cfg.themeExclude = result.helpCfg.themeExclude
    state.dirty.delete("helpCfg.themeExclude")
  }
}

async function uploadMiaoThemeImage(url, file, method) {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": file.type || "image/png" },
    body: await file.arrayBuffer(),
    credentials: "same-origin",
  })
  if (res.status === 401) {
    showLogin()
    throw new Error("需要登录")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function toggleMiaoThemeEdit(name) {
  state.miaoThemeEdit = state.miaoThemeEdit === name ? "" : name
  state.miaoThemeEditFile = null
  renderContent()
}

async function createMiaoThemeFromUi() {
  const input = content().querySelector("[data-miao-theme-create]")
  const name = input?.value.trim() || ""
  const file = state.miaoThemeCreateFile
  if (!name) return toast("请输入主题名称", "error")
  if (!file) return toast("请选择主图", "error")
  try {
    const result = await uploadMiaoThemeImage(`${API}/miao-help/themes?name=${encodeURIComponent(name)}`, file, "POST")
    state.miaoThemeCreateFile = null
    state.miaoStyleDraft = null
    applyMiaoThemeResult(result)
    state.miaoStyleTheme = name
    renderContent()
    const made = (result.themes || []).find(theme => theme.name === name)
    toast("主题已创建，可在「主题配色」中调整")
  } catch (err) {
    toast(err.message, "error")
  }
}

async function saveMiaoThemeFromUi(name) {
  const panel = content().querySelector(`[data-miao-theme-editor="${cssEscape(name)}"]`)
  if (!panel) return
  const newName = panel.querySelector("[data-miao-theme-name]")?.value.trim() || name
  let current = name
  try {
    if (newName !== name) {
      const wasStyleTheme = state.miaoStyleTheme === name
      const draft = state.miaoStyleDraft?.theme === name ? state.miaoStyleDraft : null
      const renamed = await api(`/miao-help/themes/${encodeURIComponent(name)}`, { method: "PATCH", body: { name: newName } })
      applyMiaoThemeResult(renamed)
      if (wasStyleTheme) state.miaoStyleTheme = newName
      if (draft) state.miaoStyleDraft = { theme: newName, style: draft.style }
      current = newName
      state.miaoThemeEdit = newName
    }
    if (state.miaoThemeEditFile) {
      const uploaded = await uploadMiaoThemeImage(`${API}/miao-help/themes/${encodeURIComponent(current)}/main`, state.miaoThemeEditFile, "PUT")
      applyMiaoThemeResult(uploaded)
      state.miaoThemeEditFile = null
    }
    renderContent()
    toast("主题已保存")
  } catch (err) {
    toast(err.message, "error")
  }
}

async function saveMiaoThemeStyleFromUi(name) {
  const scope = content().querySelector(`[data-miao-theme-style-theme="${cssEscape(name)}"]`)
  if (!scope) return
  const style = { ...(state.miaoStyleDraft?.theme === name ? state.miaoStyleDraft.style : {}) }
  for (const input of scope.querySelectorAll("[data-miao-theme-style]")) style[input.dataset.miaoThemeStyle] = input.type === "number" ? Number(input.value) : input.value
  try {
    const result = await api(`/miao-help/themes/${encodeURIComponent(name)}/style`, { method: "PUT", body: { style } })
    state.miaoStyleDraft = null
    applyMiaoThemeResult(result)
    renderContent()
    toast("主题配色已保存")
  } catch (err) {
    toast(err.message, "error")
  }
}

async function refreshMiaoThemeList() {
  try {
    const result = await api("/miao-help/themes")
    applyMiaoThemeResult(result)
    renderContent()
    toast("主题列表已刷新")
  } catch (err) {
    toast(err.message, "error")
  }
}

function updateMiaoStyleDraftFor(themeName, key, value) {
  if (!themeName) return
  const theme = (state.config.themes || []).find(item => item.name === themeName)
  const base = { ...(theme?.style || {}), ...(state.miaoStyleDraft?.theme === themeName ? state.miaoStyleDraft.style : {}) }
  base[key] = value
  state.miaoStyleDraft = { theme: themeName, style: base }
  refreshMiaoPreview()
}

function updateMiaoStyleDraft(element, key, value) {
  const scope = element.closest("[data-miao-theme-style-theme]")
  updateMiaoStyleDraftFor(scope?.dataset.miaoThemeStyleTheme, key, value)
}

function handleMiaoStyleInput(input) {
  const key = input.dataset.miaoThemeStyle
  if (!key) return
  let value = input.type === "number" ? Number(input.value) : input.value
  if (input.type === "number" && (input.value.trim() === "" || !Number.isFinite(value))) return
  if (input.matches("[data-miao-color-value]")) {
    const parsed = parseCssColor(value)
    const control = input.closest(".miao-color-control")
    if (parsed && control) {
      const picker = control.querySelector("[data-miao-color-picker]")
      const alpha = control.querySelector("[data-miao-color-alpha]")
      const label = control.querySelector(".miao-color-alpha-value")
      if (picker) picker.value = colorToHex(parsed)
      if (alpha) alpha.value = String(Math.round(parsed.a * 100))
      if (label) label.textContent = `${Math.round(parsed.a * 100)}%`
    }
  }
  updateMiaoStyleDraft(input, key, value)
}

function handleMiaoColorInput(input) {
  const control = input.closest("[data-miao-color]")
  if (!control) return
  const picker = control.querySelector("[data-miao-color-picker]")
  const alpha = control.querySelector("[data-miao-color-alpha]")
  const text = control.querySelector("[data-miao-color-value]")
  const label = control.querySelector(".miao-color-alpha-value")
  const parsed = parseCssColor(picker?.value) || { r: 0, g: 0, b: 0, a: 1 }
  const value = Number(alpha?.value ?? 100) / 100
  const css = colorToCss({ ...parsed, a: value })
  if (text) text.value = css
  if (label) label.textContent = `${Math.round(value * 100)}%`
  updateMiaoStyleDraft(control, control.dataset.miaoColor, css)
}

function handleMiaoShadowSelect(select) {
  const control = select.closest(".miao-shadow-control")
  const key = control?.dataset.miaoShadowControl
  const custom = control?.querySelector("[data-miao-shadow-custom]")
  if (!key || !custom) return
  if (select.value === "__custom") {
    custom.hidden = false
    custom.focus()
    updateMiaoStyleDraft(custom, key, custom.value)
    return
  }
  custom.value = select.value
  custom.hidden = true
  updateMiaoStyleDraft(custom, key, select.value)
}

async function deleteMiaoThemeFromUi(name) {
  const ok = await confirmDialog("删除主题？", `将删除主题「${name}」及其背景和配色，无法恢复。`, "删除")
  if (!ok) return
  try {
    const result = await api(`/miao-help/themes/${encodeURIComponent(name)}`, { method: "DELETE" })
    applyMiaoThemeResult(result)
    if (state.miaoThemeEdit === name) state.miaoThemeEdit = ""
    state.miaoThemeEditFile = null
    renderContent()
    toast("主题已删除")
  } catch (err) {
    toast(err.message, "error")
  }
}

function handleHelpContentEdit(element) {
  const gi = Number(element.dataset.hpGroup)
  const itemIndex = element.dataset.hpItem
  const field = element.dataset.hpField
  const groups = miaoHelpGroups()
  const group = groups[gi]
  if (!group) return
  if (itemIndex == null) {
    if (field === "group") group.group = element.textContent
    else if (field === "auth") {
      if (element.value) group.auth = element.value
      else delete group.auth
    } else return
  } else {
    const ii = Number(itemIndex)
    const item = group.list?.[ii]
    if (!item) return
    if (field === "icon") {
      const icon = Math.max(0, Math.floor(Number(element.value) || 0))
      item.icon = icon
      const iconEl = element.parentElement?.querySelector(".hp-icon")
      if (iconEl) {
        iconEl.style.display = icon ? "" : "none"
        if (icon) iconEl.style.backgroundPosition = helpIconPosition(icon).replace("background-position:", "")
      }
    } else if (field === "title" || field === "desc") item[field] = element.textContent
    else return
  }
  setDirty("helpList", groups)
}

function addMiaoGroup() {
  const groups = miaoHelpGroups()
  groups.push({ group: "新分组", list: [] })
  setDirty("helpList", groups)
  renderContent()
}

async function removeMiaoGroup(index) {
  const groups = miaoHelpGroups()
  const group = groups[index]
  if (!group) return
  const ok = await confirmDialog("删除帮助分组？", `将删除「${group.group || "未命名分组"}」及其下所有帮助项，保存后生效。`, "删除")
  if (!ok) return
  groups.splice(index, 1)
  setDirty("helpList", groups)
  renderContent()
}

function addMiaoItem(groupIndex) {
  const groups = miaoHelpGroups()
  const group = groups[groupIndex]
  if (!group) return
  if (!Array.isArray(group.list)) group.list = []
  group.list.push({ icon: 1, title: "", desc: "" })
  setDirty("helpList", groups)
  renderContent()
  requestAnimationFrame(() => {
    const node = content().querySelector(`[data-hp-group="${groupIndex}"][data-hp-item="${group.list.length - 1}"][data-hp-field="title"]`)
    node?.focus()
  })
}

function removeMiaoItem(groupIndex, itemIndex) {
  const groups = miaoHelpGroups()
  if (!Array.isArray(groups[groupIndex]?.list)) return
  groups[groupIndex].list.splice(itemIndex, 1)
  setDirty("helpList", groups)
  renderContent()
}

function beginSave() {
  const button = $("#save")
  clearTimeout(state.saveTimer)
  button.classList.remove("is-saved")
  button.classList.add("is-saving")
  button.setAttribute("aria-busy", "true")
  button.disabled = true
  button.textContent = "保存中…"
  document.querySelector(".toolbar")?.classList.add("is-saving")
}

function endSave(ok) {
  const button = $("#save")
  document.querySelector(".toolbar")?.classList.remove("is-saving")
  button.classList.remove("is-saving")
  button.removeAttribute("aria-busy")
  if (!ok) {
    button.textContent = "保存"
    renderDirty()
    return
  }
  button.classList.add("is-saved")
  button.textContent = "已保存"
  state.saveTimer = setTimeout(() => {
    button.classList.remove("is-saved")
    button.textContent = "保存"
    renderDirty()
  }, 1500)
}

function shakeField(element) {
  element.classList.remove("invalid")
  void element.offsetWidth
  element.classList.add("invalid")
}

async function save() {
  if (!state.config) return
  if (state.mode === "yaml") return saveRaw()
  clampAllNumberInputs()
  let invalidUrl = null
  for (const input of content().querySelectorAll('[data-validate="http-url"]')) if (!checkHttpUrl(input)) invalidUrl ||= input
  if (invalidUrl) {
    invalidUrl.focus()
    shakeField(invalidUrl)
    return toast("MCP 服务地址必填，且需以 http:// 或 https:// 开头", "error")
  }
  if (!state.dirty.size && !state.removals.size) return toast("没有需要保存的修改")
  const invalid = content().querySelector("[data-kind].invalid")
  if (invalid) {
    invalid.focus()
    shakeField(invalid)
    return toast("请先修正高亮的字段", "error")
  }
  beginSave()
  try {
    const result = await api("/config", { method: "PUT", body: { name: state.name, patch: buildPatch(), remove: [...state.removals] } })
    state.config = result.config
    state.dirty.clear()
    state.removals.clear()
    state.draftListItem = null
    renderAll()
    endSave(true)
    toast("已保存")
  } catch (err) {
    endSave(false)
    toast(err.message, "error")
  }
}

async function saveRaw() {
  if (!state.raw || !state.rawDirty) return toast("没有需要保存的修改")
  beginSave()
  try {
    const result = await api("/raw", { method: "PUT", body: { name: state.name, content: $("#raw-editor").value } })
    state.config = result.config
    await loadRaw(state.name)
    state.rawDirty = false
    renderAll()
    endSave(true)
    toast("已保存")
  } catch (err) {
    endSave(false)
    toast(err.message, "error")
  }
}

function renderRaw() {
  const special = state.config?.special === "miao-help"
  if (!state.raw) return `<div class="card"><div class="empty">正在读取${special ? "源码" : " YAML"}…</div></div>`
  const lines = state.raw.content.split(/\r?\n/).length
  const title = special ? "JS 源码" : "原始 YAML"
  const copy = special ? "help.js 源码；首次保存会生成 help.js。" : "原始 YAML；保存前会校验语法。"
  return `<section class="card raw-card"><header class="card-head"><h2>${title}</h2><p>${copy}</p></header><div class="card-body"><textarea id="raw-editor" class="input textarea mono raw-editor" spellcheck="false">${esc(state.raw.content)}</textarea><div class="raw-meta"><span>${lines} 行</span><span>${fmtNum(state.raw.content.length)} 字符</span><button class="inline-button" type="button" data-action="reload-raw">重新读取</button></div></div></section>`
}

function canViewTransition() {
  return !!document.startViewTransition && !reduceMotion() && window.matchMedia("(min-width: 821px)").matches
}

async function switchConfig(name) {
  if (state.view === "config" && name === state.name) return true
  if (isDirty() && !(await confirmDialog("放弃未保存的修改？", "当前配置有未保存的修改，切换后会丢失。", "放弃修改"))) return false
  if (window.matchMedia("(max-width: 820px)").matches) setSidebar(false)
  state.view = "config"
  const title = $("#config-title")
  if (!canViewTransition() || !title) {
    try {
      await loadConfig(name)
    } catch (err) {
      toast(err.message, "error")
      return false
    }
    window.scrollTo(0, 0)
    animateContentIn()
    return true
  }
  const token = ++viewTransitionToken
  let loaded = true
  title.style.viewTransitionName = "config-title"
  const transition = document.startViewTransition(async () => {
    try {
      await loadConfig(name)
      window.scrollTo(0, 0)
    } catch (err) {
      loaded = false
      toast(err.message, "error")
    }
  })
  await transition.finished.catch(() => {})
  if (token === viewTransitionToken) title.style.viewTransitionName = ""
  return loaded
}

async function switchMode(mode) {
  if (mode === state.mode) return
  if (isDirty() && !(await confirmDialog("放弃未保存的修改？", "切换编辑模式会丢弃当前未保存的修改。", "放弃修改"))) return
  state.mode = mode
  state.dirty.clear()
  state.removals.clear()
  state.rawDirty = false
  state.draftListItem = null
  if (mode === "yaml" && state.raw?.name !== state.name) await loadRaw(state.name)
  renderAll()
  animateContentIn()
}

function confirmDialog(title, message, label) {
  return new Promise(resolve => {
    const dialog = $("#dialog")
    clearTimeout(state.dialogTimer)
    state.dialogResolve = resolve
    dialog.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-body"><h2 id="dialog-title">${esc(title)}</h2><p>${esc(message)}</p></div><div class="dialog-actions"><button class="button" type="button" data-dialog="cancel">取消</button><button class="button primary" type="button" data-dialog="ok">${esc(label)}</button></div></div>`
    dialog.hidden = false
    dialog.classList.remove("open")
    requestAnimationFrame(() => {
      dialog.classList.add("open")
      dialog.querySelector('[data-dialog="cancel"]')?.focus()
    })
  })
}

function chooseDialog(title, message, options) {
  return new Promise(resolve => {
    const dialog = $("#dialog")
    clearTimeout(state.dialogTimer)
    state.dialogResolve = resolve
    const items = options.map(option => `<button class="choice-item" type="button" data-choice="${esc(option.value)}"><span class="choice-copy"><span class="choice-label">${esc(option.label)}</span>${option.description ? `<span class="choice-desc">${esc(option.description)}</span>` : ""}</span><span class="choice-tag">${esc(option.value)}</span></button>`).join("")
    const search = options.length > 10 ? `<input class="input choice-search" data-choice-search placeholder="搜索…" autocomplete="off" spellcheck="false" />` : ""
    dialog.innerHTML = `<div class="dialog-card dialog-choices" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-body"><h2 id="dialog-title">${esc(title)}</h2><p>${esc(message)}</p></div><div class="choice-list">${search}${items}</div><div class="dialog-actions dialog-actions-single"><button class="button" type="button" data-dialog="cancel">取消</button></div></div>`
    dialog.hidden = false
    dialog.classList.remove("open")
    requestAnimationFrame(() => {
      dialog.classList.add("open")
      dialog.querySelector(".choice-item")?.focus()
    })
  })
}

function textDialog(title, message, placeholder = "") {
  return new Promise(resolve => {
    const dialog = $("#dialog")
    clearTimeout(state.dialogTimer)
    state.dialogResolve = resolve
    dialog.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-body"><h2 id="dialog-title">${esc(title)}</h2><p>${esc(message)}</p><input id="dialog-input" class="input dialog-input" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" /></div><div class="dialog-actions"><button class="button" type="button" data-dialog="cancel">取消</button><button class="button primary" type="button" data-dialog="ok">确定</button></div></div>`
    dialog.hidden = false
    dialog.classList.remove("open")
    requestAnimationFrame(() => {
      dialog.classList.add("open")
      dialog.querySelector("#dialog-input")?.focus()
    })
  })
}

function closeDialog(result) {
  const dialog = $("#dialog")
  if (dialog.hidden) return
  dialog.classList.remove("open")
  const resolve = state.dialogResolve
  state.dialogResolve = null
  resolve?.(result)
  clearTimeout(state.dialogTimer)
  state.dialogTimer = setTimeout(() => {
    dialog.hidden = true
    dialog.innerHTML = ""
  }, 170)
}

function bindEvents() {
  const gate = $("#gate")
  let gateFrame = 0
  gate?.addEventListener("pointermove", event => {
    if (reduceMotion() || event.pointerType === "touch" || gateFrame) return
    gateFrame = requestAnimationFrame(() => {
      gateFrame = 0
      const rect = gate.getBoundingClientRect()
      const x = ((event.clientX - rect.left) / rect.width - 0.5) * 28
      const y = ((event.clientY - rect.top) / rect.height - 0.5) * 22
      gate.style.setProperty("--gate-x", `${x.toFixed(2)}px`)
      gate.style.setProperty("--gate-y", `${y.toFixed(2)}px`)
    })
  })
  gate?.addEventListener("pointerleave", () => {
    gate.style.setProperty("--gate-x", "0px")
    gate.style.setProperty("--gate-y", "0px")
  })

  $("#config-search").addEventListener("input", event => {
    state.search = event.target.value
    renderSidebar()
  })

  $("#config-search-clear")?.addEventListener("click", () => {
    const input = $("#config-search")
    input.value = ""
    state.search = ""
    renderSidebar()
    input.focus()
  })

  $("#home-nav")?.addEventListener("click", () => switchHome().catch(err => toast(err.message, "error")))
  $("#sidebar-toggle")?.addEventListener("click", () => setSidebar(!sidebarOpen()))
  $("#sidebar-close")?.addEventListener("click", () => setSidebar(false))
  $("#sidebar-backdrop")?.addEventListener("click", () => setSidebar(false))

  $("#config-groups").addEventListener("click", event => {
    if (event.target.closest('[data-action="clear-search"]')) {
      const input = $("#config-search")
      input.value = ""
      state.search = ""
      renderSidebar()
      input.focus()
      return
    }
    const toggle = event.target.closest("[data-group]")
    if (toggle) {
      const id = toggle.dataset.group
      const open = toggle.getAttribute("aria-expanded") !== "true"
      toggle.setAttribute("aria-expanded", String(open))
      toggle.nextElementSibling?.classList.toggle("collapsed", !open)
      if (!state.search.trim()) {
        if (open) state.expanded.add(id)
        else state.expanded.delete(id)
        saveExpanded()
      }
      return
    }
    const item = event.target.closest("[data-name]")
    if (item) {
      switchConfig(item.dataset.name).then(switched => {
        if (switched) setSidebar(false)
      })
    }
  })

  $("#copy-path")?.addEventListener("click", async () => {
    const file = state.config?.file
    if (!file) return
    try {
      await navigator.clipboard.writeText(file)
      toast("路径已复制")
    } catch {
      toast("无法复制路径", "error")
    }
  })

  document.addEventListener("click", event => {
    if (event.target.closest("[data-theme-toggle]")) toggleTheme()
  })

  document.querySelector(".segmented").addEventListener("click", event => {
    const button = event.target.closest("[data-mode]")
    if (button) switchMode(button.dataset.mode).catch(err => toast(err.message, "error"))
  })

  $("#save").addEventListener("click", save)

  content().addEventListener("input", event => {
    if (event.target.id === "raw-editor") {
      state.rawDirty = event.target.value !== (state.raw?.content || "")
      renderDirty()
      return
    }
    if (event.target.matches("[data-miao-color-picker], [data-miao-color-alpha]")) {
      handleMiaoColorInput(event.target)
      return
    }
    if (event.target.matches("[data-miao-blur]")) {
      if (event.target.value.trim() === "") return
      updateMiaoStyleDraftFor(event.target.dataset.miaoBlurTheme, "contBgBlur", Number(event.target.value))
      return
    }
    if (event.target.matches("[data-miao-theme-style]")) {
      handleMiaoStyleInput(event.target)
      return
    }
    if (event.target.matches("[data-miao-cfg]") && event.target.type !== "checkbox") {
      handleMiaoCfgInput(event.target)
      return
    }
    if (event.target.matches("[data-hp-field]")) {
      handleHelpContentEdit(event.target)
      return
    }
    if (event.target.matches("[data-cron-field]")) {
      updateCronFromBuilder(event.target.closest("[data-cron]"))
      return
    }
    if (event.target.matches("[data-cron-expr]")) {
      updateCronHint(event.target.closest("[data-cron]"), event.target.value)
    }
    if (event.target.matches("[data-multi-search]")) {
      filterMultiOptions(event.target)
      return
    }
    if (event.target.matches("[data-list-index]")) {
      handleListEdit(event.target)
      return
    }
    if (event.target.matches("[data-path], [data-array-path]")) handleEdit(event.target)
  })

  content().addEventListener("change", event => {
    if (event.target.matches("[data-miao-style-theme]")) {
      state.miaoStyleTheme = event.target.value
      state.miaoStyleDraft = null
      renderContent()
      return
    }
    if (event.target.matches("[data-miao-shadow]")) {
      handleMiaoShadowSelect(event.target)
      return
    }
    if (event.target.matches("[data-miao-theme-file]")) {
      state.miaoThemeEditFile = event.target.files?.[0] || null
      const hint = event.target.closest("[data-miao-theme-editor]")?.querySelector(".field-info p")
      if (hint) hint.textContent = state.miaoThemeEditFile ? `已选择：${state.miaoThemeEditFile.name}` : "选择新图片后保存生效"
      return
    }
    if (event.target.matches("[data-miao-theme-create-file]")) {
      state.miaoThemeCreateFile = event.target.files?.[0] || null
      const hint = event.target.closest(".miao-theme-create")?.querySelector(".control-hint")
      if (hint) hint.textContent = state.miaoThemeCreateFile ? state.miaoThemeCreateFile.name : "未选择图片"
      return
    }
    if (event.target.matches("[data-miao-theme-all]")) {
      setMiaoThemeAll(event.target)
      return
    }
    if (event.target.matches("[data-miao-theme]")) {
      setMiaoThemeItem()
      return
    }
    if (event.target.matches("[data-miao-theme-exclude]")) {
      setMiaoThemeExclude()
      return
    }
    if (event.target.matches("[data-miao-cfg]") && event.target.type === "checkbox") {
      handleMiaoCfgInput(event.target)
      return
    }
    if (event.target.matches('[data-hp-field="auth"]')) {
      handleHelpContentEdit(event.target)
      return
    }
    if (event.target.matches('[data-validate="http-url"]')) {
      checkHttpUrl(event.target)
      return
    }
    if (event.target.matches("[data-multi-option]")) {
      handleMultiToggle(event.target)
      return
    }
    if (event.target.matches('input[data-kind="number"][data-min], input[data-kind="number"][data-max]')) {
      clampNumberInput(event.target)
      return
    }
    if (event.target.matches("[data-cron-mode]")) {
      changeCronMode(event.target.closest("[data-cron]"))
      return
    }
    if (event.target.matches("[data-cron-field]")) {
      updateCronFromBuilder(event.target.closest("[data-cron]"))
      return
    }
    if (event.target.matches("[data-cron-expr]")) syncCronFromExpression(event.target.closest("[data-cron]"))
  })

  content().addEventListener(
    "toggle",
    event => {
      const card = event.target.closest?.(".section-card")
      if (!card) return
      const key = card.dataset.sectionKey
      if (!key) return
      if (card.open) state.openSections.add(key)
      else state.openSections.delete(key)
    },
    true,
  )

  content().addEventListener("click", event => {
    const button = event.target.closest("[data-action]")
    if (!button) return
    if (button.dataset.action === "reveal") revealSecret(button)
    else if (button.dataset.action === "format-json") formatJson(button)
    else if (button.dataset.action === "expand") openEditor(document.getElementById(button.dataset.target))
    else if (button.dataset.action === "add-array-item") addArrayItem(button.dataset.arrayPath).catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "remove-array-item") removeArrayItem(button.dataset.arrayPath, Number(button.dataset.index))
    else if (button.dataset.action === "add-list-item") addListItem(button)
    else if (button.dataset.action === "remove-list-item") removeListItem(button)
    else if (button.dataset.action === "multi-add") addMultiValue(button)
    else if (button.dataset.action === "add-group-section") addGroupSection().catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "remove-group-section") removeGroupSection(button.dataset.key).catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "miao-add-group") addMiaoGroup()
    else if (button.dataset.action === "miao-remove-group") removeMiaoGroup(Number(button.dataset.group)).catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "miao-add-item") addMiaoItem(Number(button.dataset.group))
    else if (button.dataset.action === "miao-remove-item") removeMiaoItem(Number(button.dataset.group), Number(button.dataset.item))
    else if (button.dataset.action === "miao-theme-edit") toggleMiaoThemeEdit(button.dataset.theme)
    else if (button.dataset.action === "miao-theme-cancel") {
      state.miaoThemeEdit = ""
      state.miaoThemeEditFile = null
      renderContent()
    } else if (button.dataset.action === "miao-theme-save") saveMiaoThemeFromUi(button.dataset.theme).catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "miao-theme-style-save") saveMiaoThemeStyleFromUi(button.dataset.theme).catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "miao-theme-refresh") refreshMiaoThemeList().catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "miao-theme-delete") deleteMiaoThemeFromUi(button.dataset.theme).catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "miao-theme-create") createMiaoThemeFromUi().catch(err => toast(err.message, "error"))
    else if (button.dataset.action === "reload-raw") {
      loadRaw(state.name).then(() => {
        state.rawDirty = false
        renderAll()
      })
    } else if (button.dataset.action === "refresh-state") {
      loadState().catch(err => toast(err.message, "error"))
    }
  })

  $("#dialog").addEventListener("click", event => {
    if (event.target.id === "dialog") closeDialog(false)
    const choice = event.target.closest("[data-choice]")
    if (choice) {
      closeDialog(choice.dataset.choice)
      return
    }
    const button = event.target.closest("[data-dialog]")
    if (button) {
      const input = $("#dialog-input")
      if (button.dataset.dialog === "ok" && input) closeDialog(input.value.trim() || false)
      else closeDialog(button.dataset.dialog === "ok")
    }
  })

  $("#dialog").addEventListener("input", event => {
    if (!event.target.matches("[data-choice-search]")) return
    const query = event.target.value.trim().toLowerCase()
    for (const item of event.target.parentElement.querySelectorAll(".choice-item")) item.hidden = !!query && !item.textContent.toLowerCase().includes(query)
  })

  $("#dialog").addEventListener("keydown", event => {
    if (event.key !== "Enter") return
    const input = $("#dialog-input")
    if (!input || event.target !== input) return
    event.preventDefault()
    closeDialog(input.value.trim() || false)
  })

  const editor = $("#editor")
  editor?.addEventListener("click", event => {
    if (event.target === editor) closeEditor()
  })
  $("#editor-close")?.addEventListener("click", closeEditor)
  $("#editor-done")?.addEventListener("click", closeEditor)
  $("#editor-area")?.addEventListener("input", () => {
    const area = $("#editor-area")
    syncEditorMeta()
    const target = state.editorTarget
    if (!target || !area) return
    target.value = area.value
    target.dispatchEvent(new Event("input", { bubbles: true }))
  })

  document.addEventListener("keydown", event => {
    const active = document.activeElement
    const typing = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable)
    const dialogOpen = !$("#dialog").hidden
    const gateOpen = !$("#gate").hidden
    const editorOpen = !$("#editor")?.hidden
    const search = $("#config-search")

    if (event.key === "Enter" && event.target.matches?.("[data-multi-input]")) {
      event.preventDefault()
      const add = event.target.closest("[data-multi]")?.querySelector('[data-action="multi-add"]')
      if (add) addMultiValue(add)
      return
    }
    if (event.key === "Enter" && event.target.matches?.("[contenteditable][data-hp-field]")) {
      event.preventDefault()
      event.target.blur()
      return
    }
    if (editorOpen && event.key === "Escape") {
      event.preventDefault()
      closeEditor()
      return
    }
    if (!typing && !dialogOpen && !editorOpen && !gateOpen && (event.key === "/" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k"))) {
      event.preventDefault()
      focusSearch()
      return
    }
    if (event.key === "Escape") {
      if (dialogOpen) {
        closeDialog(false)
        return
      }
      if (active === search && search.value) {
        search.value = ""
        state.search = ""
        renderSidebar()
        syncSearchUI()
        return
      }
      if (sidebarOpen()) setSidebar(false)
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      if (!dialogOpen && !gateOpen) save()
    }
  })

  window.addEventListener("beforeunload", event => {
    if (!isDirty()) return
    event.preventDefault()
    event.returnValue = ""
  })

  const mobileViewport = window.matchMedia("(max-width: 820px)")
  mobileViewport.addEventListener?.("change", event => {
    if (!event.matches) setSidebar(false)
  })

  window.addEventListener("resize", () => {
    if (state.config?.special === "miao-help" && state.mode === "form") requestAnimationFrame(fitMiaoPreview)
  })

  window.addEventListener("hashchange", () => {})
}

function emptyIcon() {
  return `<svg class="empty-icon" viewBox="0 0 48 48" aria-hidden="true"><rect x="8" y="7" width="32" height="34" rx="7"></rect><path d="M16 16h16M16 23h16M16 30h10"></path></svg>`
}

bindEvents()
boot().catch(err => {
  if (!$("#gate").hidden) return
  $("#app").hidden = false
  content().innerHTML = `<div class="empty"><h2>无法连接控制台</h2><p>${esc(err.message)}</p></div>`
})
