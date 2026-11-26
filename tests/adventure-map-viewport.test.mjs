import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chapterSignBounds, createRouteMapPages, markerArtwork, routeMarkerGap, WIDTH} from '../packages/map-layout/index.mjs';

const terrains = ['grassland', 'snow', 'ocean', 'desert', 'river-valley', 'volcanic-belt', 'forest', 'yardang', 'cavern'];
const viewports = [
  {width: 1440, height: 960, top: 140, bottom: 98},
  {width: 1280, height: 800, top: 140, bottom: 98},
  {width: 2560, height: 1080, top: 146, bottom: 100},
  {width: 960, height: 540, top: 118, bottom: 80},
];
const route = (sizes, id) => ({id, chapters: sizes.map((size, chapter) => ({
  id: `chapter-${chapter}`, title: `Chapter ${chapter + 1}`,
  nodes: Array.from({length: size}, (_, lesson) => ({id: `lesson-${chapter}-${lesson}`, title: `Lesson ${lesson + 1}`})),
}))});

await mkdir('tmp/checks/map-viewport', {recursive: true});
const directory = await mkdtemp('tmp/checks/map-viewport/ui-'), bundle = resolve(directory, 'ui.mjs');
await build({stdin: {contents: `export {projectMapPage} from './apps/local-ui/src/components/adventure-map-viewport.ts';
 export {mapLessonBadgeBox} from './apps/local-ui/src/components/map-scene-frame.ts';`, resolveDir: process.cwd(), loader: 'ts'}, bundle: true,
  platform: 'node', format: 'esm', outfile: bundle});
const {projectMapPage, mapLessonBadgeBox} = await import(pathToFileURL(bundle).href);

const near = (a, b, label, epsilon = .25) => assert.ok(Math.abs(a - b) <= epsilon, `${label}: ${a} differs from ${b}`);
const envelope = boxes => ({
  left: Math.min(...boxes.map(box => box.left)), right: Math.max(...boxes.map(box => box.right)),
  top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)),
});
const target = viewport => {
  const scale = viewport.width / WIDTH;
  return {left: WIDTH * .1, right: WIDTH * .9,
    top: Math.max(viewport.height * .1, viewport.top) / scale,
    bottom: Math.min(viewport.height * .9, viewport.height - viewport.bottom) / scale};
};

function artworkBoxes(node, terrain) {
  if (node.kind === 'chapter') {
    const [left, top, right, bottom] = markerArtwork(terrain, 'landmark').bounds;
    const aspect = (right - left) / (bottom - top);
    const width = Math.min(node.width, node.height * aspect), height = width / aspect;
    return [{left: node.x - width / 2, right: node.x + width / 2, top: node.y - height, bottom: node.y},
      chapterSignBounds(node, terrain)];
  }
  return [{left: node.x - node.width / 2, right: node.x + node.width / 2,
    top: node.y - node.height / (node.kind === 'lesson' ? 2 : 1),
    bottom: node.y + (node.kind === 'lesson' ? node.height / 2 : 0)}];
}

function assertInside(box, area, label) {
  const tolerance = 3;
  assert.ok(box.left >= area.left - tolerance && box.right <= area.right + tolerance &&
    box.top >= area.top - tolerance && box.bottom <= area.bottom + tolerance,
  `${label}: ${JSON.stringify(box)} outside ${JSON.stringify(area)}`);
}

function curvePoints(paths) {
  const points = [];
  for (const path of paths) for (let step = 0; step <= 40; step++) {
    const t = step / 40, u = 1 - t;
    const coordinate = axis => u ** 3 * path.start[axis] + 3 * u ** 2 * t * path.control1[axis] +
      3 * u * t ** 2 * path.control2[axis] + t ** 3 * path.end[axis];
    points.push({x: coordinate('x'), y: coordinate('y')});
  }
  return points;
}

