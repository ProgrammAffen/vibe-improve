import assert from 'node:assert/strict';
import test from 'node:test';
import {createRouteMapPages, MAX_PAGE_NODES, routeMarkerGap} from '../packages/map-layout/index.mjs';
import {curvePoint} from '../packages/map-layout/route-spacing.mjs';
import {random} from '../packages/map-layout/route-layout.mjs';
import {randomRouteCurves} from '../packages/map-layout/random-curves.mjs';

const route = (sizes, id = 'route_map_demo_20_chapters_100_lessons') => ({
  id, chapters: sizes.map((count, ch) => ({id: `demo_chapter_${ch + 1}`, title: `Chapter ${ch + 1}`,
    nodes: Array.from({length: count}, (_, n) => ({id: `demo_lesson_${ch + 1}_${n + 1}`, title: `Lesson ${n + 1}`}))})),
});
const paths = page => [...page.paths, ...page.finishPaths];
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function samples(curve) {
  return [curve[0].start, ...curve.flatMap(path => Array.from({length: 20}, (_, i) => curvePoint(path, (i + 1) / 20)))];
}
function turningAmount(curve) {
  const points = samples(curve), headings = points.slice(1).map((p, i) => Math.atan2(p.y - points[i].y, p.x - points[i].x));
  return headings.slice(1).reduce((sum, heading, i) => {
    const change = heading - headings[i];
    return sum + Math.abs(Math.atan2(Math.sin(change), Math.cos(change)));
  }, 0) / (Math.PI / 2);
}
function crossesItself(curve) {
  const points = samples(curve);
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < points.length - 1; i++) for (let j = i + 2; j < points.length - 1; j++) {
    const a = points[i], b = points[i + 1], c = points[j], d = points[j + 1];
    if (cross(a, b, c) * cross(a, b, d) < -1e-8 && cross(c, d, a) * cross(c, d, b) < -1e-8) return true;
  }
  return false;
}

// Compare the visible trace at equal travel distances, including mirrored copies.
function trace(page) {
  const points = [{...paths(page)[0].start, at: 0}];
  for (const path of paths(page)) for (let i = 1; i <= 24; i++) {
    const next = curvePoint(path, i / 24), previous = points.at(-1);
    points.push({...next, at: previous.at + distance(next, previous)});
  }
  const result = [];
  let index = 1;
  for (let i = 0; i < 25; i++) {
    const at = points.at(-1).at * i / 24;
    while (index < points.length - 1 && points[index].at < at) index++;
    const a = points[index - 1], b = points[index], t = (at - a.at) / (b.at - a.at);
    result.push({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});
  }
  const cx = result.reduce((sum, p) => sum + p.x, 0) / result.length;
  const cy = result.reduce((sum, p) => sum + p.y, 0) / result.length;
  return result.map(p => ({x: p.x - cx, y: p.y - cy}));
}
function difference(a, b) {
  let best = Infinity;
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const reverse of [false, true]) {
    best = Math.min(best, Math.sqrt(a.reduce((sum, point, i) => {
      const other = b[reverse ? b.length - 1 - i : i];
      return sum + (point.x - other.x * x) ** 2 + (point.y - other.y * y) ** 2;
    }, 0) / a.length));
  }
  return best;
}

test('full ten-marker pages vary their curve shape across the 20-chapter, 100-lesson route', () => {
  const pages = createRouteMapPages(route(Array(20).fill(5))), traces = pages.map(trace);
  assert.equal(pages.length, 12);
  assert.ok(pages.every(page => page.nodes.length === MAX_PAGE_NODES));
  assert.equal(pages.flatMap(page => page.lessonIds).length, 100);
  const turns = pages.map(page => Math.round(turningAmount(paths(page))));
  assert.ok(new Set(turns).size >= 3, `The route needs different numbers of bends: ${turns}`);
  assert.ok(pages.filter(page => page.paths.some(path => path.end.x < path.start.x - 1)).length >= 2,
    'Random walks should include local returns as well as forward progress');
  for (const page of pages) {
    assert.ok(page.nodes[0].x < page.nodes.at(-1).x, 'The overall route should still progress toward the right');
    assert.equal(crossesItself(paths(page)), false, `Page ${page.pageNumber} crosses itself`);
  }
  for (let i = 1; i < traces.length; i++) assert.ok(difference(traces[i - 1], traces[i]) > 35, `Pages ${i} and ${i + 1} are too similar`);
  for (let i = 9; i < traces.length; i++) assert.ok(difference(traces[i - 9], traces[i]) > 35, `Terrain repeat on page ${i + 1} reused its curve`);
});

