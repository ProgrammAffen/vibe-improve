import { cubicSlopes, monotoneSlopes } from './curve-slopes.mjs';
import { chapterSignBounds } from './chapter-sign.mjs';
import { newThemes, originalThemes } from './map-themes.mjs';
import { curvePoint, pathRecord, placeRouteMarkers } from './route-spacing.mjs';

export const WIDTH = 1672;
export const HEIGHT = 941;
export const MAX_PAGE_NODES = 10;
const MIN_PAGE_NODES = 9;
const LAST_ANCHOR_ROW = 790;
const FIRST_ANCHOR_ROW = 240;
const SIDE_INSET = 205;
const ROUTE_CLEARANCE = 27;
const MAX_BATCHES = 5;
const FALLBACK_ATTEMPTS = 48;
const TARGET_VARIATION = 100;
const SCENIC_VARIATION = 74;
const MIN_VARIATION = 50;
const FOLD_TARGET_VARIATION = 74;
const FOLD_MIN_VARIATION = 25;
const UPPER_ROW_LIMIT = 518;
const LOWER_ROW_LIMIT = 557;
const MIN_TURN_HEIGHT = 251;
const FINGERPRINT_POINTS = 13;
const MARKER = { chapter: { width: 198, height: 191 }, lesson: { width: 94, height: 78 } };

export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let next = Math.imul(state ^ state >>> 15, state | 1);
    next ^= next + Math.imul(next ^ next >>> 7, next | 61);
    return ((next ^ next >>> 14) >>> 0) / 4294967296;
  };
}

function mixSeed(seed, page) {
  let value = (seed ^ Math.imul(page + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ value >>> 16, 0x85ebca6b);
  value = Math.imul(value ^ value >>> 13, 0xc2b2ae35);
  return (value ^ value >>> 16) >>> 0;
}

const themes = [...originalThemes, ...newThemes];

function buildNodes(chapters) {
  return chapters.flatMap((source, chapterIndex) => {
    const chapter = chapterIndex + 1;
    const chapterId = source.id;
    return [
      { id: chapterId, key: `chapter:${chapterId}`, chapterId, chapter, title: source.title, kind: 'chapter',
        label: String(chapter).padStart(2, '0'), ...MARKER.chapter },
      ...source.nodes.map((node, index) => ({
        id: node.id, key: `lesson:${node.id}`, chapterId, chapter, lesson: index + 1, title: node.title,
        kind: 'lesson', label: `${chapter}.${index + 1}`, ...MARKER.lesson,
      })),
    ];
  });
}

function comparePartitions(a, b) {
  return Number(a.shortfall > 0) - Number(b.shortfall > 0)
    || a.pageCount - b.pageCount
    || a.splits - b.splits
    || a.shortfall - b.shortfall;
}

function partition(nodes) {
  if (nodes.length <= MAX_PAGE_NODES) return [nodes];

  const best = Array(nodes.length + 1);
  best[nodes.length] = { pageCount: 0, splits: 0, shortfall: 0 };
  for (let start = nodes.length - 1; start >= 0; start--) {
    const first = Math.min(start + MIN_PAGE_NODES, nodes.length);
    const last = Math.min(start + MAX_PAGE_NODES, nodes.length);
    for (let end = last; end >= first; end--) {
      const suffix = best[end];
      const before = nodes[end - 1];
      const continuation = before.chapter === nodes[end]?.chapter;
      if (!suffix || (continuation && before.kind === 'chapter')) continue;
      const candidate = {
        end,
        pageCount: suffix.pageCount + 1,
        splits: suffix.splits + Number(continuation),
        shortfall: Math.max(suffix.shortfall, MIN_PAGE_NODES - (end - start)),
      };
      if (!best[start] || comparePartitions(candidate, best[start]) < 0) best[start] = candidate;
    }
  }

  const pages = [];
  for (let start = 0; start < nodes.length;) {
    const { end } = best[start];
    pages.push(nodes.slice(start, end));
    start = end;
  }
  return pages;
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const rounded = p => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 });

function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const half = ordered => {
    const side = [];
    for (const point of ordered) {
      while (side.length > 1 && cross(side.at(-2), side.at(-1), point) <= 0) side.pop();
      side.push(point);
    }
    return side.slice(0, -1);
  };
  return [...half(sorted), ...half(sorted.reverse())];
}

