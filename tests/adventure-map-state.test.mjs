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

test('completed and skipped lessons deepen their terrain colors while current and locked lessons retain their terrain appearance', () => {
  const route = mapRoute([
    mapLesson('lesson-0', 'Lesson 0'),
    mapLesson('lesson-1', 'Lesson 1', ['lesson-0']),
    mapLesson('lesson-2', 'Lesson 2', ['lesson-1']),
    mapLesson('lesson-3', 'Lesson 3'),
  ]);
  for (const language of ['zh-CN', 'en']) {
    const html = renderMap(route, {language, completedNodeIds: new Set(['lesson-0']), skippedReasons: new Map([['lesson-1', '']])});
    assert.equal((html.match(/data-tone="deep"/g) ?? []).length, 2);
    assert.equal((html.match(/data-tone="terrain"/g) ?? []).length, 2);
    assert.equal((html.match(/data-status="complete"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="skipped"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="locked"/g) ?? []).length, 1);
    assert.equal((html.match(/data-status="current"/g) ?? []).length, 1);
    assert.doesNotMatch(html, /清空学习记录并编辑|Clear progress &amp; edit/);
    assert.match(html, language === 'en' ? /Lesson 1 · Skipped/ : /Lesson 1 · 已跳过/);
    assert.match(html, language === 'en' ? /Lesson 2 · Locked/ : /Lesson 2 · 未解锁/);
  }
});

test('every explicitly assigned prerequisite must be complete or mastered, even an elective', () => {
  const route = mapRoute([
    mapLesson('optional', 'Elective foundation', [], 'optional'),
    mapLesson('required', 'Required foundation'),
    mapLesson('dependent', 'Dependent', ['optional', 'required']),
    mapLesson('prior-skip', 'Previously skipped dependent', ['optional', 'required']),
  ]);
  const oldSkips = new Map([['optional', ''], ['prior-skip', 'older route skip']]);
  const afterSkip = renderMap(route, {skippedReasons: oldSkips});
  assert.match(afterSkip, /Elective foundation · Skipped/);
  assert.match(afterSkip, /aria-label="Dependent · Locked"/);
  assert.match(afterSkip, /Previously skipped dependent · Locked/);

  const afterRequired = renderMap(route, {skippedReasons: oldSkips, completedNodeIds: new Set(['required'])});
  assert.match(afterRequired, /aria-label="Dependent · Locked"/);

  const satisfied = renderMap(route, {
    skippedReasons: new Map([['prior-skip', 'older route skip']]),
    completedNodeIds: new Set(['required']),
    masteredNodeIds: new Set(['optional']),
  });
  assert.match(satisfied, /Elective foundation · Mastered/);
  assert.match(satisfied, /aria-label="Dependent · Current lesson"/);
  assert.match(satisfied, /Previously skipped dependent · Skipped/);
});

test('required mastery counts toward route progress and has its own accessible marker', () => {
  const route = mapRoute([
    mapLesson('complete', 'Completed foundation'),
    mapLesson('mastered', 'Known foundation'),
    mapLesson('dependent', 'Dependent', ['complete', 'mastered']),
  ]);
  const html = renderMap(route, {completedNodeIds: new Set(['complete']), masteredNodeIds: new Set(['mastered'])});
  assert.match(html, /<progress max="3" value="2" aria-label="Required progress"/);
  assert.match(html, /aria-label="Known foundation · Mastered"[^>]*data-status="mastered"/);
  assert.equal((html.match(/data-tone="deep"/g) ?? []).length, 2);
  assert.match(html, /aria-label="Dependent · Current lesson"/);
});

function mapRoute(nodes) {
  return {
    format: 'vibe-improve.route', schemaVersion: 2, id: 'synthetic-map-states', revision: 1,
    title: 'Learning progress', locale: 'en', sourceLanguage: 'en',
    chapters: [{id: 'chapter', title: 'Chapter', stageGoal: 'Learn independently.', nodes}],
  };
}

function mapLesson(id, title, prerequisites = [], requirement = 'required') {
  return {id, title, estimatedMinutes: 30, prerequisites, requirement, objectives: [{id: 'goal', description: 'Apply the idea.'}]};
}

function renderMap(route, progress) {
  return renderToStaticMarkup(createElement(AdventureMap, {route, language: 'en', onStartLesson: no, onEdit: no, onBack: no, ...progress}));
}
