#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { auditSchedule } from './index.mjs';

const args = process.argv.slice(2);
if (args.length !== 1 || args[0] === '-' || args[0].startsWith('--')) {
  console.error('Usage: node cli.mjs <schedule.json>');
  process.exitCode = 2;
} else {
  try {
    const report = auditSchedule(JSON.parse(await readFile(args[0], 'utf8')));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } catch {
    console.error('Could not read a valid JSON schedule from the supplied path.');
    process.exitCode = 2;
  }
}
