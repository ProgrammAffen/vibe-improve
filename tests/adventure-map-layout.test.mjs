import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ROUTE_NODES, validateRoute } from '../packages/domain/route-validation.mjs';
import { createRouteMapPages, MAX_PAGE_NODES, pawPlacement } from '../packages/map-layout/index.mjs';

const terrains = ['grassland', 'snow', 'ocean', 'desert', 'river-valley', 'volcanic-belt', 'forest', 'yardang', 'cavern'];

function routeWithLessons(sizes, id = 'map-lesson-layout') {
  return validateRoute({
    format: 'vibe-improve.route', schemaVersion: 1, id, revision: 1,
    title: 'Learning route', locale: 'en', sourceLanguage: 'en',
    chapters: sizes.map((size, index) => ({
      id: `chapter-${index + 1}`, title: `Chapter ${index + 1}`,
      nodes: Array.from({ length: size }, (_, lesson) => ({
        id: `lesson-${index + 1}-${lesson + 1}`, title: `Lesson ${lesson + 1}`,
        objectives: [{ id: 'goal', description: 'Learn the material' }], prerequisites: [], estimatedMinutes: 15,
      })),
    })),
  });
}

const markerCounts = pages => pages.map(page => page.totalChapters + page.totalLessons);

test('short routes use one page and dense cuts keep chapter landmarks and first lessons together', () => {
  assert.deepEqual(markerCounts(createRouteMapPages(routeWithLessons([1]))), [2]);
  const short = createRouteMapPages(routeWithLessons([9]));
  assert.deepEqual(short.map(({ themeId, totalChapters, totalLessons }) => [themeId, totalChapters, totalLessons]), [
    ['grassland', 1, 9],
  ]);
  const wholeChapters = createRouteMapPages(routeWithLessons([8, 9]));
  assert.deepEqual(markerCounts(wholeChapters), [9, 10]);
  assert(wholeChapters.every(page => !page.continuation));
  assert.deepEqual(markerCounts(createRouteMapPages(routeWithLessons([7, 9]))), [10, 8]);
  assert.deepEqual(markerCounts(createRouteMapPages(routeWithLessons(Array(9).fill(1)))), [10, 8]);
});

test('38 lessons fill the first page and use only the terrains required by density', () => {
  const oneChapter = createRouteMapPages(routeWithLessons([38]));
  assert.deepEqual(markerCounts(oneChapter), [10, 10, 10, 9]);
  assert.deepEqual(oneChapter.map(page => page.themeId), terrains.slice(0, 4));

  const sevenChapters = createRouteMapPages(routeWithLessons([4, 5, 6, 6, 6, 5, 6]));
  assert.deepEqual(markerCounts(sevenChapters), [9, 9, 9, 9, 9]);
  assert.equal(sevenChapters[0].nodes.length, 9);
});

test('an extra page is allowed when it keeps every page within 9–10 markers', () => {
  const pages = createRouteMapPages(routeWithLessons([8, 43, 46]));
  assert.equal(pages.length, 11);
  assert(markerCounts(pages).every(count => count >= 9 && count <= 10));
});

test('a 40-lesson chapter keeps only the last page below nine and continues without duplicate nodes', () => {
  const route = routeWithLessons([40]);
  const pages = createRouteMapPages(route);
  const originalIds = route.chapters[0].nodes.map(node => node.id);
  assert.deepEqual(markerCounts(pages), [9, 9, 9, 9, 5]);
  assert.deepEqual(pages.map(page => page.themeId), terrains.slice(0, 5));
  assert.deepEqual(pages.flatMap(page => page.lessonIds), originalIds);
  assert.equal(pages.reduce((total, page) => total + page.totalChapters, 0), 1);
  let consumedLessons = 0;
  for (const page of pages) {
    assert.equal(page.continuesToNextPage, page.pageNumber < pages.length);
    if (page.pageIndex) {
      assert.deepEqual(page.continuedChapter, {
        id: 'chapter-1', title: 'Chapter 1', number: 1,
        firstLesson: consumedLessons + 1, lastLesson: consumedLessons + page.totalLessons,
      });
    } else {
      assert.equal(page.continuedChapter, null);
    }
    consumedLessons += page.totalLessons;
  }
});

test('maximum validated lesson and chapter counts produce bounded, ordered pages and repeat terrains after nine', () => {
  const sizes = Array.from({ length: 24 }, (_, index) => index < 8 ? 22 : 21);
  const route = routeWithLessons(sizes, 'maximum-map-route');
  assert.equal(sizes.reduce((sum, count) => sum + count, 0), MAX_ROUTE_NODES);
  const pages = createRouteMapPages(route);
  assert.equal(pages.length, Math.ceil((MAX_ROUTE_NODES + sizes.length) / MAX_PAGE_NODES));
  assert.deepEqual(pages.flatMap(page => page.lessonIds), route.chapters.flatMap(chapter => chapter.nodes.map(node => node.id)));
  assert.deepEqual(pages.slice(0, 10).map(page => page.themeId), [...terrains, terrains[0]]);
  assert(pages.every(page => page.totalChapters + page.totalLessons <= MAX_PAGE_NODES && page.totalLessons > 0));
  assert.equal(pages.reduce((total, page) => total + page.totalChapters, 0), sizes.length);

  const lastPage = pages.at(-1);
  const lastNodes = lastPage.nodes;
  assert(lastNodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  assert.strictEqual(lastPage.nodes, lastNodes);
  assert.deepEqual(createRouteMapPages(route).at(-1).nodes, lastNodes);
});

test('chapter and lesson IDs that match remain distinct along the trail', () => {
  const route = routeWithLessons([2]);
  route.chapters[0].nodes[0].id = route.chapters[0].id;
  validateRoute(route);
  const [page] = createRouteMapPages(route);
  const [chapter, lesson] = page.nodes;
  assert.equal(chapter.id, lesson.id);
  assert.notEqual(chapter.key, lesson.key);
  assert.equal(page.paths[0].from, chapter.key);
  assert(page.paths.some(path => path.to === lesson.key));
  assert(page.paths.some(path => path.from === lesson.key));
  assert(Number.isFinite(pawPlacement(page, lesson).angle));
});
