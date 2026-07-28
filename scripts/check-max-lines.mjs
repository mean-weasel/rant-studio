import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const roots = ['apps', 'packages', 'src', 'tests'];
const sourceExtensions = new Set(['.css', '.ts', '.tsx']);
const defaultLimits = {
  '.css': 500,
  '.ts': 500,
  '.tsx': 500,
};
const testLimit = 650;

// V1 predates this guard. These ceilings freeze existing oversized files so
// they cannot grow while follow-up refactors split them into bounded modules.
const ratchets = {
  'apps/service/src/server.ts': 986,
  'apps/service/src/store.ts': 3555,
  'packages/api/src/index.ts': 652,
  'src/App.tsx': 2038,
  'src/ProductionLedger.tsx': 633,
  'src/styles.css': 3075,
  'tests/assets/assets.test.ts': 652,
};

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

function countLines(contents) {
  if (contents.length === 0) return 0;
  const lines = contents.split(/\r?\n/).length;
  return contents.endsWith('\n') ? lines - 1 : lines;
}

const files = (await Promise.all(roots.map(collectFiles))).flat().sort();
const failures = [];

for (const file of files) {
  const extension = path.extname(file);
  const defaultLimit = file.startsWith(`tests${path.sep}`)
    ? testLimit
    : defaultLimits[extension];
  const normalizedFile = file.split(path.sep).join('/');
  const limit = ratchets[normalizedFile] ?? defaultLimit;
  const lineCount = countLines(await readFile(file, 'utf8'));

  if (lineCount > limit) {
    failures.push(`${normalizedFile}: ${lineCount} lines (limit ${limit})`);
  }
}

if (failures.length > 0) {
  console.error('Maximum line-count guard failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Maximum line-count guard passed for ${files.length} files.`);
}
