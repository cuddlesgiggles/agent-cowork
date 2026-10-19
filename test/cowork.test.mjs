import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { agent } from "../cowork.agent.js"
import { backupNeeded, entry, opt, plan, provider, unplan, PROVIDER_ID } from "../seed.mjs"

const SEED = fileURLToPath(new URL("../seed.mjs", import.meta.url))

const GLM = {
  id: "group/auto-glm-5-3-flash",
  display_name: "GLM-5.3-Flash",
  magpie_label: "GLM-5.3-Flash · routing group",
  context_length: 1000000,
  modalities: { input: ["text", "image"] },
}
const TEXT = { id: "workbuddy/deepseek-v4.1-flash", display_name: "DeepSeek V4.1 Flash", context_length: 262144, modalities: { input: ["text"] } }
const V1 = "http://127.0.0.1:3425/v1"

test("Cowork is pointed at the field it starts a session on", () => {
  assert.equal(agent.id, "cowork")
  assert.equal(agent.config, "~/.codely/ide-settings.json")
  assert.equal(agent.format, "json")
  assert.equal(agent.model, "defaultChatModelTitle")
  assert.equal(agent.dir, "~/.codely")
})

test("carries the vendor's own icon, in the agent and in the package", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  assert.ok(agent.icon.startsWith("data:image/png;base64,"), "a PNG inlined, so it renders before the repo exists")
  assert.equal(pkg.magpie.icon, agent.icon)
  assert.ok(pkg.files.includes("icon.png"), "the same icon shipped as a file")
})

test("a catalog model becomes the shape Cowork's own store uses", () => {
  assert.deepEqual(entry(GLM), {
    id: `${PROVIDER_ID}:group/auto-glm-5-3-flash`,
    model: "group/auto-glm-5-3-flash",
    providerId: PROVIDER_ID,
    displayName: "GLM-5.3-Flash · routing group",
    authType: "openai",
    roles: ["model"],
    wireApi: "chat",
    contextLength: 1000000,
    supportsMultimodal: true,
  })
  assert.equal(entry(TEXT).supportsMultimodal, false)
  assert.equal(entry(TEXT).displayName, "DeepSeek V4.1 Flash")
})

test("the store keeps its own models and gets one entry per new catalog model", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", name: "the user's own", baseUrl: "https://example.test/v1" }],
    customModels: [{ id: "custom-provider:mine", model: "mine", providerId: "custom-provider" }],
    migratedFromOldFormat: true,
  }
  const { next, added } = plan(store, [GLM, TEXT], V1)
  assert.equal(next.migratedFromOldFormat, true)
  assert.equal(next.customModels[0].id, "custom-provider:mine")
  assert.deepEqual(added, [GLM.id, TEXT.id])
  assert.ok(Array.isArray(next.customModels))
  assert.equal(next.customModels.length, 3)
  assert.equal(next.customModelProviders.length, 2)
  assert.deepEqual(next.customModelProviders[1], provider(V1))
})

test("a model Cowork already has is not added twice, by any provider", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", name: "x", baseUrl: V1 }],
    customModels: [{ id: "custom-provider:glm", model: GLM.id, providerId: "custom-provider" }],
  }
  const { next, added } = plan(store, [GLM], V1)
  assert.deepEqual(added, [])
  assert.equal(next.customModels.length, 1)
})

test("a magpie model magpie no longer offers is dropped, and nothing else moves", () => {
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, name: "magpie", baseUrl: V1, apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [
      { id: "custom-provider:mine", model: "mine", providerId: "custom-provider" },
      { id: `${PROVIDER_ID}:gone`, model: "gone", providerId: PROVIDER_ID },
      { id: `${PROVIDER_ID}:${TEXT.id}`, model: TEXT.id, providerId: PROVIDER_ID },
    ],
  }
  const { next, added, pruned } = plan(store, [TEXT], V1)
  assert.deepEqual(pruned, ["gone"])
  assert.deepEqual(added, [])
  assert.deepEqual(next.customModels.map((m) => m.id), ["custom-provider:mine", `${PROVIDER_ID}:${TEXT.id}`])
})

