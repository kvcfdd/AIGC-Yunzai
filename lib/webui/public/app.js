const API = "/aigc_yunzai/api"
const THEME_KEY = "yunzai-config-theme"
const ACRONYMS = new Set(["api", "id", "url", "qq", "uid", "mcp", "tts", "ai", "http", "https", "ui", "db", "gsuid"])
const KEY_LABELS = {
  enable: "启用",
  inject: "注入",
  model_config: "模型配置",
  api: "接口类型",
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

const state = {
  data: null,
  bot: null,
  name: null,
  config: null,
  mode: "form",
  dirty: new Map(),
  raw: null,
  rawDirty: false,
  search: "",
  theme: "light",
  expanded: new Set(["core"]),
  openItem: null,
  openHelpGroup: null,
  dialogResolve: null,
  toastTimer: null,
}

const $ = selector => document.querySelector(selector)
const content = () => $("#content")

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
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

function fmtUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days) return `${days} 天 ${hours} 小时`
  if (hours) return `${hours} 小时 ${minutes} 分`
  return `${minutes} 分`
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
    if (itemType === "object" && value.length) return "对象列表"
    if (itemType === "array" || itemType === "mixed" || itemType === "object" || (!value.length && !listLike(key))) return "JSON"
    return "列表"
  }
  if (value === null || value === undefined) return info.type === "list" ? "列表" : "空值"
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

function buildPatch() {
  const patch = {}
  for (const [path, value] of state.dirty) setPath(patch, path, value)
  return patch
}

function isDirty() {
  return state.dirty.size > 0 || state.rawDirty
}

function setDirty(path, value) {
  const old = getPath(state.config?.effective, path)
  if (JSON.stringify(old) === JSON.stringify(value)) state.dirty.delete(path)
  else state.dirty.set(path, value)
  renderDirty()
}

function renderDirty() {
  const el = $("#dirty")
  el.hidden = !isDirty()
  $("#save").disabled = !isDirty()
}

function toast(message, kind = "success") {
  const el = $("#toast")
  el.textContent = message
  el.className = `toast ${kind}`
  el.hidden = false
  clearTimeout(state.toastTimer)
  state.toastTimer = setTimeout(() => {
    el.hidden = true
  }, 2800)
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
  $("#app").hidden = true
  $("#gate").hidden = false
  const form = $("#gate-form")
  const bot = state.bot
  const icon = bot?.avatar ? `<div class="app-icon large has-image"><img src="${esc(bot.avatar)}" alt="${esc(bot.nickname || bot.self_id || "Bot")}" referrerpolicy="no-referrer" /></div>` : `<div class="app-icon large"><span></span><span></span><span></span></div>`
  const title = bot?.nickname || "Yunzai"
  form.innerHTML = `<div class="gate-head">${icon}<h1>${esc(title)}</h1><p>配置控制台</p></div><label class="login-field" for="login-key"><span class="login-label">密钥</span><span class="login-input-wrap"><span class="login-key-icon">${keyIcon()}</span><input id="login-key" type="password" placeholder="输入密钥" autocomplete="off" required /><button class="login-eye" type="button" aria-label="显示密钥">${eyeIcon()}</button></span></label>${message ? `<p class="gate-error">${esc(message)}</p>` : ""}<button class="button primary wide login-submit" type="submit">登录</button>`
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
  state.rawDirty = false
  state.raw = null
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
      return `<section class="config-group">
        <button class="group-toggle" type="button" data-group="${esc(group.id)}" aria-expanded="${open}"><span class="group-chevron"></span><span class="group-title">${esc(group.label)}</span><span class="group-count">${items.length}</span></button>
        <div class="group-items" ${open ? "" : "hidden"}>${items
          .map(
            config => `<button class="config-item ${config.name === state.name ? "active" : ""}" type="button" data-name="${esc(config.name)}">
              <span class="config-dot ${config.group}"></span>
              <span class="config-meta"><span class="config-name">${esc(config.sidebarLabel || config.label)}</span><span class="config-file">${esc(config.file)}</span></span>
            </button>`,
          )
          .join("")}</div>
      </section>`
    })
    .join("")
  $("#config-groups").innerHTML = html || `<div class="sidebar-empty">${emptyIcon()}<p>${query ? "没有匹配的配置" : "没有可编辑的配置"}</p></div>`
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
  $("#config-title").textContent = config?.label || "配置"
  $("#config-path").textContent = config?.file || ""
  document.title = `${config?.label || "配置"} · Yunzai`
  for (const button of document.querySelectorAll("[data-mode]")) button.classList.toggle("active", button.dataset.mode === state.mode)
  const sourceButton = document.querySelector('.segmented [data-mode="yaml"]')
  if (sourceButton) sourceButton.textContent = config?.special === "miao-help" ? "源码" : "YAML"
}

