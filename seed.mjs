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
import { join, dirname } from "node:path"
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

// A store written by an older version of this script, before the record existed,
// is adopted once — and only entries under our own provider, whose model magpie
// still offers. A provider that merely happens to point at magpie's address can
// be the user's own, and nothing here entitles us to claim it.
export function adoptSeeded(store, catalog = null) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const ids = catalog === null ? null : new Set(catalog.map((m) => m.id))
  return new Set(models
    .filter((m) => m && m.providerId === PROVIDER_ID && (ids === null || ids.has(m.model)))
    .map((m) => m.id))
}

// store: Cowork's settings.json object. catalog: magpie's /v1/models data.
// seeded: the entry ids this package wrote, from the record. opts.selected is the
// model Cowork is on right now, opts.prune allows a shrinking catalog to remove
// recorded entries. Nothing passed in is mutated.
export function plan(store, catalog, baseUrl, seeded = new Set(), opts = {}) {
  const models = Array.isArray(store.customModels) ? store.customModels : []
  const providers = Array.isArray(store.customModelProviders) ? store.customModelProviders.slice() : []
  const ids = new Set(catalog.map((m) => m.id))
  const taken = new Set(models.map((m) => m && m.model))
  const selected = opts.selected ?? null

  // A catalog smaller than what we recorded is more often magpie starting up or
  // an account resting than a real retirement, and pruning then deletes the model
  // the user is talking to. Hold unless they say --prune.
  const shrank = catalog.length < seeded.size
  const droppable = models.filter((m) => m && seeded.has(m.id) && !ids.has(m.model) &&
    m.id !== selected && m.model !== selected && m.displayName !== selected)
  const pruned = shrank && !opts.prune ? [] : droppable.map((m) => m.id)
  const held = shrank ? droppable.map((m) => m.id).filter((id) => !pruned.includes(id)) : []

  let relabeled = 0
  let renamed = null
  const dropped = new Set(pruned)
  const kept = models
    .filter((m) => !(m && dropped.has(m.id)))
    .map((m) => {
      // only entries we wrote, and only ones we recorded: a name the user chose in
      // Cowork is theirs, and renaming it would leave their selection pointing nowhere
      if (!m || !seeded.has(m.id) || m.displayName === m.model) return m
      relabeled++
      if (m.displayName === selected) renamed = m.model
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
    added, pruned, held, relabeled, renamed, seeded: [...nextSeeded], changed,
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
    console.log("usage: node seed.mjs [--gateway http://127.0.0.1:3425] [--store ~/.codely/settings.json] [--check | --remove | --prune]")
    process.exit(0)
  }

  const gateway = opt(argv, "gateway", "http://127.0.0.1:3425").replace(/\/$/, "")
  const storePath = expand(opt(argv, "store", "~/.codely/settings.json"))
  const listPath = seedFile(storePath)
  const bakPath = `${storePath}.pre-magpie`
  const titlePath = join(dirname(storePath), "ide-settings.json")

  const readStore = () => {
    if (!existsSync(storePath)) return {}
    let store
    try {
      store = JSON.parse(readFileSync(storePath, "utf8"))
    } catch {
      console.error(`${storePath} isn't readable JSON — Cowork may be writing it right now; try again, or restore ${bakPath}`)
      process.exit(2)
    }
    if (!Array.isArray(store.customModels) && "customModels" in store) {
      console.error(`${storePath}'s customModels is not a list; open Cowork once and retry`)
      process.exit(2)
    }
    return store
  }
  const writeList = (ids) => {
    writeFileSync(`${listPath}.tmp`, `${JSON.stringify(ids, null, 1)}\n`, "utf8")
    renameSync(`${listPath}.tmp`, listPath)
  }
  const writeStore = (next, seeded) => {
    if (backupNeeded(storePath, bakPath)) {
      copyFileSync(storePath, bakPath)
      console.log(`the store as it was before magpie touched it: ${bakPath}`)
    }
    // Cowork writes this file too, so land each new one in a single move
    writeFileSync(`${storePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8")
    renameSync(`${storePath}.tmp`, storePath)
    // an empty record is kept: "nothing of ours" and "no record, guess" are
    // different answers, and only the first one is safe to act on
    writeList(seeded)
  }
  const readTitle = () => {
    try {
      return JSON.parse(readFileSync(titlePath, "utf8")).defaultChatModelTitle ?? null
    } catch {
      return null
    }
  }
  const writeTitle = (t) => {
    let ide = {}
    try {
      ide = JSON.parse(readFileSync(titlePath, "utf8"))
    } catch {
      return console.error(`${titlePath} isn't readable JSON; leaving Cowork's selection alone — re-pick it once in Cowork`)
    }
    ide.defaultChatModelTitle = t
    writeFileSync(`${titlePath}.tmp`, `${JSON.stringify(ide, null, 2)}\n`, "utf8")
    renameSync(`${titlePath}.tmp`, titlePath)
  }

  const store = readStore()
  let seeded = loadSeeded(listPath)
  if (seeded === null && existsSync(listPath)) {
    console.error(`${listPath} isn't readable JSON; refusing to guess which entries magpie wrote`)
    process.exit(2)
  }
  // No record: adopt only where there is evidence this script wrote the store.
  let adopted = false
  if (seeded === null && existsSync(bakPath)) {
    seeded = adoptSeeded(store)
    adopted = true
    if (seeded.size) console.log(`no ${listPath}: adopting the ${seeded.size} entries under "${PROVIDER_ID}"`)
  }
  if (seeded === null) seeded = new Set()

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
  if (adopted) seeded = new Set([...seeded].filter((id) => catalog.some((m) => `${PROVIDER_ID}:${m.id}` === id)))

  const selected = readTitle()
  const { next, added, pruned, held, relabeled, renamed, seeded: nextSeeded, changed } =
    plan(store, catalog, `${gateway}/v1`, seeded, { prune: flag("prune"), selected })

  if (flag("check")) {
    if (changed) console.log(`drift: +${added.length} to add, -${pruned.length} to drop, ~${relabeled} to relabel`)
    else console.log(`in step: ${catalog.length} catalog models, ${next.customModels.length} in Cowork, nothing to write`)
    if (held.length) console.log(`held ${held.length} recorded entries back: the catalog is shorter than the last run, pass --prune to drop them`)
    process.exit(changed ? 1 : 0)
  }
  if (!changed) {
    console.log(`in step: nothing to write (${next.customModels.length} models in Cowork)`)
    if (adopted) writeList(nextSeeded)
    if (held.length) console.log(`held ${held.length} recorded entries back: the catalog is shorter than the last run, pass --prune to drop them`)
    process.exit(0)
  }

  writeStore(next, nextSeeded)
  if (renamed) {
    writeTitle(renamed)
    console.log(`Cowork was on the entry we just renamed; its selection now says ${renamed}`)
  }
  console.log(`wrote ${storePath}: +${added.length} magpie models, -${pruned.length} stale, ~${relabeled} relabelled, ${next.customModels.length} total`)
  if (held.length) console.log(`held ${held.length} recorded entries back: the catalog is shorter than the last run, pass --prune to drop them`)
}
