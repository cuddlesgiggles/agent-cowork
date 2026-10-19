#!/usr/bin/env node
// One-time wiring for Cowork: copy magpie's model catalog into the store
// Cowork reads its models from (~/.codely/settings.json). Cowork matches a
// model by the `model` string, so a catalog model already in the store under
// any provider is left alone rather than added twice.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const PROVIDER_ID = "magpie"

export function expand(p) {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p
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

// Importing this file (the tests) must not seed anything: only `node seed.mjs` runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(`--${n}`)
  if (flag("help")) {
    console.log("usage: node seed.mjs [--gateway http://127.0.0.1:3425] [--store ~/.codely/settings.json] [--check]")
    process.exit(0)
  }

  const gateway = opt(argv, "gateway", "http://127.0.0.1:3425").replace(/\/$/, "")
  const storePath = expand(opt(argv, "store", "~/.codely/settings.json"))

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

  const store = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {}
  if (!Array.isArray(store.customModels) && "customModels" in store) {
    console.error(`${storePath}'s customModels is not a list; open Cowork once and retry`)
    process.exit(2)
  }
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

  if (existsSync(storePath)) {
    const bak = `${storePath}.pre-magpie`
    copyFileSync(storePath, bak)
    console.log(`old store kept at ${bak}`)
  }
  writeFileSync(storePath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
  console.log(`wrote ${storePath}: +${added.length} magpie models, -${pruned.length} stale, ${next.customModels.length} total`)
}
