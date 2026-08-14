import { defineConfig } from 'vite';
import { readdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const INITIAL_PORTAL_BUDGET = 50 * 1024 * 1024;
const RELEASE_EXCLUDED_ASSETS = [
  'art/arena/gameplay-pitch-v1.webp',
  'art/arena/gameplay-pitch-v2.webp',
  'art/arena/variants/electric-derby.webp',
  'art/arena/variants/heritage-day.webp',
  'art/arena/variants/midnight-final.webp',
  'art/projectiles/curveball.png',
  'art/projectiles/golden-boot.png',
  'art/enemies/drone-run.png',
  'art/allies/bodyguard-heavy.png',
  'art/allies/bodyguard-scout.png',
  'art/vfx/kick-contact-turf-strip.png',
] as const;
const RELEASE_EXCLUDED_DIRECTORIES = [
  // Keep the prior authored player atlases in source control as a rollback,
  // but do not ship two complete 384-frame sets in the portal payload.
  'art/players/directional-v2',
] as const;

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    total += entry.isDirectory() ? await directoryBytes(child) : (await stat(child)).size;
  }
  return total;
}

export default defineConfig({
  base: './',
  plugins: [{
    name: 'release-payload-budget',
    apply: 'build',
    async closeBundle() {
      const output = resolve('dist');
      // Preserve every source asset. Only known-unreferenced legacy files are
      // omitted from the generated portal package.
      await Promise.all(RELEASE_EXCLUDED_ASSETS.map((asset) => rm(resolve(output, asset), { force: true })));
      await Promise.all(RELEASE_EXCLUDED_DIRECTORIES.map((directory) => rm(resolve(output, directory), { recursive: true, force: true })));
      const bytes = await directoryBytes(output);
      if (bytes > INITIAL_PORTAL_BUDGET) {
        throw new Error(`Portal payload ${bytes} bytes exceeds the 50 MB Basic Launch budget.`);
      }
      console.log(`Portal payload: ${(bytes / 1024 / 1024).toFixed(2)} MiB / 50.00 MiB`);
    },
  }],
  build: {
    target: 'es2022',
    minify: 'esbuild',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
  },
} as never);
