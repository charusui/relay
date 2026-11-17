'use client';

import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';

/* ------------------------------------------------------------ theme toggle */

export function ThemeToggle() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const t = document.documentElement.dataset.theme;
    setDark(t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches);
  }, []);
  const flip = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    try {
      localStorage.setItem('relay-theme', next ? 'dark' : 'light');
    } catch {
      // storage blocked: the toggle still works for this visit
    }
  };
  return (
    <button className="icon-btn" onClick={flip} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title="Theme">
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 1.75a6.25 6.25 0 0 1 0 12.5Z" fill="currentColor" />
      </svg>
    </button>
  );
}

/* ------------------------------------------------------------ local time */

export function LocalTime({ iso, mode = 'datetime' }: { iso: string; mode?: 'datetime' | 'relative' }) {
  const [text, setText] = useState<string>(iso.slice(0, 16).replace('T', ' ') + ' UTC');
  useEffect(() => {
    const d = new Date(iso);
    if (mode === 'relative') {
      const s = Math.round((Date.now() - d.getTime()) / 1000);
      const rel = s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
      setText(rel);
    } else {
      setText(d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
    }
  }, [iso, mode]);
  return (
    <time dateTime={iso} title={new Date(iso).toUTCString()}>
      {text}
    </time>
  );
}

/* ------------------------------------------------------------ chart frame */

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

const shortDay = (day: string) => {
  const [, m, d] = day.split('-');
  return `${Number(m)}/${Number(d)}`;
};

/** Bar with a rounded data end (top) and a square base. */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

const H = 190;
const M = { l: 34, r: 10, t: 10, b: 24 };

type Tip = { x: number; y: number; content: ReactNode } | null;

/* ------------------------------------------------------------ stacked bars */

export type StackDay = { day: string; answered: number; handedOff: number; failures: number };

export function DailyConversations({ days }: { days: StackDay[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  const total = (d: StackDay) => d.answered + d.handedOff;
  const max = niceMax(Math.max(0, ...days.map(total)));
  const iw = Math.max(0, width - M.l - M.r);
  const ih = H - M.t - M.b;
  const band = days.length ? iw / days.length : 0;
  const bw = Math.max(3, Math.min(26, band * 0.62));
  const y = (v: number) => M.t + ih - (v / max) * ih;
  const every = Math.max(1, Math.ceil(days.length / 7));
  const ticks = [0, max / 2, max];

  return (
    <div ref={ref} className="chart" onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label="Conversations per day, split into answered by Relay and handed to a person">
          {ticks.map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={M.l - 8} y={y(t) + 4} textAnchor="end">
                {Number.isInteger(t) ? t : t.toFixed(1)}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const cx = M.l + band * i + band / 2;
            const x = cx - bw / 2;
            const a = d.answered;
            const h = d.handedOff;
            const aH = (a / max) * ih;
            const hH = (h / max) * ih;
            const gap = a > 0 && h > 0 ? 2 : 0;
            return (
              <g key={d.day}>
                {a > 0 && <path d={h > 0 ? `M${x},${M.t + ih}V${M.t + ih - aH}H${x + bw}V${M.t + ih}Z` : topRounded(x, M.t + ih - aH, bw, aH, 4)} fill="var(--series-1)" />}
                {h > 0 && <path d={topRounded(x, M.t + ih - aH - hH, bw, Math.max(0, hH - gap), 4)} fill="var(--series-2)" />}
                {(i % every === 0 || i === days.length - 1) && (
                  <text className="tick" x={cx} y={H - 6} textAnchor="middle">
                    {shortDay(d.day)}
                  </text>
                )}
                <rect
                  x={M.l + band * i}
                  y={M.t}
                  width={band}
                  height={ih}
                  fill="transparent"
                  onMouseEnter={() =>
                    setTip({
                      x: cx,
                      y: y(total(d)),
                      content: (
                        <>
                          <strong>{d.day} (UTC)</strong>
                          <div className="row">
                            <span>Answered by Relay</span>
                            <b>{a}</b>
                          </div>
                          <div className="row">
                            <span>Handed to a person</span>
                            <b>{h}</b>
                          </div>
                          <div className="row">
                            <span>Failed messages</span>
                            <b>{d.failures}</b>
                          </div>
                        </>
                      ),
                    })
                  }
                />
              </g>
            );
          })}
        </svg>
      )}
      {tip && (
        <div className="tooltip" style={{ left: tip.x, top: tip.y }}>
          {tip.content}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ line */

export type LinePoint = { day: string; value: number | null };

const FORMATS = {
  seconds: (v: number) => (v === 0 ? '0 s' : `${v.toFixed(v < 1 ? 2 : v < 10 ? 1 : 0)} s`),
  tokens: (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`),
};

export function DailyLine({ points, label, unit, color = 'var(--series-1)' }: { points: LinePoint[]; label: string; unit: keyof typeof FORMATS; color?: string }) {
  const format = FORMATS[unit];
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const max = niceMax(Math.max(0, ...vals));
  const iw = Math.max(0, width - M.l - M.r);
  const ih = H - M.t - M.b;
  const step = points.length > 1 ? iw / (points.length - 1) : 0;
  const x = (i: number) => M.l + (points.length > 1 ? step * i : iw / 2);
  const y = (v: number) => M.t + ih - (v / max) * ih;
  const every = Math.max(1, Math.ceil(points.length / 7));

  // Path segments, broken where a day has no data.
  const segs: string[] = [];
  let cur = '';
  points.forEach((p, i) => {
    if (p.value === null) {
      if (cur) segs.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${x(i)},${y(p.value)}`;
  });
  if (cur) segs.push(cur);
  const isolated = points.map((p, i) => p.value !== null && (points[i - 1]?.value ?? null) === null && (points[i + 1]?.value ?? null) === null);

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const i = points.length > 1 ? Math.round((e.clientX - box.left) / step) : 0;
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };
  const hp = hover !== null ? points[hover] : null;

  return (
    <div ref={ref} className="chart" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={label}>
          {[0, max / 2, max]
            .filter((t, i, all) => i === 0 || format(t) !== format(all[i - 1]))
            .map((t) => (
            <g key={t}>
              <line className={t === 0 ? 'baseline' : 'gridline'} x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} />
              <text className="tick" x={M.l - 8} y={y(t) + 4} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {points.map((p, i) =>
            i % every === 0 || i === points.length - 1 ? (
              <text key={p.day} className="tick" x={x(i)} y={H - 6} textAnchor="middle">
                {shortDay(p.day)}
              </text>
            ) : null,
          )}
          {segs.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {points.map((p, i) => (isolated[i] && p.value !== null ? <circle key={p.day} cx={x(i)} cy={y(p.value)} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} /> : null))}
          {hp && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={M.t} y2={M.t + ih} stroke="var(--axis)" strokeWidth={1} />
              {hp.value !== null && <circle cx={x(hover)} cy={y(hp.value)} r={5} fill={color} stroke="var(--surface)" strokeWidth={2} />}
            </g>
          )}
          <rect x={M.l} y={M.t} width={iw} height={ih} fill="transparent" onMouseMove={onMove} />
        </svg>
      )}
      {hp && hover !== null && (
        <div className="tooltip" style={{ left: x(hover), top: hp.value !== null ? y(hp.value) : M.t + ih / 2 }}>
          <strong>{hp.day} (UTC)</strong>
          <div className="row">
            <span>{label}</span>
            <b>{hp.value === null ? 'no replies' : format(hp.value)}</b>
          </div>
        </div>
      )}
    </div>
  );
}
