"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Activity, ArrowDownRight, ArrowUpRight, Clock3, Minus, Users } from "lucide-react";
import type { AudienceMetric, AudiencePlatform } from "@/lib/types";
import {
  audienceChartDomain,
  audienceChartValue,
  buildAudienceChartSeries,
  summarizeAudienceMetrics,
  type AudienceChartMode,
  type AudienceChartPoint,
  type AudienceChartRange,
  type AudienceChartSeries,
  type AudienceHistorySeries,
} from "@/lib/audience-charts";
import styles from "./audience-insights.module.css";
import {
  AudienceAccountActions,
  AudienceRefreshActions,
  type AudienceManualEntry,
  type AudiencePayload,
} from "./audience-refresh-actions";

const EMPTY_HISTORY: AudienceHistorySeries[] = [];
const PLATFORMS: Record<AudiencePlatform, { name: string; symbol: string }> = {
  youtube: { name: "YouTube", symbol: "▶" },
  x: { name: "X", symbol: "𝕏" },
  instagram: { name: "Instagram", symbol: "◎" },
  facebook: { name: "Facebook", symbol: "f" },
  linkedin: { name: "LinkedIn", symbol: "in" },
  threads: { name: "Threads", symbol: "@" },
  tiktok: { name: "TikTok", symbol: "♪" },
};
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const day = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const fullDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function color(platform: AudiencePlatform) {
  return `var(--audience-${platform})`;
}

function signed(value: number) {
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${number.format(Math.abs(value))}`;
}

function percent(value: number) {
  const digits = Math.abs(value) < 0.01 && value !== 0 ? 3 : 2;
  return `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: digits })}%`;
}

function changeTone(value: number | null) {
  return value === null || value === 0 ? styles.neutral : value > 0 ? styles.positive : styles.negative;
}

function ChangeIcon({ value }: { value: number | null }) {
  if (value === null) return <Clock3 size={13} aria-hidden />;
  if (value === 0) return <Minus size={13} aria-hidden />;
  return value > 0 ? <ArrowUpRight size={14} aria-hidden /> : <ArrowDownRight size={14} aria-hidden />;
}

function pathFor(
  points: AudienceChartPoint[],
  x: (point: AudienceChartPoint) => number,
  y: (point: AudienceChartPoint) => number,
) {
  return points.map((point, index) => `${index ? "L" : "M"}${x(point).toFixed(2)},${y(point).toFixed(2)}`).join(" ");
}

function MiniChart({ series }: { series: AudienceChartSeries }) {
  const gradient = `audience-mini-${useId().replaceAll(":", "")}`;
  const points = series.points;
  if (points.length < 2) {
    return <div className={styles.miniEmpty}><Activity size={19} aria-hidden /><span>{points.length ? "First reading saved" : "No saved readings yet"}<small>A trend appears after the next verified reading.</small></span></div>;
  }
  const minimum = Math.min(...points.map((point) => point.total));
  const maximum = Math.max(...points.map((point) => point.total));
  const padding = Math.max((maximum - minimum) * 0.2, maximum * 0.0001, 1);
  const floor = Math.max(0, minimum - padding);
  const ceiling = maximum + padding;
  const start = points[0].timestamp;
  const end = points.at(-1)!.timestamp;
  const x = (point: AudienceChartPoint) => 5 + ((point.timestamp - start) / Math.max(end - start, 1)) * 330;
  const y = (point: AudienceChartPoint) => 85 - ((point.total - floor) / Math.max(ceiling - floor, 1)) * 74;
  const description = `${series.label}: ${number.format(points[0].total)} to ${number.format(points.at(-1)!.total)} ${series.primaryLabel}, ${day.format(start)} to ${day.format(end)}. ${points.length} verified readings.${series.hasGaps ? " Gaps represent missed checks." : ""}`;
  return (
    <svg className={styles.miniChart} viewBox="0 0 340 96" role="img" aria-label={description}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color(series.platform)} stopOpacity=".22" /><stop offset="100%" stopColor={color(series.platform)} stopOpacity=".015" /></linearGradient></defs>
      {[25, 55, 85].map((position) => <line key={position} x1="0" x2="340" y1={position} y2={position} className={styles.gridLine} />)}
      {series.segments.map((segment, index) => {
        const path = pathFor(segment, x, y);
        return <g key={index}>{segment.length > 1 && <><path d={`${path} L${x(segment.at(-1)!).toFixed(2)},94 L${x(segment[0]).toFixed(2)},94 Z`} fill={`url(#${gradient})`} /><path d={path} fill="none" stroke={color(series.platform)} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></>}{segment.map((point) => <circle key={point.timestamp} cx={x(point)} cy={y(point)} r="2.8" fill={color(series.platform)}><title>{`${fullDate.format(point.timestamp)}: ${number.format(point.total)}`}</title></circle>)}</g>;
      })}
    </svg>
  );
}

