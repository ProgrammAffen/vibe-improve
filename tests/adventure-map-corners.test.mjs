import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {chapterSignBounds, createRouteMapPages, markerArtwork, routeMarkerGap, WIDTH} from '../packages/map-layout/index.mjs';

const viewports = [
  {width: 1280, height: 800, top: 140, bottom: 98},
  {width: 1440, height: 960, top: 140, bottom: 98},
  {width: 2560, height: 1080, top: 146, bottom: 100},
  {width: 960, height: 540, top: 118, bottom: 80},
];
const terrains = ['grassland', 'snow', 'ocean', 'desert', 'river-valley', 'volcanic-belt', 'forest', 'yardang', 'cavern'];
const route = (sizes, id) => ({id, chapters: sizes.map((size, chapter) => ({
  id: `chapter-${chapter}`, title: `Chapter ${chapter + 1}`,
  nodes: Array.from({length: size}, (_, lesson) => ({id: `lesson-${chapter}-${lesson}`, title: `Lesson ${lesson + 1}`})),
}))});

await mkdir('tmp/checks/map-corners', {recursive: true});
const directory = await mkdtemp('tmp/checks/map-corners/ui-'), bundle = resolve(directory, 'ui.mjs');
await build({stdin: {contents: `export {projectMapPage} from './apps/local-ui/src/components/adventure-map-viewport.ts';
  export {mapCornerExclusions, MAP_BACKGROUND_SOURCE, MAP_BACKGROUND_DESTINATION, MAP_CORNER_WIDTH, MAP_CORNER_HEIGHT} from './apps/local-ui/src/components/map-scene-frame.ts';`,
  resolveDir: process.cwd(), loader: 'ts'}, bundle: true, platform: 'node', format: 'esm', outfile: bundle});
const {projectMapPage, mapCornerExclusions, MAP_BACKGROUND_SOURCE, MAP_BACKGROUND_DESTINATION, MAP_CORNER_WIDTH, MAP_CORNER_HEIGHT} = await import(pathToFileURL(bundle).href);

const near = (a, b, label, epsilon = .3) => assert.ok(Math.abs(a - b) <= epsilon, `${label}: ${a} differs from ${b}`);
const overlaps = (a, b, epsilon = .05) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > epsilon &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > epsilon;
function artwork(node, terrain) {
  if (node.kind === 'chapter') {
    const [left, top, right, bottom] = markerArtwork(terrain, 'landmark').bounds;
    const aspect = (right - left) / (bottom - top), width = Math.min(node.width, node.height * aspect);
    return [{left: node.x - width / 2, right: node.x + width / 2, top: node.y - width / aspect, bottom: node.y},
      chapterSignBounds(node, terrain)];
  }
  return [{left: node.x - node.width / 2, right: node.x + node.width / 2,
    top: node.y - node.height / (node.kind === 'lesson' ? 2 : 1),
    bottom: node.y + (node.kind === 'lesson' ? node.height / 2 : 0)}];
}
const frame = viewport => {
  const scale = viewport.width / WIDTH;
  return {left: WIDTH * .1, right: WIDTH * .9,
    top: Math.max(viewport.height * .1, viewport.top) / scale,
    bottom: Math.min(viewport.height * .9, viewport.height - viewport.bottom) / scale};
};
function pathPoints(paths) {
  const points = [];
  for (const path of paths) {
    const length = Math.hypot(path.start.x - path.control1.x, path.start.y - path.control1.y) +
      Math.hypot(path.control1.x - path.control2.x, path.control1.y - path.control2.y) +
      Math.hypot(path.control2.x - path.end.x, path.control2.y - path.end.y);
    const steps = Math.max(2, Math.ceil(length / 12));
    for (let step = 0; step <= steps; step++) {
      if (step === 0 && points.length) continue;
      const t = step / steps, u = 1 - t;
      const at = axis => u ** 3 * path.start[axis] + 3 * u * u * t * path.control1[axis] +
        3 * u * t * t * path.control2[axis] + t ** 3 * path.end[axis];
      points.push({x: at('x'), y: at('y')});
    }
  }
  return points;
}
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
function selfIntersects(points) {
  for (let i = 1; i < points.length; i++) for (let j = i + 2; j < points.length; j++) {
    const a = points[i - 1], b = points[i], c = points[j - 1], d = points[j];
    if (cross(a, b, c) * cross(a, b, d) < -.00001 && cross(c, d, a) * cross(c, d, b) < -.00001) return true;
  }
  return false;
}

