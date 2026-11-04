#!/usr/bin/env node
// Runs `vitest run` with any CLI filters. pnpm forwards a literal `--` from
// `pnpm --filter server test -- jobs`, which vitest would treat as the end of
// its options and ignore the filter after it, so drop it before forwarding.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(join(process.cwd(), 'package.json'));
const vitestBin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const result = spawnSync(process.execPath, [vitestBin, 'run', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