function renderContent() {
  if (!state.data) {
    content().innerHTML = `<div class="empty">正在连接…</div>`
    return
  }
  if (!state.config) {
    content().innerHTML = `<div class="empty">${emptyIcon()}<h2>没有配置文件</h2><p>在 config/default_config 或 config 下添加 YAML 后刷新。</p></div>`
    return
  }
  const note = state.config.special === "miao-help" ? "" : state.config.file?.startsWith("plugins/") || state.config.file?.startsWith("data/") ? `<div class="card note-card"><p>插件更新可能覆盖此文件；修改后可能需要重启。</p></div>` : ""
  if (state.mode === "yaml") {
    content().innerHTML = note + renderRaw()
    content().classList.remove("enter")
    void content().offsetWidth
    content().classList.add("enter")
    return
  }
  content().innerHTML = note + renderForm()
  content().classList.remove("enter")
  void content().offsetWidth
  content().classList.add("enter")
}

function renderMiaoHelpForm() {
  const config = state.config
  const helpCfg = config.effective.helpCfg || {}
  const groups = currentValue("helpList", config.effective.helpList) || []
  const warning = config.warning?.length ? `<div class="card note-card"><p>${esc(config.warning.join("；"))}</p></div>` : ""
  return `${warning}<div class="card note-card"><p>首次保存会生成 help.js；源码模式可保留注释。</p></div>${renderCard("帮助设置", "", renderObjectRows(helpCfg, ["helpCfg"]))}${renderCard("帮助内容", "图标数字对应 miao 图标表。", renderMiaoGroups(groups))}`
}

function renderMiaoGroups(groups) {
  const items = groups
    .map((group, gi) => {
      const list = Array.isArray(group.list) ? group.list : []
      const open = state.openHelpGroup === gi
      return `<details class="array-item" ${open ? "open" : ""}><summary class="array-item-head"><span class="array-item-title">${esc(group.group || `分组 ${gi + 1}`)}</span><span class="array-item-hint">${list.length} 项</span><span class="array-chevron"></span></summary><div class="array-item-body"><div class="array-item-tools"><button class="inline-button" type="button" data-action="remove-help-group" data-index="${gi}">删除分组</button></div>${renderHelpField(gi, null, "group", "分组名称", group.group, "text")}${renderHelpField(gi, null, "desc", "说明", group.desc, "text")}${renderHelpField(gi, null, "auth", "权限（留空或 master）", group.auth, "text")}<div class="array-subgroup"><h4>帮助项<span class="type-badge">对象列表</span></h4><div class="help-item-head"><span>图标</span><span>命令</span><span>说明</span><span></span></div>${list.map((item, ii) => `<div class="help-item-row"><input class="input mono" type="number" data-help-group="${gi}" data-help-item="${ii}" data-help-field="icon" value="${esc(item.icon ?? 0)}" /><input class="input" data-help-group="${gi}" data-help-item="${ii}" data-help-field="title" value="${esc(item.title || "")}" /><input class="input" data-help-group="${gi}" data-help-item="${ii}" data-help-field="desc" value="${esc(item.desc || "")}" /><button class="inline-button" type="button" data-action="remove-help-item" data-group="${gi}" data-item="${ii}">删除</button></div>`).join("")}<button class="inline-button add-item" type="button" data-action="add-help-item" data-group="${gi}">+ 添加帮助项</button></div></div></details>`
    })
    .join("")
  return `<div class="array-editor">${items}<button class="inline-button add-item" type="button" data-action="add-help-group">+ 添加分组</button></div>`
}

