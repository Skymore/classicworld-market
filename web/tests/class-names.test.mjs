// cn() (frontend/src/lib/utils.ts) joins class names without tailwind-merge.
// That is only equivalent while no two class names the site combines are
// conflicting Tailwind utilities: check every className the frontend writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../../frontend/', import.meta.url);
const require = createRequire(new URL('package.json', root));
let twMerge, clsx;
try {
  ({ twMerge } = require('tailwind-merge'));
  ({ clsx } = require('clsx'));
} catch {
  /* frontend/node_modules is not installed here */
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
}

// The ui/ wrappers whose className goes through cn().
const WRAPPERS = ['Button', 'TabsList', 'TabsTrigger', 'TabsContent', 'DialogContent', 'DropdownMenuContent', 'DropdownMenuRadioItem'];

/** String literals of cn()/cva() arguments and of className on the wrappers. */
function classLiterals(source) {
  const found = [];
  const literals = (text) => {
    for (const match of text.matchAll(/"([^"\\]*)"|'([^'\\]*)'|`([^`\\]*)`/g)) {
      const value = match[1] ?? match[2] ?? match[3];
      for (const part of value.split(/\$\{[^}]*\}/)) found.push(part);
    }
  };
  // From an opening bracket to its match.
  const balanced = (start) => {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if ('{(['.includes(source[i])) depth++;
      else if ('})]'.includes(source[i]) && --depth === 0) return source.slice(start, i + 1);
    }
    return '';
  };
  // A JSX opening tag: up to the first > outside braces.
  const tag = (start) => {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') depth--;
      else if (source[i] === '>' && depth === 0) return source.slice(start, i);
    }
    return '';
  };
  for (const match of source.matchAll(new RegExp(`<(${WRAPPERS.join('|')})\\b`, 'g'))) {
    const attributes = tag(match.index);
    for (const name of attributes.matchAll(/className=("[^"]*"|\{)/g))
      literals(name[1] === '{' ? balanced(match.index + name.index + 'className='.length) : name[1]);
  }
  for (const match of source.matchAll(/\b(cn|cva)\(/g)) literals(balanced(match.index + match[1].length));
  return found;
}

test('cn keeps the plain join that tailwind-merge produced', { skip: !twMerge && 'frontend dependencies not installed' }, () => {
  const utils = readFileSync(new URL('src/lib/utils.ts', root), 'utf8');
  assert.match(utils, /clsx\(inputs\)\.split\(\/\\s\+\/\)\.filter\(Boolean\)\.join\(" "\)/);
  assert.doesNotMatch(utils, /from "tailwind-merge"/);
  const cn = (...inputs) => clsx(inputs).split(/\s+/).filter(Boolean).join(' ');
  const tokens = new Set();
  for (const file of files(fileURLToPath(new URL('src/', root))))
    for (const literal of classLiterals(readFileSync(file, 'utf8')))
      for (const token of literal.split(/\s+/)) if (token) tokens.add(token);
  assert.ok(tokens.has('btn') && tokens.has('ui-dialog-content') && tokens.has('sortmenu'), 'found the component classes');
  // No two of these conflict, so any combination merges to the plain join.
  const all = [...tokens].join(' ');
  assert.equal(twMerge(all), all);
  for (const [base, extra] of [['btn', 'primary'], ['btn ui-ghost', 'ui-icon-button'], ['tabs', ''], ['ui-dialog-content stall', 'wl-dialog  sweep-dialog'], ['pane list', undefined]])
    assert.equal(cn(base, extra), twMerge(clsx(base, extra)));
});
