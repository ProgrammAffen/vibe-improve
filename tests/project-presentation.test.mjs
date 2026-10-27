import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = await readFile(new URL('../apps/local-ui/src/projects/presentation.ts', import.meta.url), 'utf8');
function load(intl = Intl) {
  const module = {exports: {}};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, {module, exports: module.exports, Intl: intl});
  return module.exports.projectNameLabel;
}
const label = load();
test('project labels keep 15 characters and preserve the full name as data', () => {
  for (const value of ['', 'Python', '中'.repeat(15), 'a'.repeat(15)]) assert.equal(label(value), value);
  for (const value of ['中'.repeat(16), 'a'.repeat(80)]) {
    assert.equal(label(value), [...value].slice(0, 15).join('') + '…');
    assert.ok(value.length > 15);
  }
});
test('project labels never split an emoji or an accented grapheme', () => {
  for (const character of ['😀', 'e\u0301', '👩‍💻', '🇨🇳']) {
    assert.equal(label(character.repeat(15)), character.repeat(15));
    assert.equal(label(character.repeat(16)), character.repeat(15) + '…');
  }
  assert.equal(load({})('😀'.repeat(16)), '😀'.repeat(15) + '…');
});