function renderHelpField(groupIndex, itemIndex, field, label, value, type) {
  const id = `help-${groupIndex}-${itemIndex ?? "g"}-${field}`
  const extra = itemIndex == null ? "" : ` data-help-item="${itemIndex}"`
  const control = type === "number" ? `<input class="input mono" id="${id}" type="number" data-help-group="${groupIndex}"${extra} data-help-field="${field}" value="${esc(value ?? 0)}" />` : `<input class="input" id="${id}" data-help-group="${groupIndex}"${extra} data-help-field="${field}" value="${esc(value ?? "")}" />`
  return `<div class="field array-field"><div class="field-info"><label for="${id}">${esc(label)}<span class="type-badge">${type === "number" ? "数字" : "文本"}</span></label></div><div class="field-control">${control}</div></div>`
}

function renderForm() {
  const config = state.config
  if (config.special === "miao-help") return renderMiaoHelpForm()
  const effective = config.effective || {}
  const entries = Object.entries(effective)
  if (!entries.length) {
    return `<div class="card"><div class="empty">${emptyIcon()}<h2>这个配置还没有内容</h2><p>切换到 YAML 模式可以直接写入。</p></div></div>`
  }
  const scalar = []
  const objects = []
  for (const [key, value] of entries) {
    if (isObj(value)) objects.push([key, value])
    else scalar.push([key, value])
  }
  const parts = []
  if (scalar.length) parts.push(renderCard("常规", "", scalar.map(([key, value]) => renderRow([key], key, value)).join("")))
  for (const [key, value] of objects) parts.push(renderObjectCard([key], key, value))
  return parts.join("")
}

function renderObjectCard(prefix, key, value) {
  const path = prefix.join(".")
  const comment = state.config.comments[path] || ""
  const label = shortLabel(comment, key).replace(/开关$/, "").trim() || KEY_LABELS[key] || humanize(key)
  return renderCard(label, comment && comment !== label ? comment : "", renderObjectRows(value, prefix))
}

function renderObjectRows(object, prefix) {
  const rows = []
  for (const [key, value] of Object.entries(object)) {
    if (isObj(value)) {
      const path = [...prefix, key].join(".")
      const comment = state.config.comments[path] || ""
      rows.push(`<div class="subgroup"><div class="subgroup-head"><h3>${esc(shortLabel(comment, key))}</h3>${comment ? `<p>${esc(comment)}</p>` : ""}</div>${renderObjectRows(value, [...prefix, key])}</div>`)
    } else {
      rows.push(renderRow([...prefix, key], key, value))
    }
  }
  return rows.join("")
}

function renderCard(title, hint, rows) {
  return `<section class="card"><header class="card-head"><h2>${esc(title)}</h2>${hint ? `<p>${esc(hint)}</p>` : ""}</header><div class="card-body">${rows}</div></section>`
}

function renderRow(prefix, key, value) {
  const path = prefix.join(".")
  const info = state.config.types[path] || {}
  const comment = state.config.comments[path] || ""
  const label = shortLabel(comment, key)
  const current = currentValue(path, value)
  const kind = valueKind(current, key, info)
  const id = `f-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`
  const hint = comment && comment !== label ? comment : ""
  return `<div class="field" data-field="${esc(path)}">
    <div class="field-info"><label for="${id}">${esc(label)}<span class="type-badge">${kind}</span></label><span class="field-key">${esc(path)}</span>${hint ? `<p>${esc(hint)}</p>` : ""}</div>
    <div class="field-control">${renderControl(id, path, key, current, info)}</div>
  </div>`
}

function isSecret(key) {
  return /key|token|secret|password|passwd|authorization|cookie/i.test(key)
}

