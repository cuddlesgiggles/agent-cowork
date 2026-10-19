import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { agent } from "../cowork.agent.js"
import { adoptSeeded, backupNeeded, entry, loadSeeded, opt, plan, provider, seedFile, unplan, PROVIDER_ID } from "../seed.mjs"

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
    displayName: "group/auto-glm-5-3-flash",
    authType: "openai",
    roles: ["model"],
    wireApi: "chat",
    contextLength: 1000000,
    supportsMultimodal: true,
  })
  assert.equal(entry(TEXT).supportsMultimodal, false)
  assert.equal(entry(GLM).displayName, entry(GLM).model, "the picker title is the one string magpie can write")
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

test("an entry already pointed at magpie is relabelled to its model id", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", name: "magpie", baseUrl: V1 }],
    customModels: [{ id: `custom-provider:${GLM.id}`, model: GLM.id, providerId: "custom-provider", displayName: "GLM-5.3-Flash · routing group" }],
  }
  const { next, added, relabeled, changed } = plan(store, [GLM], V1)
  assert.deepEqual(added, [], "no duplicate entry for a model Cowork can already reach")
  assert.equal(relabeled, 1)
  assert.equal(changed, true)
  assert.equal(next.customModels[0].displayName, GLM.id)
  assert.equal(next.customModels[0].id, `custom-provider:${GLM.id}`, "its id stays, sessions may name it")
  const again = plan(next, [GLM], V1)
  assert.equal(again.relabeled, 0)
  assert.equal(again.changed, false)
})

test("a model the user wired to their own endpoint keeps its own name", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", baseUrl: "https://their.own.test/v1" }],
    customModels: [{ id: `custom-provider:${GLM.id}`, model: GLM.id, providerId: "custom-provider", displayName: "mine" }],
  }
  const { next, relabeled, changed } = plan(store, [GLM], V1)
  assert.equal(relabeled, 0)
  assert.equal(changed, true, "magpie's own provider is still missing")
  assert.equal(next.customModels[0].displayName, "mine")
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
  const seeded = new Set([`${PROVIDER_ID}:gone`, `${PROVIDER_ID}:${TEXT.id}`])
  const { next, added, pruned } = plan(store, [TEXT], V1, seeded)
  assert.deepEqual(pruned, [`${PROVIDER_ID}:gone`])
  assert.deepEqual(added, [])
  assert.deepEqual(next.customModels.map((m) => m.id), ["custom-provider:mine", `${PROVIDER_ID}:${TEXT.id}`])
  assert.deepEqual(seeded.has(`${PROVIDER_ID}:gone`), true, "the set handed in is not edited")
})

test("a model the user added under magpie's own provider survives a shorter catalog", () => {
  const own = { id: "magpie:my-own", model: "my-own", providerId: PROVIDER_ID, displayName: "my-own" }
  const store = {
    customModelProviders: [{ id: PROVIDER_ID, name: "magpie", baseUrl: V1, apiKey: "magpie-cowork", authType: "openai" }],
    customModels: [own, { id: `${PROVIDER_ID}:${TEXT.id}`, model: TEXT.id, providerId: PROVIDER_ID, displayName: TEXT.id }],
  }
  const seeded = new Set([`${PROVIDER_ID}:${TEXT.id}`])
  const { next, pruned, changed } = plan(store, [], V1, seeded)
  assert.deepEqual(pruned, [`${PROVIDER_ID}:${TEXT.id}`], "what we wrote and magpie dropped")
  assert.ok(next.customModels.some((m) => m.id === "magpie:my-own"), "what they added under it stays")
  assert.equal(changed, true)
  const out = unplan(next, seeded)
  assert.ok(out.next.customModels.some((m) => m.id === "magpie:my-own"))
  assert.ok(out.next.customModelProviders.some((p) => p.id === PROVIDER_ID), "the provider stays while their model still uses it")
  assert.deepEqual(out.leftBehind, ["magpie:my-own"])
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
  assert.deepEqual(once.seeded, [`${PROVIDER_ID}:${GLM.id}`, `${PROVIDER_ID}:${TEXT.id}`])
  const twice = plan(once.next, [GLM, TEXT], V1, new Set(once.seeded))
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
  const p = plan(OWN_STORE, [GLM, TEXT], V1)
  assert.equal(p.next.customModels.length, 3)
  const { next, removed, changed } = unplan(p.next, new Set(p.seeded))
  assert.deepEqual(removed, [`${PROVIDER_ID}:${GLM.id}`, `${PROVIDER_ID}:${TEXT.id}`])
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

test("--remove takes out what the sidecar recorded and nothing the user added", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-remove-"))
  try {
    const store = join(dir, "settings.json")
    const p = plan(OWN_STORE, [GLM, TEXT], V1)
    p.next.customModels.push({ id: "magpie:my-own", model: "my-own", providerId: PROVIDER_ID, displayName: "my-own" })
    writeFileSync(store, JSON.stringify(p.next))
    writeFileSync(seedFile(store), JSON.stringify(p.seeded))

    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    const after = JSON.parse(readFileSync(store, "utf8"))
    assert.deepEqual(after.customModels.map((m) => m.id), ["custom-provider:mine", "magpie:my-own"])
    assert.ok(after.customModelProviders.some((x) => x.id === PROVIDER_ID), "their model still uses that provider")
    assert.match(r.stdout, /left 1 you added under it yourself/)
    assert.equal(existsSync(`${store}.pre-magpie`), true)
    assert.deepEqual(JSON.parse(readFileSync(seedFile(store), "utf8")), [], "an empty record, not no record")

    const again = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(again.status, 0)
    assert.match(again.stdout, /nothing of magpie's to remove/)
    assert.ok(JSON.parse(readFileSync(store, "utf8")).customModels.some((m) => m.id === "magpie:my-own"),
      "a second run must not eat what the first one left")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a store seeded before the sidecar existed is still taken back", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-adopt-"))
  try {
    const store = join(dir, "settings.json")
    writeFileSync(store, JSON.stringify(plan(OWN_STORE, [GLM, TEXT], V1).next))
    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /no .*magpie-seeded yet: taking the 2 entries/)
    assert.deepEqual(JSON.parse(readFileSync(store, "utf8")).customModels.map((m) => m.id), ["custom-provider:mine"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("with no record yet, an entry is adopted only when it reaches magpie", () => {
  const store = {
    customModelProviders: [{ id: "custom-provider", baseUrl: V1 }, { id: "mine", baseUrl: "https://their.own.test/v1" }],
    customModels: [
      { id: "custom-provider:a", model: "a", providerId: "custom-provider" },
      { id: "mine:b", model: "b", providerId: "mine" },
    ],
  }
  assert.deepEqual([...adoptSeeded(store, V1)], ["custom-provider:a"], "their own endpoint is not ours to adopt")
})

test("an unreadable record stops instead of guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "cowork-record-"))
  try {
    const store = join(dir, "settings.json")
    writeFileSync(store, "{}")
    writeFileSync(seedFile(store), "{ not a list")
    assert.equal(loadSeeded(seedFile(store)), null)
    const r = spawnSync(process.execPath, [SEED, "--remove", "--store", store], { encoding: "utf8" })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /refusing to guess/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
