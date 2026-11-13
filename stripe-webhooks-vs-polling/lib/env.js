// lib/env.js — load .env from the project folder (Node's built-in loader, no dotenv needed).
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Where payments.db, logs/, run/ and results/ live. Defaults to the project folder; the self-tests
// point it elsewhere so they never touch the real experiment's data.
export const DATA_DIR = path.resolve(process.env.DATA_DIR || PROJECT_DIR);

const envFile = path.join(PROJECT_DIR, '.env');
if (fs.existsSync(envFile)) {
  // Variables already set in the shell win over the file.
  process.loadEnvFile(envFile);
}

// True when the given module file was the one started with `node <file>`.
export const isMain = (metaUrl) =>
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);

// Plain one-line errors for the command-line scripts (DEBUG=1 shows the stack).
// Left alone under `node --test`, which reports errors itself.
if (!process.env.NODE_TEST_CONTEXT) {
  const report = (err) => {
    console.error(`Error: ${err?.message ?? err}`);
    if (process.env.DEBUG) console.error(err?.stack);
    process.exit(1);
  };
  process.on('uncaughtException', report);
  process.on('unhandledRejection', report);
}