test('random waypoints support different requested turn counts, irregular bends and stable seeds', () => {
  for (const turns of [4,5,6,7]) {
    const variants = new Set();
    for (let seed = 0; seed < 16; seed++) {
      const generated = randomRouteCurves(random(seed), turns, 6);
      assert.equal(generated.turns, turns);
      assert.equal(generated.waypoints.length, turns + 2);
      assert.ok(Math.abs(turningAmount(generated.paths) - turns) < 1.1);
      assert.deepEqual(randomRouteCurves(random(seed), turns, 6), generated);
      variants.add(JSON.stringify(generated.waypoints));
      const lengths = generated.waypoints.slice(1).map((point, i) => distance(point, generated.waypoints[i]));
      assert.ok(Math.max(...lengths) - Math.min(...lengths) > 30, 'Bend positions should not form equally spaced periodic waves');
    }
    assert.ok(variants.size >= 14);
  }
});

test('full pages place learning markers throughout the upper and lower areas on both sides', () => {
  const variants = [
    Array(15).fill(1), Array(24).fill(2), Array(20).fill(5),
    Array.from({length: 24}, (_, index) => [1, 2, 3, 5, 1, 4, 9, 8][index % 8]),
  ];
  for (const [index, sizes] of variants.entries()) {
    for (const page of createRouteMapPages(route(sizes, 'coverage-regression-' + index))) {
      if (page.totalChapters + page.totalLessons < 8) continue;
      for (const x of [350, 1280]) for (const y of [365, 720]) {
        const nearest = Math.min(...page.nodes.map(node => Math.hypot(node.x - x, node.y - y)));
        assert.ok(nearest < 230, `Page ${page.pageNumber} leaves the area near ${x},${y} empty`);
      }
    }
  }
});

test('page layouts stay deterministic when opening the last page first or jumping backward', () => {
  const sample = route(Array(20).fill(5));
  const forward = createRouteMapPages(sample).map(page => ({nodes: page.nodes, paths: paths(page)}));
  const jumped = createRouteMapPages(sample);
  for (const index of [11, 9, 6, 1, 10, 0, 5, 3, 8, 4, 2, 7])
    assert.deepEqual({nodes: jumped[index].nodes, paths: paths(jumped[index])}, forward[index]);
  const other = createRouteMapPages({...sample, id: 'a-different-learning-route'});
  assert.notDeepEqual(other[0].paths, forward[0].paths);
});

test('all curve families retain continuous tangents, equal lesson gaps and the single final flag', () => {
  const pages = createRouteMapPages(route(Array(20).fill(5)));
  for (const [pageIndex, page] of pages.entries()) {
    const curve = paths(page), nodes = [...page.nodes, ...(page.finish ? [page.finish] : [])];
    for (let i = 1; i < curve.length; i++) {
      assert.ok(distance(curve[i - 1].end, curve[i].start) < .00001);
      const before = {x: curve[i - 1].end.x - curve[i - 1].control2.x, y: curve[i - 1].end.y - curve[i - 1].control2.y};
      const after = {x: curve[i].control1.x - curve[i].start.x, y: curve[i].control1.y - curve[i].start.y};
      const lengths = Math.hypot(before.x, before.y) * Math.hypot(after.x, after.y);
      if (lengths > 1e-8) assert.ok((before.x * after.x + before.y * after.y) / lengths > .9999);
    }
    for (let i = 0; i < page.nodes.length - 1; i++) {
      const gap = routeMarkerGap(nodes.slice(i, i + 2), curve.filter(path => path.leg === i), page.themeId);
      const reference = routeMarkerGap(page.nodes, page.paths, page.themeId);
      assert.ok(Math.abs(gap - reference) < .2);
    }
    assert.equal(Boolean(page.finish), pageIndex === pages.length - 1);
  }
});
