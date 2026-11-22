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

test('short routes use one page and balanced cuts keep chapter landmarks and first lessons together', () => {
  assert.deepEqual(markerCounts(createRouteMapPages(routeWithLessons([1]))), [2]);
  const short = createRouteMapPages(routeWithLessons([8]));
  assert.deepEqual(short.map(({ themeId, totalChapters, totalLessons }) => [themeId, totalChapters, totalLessons]), [
    ['grassland', 1, 8],
  ]);
  const wholeChapters = createRouteMapPages(routeWithLessons([7, 8]));
  assert.deepEqual(markerCounts(wholeChapters), [8, 9]);
  assert(wholeChapters.every(page => !page.continuation));
  assert(createRouteMapPages(routeWithLessons([7, 9])).every(page => page.nodes.length <= MAX_PAGE_NODES));
  assert.deepEqual(markerCounts(createRouteMapPages(routeWithLessons(Array(9).fill(1)))), [6, 6, 6]);
});

test('38 lessons fill the first page and use only the terrains required by density', () => {
  const oneChapter = createRouteMapPages(routeWithLessons([38]));
  assert.deepEqual(markerCounts(oneChapter), [8, 8, 8, 8, 7]);
  assert.deepEqual(oneChapter.map(page => page.themeId), terrains.slice(0, 5));

  const sevenChapters = createRouteMapPages(routeWithLessons([4, 5, 6, 6, 6, 5, 6]));
  assert(sevenChapters.every(page => page.nodes.length >= 7 && page.nodes.length <= MAX_PAGE_NODES));
  assert.equal(sevenChapters[0].nodes.length, MAX_PAGE_NODES);
});

test('chapter-aware cuts keep dense pages within eight or nine markers', () => {
  const pages = createRouteMapPages(routeWithLessons([8, 43, 46]));
  assert.equal(pages.length, 12);
  assert(markerCounts(pages).every(count => count >= 8 && count <= MAX_PAGE_NODES));
});

test('a 40-lesson chapter balances its five pages and continues without duplicate nodes', () => {
  const route = routeWithLessons([40]);
  const pages = createRouteMapPages(route);
  const originalIds = route.chapters[0].nodes.map(node => node.id);
  assert.deepEqual(markerCounts(pages), [9, 8, 8, 8, 8]);
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
  assert(pages.length <= Math.ceil((MAX_ROUTE_NODES + sizes.length) / MAX_PAGE_NODES) + 1);
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

test('every page begins at a left corner and its last learning marker ends on the opposite vertical side', () => {
  const starts = new Set();
  const variants = [
    ...Array.from({length: 20}, (_, count) => [count + 1]),
    [4, 5, 6, 6, 6, 5, 6], Array(20).fill(5), Array(24).fill(1),
  ];
  for (const [index, sizes] of variants.entries()) {
    const pages = createRouteMapPages(routeWithLessons(sizes, 'opposed-corners-' + index));
    for (const page of pages) {
      const first = page.nodes[0], last = page.nodes.at(-1);
      assert.ok(page.nodes.length >= 2);
      assert.ok(first.x <= 370 && first.x < last.x);
      const upper = first.y <= 410 && last.y >= 660;
      const lower = first.y >= 660 && last.y <= 410;
      assert.ok(upper || lower, `${sizes} / page ${page.pageNumber}: ${first.y} -> ${last.y}`);
      starts.add(upper ? 'upper' : 'lower');
      assert.ok(page.spacing >= 125 - .01);
      if (page.compact) for (const path of page.paths) {
        assert.ok(path.start.x <= path.control1.x && path.control1.x <= path.control2.x && path.control2.x <= path.end.x);
      }
      if (page.finish) assert.ok(page.finish.x > last.x, 'The flag continues forward after the final lesson');
    }
  }
  assert.deepEqual([...starts].sort(), ['lower', 'upper']);
});
