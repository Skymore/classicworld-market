import { useId } from "react";

// Pixel mushroom with an iridescent cap and a sparkle: the AI assistant's icon.
// Rows are (y, first x, last x) on an 18-cell grid.
const EDGE = "#2e2a24";
const CAP_OUTLINE = [[3, 5, 10], [4, 3, 12], [5, 2, 13], [6, 1, 14], [7, 1, 14], [8, 0, 15], [9, 0, 15], [10, 0, 15], [11, 1, 14]];
const CAP = [[4, 5, 10], [5, 3, 12], [6, 2, 13], [7, 2, 13], [8, 1, 14], [9, 1, 14], [10, 1, 14]];
const STEM_OUTLINE = [[12, 4, 11], [13, 4, 11], [14, 4, 11], [15, 4, 11], [16, 4, 11], [17, 5, 10]];
const STEM = [[12, 5, 9], [13, 5, 9], [14, 5, 9], [15, 5, 9], [16, 5, 9]];
const STEM_SHADE = [[12, 10, 10], [13, 10, 10], [14, 10, 10], [15, 10, 10], [16, 10, 10]];
const EYES = [[13, 6, 6], [14, 6, 6], [13, 9, 9], [14, 9, 9]];
const SPOTS = [[6, 4, 5], [7, 4, 5], [5, 9, 10], [8, 11, 12], [9, 11, 12], [9, 7, 7]];
const SHINE = [[4, 5, 7], [5, 3, 4]];
const STOPS = [["0", "#4f93f2"], [".5", "#9a72ec"], ["1", "#ec6a95"]];

const runs = (rows: number[][], fill: string) =>
  rows.map(([y, x0, x1]) => <rect key={`${y}-${x0}`} x={x0} y={y} width={x1 - x0 + 1} height={1} fill={fill} />);
// Four-point star with concave sides.
const star = (cx: number, cy: number, r: number, k: number) => {
  const a = r * k;
  return `M${cx} ${cy - r}Q${cx + a} ${cy - a} ${cx + r} ${cy}Q${cx + a} ${cy + a} ${cx} ${cy + r}Q${cx - a} ${cy + a} ${cx - r} ${cy}Q${cx - a} ${cy - a} ${cx} ${cy - r}Z`;
};

export function AssistantIcon({ size = 24 }: { size?: number }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg
      className="assistant-icon"
      viewBox="0 0 18 18"
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
    >
      <defs>
        {[["c", 1, 3, 15, 12], ["s", 12, 0, 18, 6]].map(([name, x1, y1, x2, y2]) => (
          <linearGradient key={name} id={name + id} gradientUnits="userSpaceOnUse" x1={x1} y1={y1} x2={x2} y2={y2}>
            {STOPS.map(([offset, color]) => (
              <stop key={offset} offset={offset} stopColor={color} />
            ))}
          </linearGradient>
        ))}
      </defs>
      {runs(CAP_OUTLINE, EDGE)}
      {runs(STEM_OUTLINE, EDGE)}
      {runs(CAP, `url(#c${id})`)}
      {runs(STEM, "#fbf4e2")}
      {runs(STEM_SHADE, "#e2cfa3")}
      {runs(EYES, "#2a2620")}
      {runs(SPOTS, "#fff8ec")}
      {runs(SHINE, "rgba(255,255,255,.45)")}
      <g shapeRendering="geometricPrecision">
        <path d={star(15, 3, 3.1, 0.24)} fill="#fff" />
        <path d={star(15, 3, 2.3, 0.22)} fill={`url(#s${id})`} />
      </g>
    </svg>
  );
}
