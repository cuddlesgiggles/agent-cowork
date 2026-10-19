#!/usr/bin/env node
// One-time wiring for Cowork: copy magpie's model catalog into the store Cowork
// reads its models from (~/.codely/settings.json). Cowork picks a model by the
// name it shows in its list, so the entries written here are named by the magpie
// model id — that is the string `magpie cowork <model>` puts in ide-settings.json.
// What this package wrote is recorded in a sidecar next to the store: an entry's
// `providerId` being "magpie" is not the same question, because a user can add
// their own model under that provider in Cowork and nothing entitles us to prune it.
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
    // Cowork's picker shows this and stores it as the session's model title, and
    // the title is the one string magpie's agent plugin can write — so it has to
    // be the model id, not a prettier label, or the switch lands on nothing.
    displayName: m.id,
    authType: "openai",
    roles: ["model"],
    wireApi: "chat",
    contextLength: m.context_length || 8192,
    supportsMultimodal: !!(m.modalities && (m.modalities.input || []).includes("image")),
  }
}

export function seedFile(storePath) {
  return `${storePath}.magpie-seeded`
}

// null: no sidecar to read. An unreadable one is an error the caller refuses on,
// because guessing is exactly what drops someone's own model.
export function loadSeeded(path) {
  if (!existsSync(path)) return null
  try {
    const ids = JSON.parse(readFileSync(path, "utf8"))
    return Array.isArray(ids) ? new Set(ids) : null
  } catch {
    return null
  }
}

// A store seeded before the sidecar existed — by an older version of this script
// or by hand — is adopted once: every entry that reaches magpie's address counts
// as ours to manage, so --remove can still clean up after a version that wrote
// them under another provider's id.
export function adoptSeeded(store, baseUrl) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders : []
  const atMagpie = new Map(providers.map((p) => [p && p.id, p && p.baseUrl]))
  return new Set(models
    .filter((m) => m && (m.providerId === PROVIDER_ID || atMagpie.get(m.providerId) === baseUrl))
    .map((m) => m.id))
}

// An entry is ours to relabel when it names a model magpie offers and its provider
// points at magpie's address. That reaches entries seeded before this package knew
// the naming rule, without touching a model the user wired somewhere else.
function oursToLabel(m, ids, byId, baseUrl) {
  return !!m && ids.has(m.model) && byId.get(m.providerId) === baseUrl
}

// store: Cowork's settings.json object. catalog: magpie's /v1/models data.
// seeded: the entry ids this package wrote. Nothing passed in is mutated.
export function plan(store, catalog, baseUrl, seeded = new Set()) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders.slice() : []
  const byId = new Map(providers.map((p) => [p && p.id, p && p.baseUrl]))
  const ids = new Set(catalog.map((m) => m.id))
  const taken = new Set(models.map((m) => m && m.model))

  const pruned = models.filter((m) => m && seeded.has(m.id) && !ids.has(m.model)).map((m) => m.id)
  let relabeled = 0
  const kept = models
    .filter((m) => !(m && pruned.includes(m.id)))
    .map((m) => {
      if (!oursToLabel(m, ids, byId, baseUrl) || m.displayName === m.model) return m
      relabeled++
      return { ...m, displayName: m.model }
    })
  const added = []
  for (const m of catalog) {
    if (taken.has(m.id)) continue
    added.push(m.id)
    kept.push(entry(m))
  }

  const at = providers.findIndex((p) => p && p.id === PROVIDER_ID)
  if (at === -1) providers.push(provider(baseUrl))
  else providers[at] = provider(baseUrl)

  const nextSeeded = new Set([...seeded].filter((id) => !pruned.includes(id)))
  for (const m of catalog) if (added.includes(m.id)) nextSeeded.add(`${PROVIDER_ID}:${m.id}`)
  const changed = added.length > 0 || pruned.length > 0 || relabeled > 0 || at === -1 ||
    (at !== -1 && store.customModelProviders[at].baseUrl !== baseUrl)
  return {
    next: { ...store, customModels: kept, customModelProviders: providers },
    added, pruned, relabeled, seeded: [...nextSeeded], changed,
  }
}

