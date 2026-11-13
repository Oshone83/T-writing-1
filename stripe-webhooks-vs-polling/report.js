// report.js — prints what the database knows: each payment, which method found it and how fast,
// how many API requests were made, and how many webhook deliveries were duplicates.
//
//   npm run report
//   node report.js --phase manual
import { parseArgs } from 'node:util';
import { isMain } from './lib/env.js';
import { openDb } from './lib/db.js';
import { formatReport } from './lib/report.js';

if (isMain(import.meta.url)) {
  const { values } = parseArgs({ options: { phase: { type: 'string' } } });
  console.log(formatReport(openDb(), values.phase));
}
