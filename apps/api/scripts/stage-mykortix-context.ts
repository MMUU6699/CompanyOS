import { cp, mkdir, rm } from 'node:fs/promises';
import { stageMyKortixBuildContext } from '../src/snapshots/build-context';

const outDir = process.argv[2] || '/tmp/kortix-sandbox-context';

const staged = await stageMyKortixBuildContext();
try {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await cp(staged.contextDir, outDir, { recursive: true });
  console.log(`Staged MyKortix sandbox build context into ${outDir}`);
} finally {
  await rm(staged.contextDir, { recursive: true, force: true }).catch(() => {});
}