// The other way: take out exactly the ids recorded, and the provider only once
// nothing is left under it.
export function unplan(store, seeded = new Set()) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders : []
  const removed = models.filter((m) => m && seeded.has(m.id)).map((m) => m.id)
  const left = models.filter((m) => !(m && seeded.has(m.id)))
  const stillOurs = left.some((m) => m && m.providerId === PROVIDER_ID)
  const nextProviders = stillOurs ? providers : providers.filter((p) => !(p && p.id === PROVIDER_ID))
  return {
    next: { ...store, customModels: left, customModelProviders: nextProviders },
    removed,
    leftBehind: left.filter((m) => m && m.providerId === PROVIDER_ID).map((m) => m.id),
    changed: removed.length > 0 || nextProviders.length !== providers.length,
  }
}

// Importing this file (the tests) must touch nothing: only `node seed.mjs` runs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(`--${n}`)
  if (flag("help")) {
    console.log("usage: node seed.mjs [--gateway http://127.0.0.1:3425] [--store ~/.codely/settings.json] [--check | --remove]")
    process.exit(0)
  }

  const gateway = opt(argv, "gateway", "http://127.0.0.1:3425").replace(/\/$/, "")
  const storePath = expand(opt(argv, "store", "~/.codely/settings.json"))
  const listPath = seedFile(storePath)

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
  const writeStore = (next, seeded) => {
    const bak = `${storePath}.pre-magpie`
    if (backupNeeded(storePath, bak)) {
      copyFileSync(storePath, bak)
      console.log(`the store as it was before magpie touched it: ${bak}`)
    }
    // Cowork writes this file too, so land each new one in a single move
    writeFileSync(`${storePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    renameSync(`${storePath}.tmp`, storePath)
    // an empty record is kept: "nothing of ours" and "no record, guess from the
    // provider" are different answers, and only the first one is safe to act on
    writeList(seeded)
  }

  const store = readStore()
  let seeded = loadSeeded(listPath)
  if (seeded === null && existsSync(listPath)) {
    console.error(`${listPath} isn't readable JSON; refusing to guess which entries magpie wrote`)
    process.exit(2)
  }
  let adopted = false
  if (seeded === null) {
    seeded = adoptSeeded(store, `${gateway}/v1`)
    adopted = true
    if (seeded.size) console.log(`no ${listPath} yet: taking the ${seeded.size} entries that reach magpie as the ones magpie wrote`)
  }
  const writeList = (ids) => {
    writeFileSync(`${listPath}.tmp`, `${JSON.stringify(ids, null, 1)}\n`, "utf8")
    renameSync(`${listPath}.tmp`, listPath)
  }

  if (flag("remove")) {
    const { next, removed, leftBehind, changed } = unplan(store, seeded)
    if (flag("check")) {
      console.log(changed ? `still seeded: ${removed.length} of magpie's models in ${storePath}` : "nothing of magpie's left in the store")
      process.exit(changed ? 1 : 0)
    }
    if (!changed) {
      console.log("nothing of magpie's to remove")
      if (adopted) writeList([])
      process.exit(0)
    }
    writeStore(next, [])
    console.log(`took magpie out of ${storePath}: ${removed.length} models${leftBehind.length ? `, left ${leftBehind.length} you added under it yourself` : ""}`)
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

  const { next, added, pruned, relabeled, seeded: nextSeeded, changed } = plan(store, catalog, `${gateway}/v1`, seeded)

  if (flag("check")) {
    if (changed) console.log(`drift: +${added.length} to add, -${pruned.length} to drop, ~${relabeled} to relabel`)
    else console.log(`in step: ${catalog.length} catalog models, ${next.customModels.length} in Cowork, nothing to write`)
    process.exit(changed ? 1 : 0)
  }
  if (!changed) {
    console.log(`in step: nothing to write (${next.customModels.length} models in Cowork)`)
    if (adopted) writeList(nextSeeded)
    process.exit(0)
  }

  writeStore(next, nextSeeded)
  console.log(`wrote ${storePath}: +${added.length} magpie models, -${pruned.length} stale, ~${relabeled} relabelled, ${next.customModels.length} total`)
}