test("a store Cowork has not filled in yet still comes out with lists", () => {
  const { next } = plan({ customModels: [], customModelProviders: [] }, [GLM], V1)
  assert.ok(Array.isArray(next.customModels))
  assert.ok(Array.isArray(next.customModelProviders))
  assert.equal(next.customModels.length, 1)
})

test("seeding twice writes nothing the second time", () => {
  const once = plan({}, [GLM, TEXT], V1)
  assert.equal(once.changed, true)
  const twice = plan(once.next, [GLM, TEXT], V1)
  assert.equal(twice.changed, false)
  assert.deepEqual(twice.added, [])
  assert.deepEqual(twice.pruned, [])
})

test("plan does not edit the store it was given", () => {
  const store = { customModelProviders: [], customModels: [{ id: "a", model: "a", providerId: "custom-provider" }] }
  const before = JSON.stringify(store)
  plan(store, [GLM], V1)
  assert.equal(JSON.stringify(store), before)
})

test("a flag with nothing after it is not read as its value", () => {
  assert.equal(opt(["--check"], "gateway", V1), V1)
  assert.equal(opt(["--gateway", "http://127.0.0.1:9999", "--check"], "gateway", V1), "http://127.0.0.1:9999")
  assert.equal(opt(["--gateway", "--check"], "gateway", V1), V1)
  assert.equal(opt([], "store", "~/.codely/settings.json"), "~/.codely/settings.json")
})

const OWN = { id: "custom-provider:mine", model: "mine", providerId: "custom-provider" }
const OWN_STORE = {
  customModelProviders: [{ id: "custom-provider", name: "the user's own", baseUrl: "https://example.test/v1" }],
  customModels: [OWN],
  migratedFromOldFormat: true,
}

test("what the package put in, it can take out again", () => {
  const seeded = plan(OWN_STORE, [GLM, TEXT], V1).next
  assert.equal(seeded.customModels.length, 3)
  const { next, removed, changed } = unplan(seeded)
  assert.deepEqual(removed, [GLM.id, TEXT.id])
  assert.equal(changed, true)
  assert.deepEqual(next.customModels, OWN_STORE.customModels)
  assert.deepEqual(next.customModelProviders, OWN_STORE.customModelProviders)
  assert.equal(next.migratedFromOldFormat, true)
})

test("taking magpie out of a store it never touched changes nothing", () => {
  const { next, removed, changed } = unplan(OWN_STORE)
  assert.equal(changed, false)
  assert.deepEqual(removed, [])
  assert.deepEqual(next.customModels, OWN_STORE.customModels)
})

test("the backup is only ever taken from a store magpie has not written yet", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-backup-"))
  try {
    const store = join(dir, "settings.json"), bak = `${store}.pre-magpie`
    assert.equal(backupNeeded(store, bak), false, "no store, nothing to keep")
    writeFileSync(store, "{}")
    assert.equal(backupNeeded(store, bak), true, "first write keeps the original")
    writeFileSync(bak, "{}")
    assert.equal(backupNeeded(store, bak), false, "a second write must not replace the original with a seeded store")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("--remove on a real store file leaves the user's own models and keeps the original", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-remove-"))
  try {
    const store = join(dir, "settings.json")
    writeFileSync(store, JSON.stringify(plan(OWN_STORE, [GLM, TEXT], V1).next))
    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    const after = JSON.parse(readFileSync(store, "utf8"))
    assert.deepEqual(after.customModels.map((m) => m.id), ["custom-provider:mine"])
    assert.deepEqual(after.customModelProviders.map((p) => p.id), ["custom-provider"])
    assert.equal(existsSync(`${store}.pre-magpie`), true)
    const again = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(again.status, 0)
    assert.match(again.stdout, /nothing of magpie's to remove/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
