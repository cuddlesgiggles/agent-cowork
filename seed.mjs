#!/usr/bin/env node
// One-time wiring for Cowork: copy magpie's model catalog into the store
// Cowork reads its models from (~/.codely/settings.json). Cowork matches a
// model by the `model` string, so a catalog model already in the store under
// any provider is left alone rather than added twice.
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const PROVIDER_ID = "magpie"

export function expand(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
}

// The backup is the store as it was before magpie ever touched it, so a later
// run must not overwrite it with an already-seeded one.
export function backupNeeded(storePath, bakPath) {
  return existsSync(storePath) && !existsSync(bakPath)
}

// --gateway <url> --store <path>; a flag with no value after it takes the default,
// so `--check` on its own is never read as a value.
export function opt(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return dflt
  const v = argv[i + 1]
  return v && !v.startsWith("--") ? v : dflt
}

export function provider(baseUrl) {
  return {
    id: PROVIDER_ID,
    name: "magpie",
    baseUrl,
    apiKey: "magpie-cowork",
    authType: "openai",
  }
}

export function entry(m) {
  return {
    id: `${PROVIDER_ID}:${m.id}`,
    model: m.id,
    providerId: PROVIDER_ID,
    displayName: m.magpie_label || m.display_name || m.id,
    authType: "openai",
    roles: ["model"],
    wireApi: "chat",
    contextLength: m.context_length || 8192,
    supportsMultimodal: !!(m.modalities && (m.modalities.input || []).includes("image")),
  }
}

// store: Cowork's settings.json object. catalog: magpie's /v1/models data.
// Returns the next store plus what moved, without touching the input.
export function plan(store, catalog, baseUrl) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const taken = new Set(models.map((m) => m && m.model))
  const live = new Set(catalog.map((m) => m.id))

  const kept = models.filter((m) => !(m && m.providerId === PROVIDER_ID && !live.has(m.model)))
  const added = []
  for (const m of catalog) {
    if (taken.has(m.id)) continue
    added.push(m.id)
    kept.push(entry(m))
  }

  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders.slice() : []
  const at = providers.findIndex((p) => p && p.id === PROVIDER_ID)
  if (at === -1) providers.push(provider(baseUrl))
  else providers[at] = provider(baseUrl)

  const pruned = models.filter((m) => m && m.providerId === PROVIDER_ID && !live.has(m.model)).map((m) => m.model)
  const changed = added.length > 0 || pruned.length > 0 || at === -1 ||
    (at !== -1 && store.customModelProviders[at].baseUrl !== baseUrl)
  return { next: { ...store, customModels: kept, customModelProviders: providers }, added, pruned, changed }
}

// The other way: take everything this package put in, and only that.
export function unplan(store) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders : []
  const removed = models.filter((m) => m && m.providerId === PROVIDER_ID).map((m) => m.model)
  const next = {
    ...store,
    customModels: models.filter((m) => !(m && m.providerId === PROVIDER_ID)),
    customModelProviders: providers.filter((p) => !(p && p.id === PROVIDER_ID)),
  }
  return { next, removed, changed: removed.length > 0 || next.customModelProviders.length !== providers.length }
}

// Importing this file (the tests) must not seed anything: only `node seed.mjs` runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(`--${n}`)
  if (flag("help")) {
    console.log("usage: node seed.mjs [--gateway http://127.0.0.1:3425] [--store ~/.codely/settings.json] [--check | --remove]")
    process.exit(0)
  }

  const gateway = opt(argv, "gateway", "http://127.0.0.1:3425").replace(/\/$/, "")
  const storePath = expand(opt(argv, "store", "~/.codely/settings.json"))

  const readStore = () => {
    if (!existsSync(storePath)) return {}
    let store
    try {
      store = JSON.parse(readFileSync(storePath, "utf8"))
    } catch {
      console.error(`${storePath} isn't readable JSON — Cowork may be writing it right now; try again, or restore ${storePath}.pre-magpie`)
      process.exit(2)
    }
    if (!Array.isArray(store.customModels) && "customModels" in store) {
      console.error(`${storePath}'s customModels is not a list; open Cowork once and retry`)
      process.exit(2)
    }
    return store
  }
  const writeStore = (next) => {
    const bak = `${storePath}.pre-magpie`
    if (backupNeeded(storePath, bak)) {
      copyFileSync(storePath, bak)
      console.log(`the store as it was before magpie touched it: ${bak}`)
    }
    // Cowork writes this file too, so land the new one in a single move
    writeFileSync(`${storePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    renameSync(`${storePath}.tmp`, storePath)
  }

  if (flag("remove")) {
    const store = readStore()
    const { next, removed, changed } = unplan(store)
    if (flag("check")) {
      console.log(changed ? `still seeded: ${removed.length} magpie models and the magpie provider in ${storePath}` : "nothing of magpie's left in the store")
      process.exit(changed ? 1 : 0)
    }
    if (!changed) {
      console.log("nothing of magpie's to remove")
      process.exit(0)
    }
    writeStore(next)
    console.log(`took magpie out of ${storePath}: ${removed.length} models and its provider`)
    process.exit(0)
  }

  const res = await fetch(`${gateway}/v1/models`)
  if (!res.ok) {
    console.error(`magpie's catalog came back ${res.status} from ${gateway}/v1/models — is magpie running?`)
    process.exit(2)
  }
  const catalog = (await res.json()).data
  if (!Array.isArray(catalog) || !catalog.length) {
    console.error("magpie's catalog is empty")
    process.exit(2)
  }

  const store = readStore()
  const { next, added, pruned, changed } = plan(store, catalog, `${gateway}/v1`)

  if (flag("check")) {
    if (changed) console.log(`drift: +${added.length} to add, -${pruned.length} to drop (${[...added, ...pruned].slice(0, 6).join(", ")})`)
    else console.log(`in step: ${catalog.length} catalog models, ${next.customModels.length} in Cowork, nothing to write`)
    process.exit(changed ? 1 : 0)
  }
  if (!changed) {
    console.log(`in step: nothing to write (${next.customModels.length} models in Cowork)`)
    process.exit(0)
  }

  writeStore(next)
  console.log(`wrote ${storePath}: +${added.length} magpie models, -${pruned.length} stale, ${next.customModels.length} total`)
}
