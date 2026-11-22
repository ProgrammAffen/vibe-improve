import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';

await mkdir('tmp/checks/map-state', {recursive: true});
const directory = await mkdtemp('tmp/checks/map-state/ui-'), bundle = resolve(directory, 'ui.mjs');
await build({stdin: {contents: `export {AdventureMap,SkipLessonConfirmation} from './apps/local-ui/src/components/AdventureMap.tsx';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`, resolveDir: process.cwd(), loader: 'tsx'}, bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: {'.css': 'empty'}, define: {'import.meta.env.BASE_URL': '"/vibe-improve/"'}, outfile: bundle});
const {AdventureMap, SkipLessonConfirmation, renderToStaticMarkup, createElement} = await import(pathToFileURL(bundle).href);
const no = () => {};

test('skip confirmation asks one question without a reason field and is immediately confirmable', () => {
  for (const language of ['zh-CN', 'en']) {
    const html = renderToStaticMarkup(createElement(SkipLessonConfirmation, {language, saving: false, failed: false, canSkip: true, onConfirm: no, onCancel: no}));
    assert.match(html, language === 'en' ? /Skip this lesson\?/ : /确定跳过本节吗？/);
    assert.doesNotMatch(html, /textarea|<input|required|Reason for skipping|跳过原因|prerequisite|前置/);
    assert.match(html, /<button[^>]*type="submit"(?![^>]*disabled)[^>]*>/);
    const saving = renderToStaticMarkup(createElement(SkipLessonConfirmation, {language, saving: true, failed: false, canSkip: true, onConfirm: no, onCancel: no}));
    assert.match(saving, /<button[^>]*disabled=""[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled=""/);
    const failed = renderToStaticMarkup(createElement(SkipLessonConfirmation, {language, saving: false, failed: true, canSkip: true, onConfirm: no, onCancel: no}));
    assert.match(failed, /role="alert"/);
    assert.doesNotMatch(failed, /textarea/);
  }
});

test('completed and skipped lessons are gold while current and locked lessons retain their terrain appearance', () => {
  const route = {format: 'vibe-improve.route', schemaVersion: 2, id: 'synthetic-map-states', revision: 1, title: 'Learning progress', locale: 'en', sourceLanguage: 'en', chapters: [{id: 'chapter', title: 'Chapter', stageGoal: 'Learn independently.', nodes: Array.from({length: 4}, (_, index) => ({id: 'lesson-' + index, title: 'Lesson ' + index, estimatedMinutes: 30, prerequisites: index ? ['lesson-' + (index - 1)] : [], objectives: [{id: 'goal', description: 'Apply the idea.'}]}))}]};
  for (const language of ['zh-CN', 'en']) {
    const html = renderToStaticMarkup(createElement(AdventureMap, {route, language, onStartLesson: no, onEdit: no, onBack: no, onResetLearning: no, completedNodeIds: new Set(['lesson-0']), skippedReasons: new Map([['lesson-1', '']])}));
    assert.equal((html.match(/data-tone="gold"/g) ?? []).length, 2);
    assert.equal((html.match(/data-tone="terrain"/g) ?? []).length, 2);
    assert.equal((html.match(/data-status="complete"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="skipped"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="locked"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="current"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /清空学习记录并编辑|Clear progress &amp; edit/);
    assert.match(html, language === 'en' ? /Lesson 1 · Skipped/ : /Lesson 1 · 已跳过/);
  }
});
