#!/usr/bin/env node
// Phase 2: mark which groups to watch.
// Default: GUTS / Back From the Edge / Audio Anonymous (case-insensitive substring match).

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const GROUPS = path.join(ROOT, 'groups.json');

const PATTERNS = [
  /\bguts\b/i,
  /back\s*from\s*the\s*edge/i,
  /\bbfte\b/i,
  /audio\s*anonymous/i,
];

function classify(name) {
  if (!name) return null;
  if (/audio\s*anonymous/i.test(name)) return 'audio-anonymous';
  if (/\bguts\b/i.test(name)) return 'guts';
  if (/back\s*from\s*the\s*edge|\bbfte\b/i.test(name)) return 'bfte';
  return null;
}

function main() {
  if (!fs.existsSync(GROUPS)) {
    console.error('groups.json not found. Run: npm run list first.');
    process.exit(2);
  }
  const groups = JSON.parse(fs.readFileSync(GROUPS, 'utf8'));
  let on = 0;
  for (const g of groups) {
    const tag = classify(g.name);
    const match = PATTERNS.some((re) => re.test(g.name || ''));
    g.watch = !!match;
    g.tag = tag;
    if (g.watch) on += 1;
  }
  fs.writeFileSync(GROUPS, JSON.stringify(groups, null, 2));
  console.log(`Marked ${on}/${groups.length} groups as watched.`);
  for (const g of groups.filter((x) => x.watch)) {
    console.log(`  ✓ [${g.tag || '-'}] ${g.name}  (${g.id})`);
  }
}

main();