function TrendChart({ series, mode, days }: { series: AudienceChartSeries[]; mode: AudienceChartMode; days: AudienceChartRange }) {
  const [active, setActive] = useState<{ id: string; index: number } | null>(null);
  const [chartWidth, setChartWidth] = useState(810);
  const plotRef = useRef<HTMLDivElement>(null);
  const chartId = useId();
  const plotted = series.filter((entry) => entry.points.length >= 2 && (mode === "total" || entry.percentChange !== null));
  const allPoints = plotted.flatMap((entry) => entry.points);
  const selectedSeries = plotted.find((entry) => entry.id === active?.id);
  const selectedPoint = selectedSeries && active ? selectedSeries.points[active.index] : undefined;
  const hasData = allPoints.length > 0;
  useEffect(() => {
    const element = plotRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0) setChartWidth(Math.max(240, Math.round(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasData]);
  if (!allPoints.length) {
    const zeroBaseline = series.some((entry) => entry.points.length >= 2 && entry.points[0].total === 0);
    return <div className={styles.chartEmpty}><span className={styles.chartEmptyIcon}><Activity size={28} aria-hidden /></span><h3>{zeroBaseline && mode === "growth" ? "Start with the counts view" : series.length ? "Your story starts here" : "Choose an account to compare"}</h3><p>{zeroBaseline && mode === "growth" ? "Percentage growth needs a non-zero baseline. Your actual counts are available in the Counts view." : series.length ? "As verified readings arrive, your growth lines will take shape. History is saved locally; nothing is backfilled or estimated." : "Use the colored account buttons below to bring a line back into view."}</p></div>;
  }
  const start = Math.min(...allPoints.map((point) => point.timestamp));
  const end = Math.max(...allPoints.map((point) => point.timestamp));
  const [minimum, maximum] = audienceChartDomain(plotted, mode);
  const left = chartWidth < 500 ? 48 : 66;
  const right = chartWidth - 19;
  const x = (point: AudienceChartPoint) => left + ((point.timestamp - start) / Math.max(end - start, 1)) * (right - left);
  const y = (point: AudienceChartPoint) => 242 - (((audienceChartValue(point, mode) ?? 0) - minimum) / (maximum - minimum)) * 220;
  const tickValue = (value: number) => mode === "growth" ? percent(value) : compact.format(value);
  const detailedTicks = mode === "total" && compact.format(minimum) === compact.format(maximum);
  const dateLabel = end - start < 2 * 24 * 60 * 60 * 1000 ? time : day;

  function navigate(event: KeyboardEvent<SVGGElement>, entry: AudienceChartSeries) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const index = active?.id === entry.id ? active.index : entry.points.length - 1;
    const next = event.key === "Home" ? 0 : event.key === "End" ? entry.points.length - 1 : Math.max(0, Math.min(entry.points.length - 1, index + (event.key === "ArrowLeft" ? -1 : 1)));
    setActive({ id: entry.id, index: next });
  }

  return (
    <div ref={plotRef} className={styles.trendPlot} onMouseLeave={() => setActive(null)}>
      <svg className={styles.mainChart} viewBox={`0 0 ${chartWidth} 280`} role="group" aria-labelledby={`${chartId}-title ${chartId}-description`}>
        <title id={`${chartId}-title`}>{mode === "growth" ? "Percentage growth" : "Verified audience counts"} over time</title>
        <desc id={`${chartId}-description`}>Only saved readings in the selected {days}-day window. Each account has its own baseline; missing checks are gaps. Focus a colored line and use left or right arrow keys to inspect readings, or open the recorded-values table below.</desc>
        {[0, 1, 2, 3, 4].map((step) => {
          const position = 22 + step * 55;
          const value = maximum - ((maximum - minimum) * step) / 4;
          return <g key={step}><line x1={left} x2={right} y1={position} y2={position} className={styles.gridLine} /><text x={left - 10} y={position + 4} textAnchor="end" className={styles.axisLabel}>{detailedTicks ? number.format(value) : tickValue(value)}</text></g>;
        })}
        {(chartWidth < 500 ? [0, .5, 1] : [0, .25, .5, .75, 1]).map((step) => <text key={step} x={left + step * (right - left)} y="270" textAnchor={step === 0 ? "start" : step === 1 ? "end" : "middle"} className={styles.axisLabel}>{dateLabel.format(start + (end - start) * step)}</text>)}
        {mode === "growth" && <line x1={left} x2={right} y1={242 - ((0 - minimum) / (maximum - minimum)) * 220} y2={242 - ((0 - minimum) / (maximum - minimum)) * 220} className={styles.zeroLine} />}
        {plotted.map((entry) => <g key={entry.id} tabIndex={0} role="img" className={styles.chartSeries} aria-label={`${entry.label}, ${number.format(entry.points.at(-1)!.total)} ${entry.primaryLabel}. Use arrow keys to inspect ${entry.points.length} readings.`} onFocus={() => setActive({ id: entry.id, index: entry.points.length - 1 })} onBlur={() => setActive(null)} onKeyDown={(event) => navigate(event, entry)}>
          {entry.segments.map((segment, index) => <path key={index} d={pathFor(segment, x, y)} fill="none" stroke={color(entry.platform)} strokeWidth={active?.id === entry.id ? 3.4 : 2.5} strokeDasharray={entry.lastKnown ? "5 5" : undefined} strokeLinecap="round" strokeLinejoin="round" opacity={active && active.id !== entry.id ? 0.32 : 1} />)}
          {entry.points.map((point, index) => <g key={point.timestamp} onMouseEnter={() => setActive({ id: entry.id, index })} onClick={() => setActive({ id: entry.id, index })}><circle cx={x(point)} cy={y(point)} r="10" fill="transparent" /><circle cx={x(point)} cy={y(point)} r={active?.id === entry.id && active.index === index ? 5 : 3} fill={color(entry.platform)} stroke="var(--card)" strokeWidth="1.6" opacity={active && active.id !== entry.id ? 0.32 : 1}><title>{`${entry.label}, ${fullDate.format(point.timestamp)}: ${number.format(point.total)} ${entry.primaryLabel}${point.percentChange === null ? "" : `, ${percent(point.percentChange)} since first reading`}`}</title></circle></g>)}
        </g>)}
      </svg>
      <div className={styles.chartReadout} role="status" aria-live="polite">
        {selectedPoint && selectedSeries ? <><i style={{ background: color(selectedSeries.platform) }} /><b>{selectedSeries.label}</b><span>{fullDate.format(selectedPoint.timestamp)}</span><strong>{number.format(selectedPoint.total)} <small>{selectedSeries.primaryLabel}</small></strong>{selectedPoint.percentChange !== null && <em className={changeTone(selectedPoint.change)}>{percent(selectedPoint.percentChange)}</em>}</> : <><span>Showing {day.format(start)} – {day.format(end)}</span><span className={styles.readoutHint}>Hover or focus a line to explore</span></>}
      </div>
    </div>
  );
}

function AudienceMix({ items }: { items: AudienceMetric[] }) {
  const known = items.filter((item) => item.total !== null && Number.isFinite(item.total) && item.total >= 0);
  const sum = known.reduce((total, item) => total + item.total!, 0);
  const ring = 2 * Math.PI * 60;
  const slices = known.map((item, index) => {
    const length = sum > 0 ? (item.total! / sum) * ring : 0;
    const offset = sum > 0 ? (known.slice(0, index).reduce((total, previous) => total + previous.total!, 0) / sum) * ring : 0;
    return { item, length, offset };
  });
  return <aside className={styles.mixPanel} aria-labelledby="audience-mix-title">
    <p className={styles.eyebrow}>The bigger picture</p><h3 id="audience-mix-title">Your platform mix</h3>
    <div className={styles.donutWrap}>
      <svg viewBox="0 0 160 160" role="img" aria-label={sum ? `Distribution of ${number.format(sum)} combined platform counts. These are not unique people.` : "No audience distribution available yet."}>
        <circle cx="80" cy="80" r="60" fill="none" stroke="var(--line)" strokeWidth="15" />
        {slices.map(({ item, length, offset: sliceOffset }) => <circle key={item.id} cx="80" cy="80" r="60" fill="none" stroke={color(item.platform)} strokeWidth="15" strokeDasharray={`${Math.max(0, length - (length > 4 ? 3 : 0))} ${ring}`} strokeDashoffset={-sliceOffset} transform="rotate(-90 80 80)"><title>{`${item.label}: ${number.format(item.total!)} ${item.primaryLabel || "audience"}${item.stale || item.error ? " (last known)" : ""}`}</title></circle>)}
      </svg>
      <div><strong>{known.length}</strong><span>tracked accounts</span></div>
    </div>
    <ul className={styles.mixLegend}>{known.map((item) => <li key={item.id}><i style={{ background: color(item.platform) }} /><span title={item.label}>{item.label}<small>{item.stale || item.error ? "Last known" : PLATFORMS[item.platform].name}</small></span><b>{number.format(item.total!)}<small>{sum > 0 ? `${((item.total! / sum) * 100).toFixed(1)}% of total` : "0 recorded"}</small></b></li>)}</ul>
    <p className={styles.mixNote}>Platform counts are added together. A person following you in two places is counted twice.{known.some((item) => item.stale || item.error) ? " Last-known counts are included and labeled." : ""}</p>
  </aside>;
}

export function AudienceInsights({ items, history = EMPTY_HISTORY, checkedAt, manual, staggerMs, onDataChange }: {
  items: AudienceMetric[];
  history?: AudienceHistorySeries[];
  checkedAt?: string;
  manual?: Record<string, AudienceManualEntry>;
  staggerMs?: number;
  onDataChange?: (payload: AudiencePayload) => void;
}) {
  const [days, setDays] = useState<AudienceChartRange>(7);
  const [mode, setMode] = useState<AudienceChartMode>("growth");
  const [hiddenIds, setHiddenIds] = useState<string[]>([]);
  const timestamp = Date.parse(checkedAt || items[0]?.checkedAt || "1970-01-01T00:00:00Z");
  const now = Number.isFinite(timestamp) ? timestamp : 0;
  const series = useMemo(() => buildAudienceChartSeries(items, history, days, now), [items, history, days, now]);
  const visibleSeries = series.filter((entry) => !hiddenIds.includes(entry.id));
  const summary = summarizeAudienceMetrics(items);
  const trendCount = series.filter((entry) => entry.points.length >= 2).length;
  if (!items.length) return null;

  return <section className={styles.insights} aria-label="Audience growth insights">
    <AudienceRefreshActions items={items} staggerMs={staggerMs} onUpdated={onDataChange} />

    <div className={styles.statsRow}>
      <div className={styles.stat}><span><Users size={14} aria-hidden /> Combined platform totals</span><strong>{summary.total === null ? "—" : number.format(summary.total)}</strong><p>{summary.knownCount} of {items.length} accounts with verified counts{summary.lastKnownCount ? ` · ${summary.lastKnownCount} last-known` : ""}</p></div>
      <div className={styles.stat}><span><Activity size={14} aria-hidden /> 24–36h net change</span><strong className={changeTone(summary.change)}>{summary.change === null ? "Building history" : signed(summary.change)}</strong><p>{summary.comparisonCount ? `${summary.comparisonCount} accounts with a comparable baseline` : "A day-old reading is needed for an honest comparison"}</p></div>
      <div className={styles.stat}><span><Clock3 size={14} aria-hidden /> Your growing record</span><strong>{trendCount}<small> / {items.length}</small></strong><p>Accounts with a trend in the selected {days}-day window</p></div>
    </div>

    <div className={styles.sectionHeading}><div><p className={styles.eyebrow}>A little perspective</p><h2>Your audience, in motion.</h2></div><div className={styles.segmented} role="group" aria-label="Audience history range">{([7, 30] as const).map((range) => <button type="button" key={range} aria-pressed={days === range} onClick={() => setDays(range)}>{range} days</button>)}</div></div>

    <div className={styles.chartGrid}>
      <div className={styles.trendPanel}>
        <header className={styles.chartHeading}><div><h3>{mode === "growth" ? "Growth, side by side" : "Every count tells a story"}</h3><p>{mode === "growth" ? "Each line starts at its first available reading in this window." : "Actual follower, subscriber, or page-like counts for each account."}</p></div><div className={styles.segmented} role="group" aria-label="Audience chart measurement">{(["growth", "total"] as const).map((option) => <button type="button" key={option} aria-pressed={mode === option} onClick={() => setMode(option)}>{option === "growth" ? "Growth %" : "Counts"}</button>)}</div></header>
        <TrendChart series={visibleSeries} mode={mode} days={days} />
        <div className={styles.legend} aria-label="Show or hide accounts on the comparison chart">{series.map((entry) => <button type="button" key={entry.id} aria-pressed={!hiddenIds.includes(entry.id)} onClick={() => setHiddenIds((current) => current.includes(entry.id) ? current.filter((id) => id !== entry.id) : [...current, entry.id])}><i style={{ background: color(entry.platform) }} /><span>{entry.label}{entry.lastKnown ? " · last known" : ""}</span>{entry.percentChange !== null && <b className={changeTone(entry.change)}>{percent(entry.percentChange)}</b>}</button>)}</div>
        <p className={styles.chartNote}>12-hour snapshots + latest verified reading. Only available history is shown; gaps longer than 36 hours stay open. Percentages use each account’s own starting date, not a guaranteed full {days}-day baseline.{series.some((entry) => entry.lastKnown) ? " Dashed lines are last-known history for accounts whose latest check failed." : ""}</p>
      </div>
      <AudienceMix items={items} />
    </div>

    <div className={styles.accountGrid}>{items.map((item, index) => {
      const entry = series[index];
      const lastKnown = Boolean(item.error || item.stale);
      const verifiedAt = item.lastSuccessfulAt || item.checkedAt;
      const verifiedTime = Date.parse(verifiedAt);
      const available = item.total !== null && Number.isFinite(item.total) && item.total >= 0;
      const dailyChange = lastKnown ? null : item.change;
      return <article key={item.id} className={styles.accountCard} style={{ "--account-color": color(item.platform) } as CSSProperties}>
        <div className={styles.accountHeading}><span className={styles.platformMark} aria-hidden>{PLATFORMS[item.platform].symbol}</span><div><h3>{item.label}</h3><p>{PLATFORMS[item.platform].name} · {item.handle}</p></div><span className={`${styles.accountStatus} ${lastKnown ? styles.limited : ""}`}>{available ? lastKnown ? "Last known" : "Verified" : "Waiting"}</span></div>
        <div className={styles.accountValue}><strong>{available ? number.format(item.total!) : "—"}</strong><span>{item.primaryLabel || "audience"}</span></div>
        <div className={`${styles.dailyChange} ${changeTone(dailyChange)}`}><ChangeIcon value={dailyChange} /><b>{dailyChange === null ? lastKnown ? "Latest check unavailable" : "Building a daily baseline" : signed(dailyChange)}</b>{dailyChange !== null && <span>vs 24–36h baseline</span>}</div>
        <MiniChart series={entry} />
        <div className={styles.cardFoot}><span>{entry.points.length ? `${entry.points.length} saved readings` : "History begins with your first check"}</span>{entry.change !== null && <b className={changeTone(entry.change)}>{signed(entry.change)} observed</b>}</div>
        <p className={styles.verifiedAt}>{available && Number.isFinite(verifiedTime) ? `Last verified ${fullDate.format(verifiedTime)}` : "No verified public count yet"}{entry.hasGaps ? " · gaps in history" : ""}</p>
        <AudienceAccountActions item={item} manual={manual?.[item.id]} onUpdated={onDataChange} />
      </article>;
    })}</div>

    <details className={styles.historyTable}><summary>View recorded values <span>Exact readings behind the charts</span></summary><div className={styles.tableScroll}><table><caption>Verified audience readings in the selected {days}-day window. Missing checks are not filled in. Latest readings may fall between the regular 12-hour snapshots.</caption><thead><tr><th scope="col">Account</th><th scope="col">Recorded</th><th scope="col">Count</th><th scope="col">Change from first reading</th></tr></thead><tbody>{series.flatMap((entry) => entry.points.map((point, index) => <tr key={`${entry.id}-${point.timestamp}`}><th scope="row"><i style={{ background: color(entry.platform) }} />{entry.label}<small>{PLATFORMS[entry.platform].name}</small></th><td><time dateTime={point.checkedAt}>{fullDate.format(point.timestamp)}</time></td><td>{number.format(point.total)} {entry.primaryLabel}</td><td>{index === 0 ? "Baseline" : `${signed(point.change)}${point.percentChange === null ? "" : ` (${percent(point.percentChange)})`}`}</td></tr>))}{series.every((entry) => !entry.points.length) && <tr><td colSpan={4}>No verified readings in this window yet.</td></tr>}</tbody></table></div></details>
  </section>;
}
