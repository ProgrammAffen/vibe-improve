import {pathRecord} from './route-spacing.mjs';
import {monotoneSlopes} from './curve-slopes.mjs';

const COLUMNS = 4, ROWS = 3;
let walks;

// Enumerate self-avoiding grid walks, rather than a catalogue of curve shapes.
// The chosen walk, region sizes, corner positions and rounding all vary by seed.
function availableWalks() {
  if (walks) return walks;
  walks = new Map();
  function visit(path, occupied, direction, turns) {
    const cell = path.at(-1), x = cell % COLUMNS, y = Math.floor(cell / COLUMNS);
    const firstRow = Math.floor(path[0] / COLUMNS);
    if (x === COLUMNS - 1 && y === ROWS - 1 - firstRow && path.length >= 6 && turns >= 2 &&
        path.some(point => point < COLUMNS) && path.some(point => point >= COLUMNS * (ROWS - 1))) {
      const group = walks.get(turns) ?? [];
      group.push(path);
      walks.set(turns, group);
    }
    if (turns >= 8 || path.length === COLUMNS * ROWS) return;
    for (const [dx, dy, nextDirection] of [[1, 0, 0], [0, 1, 1], [-1, 0, 2], [0, -1, 3]]) {
      const nx = x + dx, ny = y + dy, next = ny * COLUMNS + nx;
      if (nx < 0 || nx >= COLUMNS || ny < 0 || ny >= ROWS || occupied & (1 << next)) continue;
      const nextTurns = turns + Number(direction !== -1 && direction !== nextDirection);
      visit([...path, next], occupied | (1 << next), nextDirection, nextTurns);
    }
  }
  for (const row of [0, ROWS - 1]) visit([row * COLUMNS], 1 << (row * COLUMNS), -1, 0);
  return walks;
}

const length = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const toward = (a, b, t) => ({x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t});

export function randomRouteCurves(rng, targetTurns, markerCount = 10) {
  const minimumCells = Math.max(6, Math.min(9, Math.ceil(markerCount * .75)));
  // Full pages visit all four outer regions before rounding their turns.
  const outerCells = [0, COLUMNS - 1, COLUMNS * (ROWS - 1), COLUMNS * ROWS - 1];
  const options = [...availableWalks()].map(([turns, paths]) =>
    ({turns, paths: paths.filter(path => path.length >= minimumCells &&
      (markerCount < 8 || outerCells.every(cell => path.includes(cell))))}))
    .filter(group => group.paths.length)
    .sort((a, b) => Math.abs(a.turns - targetTurns) - Math.abs(b.turns - targetTurns));
  const {turns, paths: choices} = options[0];
  const walk = choices[Math.floor(rng() * choices.length)];
  const left = 295 + 25 * rng(), right = 1260 + 30 * rng();
  const weights = Array.from({length: COLUMNS - 1}, () => .75 + .5 * rng());
  const total = weights.reduce((sum, n) => sum + n, 0);
  const xs = [left];
  for (const weight of weights) xs.push(xs.at(-1) + (right - left) * weight / total);
  const ys = [355 + 15 * rng(), 510 + 45 * rng(), 710 + 20 * rng()];
  const corners = walk.filter((cell, index) => index === 0 || index === walk.length - 1 ||
    cell - walk[index - 1] !== walk[index + 1] - cell);
  const waypoints = corners.map(cell => {
    const column = cell % COLUMNS;
    const x = Math.max(300, Math.min(1370, xs[column] + (rng() - .5) * (column === 0 || column === COLUMNS - 1 ? 40 : 100)));
    const row = Math.floor(cell / COLUMNS), edge = column === 0 || column === COLUMNS - 1;
    const y = Math.max(edge ? 350 : 260, Math.min(edge ? 735 : 770,
      ys[row] + (edge ? (rng() - .5) * 16 : row === 0 ? -50 - 35 * rng() : row === ROWS - 1 ? 20 + 20 * rng() : (rng() - .5) * 40)));
    return {x, y};
  });
  const result = [];
  let cursor = waypoints[0];
  const straight = end => {
    if (length(cursor, end) > .001) result.push(pathRecord(null, null, cursor, toward(cursor, end, 1 / 3), toward(cursor, end, 2 / 3), end));
    cursor = end;
  };
  const joins = waypoints.slice(1).map((point, index) => toward(waypoints[index], point, .4 + .2 * rng()));
  straight(joins[0]);
  for (let index = 1; index < waypoints.length - 1; index++) {
    const corner = waypoints[index], entry = joins[index - 1], exit = joins[index];
    const rounding = .6 + .13 * rng();
    result.push(pathRecord(null, null, entry, toward(entry, corner, rounding), toward(exit, corner, rounding), exit));
    cursor = exit;
  }
  straight(waypoints.at(-1));
  return {paths: result, turns, waypoints};
}

// Short last pages open toward the right rather than sampling the beginning of
// a long folded walk. Their horizontal span grows with their marker count.
export function forwardRouteCurves(rng, markerCount = 5) {
  const lower = rng() < .5;
  const left = 300 + rng() * 20;
  const width = Math.min(980, 340 + Math.max(0, markerCount - 2) * 155) + 35 * rng();
  const right = left + width;
  const startY = lower ? 712 + 16 * rng() : 353 + 16 * rng();
  const endY = lower ? 353 + 16 * rng() : 712 + 16 * rng();
  const points = [{x:left, y:startY}];
  const interior = markerCount < 4 ? 1 : 2 + Math.floor(rng() * 2);
  for (let index = 1; index <= interior; index++) {
    const t = index / (interior + 1);
    const x = left + width * (t + (rng() - .5) * .09);
    const baseline = startY + (endY - startY) * t;
    const deviation = markerCount < 4 ? (rng() - .5) * 170 : (rng() < .5 ? -1 : 1) * (100 + 125 * rng());
    points.push({x, y:Math.max(270, Math.min(755, baseline + deviation))});
  }
  points.push({x:right, y:endY});
  const widths = points.slice(1).map((point, index) => point.x - points[index].x);
  const grades = widths.map((width, index) => (points[index + 1].y - points[index].y) / width);
  const slopes = monotoneSlopes(widths, grades);
  const paths = points.slice(1).map((end, index) => {
    const start = points[index], third = widths[index] / 3;
    return pathRecord(null,null,start,{x:start.x+third,y:start.y+slopes[index]*third},
      {x:end.x-third,y:end.y-slopes[index+1]*third},end);
  });
  return {paths, waypoints:points, turns:interior};
}
