import test from 'node:test';
import assert from 'node:assert/strict';
import {assertStudiedRouteUnchanged} from '../packages/domain/planning.mjs';

function lesson(id, prerequisites = []) {
  return {
    id, title: `Lesson ${id}`, estimatedMinutes: 30, prerequisites,
    objectives: [{id: `goal-${id}`, description: 'Apply the technique independently.'}],
    activities: ['Practice with a worked example.'],
    assessment: {task: 'Demonstrate the technique.', passCriteria: ['Show a correct result.'], objectiveIds: [`goal-${id}`]},
  };
}

function route() {
  return {
    format: 'vibe-improve.route', schemaVersion: 2, id: 'example-route', revision: 1,
    title: 'Synthetic route', locale: 'en', sourceLanguage: 'en',
    chapters: [
      {id: 'first', title: 'First chapter', stageGoal: 'Develop the skill.', nodes: [lesson('a'), lesson('b'), lesson('c', ['a'])]},
      {id: 'second', title: 'Second chapter', stageGoal: 'Apply the skill.', nodes: [lesson('d')]},
    ],
  };
}

const lockError = {message: 'PLANNING_STUDIED_LESSON_LOCKED'};

test('studied lesson contents, original chapter and stage goal are immutable', () => {
  const previous = route();
  const edits = [
    next => { next.chapters[0].nodes[2].title = 'Different lesson'; },
    next => { next.chapters[0].nodes[2].objectives[0].description = 'Change the learning objective.'; },
    next => { next.chapters[0].nodes[2].prerequisites = []; },
    next => { next.chapters[0].nodes[2].estimatedMinutes = 45; },
    next => { next.chapters[0].nodes[2].activities.push('Add another exercise.'); },
    next => { delete next.chapters[0].nodes[2].assessment; },
    next => { next.chapters[0].title = 'Renamed parent'; },
    next => { next.chapters[0].stageGoal = 'Replace the stage goal.'; },
    next => { next.chapters[0].id = 'new-parent'; },
    next => { next.chapters[1].nodes.push(next.chapters[0].nodes.pop()); },
    next => { next.chapters[0].nodes.pop(); },
    next => { next.chapters.shift(); },
    next => { next.id = 'replacement-route'; },
  ];
  for (const edit of edits) {
    const next = structuredClone(previous);
    edit(next);
    assert.throws(() => assertStudiedRouteUnchanged(previous, next, ['c']), lockError);
  }
  assert.throws(() => assertStudiedRouteUnchanged(previous, null, ['c']), lockError);
});

test('the relative order of studied lessons and their containing chapters is immutable', () => {
  const previous = route();
  const reversedLessons = structuredClone(previous);
  reversedLessons.chapters[0].nodes.reverse();
  assert.throws(() => assertStudiedRouteUnchanged(previous, reversedLessons, new Set(['a', 'c'])), lockError);
  const reversedChapters = structuredClone(previous);
  reversedChapters.chapters.reverse();
  assert.throws(() => assertStudiedRouteUnchanged(previous, reversedChapters, new Set(['a', 'd'])), lockError);
});

test('a draft cannot remove a prerequisite used by a studied lesson', () => {
  const previous = route();
  const next = structuredClone(previous);
  const [prerequisite] = next.chapters[0].nodes.splice(0, 1);
  assert.deepEqual(next.chapters[0].nodes.at(-1).prerequisites, ['a']);
  assert.throws(() => assertStudiedRouteUnchanged(previous, next, ['c']), lockError);

  prerequisite.title = 'Updated unstudied prerequisite';
  next.chapters[1].nodes.push(prerequisite);
  assert.doesNotThrow(() => assertStudiedRouteUnchanged(previous, next, ['c']));
});

test('unstudied edits, derived renumbering and object property order do not change studied content', () => {
  const previous = route();
  const next = structuredClone(previous);
  next.revision++;
  const protectedLesson = next.chapters[0].nodes[2];
  protectedLesson.assessment = Object.fromEntries(Object.entries(protectedLesson.assessment).reverse());
  next.chapters[0].nodes[2] = Object.fromEntries(Object.entries(protectedLesson).reverse());
  next.chapters[0].nodes[1].title = 'Changed unstudied sibling';
  next.chapters[0].nodes.unshift(lesson('new'));
  next.chapters[1].title = 'Changed unstudied chapter';
  next.chapters.unshift(next.chapters.pop());
  assert.doesNotThrow(() => assertStudiedRouteUnchanged(previous, next, ['c']));
});

test('no active studied lessons means the route can be replaced or removed', () => {
  const previous = route();
  assert.doesNotThrow(() => assertStudiedRouteUnchanged(previous, null, []));
  assert.doesNotThrow(() => assertStudiedRouteUnchanged(previous, null, ['historical-id']));
  assert.doesNotThrow(() => assertStudiedRouteUnchanged(undefined, previous, ['historical-id']));
  const next = structuredClone(previous);
  next.chapters[1].nodes.push(lesson('historical-id'));
  assert.doesNotThrow(() => assertStudiedRouteUnchanged(previous, next, ['c', 'historical-id']));
});