function learningContentBoxes(page) {
  return [...page.nodes.flatMap(node => artworkBoxes(node, page.themeId)),
    // Layout reserves the detached status badge for every lesson so completing
    // it later cannot shift the route. Its CSS top is independent of the size
    // clamp and must count toward the actual upper extent of learning content.
    ...page.nodes.filter(node => node.kind === 'lesson').map(mapLessonBadgeBox),
    ...curvePoints(page.paths).map(point => ({left: point.x, right: point.x, top: point.y, bottom: point.y}))];
}

function assertUsableRegionCoverage(page, area, label) {
  const width = area.right - area.left, height = area.bottom - area.top;
  const region = (left, top, right, bottom) => ({left: area.left + width * left, right: area.left + width * right,
    top: area.top + height * top, bottom: area.top + height * bottom});
  // These five patches occupy the clear arms and center of the corner-cut
  // region. Reaching a forbidden corner cannot stand in for reaching an arm.
  const regions = {
    left: region(0, .38, .15, .62), right: region(.85, .38, 1, .62),
    top: region(.3, 0, .7, .1), bottom: region(.3, .9, .7, 1),
    center: region(.4, .4, .6, .6),
  };
  const content = learningContentBoxes(page);
  for (const [name, target] of Object.entries(regions)) {
    const distance = Math.min(...content.map(box => Math.hypot(
      Math.max(target.left - box.right, box.left - target.right, 0) / width,
      Math.max(target.top - box.bottom, box.top - target.bottom, 0) / height,
    )));
    assert.ok(distance <= .14, `${label} / ${name} clear region is empty (normalized distance ${distance})`);
  }
}

function assertPageSafety(page, viewport, label) {
  const area = target(viewport);
  const markers = [...page.nodes, ...(page.finish ? [page.finish] : [])];
  const boxes = markers.map(node => artworkBoxes(node, page.themeId));
  for (let index = 0; index < boxes.length; index++) for (const box of boxes[index]) {
    assertInside(box, area, `${label} / ${markers[index].key}`);
    for (let previous = 0; previous < index; previous++) for (const other of boxes[previous]) {
      const overlapWidth = Math.min(box.right, other.right) - Math.max(box.left, other.left);
      const overlapHeight = Math.min(box.bottom, other.bottom) - Math.max(box.top, other.top);
      assert.ok(overlapWidth <= 2 || overlapHeight <= 2,
        `${label}: artwork overlaps ${markers[index].key} and ${markers[previous].key} (${overlapWidth} × ${overlapHeight})`);
    }
  }
  const paths = [...page.paths, ...page.finishPaths];
  for (const point of curvePoints(paths)) assertInside({left: point.x, right: point.x, top: point.y, bottom: point.y}, area, label + ' / trail');
  const first = page.nodes[0], last = page.nodes.at(-1);
  assert.ok(first.x < last.x, label + ' / route must proceed from the left');
  const learning = envelope(page.nodes.flatMap(node => artworkBoxes(node, page.themeId)));
  const middle = (learning.top + learning.bottom) / 2;
  assert.ok((first.y < middle) !== (last.y < middle), label + ' / endpoints must occupy opposite vertical sides');
  for (let leg = 0; leg < page.nodes.length - 1; leg++) {
    near(routeMarkerGap(page.nodes.slice(leg, leg + 2), page.paths.filter(path => path.leg === leg), page.themeId), page.spacing, label + ' / equal visible gaps');
  }
  near(page.paths[0].start.x, first.x, label + ' / beginning');
  near(page.paths.at(-1).end.x, last.x, label + ' / ending');
  if (page.finish) {
    near(page.finishPaths[0].start.x, last.x, label + ' / flag connection x');
    near(page.finishPaths[0].start.y, last.y, label + ' / flag connection y');
    near(page.finishPaths.at(-1).end.x, page.finish.x, label + ' / flag ending x');
    near(page.finishPaths.at(-1).end.y, page.finish.y, label + ' / flag ending y');
  }
  return {area, learning};
}

