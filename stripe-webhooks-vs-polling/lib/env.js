// lib/env.js — shared start-up code for every script.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Load .env from the project folder (Node's built-in loader). Variables already set in the shell win.
const envFile = path.join(PROJECT_DIR, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// True when this module is the file that was started with `node <file>`.
export const isMain = (metaUrl) =>
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);

// Print one-line errors instead of stack traces (DEBUG=1 shows the stack). Not under `node --test`.
if (!process.env.NODE_TEST_CONTEXT) {
  const report = (err) => {
    console.error(`Error: ${err?.message ?? err}`);
    if (process.env.DEBUG) console.error(err?.stack);
    process.exit(1);
  };
  process.on('uncaughtException', report);
  process.on('unhandledRejection', report);
}
