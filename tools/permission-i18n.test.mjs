import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('permission diagnostics have matching IT/EN keys and interpolation fields', () => {
  const load = lang => JSON.parse(readFileSync(new URL(`../apps/web/src/i18n/locales/${lang}.json`, import.meta.url), 'utf8')).system.permissions;
  function flatten(object, prefix = '') {
    return Object.fromEntries(Object.entries(object).flatMap(([key, value]) => typeof value === 'string' ? [[prefix + key, value]] : Object.entries(flatten(value, `${prefix}${key}.`))));
  }
  const en = flatten(load('en')), it = flatten(load('it'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(it).sort());
  for (const [key, value] of Object.entries(en)) {
    assert.ok(it[key].length > 0, key);
    const fields = text => [...text.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]).sort();
    assert.deepEqual(fields(value), fields(it[key]), key);
  }
});
