import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {preparePdfResources, packageEditorLicenses} from '../scripts/package-editor-resources.mjs';

test('offline lesson builds carry PDF character maps, decoders, fonts and dependency attribution', async () => {
  await mkdir('tmp/checks', {recursive: true});
  const target = await mkdtemp('tmp/checks/lesson-editor-package-');
  await preparePdfResources(process.cwd(), target);
  for (const file of ['cmaps/Adobe-GB1-UCS2.bcmap', 'standard_fonts/FoxitSerif.pfb', 'wasm/openjpeg.wasm', 'iccs/LICENSE']) {
    assert.ok((await stat(join(target, 'pdfjs', file))).size > 0, file);
  }
  const entries = await packageEditorLicenses(process.cwd(), join(target, 'licenses'));
  assert.equal(entries.find(entry => entry.name === 'pdfjs-dist').license, 'Apache-2.0');
  for (const entry of entries) for (const notice of entry.notices) assert.ok((await readFile(join(target, 'licenses', entry.name.replaceAll('/', '__'), notice))).length);
  assert.ok(entries.some(entry => entry.name === '@tiptap/extension-mathematics' && entry.license === 'MIT'));
  const native = await readFile(resolve('apps/macos/main.swift'), 'utf8');
  assert.match(native, /"mjs":"text\/javascript/);
  assert.match(native, /"wasm":"application\/wasm"/);
});