function separationAxes(a, b) {
  const axes = [[1, 0], [0, 1]];
  for (const hull of [a, b]) {
    for (let i = 0; i < hull.length; i++) {
      const first = hull[i];
      const second = hull[(i + 1) % hull.length];
      if (first.x !== second.x || first.y !== second.y) axes.push([first.y - second.y, second.x - first.x]);
    }
  }
  return axes;
}

function interval(points, x, y) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const value = point.x * x + point.y * y;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

// Separating axes prove control hulls don't overlap, which bounds the full Bézier curve.
function intersects(a, b) {
  return separationAxes(a, b).every(([x, y]) => {
    const [amin, amax] = interval(a, x, y);
    const [bmin, bmax] = interval(b, x, y);
    return Math.min(amax, bmax) >= Math.max(amin, bmin) - 1e-7;
  });
}

function rectangle(left, top, right, bottom) {
  return [
    { x: left, y: top }, { x: right, y: top },
    { x: right, y: bottom }, { x: left, y: bottom },
  ];
}

function markerBoxes(point, { width, height, kind }, themeId, padding = 11) {
  const x = width / 2 + padding;
  const centered = kind === 'lesson';
  const top = point.y - (centered ? height / 2 : height) - 10 - padding;
  const bottom = point.y + (centered ? height / 2 : 0) + 24 + padding;
  const artwork = rectangle(point.x - x, top, point.x + x, bottom);
  if (centered) return [artwork];
  const sign = chapterSignBounds(point, themeId);
  const clearance = Math.min(padding, 9);
  return [artwork, rectangle(sign.left - clearance, sign.top - clearance, sign.right + clearance, sign.bottom + clearance)];
}

function markersFit(nodes, themeId) {
  const occupied = [];
  for (const node of nodes) {
    const boxes = markerBoxes(node, node, themeId);
    if (boxes.some(box => occupied.some(other => intersects(box, other)))) return false;
    occupied.push(...boxes);
  }
  return true;
}

function anchorLimits(x) {
  const fromSide = Math.min(x, WIDTH - x);
  const top = fromSide < 370 ? 350 : fromSide < 440 ? 285 : FIRST_ANCHOR_ROW;
  const bottom = fromSide < 295 ? 665 : fromSide < 370 ? 740 : LAST_ANCHOR_ROW;
  return { top, bottom };
}

function playable({ x, y }) {
  const { top, bottom } = anchorLimits(x);
  return Math.min(x, WIDTH - x) >= SIDE_INSET && y >= top && y <= bottom;
}

function markerOnTerrain(point, kind, themeId) {
  if (!playable(point)) return false;
  if (kind === 'lesson') return true;
  const sign = chapterSignBounds(point, themeId);
  return sign.right <= WIDTH - 75 && sign.bottom <= HEIGHT - 100;
}

function markerGaps(nodes, padding = 23) {
  return nodes.slice(1).map((node, index) => (node.width + nodes[index].width) / 2 + padding);
}

const sum = values => values.reduce((total, value) => total + value, 0);

function needsFold(nodes) {
  return nodes.length === MAX_PAGE_NODES || sum(markerGaps(nodes, 30)) > WIDTH - 540;
}

function samplePoints(source, rng, themeId) {
  const count = source.length;
  const startX = 245 + 52 * rng();
  const finishX = WIDTH - 245 - 52 * rng();
  const gaps = Array.from({ length: count - 1 }, () => .87 + .26 * rng());
  const totalGap = sum(gaps);
  const clearance = markerGaps(source);
  const routeWidth = finishX - startX;
  const spareWidth = routeWidth - sum(clearance);
  const advances = gaps.map((gap, index) => spareWidth >= 0
    ? clearance[index] + spareWidth * gap / totalGap
    : routeWidth * gap / totalGap);
  const phase = rng() * Math.PI * 2;
  const waves = .62 + rng() * 1.02;
  const stretch = (rng() - .5) * 1.7;
  const height = 188 + 73 * rng();
  const offset = 524 + (rng() - .5) * 75;
  const accent = rng() * Math.PI * 2;
  const points = [];
  const boxes = [];
  let travel = 0;
  for (const [index, marker] of source.entries()) {
    const x = startX + (finishX - startX) * travel;
    const progress = travel * waves + stretch * travel * (1 - travel);
    const angle = phase + progress * Math.PI * 2;
    const envelope = .63 + .37 * Math.sin(Math.PI * travel);
    const targetY = offset + envelope * (height * Math.sin(angle) + 25 * Math.sin(2 * angle + accent));
    const last = points.at(-1);
    const before = points.at(-2);
    const approach = before && unit(last.x - before.x, last.y - before.y);
    let placed = false;
    for (let attempt = 0; attempt < 28; attempt++) {
      const y = attempt < 19
        ? targetY + (rng() - .5) * (attempt < 7 ? 24 : 120)
        : FIRST_ANCHOR_ROW + rng() * (LAST_ANCHOR_ROW - FIRST_ANCHOR_ROW);
      const point = rounded({ x, y });
      if (!markerOnTerrain(point, marker.kind, themeId)) continue;
      if (approach && dot(approach, unit(point.x - last.x, point.y - last.y)) < -.66) continue;
      const markerSpace = markerBoxes(point, marker, themeId);
      if (markerSpace.some(box => boxes.some(existing => intersects(box, existing)))) continue;
      points.push(point);
      boxes.push(...markerSpace);
      placed = true;
      break;
    }
    if (!placed) return null;
    travel += (advances[index] ?? 0) / routeWidth;
  }
  return points;
}