function isLongText(key, value) {
  return typeof value === "string" && (value.includes("\n") || value.length > 120 || /prompt|description|content|comment|help|reply|message|template|script|proxy/i.test(key))
}

function listLike(key) {
  return /(keys?|list|whitelist|blacklist|prefix|filter|ids?)$/i.test(key)
}

function renderControl(id, path, key, value, info, context = null) {
  const common = context ? `data-array-path="${esc(context.arrayPath)}" data-item-index="${context.itemIndex}" data-item-path="${esc(context.itemPath)}"` : `data-path="${esc(path)}"`
  const secret = isSecret(key)
  if (typeof value === "boolean") {
    return `<label class="switch"><input id="${id}" type="checkbox" ${common} data-kind="bool" ${value ? "checked" : ""}/><span class="switch-track"><span class="switch-knob"></span></span></label>`
  }
  if (typeof value === "number") {
    return `<input class="input mono" id="${id}" type="number" ${common} data-kind="number" value="${esc(value)}" step="${Number.isInteger(value) ? "1" : "any"}" />`
  }
  if (typeof value === "string") {
    if (isLongText(key, value) && !secret) {
      return `<textarea class="input textarea mono" id="${id}" ${common} data-kind="string" rows="${Math.min(12, Math.max(4, String(value).split("\n").length + 1))}">${esc(value)}</textarea>`
    }
    const type = secret ? "password" : "text"
    const reveal = secret ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""
    return `<div class="control-row"><input class="input ${secret ? "secret-input" : ""}" id="${id}" type="${type}" ${common} data-kind="string" value="${esc(value)}" spellcheck="false" />${reveal}</div>`
  }
  if (Array.isArray(value)) {
    const itemType = info.itemType || (value.length ? typeof value[0] : "")
    if (!context && itemType === "object" && value.length && value.every(isObj)) return renderObjectArray(path, key, value)
    const asJson = itemType === "object" || itemType === "array" || itemType === "mixed" || (!value.length && !listLike(key))
    if (asJson) {
      const jsonText = JSON.stringify(value, null, 2)
      const sensitive = /"(?:api_?keys?|keys?|token|secret|password|authorization|cookie)"\s*:/i.test(jsonText)
      return `<details class="json-control"><summary class="json-summary"><span>JSON · ${value.length} 项</span><span class="json-summary-hint">${sensitive ? "含敏感字段，展开编辑" : "展开编辑"}</span></summary><textarea class="input textarea mono ${sensitive ? "secret" : ""}" id="${id}" ${common} data-kind="json" rows="${Math.min(16, Math.max(6, jsonText.split("\n").length))}" spellcheck="false">${esc(jsonText)}</textarea><div class="json-tools"><span>JSON 数组</span><span class="json-actions">${sensitive ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""}<button class="inline-button" type="button" data-action="format-json" data-target="${id}">格式化</button></span></div></details>`
    }
    const text = value.join("\n")
    return `<div><div class="control-row"><textarea class="input textarea mono ${secret ? "secret" : ""}" id="${id}" ${common} data-kind="list" data-item-type="${esc(itemType || "string")}" rows="${Math.min(10, Math.max(3, value.length || 3))}" spellcheck="false">${esc(text)}</textarea>${secret ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""}</div><p class="control-hint">列表：每行一项</p></div>`
  }
  if (value === null || value === undefined) {
    if (info.type === "list") {
      return `<div class="control-row"><textarea class="input textarea mono ${secret ? "secret" : ""}" id="${id}" ${common} data-kind="list" data-item-type="string" rows="3" placeholder="一行一个"></textarea>${secret ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""}</div>`
    }
    const type = secret ? "password" : "text"
    const reveal = secret ? `<button class="inline-button" type="button" data-action="reveal" data-target="${id}">显示</button>` : ""
    return `<div class="control-row"><input class="input" id="${id}" type="${type}" ${common} data-kind="any" value="" placeholder="空值" spellcheck="false" />${reveal}</div><p class="control-hint">空值；可填字符串，或 JSON 数组/对象。</p>`
  }
  return `<input class="input" id="${id}" ${common} data-kind="string" value="${esc(value)}" />`
}

