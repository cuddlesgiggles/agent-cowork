// Every mutation of the package has to turn a test red. If one stays green,
// that test was never checking anything.
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const SRC = dirname(dirname(fileURLToPath(import.meta.url)))
const SCRATCH = join(dirname(SRC), ".mut-cowork")

const MUTATIONS = [
  {
    file: "seed.mjs",
    from: "if (taken.has(m.id)) continue",
    to: "if (false) continue",
    why: "adds a catalog model Cowork already has, so two entries share one title",
  },
  {
    file: "seed.mjs",
    from: "const droppable = models.filter((m) => m && seeded.has(m.id) && !ids.has(m.model) &&",
    to: "const droppable = models.filter((m) => m && m.providerId === PROVIDER_ID && !ids.has(m.model) &&",
    why: "prunes by provider again, which is how a model the user added under magpie gets eaten",
  },
  {
    file: "seed.mjs",
    from: "const pruned = shrank && !opts.prune ? [] : droppable.map((m) => m.id)",
    to: "const pruned = droppable.map((m) => m.id)",
    why: "a catalog that is short for a moment empties the picker without --prune",
  },
  {
    file: "seed.mjs",
    from: "m.id !== selected && m.model !== selected && m.displayName !== selected",
    to: "true",
    why: "prunes the model Cowork is on right now, which falls back silently",
  },
  {
    file: "seed.mjs",
    from: "if (!m || !seeded.has(m.id) || m.displayName === m.model) return m",
    to: "return m",
    why: "leaves a pretty label as the picker title, so the string magpie writes matches nothing",
  },
  {
    file: "seed.mjs",
    from: "if (!m || !seeded.has(m.id) || m.displayName === m.model) return m",
    to: "if (!m || m.displayName === m.model) return m",
    why: "renames entries the user named, dangling their saved selection",
  },
  {
    file: "seed.mjs",
    from: "if (at === -1) providers.push(provider(baseUrl))",
    to: "if (false) providers.push(provider(baseUrl))",
    why: "never adds the provider that points Cowork at magpie",
  },
  {
    file: "seed.mjs",
    from: "supportsMultimodal: !!(m.modalities && (m.modalities.input || []).includes(\"image\")),",
    to: "supportsMultimodal: false,",
    why: "tells Cowork no magpie model takes images",
  },
  {
    file: "seed.mjs",
    from: "roles: [\"model\"],",
    to: "roles: [],",
    why: "drops the role Cowork's own store gives every usable model",
  },
  {
    file: "seed.mjs",
    from: "return v && !v.startsWith(\"--\") ? v : dflt",
    to: "return v ? v : dflt",
    why: "reads the next flag as --gateway's value, so it fetches --check/v1/models",
  },
  {
    file: "seed.mjs",
    from: "const left = models.filter((m) => !(m && seeded.has(m.id)))",
    to: "const left = models.slice()",
    why: "--remove leaves every magpie model in Cowork's picker",
  },
  {
    file: "seed.mjs",
    from: "return existsSync(storePath) && !existsSync(bakPath)",
    to: "return existsSync(storePath)",
    why: "a second run overwrites the original store with an already-seeded one",
  },
  {
    file: "seed.mjs",
    from: "displayName: m.id,",
    to: "displayName: m.magpie_label || m.id,",
    why: "same, for the entries the package adds itself",
  },
  {
    file: "cowork.agent.js",
    from: "icon: \"data:image/png;base64,",
    to: "icon: \"data:image/jpeg;base64,",
    why: "ships the icon under a mime the Agents page won't render",
  },
  {
    file: "cowork.agent.js",
    from: "model: \"defaultChatModelTitle\",",
    to: "model: \"chatModelTitle\",",
    why: "writes a field name Cowork never reads",
  },
]

rmSync(SCRATCH, { recursive: true, force: true })
mkdirSync(SCRATCH, { recursive: true })
for (const f of ["package.json", "cowork.agent.js", "seed.mjs", "test"]) {
  cpSync(join(SRC, f), join(SCRATCH, f), { recursive: true })
}

let loose = 0
for (const m of MUTATIONS) {
  const p = join(SCRATCH, m.file)
  const original = readFileSync(p, "utf8")
  if (!original.includes(m.from)) {
    console.log(`ANCHOR GONE  ${m.file}: ${m.from}`)
    loose++
    continue
  }
  writeFileSync(p, original.replace(m.from, m.to), "utf8")
  const r = spawnSync(process.execPath, ["--test"], { cwd: SCRATCH, encoding: "utf8" })
  const red = r.status !== 0
  if (!red) loose++
  console.log(`${red ? "RED " : "GREEN (no guard!)"} ${m.file}: ${m.why}`)
  writeFileSync(p, original, "utf8")
}
rmSync(SCRATCH, { recursive: true, force: true })
console.log(loose ? `\n${loose} mutation(s) survived` : "\nall mutations caught")
process.exit(loose ? 1 : 0)
