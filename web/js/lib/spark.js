// Preserve gaps: missing daily observations are not a continuous price trend.
export function spark(trend, w = 104, h = 28) {
  const vals = (trend || []).filter((v) => v != null);
  if (vals.length < 2) return '';
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const x = (i) => 2 + (i / (trend.length - 1)) * (w - 4);
  const y = (v) => h - 4 - (hi > lo ? (v - lo) / (hi - lo) : 0.5) * (h - 8);
  let pen=false;
  const d=trend.map((v,i)=>{
    if(v==null){pen=false;return '';}
    const segment=`${pen?'L':'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen=true;return segment;
  }).join('');
  const last = trend.length - 1;
  const endColor = vals[vals.length - 1] >= vals[0] ? 'var(--maple)' : 'var(--fall-ink)';
  const end = trend[last] != null ? `<rect x="${(x(last) - 2.5).toFixed(1)}" y="${(y(trend[last]) - 2.5).toFixed(1)}" width="5" height="5" fill="${endColor}"/>` : '';
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="var(--mark)" stroke-width="1.6" stroke-linejoin="round"/>${end}</svg>`;
}
