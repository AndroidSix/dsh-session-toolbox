import test from 'node:test';
import assert from 'node:assert/strict';
import { dictionaries, resolveLanguage, translate } from '../src/locale.mjs';
import { guardSettings } from '../src/store.mjs';

test('language defaults to DSH and explicit choices override without changing the host', () => {
 assert.equal(guardSettings({}, 'settings').language, 'auto');
 for (const language of ['auto', 'zh', 'en']) assert.equal(guardSettings({ language }, 'settings').language, language);
 for (const language of ['fr', '', null, 1]) assert.throws(() => guardSettings({ language }, 'settings'), /language/);
 assert.equal(resolveLanguage('auto', 'en-US'), 'en');
 assert.equal(resolveLanguage('auto', 'zh-CN'), 'zh');
 assert.equal(resolveLanguage('auto', 'fr'), 'en');
 assert.equal(resolveLanguage('auto'), 'zh');
 assert.equal(resolveLanguage('zh', 'en'), 'zh');
 assert.equal(resolveLanguage('en', 'zh'), 'en');
});

test('Chinese and English have matching keys and placeholders, interpolating values literally', () => {
 assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
 for (const [key, value] of Object.entries(dictionaries.zh)) {
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  assert.deepEqual(placeholders(value), placeholders(dictionaries.en[key]), key);
  assert.equal(translate('en', key), dictionaries.en[key]);
 }
 assert.equal(translate('en', 'groups.summary', { groups: 2, projects: '<script>' }), '2 groups · <script> projects');
 assert.equal(translate('zh', 'common.save'), '保存');
 assert.equal(translate('en', 'common.save'), 'Save');
 assert.equal(translate('en', 'missing.key'), 'missing.key');
});
