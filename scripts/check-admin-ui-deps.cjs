const { existsSync } = require('node:fs');
const { join } = require('node:path');

const binDir = join(__dirname, '..', 'admin-ui', 'node_modules', '.bin');
const suffix = process.platform === 'win32' ? '.cmd' : '';
const missing = ['eslint', 'tsc', 'vite', 'vitest'].filter(
  (command) => !existsSync(join(binDir, `${command}${suffix}`)),
);

if (missing.length > 0) {
  console.error(
    `Admin UI dependencies are missing (${missing.join(', ')}). Run "npm ci --prefix admin-ui" and retry.`,
  );
  process.exit(1);
}