function fallbackPoints(count, rng) {
  const startX = 225 + rng() * 14;
  const finishX = WIDTH - 225 - rng() * 14;
  const centerY = 505 + 19 * rng();
  const wideAfter = count >= 8 ? Math.floor(rng() * (count - 1)) : -1;
  const wideGap = 204 + 8 * rng();
  const wideSteps = Number(wideAfter >= 0);
  const gap = (finishX - startX - wideGap * wideSteps) / (count - 1 - wideSteps);
  const height = count > 5 ? 235 + 7 * rng() : 60 + 145 * rng();
  const shift = (rng() - .5) * 24;
  let side = rng() < .5 ? 1 : -1;
  let x = startX;
  const points = [];
  for (let index = 0; index < count; index++) {
    const progress = index / (count - 1);
    points.push(rounded({ x, y: centerY + side * height / 2 + shift * Math.sin(progress * Math.PI) }));
    if (index === wideAfter) x += wideGap;
    else {
      x += gap;
      side = -side;
    }
  }
  return points;
}

function foldedRow(source, fromX, toX, lower, rng) {
  const direction = Math.sign(toX - fromX);
  const length = Math.abs(toX - fromX);
  const gaps = markerGaps(source);
  const spare = length - sum(gaps);
  const weights = gaps.map(() => .72 + .56 * rng());
  const totalWeight = sum(weights);
  const center = lower ? 691 + (rng() - .5) * 70 : 385 + (rng() - .5) * 94;
  const amplitude = lower ? 18 + 60 * rng() : 27 + 70 * rng();
  const phase = rng() * Math.PI * 2;
  const sweep = Math.PI * (1 + 1.4 * rng());
  let traveled = 0;
  return source.map((_, index) => {
    const x = index === source.length - 1 ? toX : fromX + direction * traveled;
    const { top, bottom } = anchorLimits(x);
    const minY = lower ? Math.max(top, 592) : top;
    const maxY = lower ? bottom : Math.min(bottom, 474);
    const y = center + amplitude * Math.sin(phase + sweep * traveled / length);
    if (index < gaps.length) traveled += gaps[index] + spare * weights[index] / totalWeight;
    return rounded({ x, y: Math.max(minY, Math.min(maxY, y)) });
  });
}

function sampleFold(source, rng, fallback) {
  const turnX = fallback ? 1230 + 100 * rng() : 1085 + 240 * rng();
  const startX = fallback ? 244 + 25 * rng() : 228 + 100 * rng();
  const finishX = fallback ? 312 + 49 * rng() : 301 + 238 * rng();
  const splits = [];
  for (let split = 3; split <= source.length - 3; split++) {
    if (Math.abs(split - source.length / 2) > 1.5) continue;
    const upper = source.slice(0, split);
    const lower = source.slice(split);
    if (sum(markerGaps(upper)) <= turnX - startX && sum(markerGaps(lower)) <= turnX - finishX) splits.push(split);
  }
  if (!splits.length) return null;

  const boundaries = splits.filter(split => source[split].kind === 'chapter');
  const choices = boundaries.length ? boundaries : splits;
  const foldAt = choices[Math.floor(rng() * choices.length)];
  const upper = foldedRow(source.slice(0, foldAt), startX, turnX, false, rng);
  const lower = foldedRow(source.slice(foldAt), turnX, finishX, true, rng);
  if (lower[0].y - upper.at(-1).y < MIN_TURN_HEIGHT) return null;
  return { points: [...upper, ...lower], foldAt };
}

