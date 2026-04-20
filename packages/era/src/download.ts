import { downloadIfMissing, header, resolveTargets } from './cli-shared.js'

const targets = await resolveTargets(process.argv[2])
for (const t of targets) {
  console.log(header(t))
  await downloadIfMissing(t)
}
