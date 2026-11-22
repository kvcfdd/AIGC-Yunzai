import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SkillStore } from "../../lib/ai_core/tools/skills/index.js"

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-skills-"))
  await fs.mkdir(path.join(root, "demo", "scripts"), { recursive: true })
  await fs.mkdir(path.join(root, "demo", "references"), { recursive: true })
  await fs.writeFile(path.join(root, "demo", "SKILL.md"), `---\nname: demo\ndescription: 演示技能\ntools: web_search, web_fetch\n---\n\n# demo\n\n正文内容\n`)
  await fs.writeFile(path.join(root, "demo", "scripts", "run.js"), "console.log(1)\n")
  await fs.writeFile(path.join(root, "demo", "references", "guide.md"), "# guide\n")
  await fs.mkdir(path.join(root, "no-skill"), { recursive: true })
  return root
}

test("skills: 列表解析 frontmatter，跳过无 SKILL.md 目录", async () => {
  const root = await makeRoot()
  try {
    const list = await new SkillStore(root).list()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, "demo")
    assert.equal(list[0].description, "演示技能")
    assert.deepEqual(list[0].tools, ["web_search", "web_fetch"])
    assert.deepEqual(Object.keys(list[0]).sort(), ["description", "dir", "file", "name", "source", "tools"])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("skills: get 返回正文与技能目录文件树", async () => {
  const root = await makeRoot()
  try {
    const skill = await new SkillStore(root).get("demo")
    assert.match(skill.content, /正文内容/)
    assert.doesNotMatch(skill.content, /^---/)
    assert.match(skill.files, /├── references\//)
    assert.match(skill.files, /guide\.md/)
    assert.match(skill.files, /├── scripts\//)
    assert.match(skill.files, /run\.js/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("skills: 根目录不存在时为空", async () => {
  const store = new SkillStore(path.join(os.tmpdir(), `aigc-missing-${Date.now()}`))
  assert.deepEqual(await store.list(), [])
  assert.equal(await store.get("nope"), null)
})

test("skills: 后面的根覆盖同名技能", async () => {
  const builtin = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-skills-builtin-"))
  const user = await fs.mkdtemp(path.join(os.tmpdir(), "aigc-skills-user-"))
  try {
    await fs.mkdir(path.join(builtin, "shared"), { recursive: true })
    await fs.mkdir(path.join(user, "shared"), { recursive: true })
    await fs.writeFile(path.join(builtin, "shared", "SKILL.md"), "---\nname: shared\ndescription: builtin\n---\n\nbuiltin body\n")
    await fs.writeFile(path.join(user, "shared", "SKILL.md"), "---\nname: shared\ndescription: user\n---\n\nuser body\n")

    const store = new SkillStore([builtin, user])
    const list = await store.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].description, "user")
    const skill = await store.get("shared")
    assert.match(skill.content, /user body/)
  } finally {
    await fs.rm(builtin, { recursive: true, force: true })
    await fs.rm(user, { recursive: true, force: true })
  }
})

test("skills: 技能列表按来源排序并使用 XML 条目", async () => {
  const { skillsListBlock } = await import("../../lib/ai_core/tools/skills/index.js")
  const list = [
    { name: "user-skill", description: "用户技能", source: "user" },
    { name: "plugin-skill", description: "插件技能", source: "plugin:demo" },
    { name: "builtin-skill", description: "内置 <技能> & 说明", source: "builtin" },
  ]
  const block = skillsListBlock(list)
  assert.match(block, /<skill name="builtin-skill">内置 &lt;技能&gt; &amp; 说明<\/skill>/)
  assert.match(block, /<skill name="plugin-skill">插件技能<\/skill>/)
  assert.match(block, /<skill name="user-skill">用户技能<\/skill>/)
  assert.ok(block.indexOf('name="builtin-skill"') < block.indexOf('name="plugin-skill"'))
  assert.ok(block.indexOf('name="plugin-skill"') < block.indexOf('name="user-skill"'))
})

test("skills: 内置 skills 目录包含作者技能", async () => {
  const store = new SkillStore("skills")
  const list = await store.list()
  assert.deepEqual(list.map(s => s.name).sort(), ["skill-authoring"])

  const detail = await store.get("skill-authoring")
  assert.match(detail.content, /Skill authoring/)
  assert.match(detail.content, /Frontmatter/)
})