function assertSafe(source, viewport, label) {
  const projected = projectMapPage(source, viewport), page = projected.page;
  const area = frame(viewport), corners = mapCornerExclusions(projected.height);
  const nodes = [...page.nodes, ...(page.finish ? [page.finish] : [])], boxes = nodes.map(node => artwork(node, page.themeId));
  for (let index = 0; index < nodes.length; index++) for (const box of boxes[index]) {
    assert.ok(box.left >= area.left - .5 && box.right <= area.right + .5 && box.top >= area.top - .5 && box.bottom <= area.bottom + .5,
      `${label}: ${nodes[index].key} escapes the navigation-safe central region ${JSON.stringify(box)}`);
    assert.ok(!corners.some(corner => overlaps(box, corner)),
      `${label}: ${nodes[index].key} occupies a decorated corner ${JSON.stringify(box)}`);
    for (let previous = 0; previous < index; previous++) assert.ok(!boxes[previous].some(other => overlaps(box, other, 1)),
      `${label}: ${nodes[index].key} overlaps ${nodes[previous].key}`);
  }
  assert.deepEqual(page.nodes.map(node => node.key), source.nodes.map(node => node.key), label + ' / chapter order');
  const first = page.nodes[0], last = page.nodes.at(-1);
  assert.ok(first.x < WIDTH / 2 && first.x < last.x, label + ' / beginning stays on the left');
  assert.equal(first.y < last.y, source.nodes[0].y < source.nodes.at(-1).y, label + ' / opposed endpoint direction');
  const points = pathPoints([...page.paths, ...page.finishPaths]);
  assert.ok(!selfIntersects(points), label + ' / no curve crossings');
  for (const point of points) assert.ok(point.x >= area.left - .5 && point.x <= area.right + .5 && point.y >= area.top - .5 && point.y <= area.bottom + .5,
    label + ' / trail stays in the navigation-safe region');
  for (let leg = 0; leg < page.nodes.length - 1; leg++) near(routeMarkerGap(page.nodes.slice(leg, leg + 2),
    page.paths.filter(path => path.leg === leg), page.themeId), page.spacing, label + ' / uniform visible spacing');
  if (source.compact || source.nodes.length <= 5) for (const path of page.paths) {
    assert.ok(path.start.x <= path.control1.x + .001 && path.control1.x <= path.control2.x + .001 && path.control2.x <= path.end.x + .001,
      label + ' / sparse trail must unfold without reversing');
  }
  near(page.paths[0].start.x, first.x, label + ' / connected beginning');
  near(page.paths.at(-1).end.y, last.y, label + ' / connected ending');
  if (page.finish) {
    near(page.finishPaths[0].start.x, last.x, label + ' / flag tail x');
    near(page.finishPaths[0].start.y, last.y, label + ' / flag tail y');
    near(page.finishPaths.at(-1).end.x, page.finish.x, label + ' / flag end x');
    near(page.finishPaths.at(-1).end.y, page.finish.y, label + ' / flag end y');
  }
  assert.deepEqual(projectMapPage(source, viewport), projected, label + ' / stable reopening');
  return page;
}

test('decorated corner exclusions share the reduced background rim geometry', () => {
  near(MAP_CORNER_WIDTH, .235, 'corner width', .000001);
  near(MAP_CORNER_HEIGHT, .245, 'corner height', .000001);
  assert.ok(MAP_BACKGROUND_DESTINATION[1] < MAP_BACKGROUND_SOURCE[1], 'Corner scenery occupies a smaller screen area');
  near(MAP_BACKGROUND_DESTINATION[1], .21, 'reduced corner scenery', .000001);
  const corners = mapCornerExclusions(1000);
  assert.equal(corners.length, 4);
  near(corners[0].right, WIDTH * .235, 'top-left width');
  near(corners[0].bottom, 245, 'top-left depth');
  near(corners[3].left, WIDTH * .765, 'bottom-right width');
  near(corners[3].top, 755, 'bottom-right depth');
});

test('chapter art and signs avoid all four corners on every terrain and window shape', () => {
  const original = route(Array(20).fill(5), 'corner-clearance-nine-terrains'), pages = createRouteMapPages(original);
  assert.deepEqual(pages.slice(0, 9).map(page => page.themeId), terrains);
  assert.deepEqual(pages.flatMap(page => page.lessonIds), original.chapters.flatMap(chapter => chapter.nodes.map(node => node.id)));
  for (const source of pages) for (const viewport of viewports) assertSafe(source, viewport,
    `${source.themeId} / page ${source.pageNumber} / ${viewport.width}×${viewport.height}`);
});

test('short, mixed and dense chapter maps keep corner clearance without changing learning order', () => {
  for (const sizes of [[1], [2], [3], [4], [11], [38], [1, 3, 2, 1, 4], Array(15).fill(1)]) {
    const pages = createRouteMapPages(route(sizes, 'corner-mixed-' + sizes.join('-')));
    for (const source of pages) for (const viewport of [viewports[0], viewports[2]]) assertSafe(source, viewport,
      `${sizes.join('-')} / page ${source.pageNumber} / ${viewport.width}×${viewport.height}`);
  }
});

for (const [label, id, sizes, pageNumber, viewport] of [
  ['finish flag clears the last footprint', 'corner-stress-6-2', Array(24).fill(1), 5, viewports[0]],
  ['mixed chapter landmark clears its neighboring footprint', 'corner-stress-7-1', [1, 4, 1, 2, 3, 1, 5], 1, viewports[2]],
]) {
  test('corner-aware ' + label, () => {
    const source = createRouteMapPages(route(sizes, id))[pageNumber - 1];
    assertSafe(source, viewport, `${id} / page ${pageNumber} / ${viewport.width}`);
  });
}

test('a narrow corner-constrained continuation chooses a wider deterministic guide',()=>{
  const source=createRouteMapPages(route([8,43,46],'central-stress-22-0'))[10];
  const page=assertSafe(source,viewports[2],'narrow continuation replacement');
  const boxes=page.nodes.flatMap(node=>artwork(node,page.themeId));
  const width=Math.max(...boxes.map(box=>box.right))-Math.min(...boxes.map(box=>box.left));
  assert.ok(width/(WIDTH*.8)>=.7,'Corner clearance must not collapse a normal page into a narrow middle strip');
});