function itemHint(item) {
  return String(item?.model || item?.type || item?.command || item?.url || "")
}

function renderObjectArray(path, key, value) {
  const base = `arr-${path.replace(/[^A-Za-z0-9_-]/g, "-")}`
  const items = value
    .map((item, index) => {
      const open = state.openItem?.path === path && state.openItem.index === index
      return `<details class="array-item" ${open ? "open" : ""}><summary class="array-item-head"><span class="array-item-title">${esc(itemLabel(item, index))}</span><span class="array-item-hint">${esc(itemHint(item))}</span><span class="array-chevron"></span></summary><div class="array-item-body"><div class="array-item-tools"><button class="inline-button" type="button" data-action="remove-array-item" data-array-path="${esc(path)}" data-index="${index}">删除</button></div>${renderArrayItemFields(item, path, index, "")}</div></details>`
    })
    .join("")
  return `<div class="array-editor">${items}<button class="inline-button add-item" type="button" data-action="add-array-item" data-array-path="${esc(path)}">+ 添加一项</button><details class="array-json"><summary>高级 JSON</summary><textarea class="input textarea mono" id="${base}-json" data-path="${esc(path)}" data-kind="json" rows="${Math.min(16, Math.max(6, JSON.stringify(value, null, 2).split("\n").length))}" spellcheck="false">${esc(JSON.stringify(value, null, 2))}</textarea></details></div>`
}

function renderArrayItemFields(item, arrayPath, index, itemPath) {
  if (!isObj(item)) return renderArrayField(arrayPath, index, itemPath, "", item)
  const parts = []
  for (const [key, value] of Object.entries(item)) {
    const full = itemPath ? `${itemPath}.${key}` : key
    if (isObj(value)) parts.push(`<div class="array-subgroup"><h4>${esc(shortLabel("", key))}</h4>${renderArrayItemFields(value, arrayPath, index, full)}</div>`)
    else parts.push(renderArrayField(arrayPath, index, itemPath, key, value))
  }
  return parts.join("")
}

function renderArrayField(arrayPath, index, itemPath, key, value) {
  const full = itemPath ? `${itemPath}.${key}` : key
  const id = `af-${arrayPath.replace(/[^A-Za-z0-9_-]/g, "-")}-${index}-${full.replace(/[^A-Za-z0-9_-]/g, "-")}`
  const info = infoForValue(value)
  const kind = valueKind(value, key, info)
  const label = key ? shortLabel("", key) : `第 ${index + 1} 项`
  const context = { arrayPath, itemIndex: index, itemPath: full }
  return `<div class="field array-field"><div class="field-info"><label for="${id}">${esc(label)}<span class="type-badge">${kind}</span></label><span class="field-key">${esc(full)}</span></div><div class="field-control">${renderControl(id, "", key, value, info, context)}</div></div>`
}

