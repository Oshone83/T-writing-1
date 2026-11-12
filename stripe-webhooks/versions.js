// versions.js: prints the versions for the article's "Runtime" line.
import { readFileSync } from 'node:fs';

const v = (name) => {
  try {
    return JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url))).version;
  } catch {
    return 'not installed';
  }
};
console.log(`Node ${process.versions.node}, stripe ${v('stripe')}, express ${v('express')}, better-sqlite3 ${v('better-sqlite3')}`);