const dot = (a, b) => a.x * b.x + a.y * b.y;
const unit = (x, y) => {
  const length = Math.hypot(x, y);
  return { x: x / length, y: y / length };
};

function segmentWithSlopes(from, to, startSlope, endSlope) {
  const start = { x: from.x, y: from.y };
  const end = { x: to.x, y: to.y };
  const thirdX = (end.x - start.x) / 3;
  const thirdWidth = Math.abs(thirdX);
  const control1 = { x: start.x + thirdX, y: start.y + startSlope * thirdWidth };
  const control2 = { x: end.x - thirdX, y: end.y - endSlope * thirdWidth };
  return pathRecord(from.key, to.key, start, control1, control2, end);
}

function rowCurves(nodes, interpolate, boundary = {}) {
  const widths = nodes.slice(1).map((node, index) => Math.abs(node.x - nodes[index].x));
  const grades = widths.map((width, index) => (nodes[index + 1].y - nodes[index].y) / width);
  const slopes = interpolate(widths, grades, boundary);
  if (boundary.startSlope !== undefined) slopes[0] = boundary.startSlope;
  if (boundary.endSlope !== undefined) slopes[slopes.length - 1] = boundary.endSlope;
  return nodes.slice(1).map((node, index) => segmentWithSlopes(nodes[index], node, slopes[index], slopes[index + 1]));
}

function curvesFit(paths, nodes, themeId) {
  const obstacles = nodes.map(node => markerBoxes(node, node, themeId, ROUTE_CLEARANCE));
  return paths.every(({ start, control1, control2, end, leg }, index) => {
    if ([control1, control2].some(point => point.y < 200 - 1e-8 || point.y > LAST_ANCHOR_ROW + 1e-8)) return false;
    const hull = convexHull([start, control1, control2, end]);
    const before = leg ?? index;
    return !obstacles.some((boxes, other) => other !== before && other !== before + 1 &&
      boxes.some(box => intersects(hull, box)));
  });
}

function makeCurves(nodes, rng, themeId) {
  if (nodes.length === 2) {
    const [start, end] = nodes;
    const width = end.x - start.x;
    const grade = (end.y - start.y) / width;
    const side = rng() < .5 ? -1 : 1;
    const outerY = side > 0 ? Math.max(start.y, end.y) : Math.min(start.y, end.y);
    const room = side > 0 ? LAST_ANCHOR_ROW - outerY : outerY - 200;
    const sweep = side * Math.min(room, 180 + rng() * 165) / (width / 3);
    const paths = [segmentWithSlopes(start, end, grade + sweep, grade - sweep)];
    return curvesFit(paths, nodes, themeId) ? paths : null;
  }
  for (const interpolate of [cubicSlopes, monotoneSlopes]) {
    const paths = rowCurves(nodes, interpolate);
    if (curvesFit(paths, nodes, themeId)) return paths;
  }
  return null;
}

function makeFoldedCurves(nodes, foldAt, rng, themeId) {
  const from = nodes[foldAt - 1];
  const to = nodes[foldAt];
  const start = { x: from.x, y: from.y };
  const end = { x: to.x, y: to.y };
  const reach = Math.min((end.y - start.y) * (.56 + .26 * rng()), (WIDTH - SIDE_INSET - start.x) * 4 / 3);
  const turn = pathRecord(from.key, to.key, start, { x: start.x + reach, y: start.y }, { x: end.x + reach, y: end.y }, end);
  // The two rows stay in separate bands. The bend runs to the right of both rows.
  for (const interpolate of [cubicSlopes, monotoneSlopes]) {
    const upper = rowCurves(nodes.slice(0, foldAt), interpolate, { endSlope: 0 });
    const lower = rowCurves(nodes.slice(foldAt), interpolate, { startSlope: 0 });
    if (upper.some(({ control1, control2 }) => Math.max(control1.y, control2.y) > UPPER_ROW_LIMIT)) continue;
    if (lower.some(({ control1, control2 }) => Math.min(control1.y, control2.y) < LOWER_ROW_LIMIT)) continue;
    const paths = [...upper, turn, ...lower];
    if (curvesFit(paths, nodes, themeId)) return paths;
  }
  return null;
}