function readControl(element) {
  const kind = element.dataset.kind
  if (kind === "bool") return { ok: true, value: element.checked }
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

function handleEdit(element) {
  const result = readControl(element)
  element.classList.toggle("invalid", !result.ok)
  if (!result.ok) return
  if (element.dataset.arrayPath) {
    const arrayPath = element.dataset.arrayPath
    const index = Number(element.dataset.itemIndex)
    const itemPath = element.dataset.itemPath || ""
    const array = clone(state.dirty.get(arrayPath) ?? getPath(state.config.effective, arrayPath) ?? [])
    if (!Array.isArray(array) || !isObj(array[index])) return
    if (itemPath) setPath(array[index], itemPath, result.value)
    else array[index] = result.value
    setDirty(arrayPath, array)
    return
  }
  setDirty(element.dataset.path, result.value)
}

function handleHelpEdit(element) {
  const gi = Number(element.dataset.helpGroup)
  const field = element.dataset.helpField
  const hasItem = element.dataset.helpItem != null
  const ii = hasItem ? Number(element.dataset.helpItem) : null
  const groups = clone(currentValue("helpList", state.config.effective.helpList) || [])
  if (!groups[gi]) return
  if (hasItem) {
    if (!Array.isArray(groups[gi].list) || !groups[gi].list[ii]) return
    groups[gi].list[ii][field] = field === "icon" ? Number(element.value) || 0 : element.value
  } else if (field === "auth" && !element.value.trim()) delete groups[gi].auth
  else groups[gi][field] = element.value
  setDirty("helpList", groups)
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

function arrayDraft(path) {
  return clone(state.dirty.get(path) ?? getPath(state.config.effective, path) ?? [])
}

function addArrayItem(path) {
  const array = arrayDraft(path)
  if (!Array.isArray(array)) return
  array.push(array.length && isObj(array[0]) ? emptyLike(array[0]) : {})
  state.openItem = { path, index: array.length - 1 }
  setDirty(path, array)
  renderContent()
}

function removeArrayItem(path, index) {
  const array = arrayDraft(path)
  if (!Array.isArray(array)) return
  array.splice(index, 1)
  setDirty(path, array)
  renderContent()
}

function addHelpGroup() {
  const groups = clone(currentValue("helpList", state.config.effective.helpList) || [])
  groups.push({ group: "新分组", list: [] })
  state.openHelpGroup = groups.length - 1
  setDirty("helpList", groups)
  renderContent()
}

function removeHelpGroup(index) {
  const groups = clone(currentValue("helpList", state.config.effective.helpList) || [])
  groups.splice(index, 1)
  state.openHelpGroup = null
  setDirty("helpList", groups)
  renderContent()
}

function addHelpItem(groupIndex) {
  const groups = clone(currentValue("helpList", state.config.effective.helpList) || [])
  if (!groups[groupIndex]) return
  if (!Array.isArray(groups[groupIndex].list)) groups[groupIndex].list = []
  groups[groupIndex].list.push({ icon: 0, title: "", desc: "" })
  state.openHelpGroup = groupIndex
  setDirty("helpList", groups)
  renderContent()
}

function removeHelpItem(groupIndex, itemIndex) {
  const groups = clone(currentValue("helpList", state.config.effective.helpList) || [])
  if (!Array.isArray(groups[groupIndex]?.list)) return
  groups[groupIndex].list.splice(itemIndex, 1)
  setDirty("helpList", groups)
  renderContent()
}

async function save() {
  if (!state.config) return
  if (state.mode === "yaml") return saveRaw()
  if (!state.dirty.size) return toast("没有需要保存的修改")
  const invalid = content().querySelector("[data-kind].invalid")
  if (invalid) {
    invalid.focus()
    return toast("请先修正高亮的字段", "error")
  }
  $("#save").disabled = true
  $("#save").textContent = "保存中…"
  try {
    const result = await api("/config", { method: "PUT", body: { name: state.name, patch: buildPatch() } })
    state.config = result.config
    state.dirty.clear()
    renderAll()
    toast("已保存")
  } catch (err) {
    toast(err.message, "error")
  } finally {
    $("#save").textContent = "保存"
    renderDirty()
  }
}

async function saveRaw() {
  if (!state.raw || !state.rawDirty) return toast("没有需要保存的修改")
  $("#save").disabled = true
  $("#save").textContent = "保存中…"
  try {
    const result = await api("/raw", { method: "PUT", body: { name: state.name, content: $("#raw-editor").value } })
    state.config = result.config
    await loadRaw(state.name)
    state.rawDirty = false
    renderAll()
    toast("已保存")
  } catch (err) {
    toast(err.message, "error")
  } finally {
    $("#save").textContent = "保存"
    renderDirty()
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

async function switchConfig(name) {
  if (name === state.name) return
  if (isDirty() && !(await confirmDialog("放弃未保存的修改？", "当前配置有未保存的修改，切换后会丢失。", "放弃修改"))) return
  await loadConfig(name)
}

async function switchMode(mode) {
  if (mode === state.mode) return
  if (isDirty() && !(await confirmDialog("放弃未保存的修改？", "切换编辑模式会丢弃当前未保存的修改。", "放弃修改"))) return
  state.mode = mode
  state.dirty.clear()
  state.rawDirty = false
  if (mode === "yaml" && state.raw?.name !== state.name) await loadRaw(state.name)
  renderAll()
}

function confirmDialog(title, message, label) {
  return new Promise(resolve => {
    state.dialogResolve = resolve
    $("#dialog").hidden = false
    $("#dialog").innerHTML = `<div class="dialog-card"><div class="dialog-body"><h2>${esc(title)}</h2><p>${esc(message)}</p></div><div class="dialog-actions"><button class="button" type="button" data-dialog="cancel">取消</button><button class="button primary" type="button" data-dialog="ok">${esc(label)}</button></div></div>`
  })
}

function closeDialog(result) {
  $("#dialog").hidden = true
  $("#dialog").innerHTML = ""
  const resolve = state.dialogResolve
  state.dialogResolve = null
  resolve?.(result)
}

function bindEvents() {
  $("#config-search").addEventListener("input", event => {
    state.search = event.target.value
    renderSidebar()
  })

  $("#config-groups").addEventListener("click", event => {
    const toggle = event.target.closest("[data-group]")
    if (toggle) {
      const id = toggle.dataset.group
      if (state.expanded.has(id)) state.expanded.delete(id)
      else state.expanded.add(id)
      renderSidebar()
      return
    }
    const item = event.target.closest("[data-name]")
    if (item) switchConfig(item.dataset.name)
  })

  document.addEventListener("click", event => {
    if (event.target.closest("[data-theme-toggle]")) toggleTheme()
  })

  document.querySelector(".segmented").addEventListener("click", event => {
    const button = event.target.closest("[data-mode]")
    if (button) switchMode(button.dataset.mode)
  })

  $("#save").addEventListener("click", save)

  content().addEventListener("input", event => {
    if (event.target.id === "raw-editor") {
      state.rawDirty = event.target.value !== (state.raw?.content || "")
      renderDirty()
      return
    }
    if (event.target.dataset.helpGroup != null) {
      handleHelpEdit(event.target)
      return
    }
    if (event.target.matches("[data-path], [data-array-path]")) handleEdit(event.target)
  })

  content().addEventListener(
    "toggle",
    event => {
      if (!event.target.matches("details.array-json") || !event.target.open) return
      const area = event.target.querySelector("textarea[data-path]")
      const path = area?.dataset.path
      if (path) area.value = JSON.stringify(currentValue(path, getPath(state.config.effective, path) ?? []), null, 2)
    },
    true,
  )

  content().addEventListener("click", event => {
    const button = event.target.closest("[data-action]")
    if (!button) return
    if (button.dataset.action === "reveal") revealSecret(button)
    else if (button.dataset.action === "format-json") formatJson(button)
    else if (button.dataset.action === "add-array-item") addArrayItem(button.dataset.arrayPath)
    else if (button.dataset.action === "remove-array-item") removeArrayItem(button.dataset.arrayPath, Number(button.dataset.index))
    else if (button.dataset.action === "add-help-group") addHelpGroup()
    else if (button.dataset.action === "remove-help-group") removeHelpGroup(Number(button.dataset.index))
    else if (button.dataset.action === "add-help-item") addHelpItem(Number(button.dataset.group))
    else if (button.dataset.action === "remove-help-item") removeHelpItem(Number(button.dataset.group), Number(button.dataset.item))
    else if (button.dataset.action === "reload-raw") {
      loadRaw(state.name).then(() => {
        state.rawDirty = false
        renderAll()
      })
    }
  })

  $("#dialog").addEventListener("click", event => {
    if (event.target.id === "dialog") closeDialog(false)
    const button = event.target.closest("[data-dialog]")
    if (button) closeDialog(button.dataset.dialog === "ok")
  })

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !$("#dialog").hidden) closeDialog(false)
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault()
      save()
    }
  })

  window.addEventListener("beforeunload", event => {
    if (!isDirty()) return
    event.preventDefault()
    event.returnValue = ""
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
