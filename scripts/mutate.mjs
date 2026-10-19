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
    from: "const kept = models.filter((m) => !(m && m.providerId === PROVIDER_ID && !live.has(m.model)))",
    to: "const kept = models.slice()",
    why: "leaves a magpie model that magpie no longer offers in the picker",
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
