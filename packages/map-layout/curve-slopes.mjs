export function cubicSlopes(widths, grades, { startSlope, endSlope } = {}) {
  const segments = widths.length;
  if (segments === 0) return [0];

  // Use natural boundary conditions at ends without a prescribed tangent.
  const upper = Array(segments).fill(0);
  const second = Array(segments + 1).fill(0);
  if (startSlope !== undefined) {
    upper[0] = .5;
    second[0] = 3 * (grades[0] - startSlope) / widths[0];
  }
  for (let knot = 1; knot < segments; knot++) {
    const leftWidth = widths[knot - 1];
    const rightWidth = widths[knot];
    const diagonal = 2 * (leftWidth + rightWidth) - leftWidth * upper[knot - 1];
    upper[knot] = rightWidth / diagonal;
    second[knot] = (6 * (grades[knot] - grades[knot - 1]) - leftWidth * second[knot - 1]) / diagonal;
  }
  if (endSlope !== undefined) {
    const last = segments - 1;
    second[segments] = (6 * (endSlope - grades[last]) / widths[last] - second[last]) / (2 - upper[last]);
  }
  for (let knot = segments - 1; knot >= 0; knot--) {
    second[knot] -= upper[knot] * second[knot + 1];
  }

  const slopes = Array.from(grades, (grade, index) => grade - widths[index] * (2 * second[index] + second[index + 1]) / 6);
  slopes.push(grades[segments - 1] + widths[segments - 1] * (second[segments - 1] + 2 * second[segments]) / 6);
  return slopes;
}

// Steffen's monotone slopes with the one-sided endpoints used by D3 curveMonotoneX.
// https://d3js.org/d3-shape/curve#curveMonotoneX
export function monotoneSlopes(widths, grades) {
  const segments = widths.length;
  if (segments === 0) return [0];
  if (segments === 1) return [grades[0], grades[0]];

  const slopes = Array(segments + 1).fill(0);
  for (let knot = 1; knot < segments; knot++) {
    const left = grades[knot - 1];
    const right = grades[knot];
    if (!left || !right || Math.sign(left) !== Math.sign(right)) continue;
    const leftWidth = widths[knot - 1];
    const rightWidth = widths[knot];
    const weighted = (left * rightWidth + right * leftWidth) / (leftWidth + rightWidth);
    slopes[knot] = Math.sign(left) * Math.min(2 * Math.abs(left), 2 * Math.abs(right), Math.abs(weighted));
  }
  slopes[0] = (3 * grades[0] - slopes[1]) / 2;
  slopes[segments] = (3 * grades[segments - 1] - slopes[segments - 1]) / 2;
  return slopes;
}
