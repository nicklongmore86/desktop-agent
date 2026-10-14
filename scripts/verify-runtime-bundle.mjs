import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verify } from './runtime-bundle.mjs'
export default async function afterPack(context) {
  await verify(join(context.appOutDir, 'resources'))
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await verify(process.argv[2])