function fingerprint(paths) {
  const points = [{ ...paths[0].start, at: 0 }];
  for (const path of paths) {
    for (let step = 1; step <= 12; step++) {
      const point = curvePoint(path, step / 12);
      const previous = points.at(-1);
      points.push({ ...point, at: previous.at + distance(previous, point) });
    }
  }
  let index = 1;
  const samples = Array.from({ length: FINGERPRINT_POINTS }, (_, sample) => {
    const at = points.at(-1).at * sample / (FINGERPRINT_POINTS - 1);
    while (index < points.length - 1 && points[index].at < at) index++;
    const a = points[index - 1];
    const b = points[index];
    const ratio = (at - a.at) / (b.at - a.at);
    return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
  });
  const mean = key => samples.reduce((total, sample) => total + sample[key], 0) / samples.length;
  const center = { x: mean('x'), y: mean('y') };
  return samples.map(point => ({ x: point.x - center.x, y: point.y - center.y }));
}

function shapeDistance(first, second) {
  let nearest = Infinity;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const reverse of [false, true]) {
        let sum = 0;
        for (let index = 0; index < first.length; index++) {
          const a = first[index];
          const b = second[reverse ? second.length - 1 - index : index];
          sum += (a.x - b.x * sx) ** 2 + (a.y - b.y * sy) ** 2;
        }
        nearest = Math.min(nearest, Math.sqrt(sum / first.length));
      }
    }
  }
  return nearest;
}

function relativeVariation(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length) / average;
}

function layoutQuality(nodes, paths, foldAt) {
  const x = nodes.map(node => node.x);
  const routeY = [paths[0].start.y, ...paths.flatMap(path => [.25, .5, .75, 1].map(t => curvePoint(path, t).y))];
  const top = Math.min(...routeY);
  const bottom = Math.max(...routeY);
  const verticalRange = LAST_ANCHOR_ROW - FIRST_ANCHOR_ROW;
  const spanX = (Math.max(...x) - Math.min(...x)) / (WIDTH - 2 * SIDE_INSET);
  const spanY = (bottom - top) / verticalRange;
  const centerY = (top + bottom) / 2;
  const centerOffset = Math.abs(centerY - (FIRST_ANCHOR_ROW + LAST_ANCHOR_ROW) / 2) / verticalRange;
  const nearest = nodes.map(node => Math.min(...nodes.filter(other => other !== node).map(other => distance(node, other))));
  const steps = paths.map(path => distance(path.start, path.end));
  const turns = nodes.slice(1, -1).map((node, index) => {
    const before = unit(node.x - nodes[index].x, node.y - nodes[index].y);
    const after = unit(nodes[index + 2].x - node.x, nodes[index + 2].y - node.y);
    return Math.max(0, .38 - dot(before, after));
  });
  const sharpestTurn = Math.max(0, ...turns);
  const directions = routeY.slice(1).map((y, index) => y - routeY[index])
    .filter(change => Math.abs(change) >= 4).map(Math.sign);
  const bends = directions.filter((direction, index) => index > 0 && direction !== directions[index - 1]).length;
  const rowPaths = foldAt === null ? paths : paths.filter((_, index) => index !== foldAt - 1);
  const steepestGrade = Math.max(...rowPaths.map(({ start, end }) => Math.abs(end.y - start.y) / Math.abs(end.x - start.x)));
  return .42 * spanX + 1.17 * spanY - .58 * centerOffset -
    .48 * relativeVariation(nearest) - .42 * relativeVariation(steps) -
    .39 * sharpestTurn - .24 * Math.max(0, bends - 2) - .18 * Math.max(0, steepestGrade - 1.45);
}