test('map pages use the central eighty percent across nine terrains and window shapes', () => {
  const original = route(Array(20).fill(5), 'central-eighty-spatial-coverage');
  const pages = createRouteMapPages(original);
  assert.deepEqual(pages.slice(0, 9).map(page => page.themeId), terrains);
  assert.deepEqual(pages.flatMap(page => page.lessonIds), original.chapters.flatMap(chapter => chapter.nodes.map(node => node.id)));
  for (const page of pages) for (const viewport of viewports) {
    const projected = projectMapPage(page, viewport).page;
    const label = `${page.themeId} / page ${page.pageNumber} / ${viewport.width}×${viewport.height}`;
    const {area, learning} = assertPageSafety(projected, viewport, label);
    if (!page.compact && page.nodes.length >= 8) {
      assert.ok((learning.right - learning.left) / (area.right - area.left) >= .7, label + ' / horizontal chapter coverage');
      const content = envelope(learningContentBoxes(projected));
      assert.ok((content.bottom - content.top) / (area.bottom - area.top) >= .82, label + ' / vertical content coverage');
      assertUsableRegionCoverage(projected, area, label);
    }
    const centerX = (area.left + area.right) / 2, centerY = (area.top + area.bottom) / 2;
    const occupied = new Set(projected.nodes.map(node => `${Number(node.x >= centerX)}:${Number(node.y >= centerY)}`));
    assert.equal(occupied.size, 4, label + ' / learning markers must occupy all four quadrants');
    assert.deepEqual(projected.nodes.map(node => node.key), page.nodes.map(node => node.key));
    assert.deepEqual(projectMapPage(page, viewport).page, projected, label + ' / projection must be deterministic');
  }
});

test('lesson-only continuation pages use the upper space without reserving an absent chapter', () => {
  const pages = createRouteMapPages(route([100], 'central-eighty-lessons-only'));
  let checked = 0;
  for (const page of pages.filter(page => !page.finish && page.nodes.every(node => node.kind === 'lesson'))) {
    for (const viewport of viewports) {
      const projected = projectMapPage(page, viewport).page;
      const {area} = assertPageSafety(projected, viewport, `continuation ${page.pageNumber} / ${viewport.width}`);
      const content = envelope(learningContentBoxes(projected));
      assert.ok(content.top - area.top <= (area.bottom - area.top) * .08,
        'A lesson-only page must not reserve the height of a chapter landmark above its first footprint');
      checked++;
    }
  }
  assert.ok(checked >= 9 * viewports.length);
});

test('short terminal pages expand forward safely and keep their learning order', () => {
  for (const sizes of [[1], [2], [3], [4], [10], [12], [14], [16], [40]]) {
    const pages = createRouteMapPages(route(sizes, 'central-eighty-sparse-' + sizes.join('-'))), source = pages.at(-1);
    for (const viewport of viewports) {
      const projected = projectMapPage(source, viewport).page;
      assertPageSafety(projected, viewport, `sparse ${sizes} / ${viewport.width}`);
      assert.deepEqual(projected.nodes.map(node => node.key), source.nodes.map(node => node.key));
      if (source.compact) for (const path of projected.paths) {
        assert.ok(path.start.x <= path.control1.x && path.control1.x <= path.control2.x && path.control2.x <= path.end.x,
          'Sparse page curves must extend forward rather than turn back to the beginning');
      }
      assert.ok(projected.finish.x > projected.nodes.at(-1).x);
    }
  }
});

test('wide terminal pages keep tall landmarks, chapter signs and nearby footprints from overlapping', () => {
  const viewport = {width: 2560, height: 1080, top: 146, bottom: 100};
  for (const [id, chapterCount, pageNumber, terrain] of [
    ['central-stress-18-2', 24, 5, 'river-valley'],
    ['central-stress-20-3', 15, 3, 'ocean'],
  ]) {
    const pages = createRouteMapPages(route(Array(chapterCount).fill(1), id));
    const source = pages[pageNumber - 1];
    assert.equal(source.themeId, terrain);
    assert.ok(source.finish, 'The regression fixture must include the terminal flag');
    const projected = projectMapPage(source, viewport).page;
    assertPageSafety(projected, viewport, `${id} / page ${pageNumber} / wide screen`);
    assert.deepEqual(projected.nodes.map(node => node.key), source.nodes.map(node => node.key));
  }
});
