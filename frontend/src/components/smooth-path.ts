// Rate lines drawn as a smooth curve through their points instead of straight
// segments: monotone cubic interpolation (Fritsch–Carlson), so the curve bends
// gently at each point but never overshoots past a neighbouring value.

/** An SVG path through "x,y x,y …" (as a polyline takes them). */
export function smoothPath(points: string | [number, number][]): string {
  const p = typeof points === "string"
    ? points.trim().split(/\s+/).filter(Boolean).map(pair => pair.split(",").map(Number) as [number, number])
    : points;
  if (!p.length) return "";
  const f = (n: number) => n.toFixed(2);
  if (p.length < 3) return `M${p.map(([x, y]) => `${f(x)},${f(y)}`).join(" L")}`;
  const slope: number[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const dx = p[i + 1][0] - p[i][0];
    slope.push(dx ? (p[i + 1][1] - p[i][1]) / dx : 0);
  }
  // A point's tangent: flat at a peak or valley, otherwise the harmonic mean of the slopes
  // on either side (which keeps the curve between its neighbours); the ends follow their segment.
  const tangent = p.map((_, i) => {
    if (i === 0) return slope[0];
    if (i === p.length - 1) return slope[i - 1];
    const a = slope[i - 1], b = slope[i];
    return a * b <= 0 ? 0 : 2 / (1 / a + 1 / b);
  });
  let d = `M${f(p[0][0])},${f(p[0][1])}`;
  for (let i = 1; i < p.length; i++) {
    const [x0, y0] = p[i - 1], [x1, y1] = p[i], third = (x1 - x0) / 3;
    d += ` C${f(x0 + third)},${f(y0 + tangent[i - 1] * third)} ${f(x1 - third)},${f(y1 - tangent[i] * third)} ${f(x1)},${f(y1)}`;
  }
  return d;
}

/** Rates as drawn: averaged down to about `target` points, then a light 1-2-1 moving
 * average. Each raw point is the minute before it (it jumps kill to kill, and to 0 over
 * a break), so a curve through all of them stays jagged however its corners are drawn;
 * this reads like a 3-5 minute trend. Read-outs (live, average, peak) use the raw values. */
export function smoothRates<T extends { t: number }>(points: T[], keys: (keyof T)[], target = 48): T[] {
  if (points.length <= 3) return points;
  const size = Math.max(1, Math.ceil(points.length / target));
  const buckets: T[] = [];
  for (let start = 0; start < points.length; start += size) {
    const slice = points.slice(start, start + size);
    const bucket = { ...slice[slice.length - 1] } as T;
    for (const key of keys) bucket[key] = slice.reduce((sum, p) => sum + Number(p[key] ?? 0), 0) / slice.length as T[keyof T];
    buckets.push(bucket);
  }
  return buckets.map((point, i) => {
    if (i === 0 || i === buckets.length - 1) return point;
    const smooth = { ...point };
    for (const key of keys) smooth[key] = (Number(buckets[i - 1][key]) + 2 * Number(point[key]) + Number(buckets[i + 1][key])) / 4 as T[keyof T];
    return smooth;
  });
}