function layoutPage(source, rng, themeId, previousShapes, exactPaths) {
  if (source.length === 1) {
    const point = rounded({ x: WIDTH / 2 + (rng() - .5) * 74, y: 544 + (rng() - .5) * 38 });
    return { nodes: [{ ...source[0], ...point }], paths: [], attempts: 1, novelty: null, fallback: false, foldAt: null, minimumNovelty: MIN_VARIATION };
  }
  const folded = needsFold(source);
  const targetVariation = folded ? FOLD_TARGET_VARIATION : TARGET_VARIATION;
  const minimumNovelty = folded ? FOLD_MIN_VARIATION : MIN_VARIATION;
  const randomAttempts = 96 + previousShapes.length * 3;
  const candidateLimit = source.length <= 5 ? 8 : 15;
  let best;
  let alternative;
  let accepted = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= randomAttempts + FALLBACK_ATTEMPTS; attempt++) {
    if (best && (attempt - best.firstAttempt > 28 || attempt > randomAttempts)) break;
    if (!folded && attempt > randomAttempts && alternative?.novelty >= SCENIC_VARIATION) break;
    attempts = attempt;
    const fallback = attempt > randomAttempts;
    const layout = folded
      ? sampleFold(source, rng, fallback)
      : { points: fallback ? fallbackPoints(source.length, rng) : samplePoints(source, rng, themeId), foldAt: null };
    if (!layout?.points) continue;
    const { points, foldAt } = layout;
    const guideNodes = source.map((node, index) => ({ ...node, ...points[index] }));
    if (!markersFit(guideNodes, themeId)) continue;
    const guide = folded ? makeFoldedCurves(guideNodes, foldAt, rng, themeId) : makeCurves(guideNodes, rng, themeId);
    if (!guide) continue;
    const exact = guide.map(path => path.d).join('|');
    if (exactPaths.has(exact)) continue;
    const shape = fingerprint(guide);
    const novelty = previousShapes.length
      ? Math.min(...previousShapes.map(previous => shapeDistance(shape, previous)))
      : null;
    if (novelty !== null && novelty < minimumNovelty) continue;
    const positioned = placeRouteMarkers(source, guide, themeId);
    if (!positioned) continue;
    const { nodes, paths } = positioned;
    if (!nodes.every(node => markerOnTerrain(node, node.kind, themeId)) ||
        !markersFit(nodes, themeId) || !curvesFit(paths, nodes, themeId)) continue;
    const quality = layoutQuality(nodes, guide, foldAt);
    const turnAfter = folded ? nodes.findIndex((node, index) => index > 0 && node.x < nodes[index - 1].x) : null;
    const candidate = { nodes, paths, novelty, fallback, foldAt: turnAfter, shape, exact, quality, firstAttempt: best?.firstAttempt ?? attempt };
    if (novelty !== null && novelty < targetVariation) {
      if (!alternative || novelty > alternative.novelty) alternative = candidate;
      continue;
    }
    if (!best || quality > best.quality) best = candidate;
    if (++accepted >= candidateLimit || fallback) break;
  }
  best ??= alternative;
  if (!best) return null;
  previousShapes.push(best.shape);
  exactPaths.add(best.exact);
  const { nodes, paths, novelty, fallback, foldAt } = best;
  return { nodes, paths, attempts, novelty, fallback, foldAt, minimumNovelty };
}

function pageGeometry(group, seed, themeId) {
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const layout = layoutPage(group, random(batch ? mixSeed(seed, batch) : seed), themeId, [], new Set());
    if (layout) return layout;
  }
  throw new Error('Could not generate a collision-free route map');
}

function seedFor(route, groups) {
  let seed = 2166136261;
  for (const char of route.id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
  for (const group of groups) {
    for (const node of group) {
      for (const char of node.key) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
      seed = Math.imul(seed ^ 58, 16777619);
    }
  }
  return seed >>> 0;
}

export function createRouteMapPages(route) {
  if (!route.chapters.length) return [];
  const groups = partition(buildNodes(route.chapters));
  const routeSeed = seedFor(route, groups);

  return groups.map((group, pageIndex) => {
    const seed = mixSeed(routeSeed, pageIndex);
    const themeId = themes[pageIndex % themes.length];
    const lessonIds = group.filter(node => node.kind === 'lesson').map(node => node.id);
    const first = group[0];
    const last = group.at(-1);
    const continuedChapter = first.kind === 'lesson' ? {
      id: first.chapterId,
      title: route.chapters[first.chapter - 1].title,
      number: first.chapter,
      firstLesson: first.lesson,
      lastLesson: group.findLast(node => node.chapterId === first.chapterId).lesson,
    } : null;
    let geometry;
    const layout = () => geometry ??= pageGeometry(group, seed, themeId);
    return {
      pageIndex, pageNumber: pageIndex + 1, totalPages: groups.length, themeId, seed,
      lessonIds, totalChapters: group.length - lessonIds.length, totalLessons: lessonIds.length,
      continuation: continuedChapter !== null, continuedChapter,
      continuesToNextPage: last.chapterId === groups[pageIndex + 1]?.[0].chapterId,
      get nodes() { return layout().nodes; },
      get paths() { return layout().paths; },
    };
  });
}
