'use client';

import { Job } from '@prisma/client';
import useJobLossLog, { LossPoint } from '@/hooks/useJobLossLog';
import { useMemo, useState, useEffect } from 'react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';

interface Props {
  job: Job;
}

function formatNum(v: number) {
  if (!Number.isFinite(v)) return '';
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 10) return v.toFixed(3);
  if (Math.abs(v) >= 1) return v.toFixed(4);
  return v.toPrecision(4);
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}

// EMA smoothing that works on a per-series list.
// alpha=1 -> no smoothing, alpha closer to 0 -> more smoothing.
function emaSmoothPoints(points: { step: number; value: number }[], alpha: number) {
  if (points.length === 0) return [];
  const a = clamp01(alpha);
  const out: { step: number; value: number }[] = new Array(points.length);

  let prev = points[0].value;
  out[0] = { step: points[0].step, value: prev };

  for (let i = 1; i < points.length; i++) {
    const x = points[i].value;
    prev = a * x + (1 - a) * prev;
    out[i] = { step: points[i].step, value: prev };
  }

  return out;
}

function hashToIndex(str: string, mod: number) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

function getDatasetFromPath(path: string | null | undefined): string {
  if (!path) return 'unknown';
  const clean = path.replace(/\\/g, '/');
  const parts = clean.split(',').map(p => {
    p = p.trim();
    const segs = p.split('/');
    if (segs.length > 1) segs.pop();
    return segs.join('/');
  });
  return parts.join(' | ');
}

const PALETTE = [
  'rgba(96,165,250,1)', // blue-400
  'rgba(52,211,153,1)', // emerald-400
  'rgba(167,139,250,1)', // purple-400
  'rgba(251,191,36,1)', // amber-400
  'rgba(244,114,182,1)', // pink-400
  'rgba(248,113,113,1)', // red-400
  'rgba(34,211,238,1)', // cyan-400
  'rgba(129,140,248,1)', // indigo-400
];

function strokeForKey(key: string) {
  return PALETTE[hashToIndex(key, PALETTE.length)];
}

export default function JobLossGraph({ job }: Props) {
  const { series, lossKeys, status, refreshLoss } = useJobLossLog(job.id, 2000);

  // Controls
  const [useLogScale, setUseLogScale] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [showSmoothed, setShowSmoothed] = useState(true);

  // 0..100 slider. 100 = no smoothing, 0 = heavy smoothing.
  const [smoothing, setSmoothing] = useState(90);

  // UI-only downsample for rendering speed
  const [plotStride, setPlotStride] = useState(1);

  // show only last N points in the chart (0 = all)
  const [windowSize, setWindowSize] = useState<number>(4000);

  // quick y clipping for readability
  const [clipOutliers, setClipOutliers] = useState(false);

  // which loss series are enabled (default: all enabled)
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  // which datasets are enabled
  const [enabledDatasets, setEnabledDatasets] = useState<Record<string, boolean>>({});

  // keep enabled map in sync with discovered keys (enable new ones automatically)
  useEffect(() => {
    setEnabled(prev => {
      const next = { ...prev };
      for (const k of lossKeys) {
        if (next[k] === undefined) next[k] = true;
      }
      // drop removed keys
      for (const k of Object.keys(next)) {
        if (!lossKeys.includes(k)) delete next[k];
      }
      return next;
    });
  }, [lossKeys]);

  const activeKeys = useMemo(() => lossKeys.filter(k => enabled[k] !== false), [lossKeys, enabled]);

  const allDatasets = useMemo(() => {
    const set = new Set<string>();
    for (const key of activeKeys) {
      const pts = series[key] ?? [];
      for (const p of pts) {
        if (p.image_path) {
          set.add(getDatasetFromPath(p.image_path));
        }
      }
    }
    return Array.from(set).sort();
  }, [series, activeKeys]);

  // Keep datasets in sync
  useEffect(() => {
    setEnabledDatasets(prev => {
      const next = { ...prev };
      let changed = false;
      for (const ds of allDatasets) {
        if (next[ds] === undefined) {
          next[ds] = false;
          changed = true;
        }
      }
      // drop removed
      for (const k of Object.keys(next)) {
        if (!allDatasets.includes(k)) {
          delete next[k];
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [allDatasets]);

  const perSeries = useMemo(() => {
    // Build per-series processed point arrays (raw + smoothed), then merge by step for charting.
    const stride = Math.max(1, plotStride | 0);

    // smoothing%: 0 => no smoothing (alpha=1.0), 100 => heavy smoothing (alpha=0.02)
    const t = clamp01(smoothing / 100);
    const alpha = 1.0 - t * 0.98; // 1.0 -> 0.02

    const out: Record<
      string,
      { raw: { step: number; value: number; image_path?: string | null }[]; smooth: { step: number; value: number }[] }
    > = {};

    const processPoints = (rawPts: { step: number; value: number; image_path?: string | null }[], outKey: string) => {
      let r = rawPts;
      // windowing (applies after stride)
      if (windowSize > 0 && r.length > windowSize) {
        r = r.slice(r.length - windowSize);
      }
      const smooth = emaSmoothPoints(r, alpha);
      out[outKey] = { raw: r, smooth };
    };

    for (const key of activeKeys) {
      const pts: LossPoint[] = series[key] ?? [];

      // Filter and stride first
      const rawAll = pts
        .filter(p => p.value !== null && Number.isFinite(p.value as number))
        .map(p => ({ step: p.step, value: p.value as number, image_path: p.image_path }))
        .filter(p => (useLogScale ? p.value > 0 : true))
        .filter((_, idx) => idx % stride === 0);

      // Process global
      processPoints(rawAll, key);

      // Group by dataset
      const byDataset: Record<string, typeof rawAll> = {};
      for (const p of rawAll) {
        const ds = getDatasetFromPath(p.image_path);
        if (!byDataset[ds]) byDataset[ds] = [];
        byDataset[ds].push(p);
      }

      for (const ds of Object.keys(byDataset)) {
        if (enabledDatasets[ds]) {
          processPoints(byDataset[ds], `${key}__ds__${ds}`);
        }
      }
    }

    return out;
  }, [series, activeKeys, smoothing, plotStride, windowSize, useLogScale, enabledDatasets]);

  const chartData = useMemo(() => {
    // Merge series into one array of objects keyed by step.
    const map = new Map<number, any>();

    // We iterate over everything in perSeries
    for (const fullKey of Object.keys(perSeries)) {
      const s = perSeries[fullKey];
      if (!s) continue;

      for (const p of s.raw) {
        const row = map.get(p.step) ?? { step: p.step };
        row[`${fullKey}__raw`] = p.value;
        if (p.image_path) row['image_path'] = p.image_path;
        map.set(p.step, row);
      }
      for (const p of s.smooth) {
        const row = map.get(p.step) ?? { step: p.step };
        row[`${fullKey}__smooth`] = p.value;
        map.set(p.step, row);
      }
    }

    const arr = Array.from(map.values());
    arr.sort((a, b) => a.step - b.step);
    return arr;
  }, [perSeries]);

  const hasData = chartData.length > 1;

  const yDomain = useMemo((): [number | 'auto', number | 'auto'] => {
    if (!clipOutliers || chartData.length < 10) return ['auto', 'auto'];

    // Collect visible values (prefer smoothed if shown, else raw)
    const vals: number[] = [];
    const keysToCheck = Object.keys(perSeries);

    for (const row of chartData) {
      for (const key of keysToCheck) {
        const k = showSmoothed ? `${key}__smooth` : `${key}__raw`;
        const v = row[k];
        if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
      }
    }
    if (vals.length < 10) return ['auto', 'auto'];

    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.02)];
    const hi = vals[Math.ceil(vals.length * 0.98) - 1];

    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return ['auto', 'auto'];
    return [lo, hi];
  }, [clipOutliers, chartData, perSeries, showSmoothed]);

  const latestSummary = useMemo(() => {
    // Provide a simple “latest” readout for the first active series
    const firstKey = activeKeys[0];
    if (!firstKey) return null;

    const s = perSeries[firstKey];
    if (!s) return null;

    const lastRaw = s.raw.length ? s.raw[s.raw.length - 1] : null;
    const lastSmooth = s.smooth.length ? s.smooth[s.smooth.length - 1] : null;

    return {
      key: firstKey,
      step: lastRaw?.step ?? lastSmooth?.step ?? null,
      raw: lastRaw?.value ?? null,
      smooth: lastSmooth?.value ?? null,
    };
  }, [activeKeys, perSeries]);

  return (
    <div className="bg-gray-900 rounded-xl shadow-lg overflow-hidden border border-gray-800 flex flex-col">
      <div className="bg-gray-800 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-2 w-2 rounded-full bg-blue-400" />
          <h2 className="text-gray-100 text-sm font-medium">Loss graph</h2>
          <span className="text-xs text-gray-400">
            {status === 'loading' && 'Loading...'}
            {status === 'refreshing' && 'Refreshing...'}
            {status === 'error' && 'Error'}
            {status === 'success' && hasData && `${chartData.length.toLocaleString()} steps`}
            {status === 'success' && !hasData && 'No data yet'}
          </span>
        </div>

        <button
          type="button"
          onClick={refreshLoss}
          className="px-3 py-1 rounded-md text-xs bg-gray-700/60 hover:bg-gray-700 text-gray-200 border border-gray-700"
        >
          Refresh
        </button>
      </div>

      {/* Chart */}
      <div className="px-4  pt-4 pb-4">
        <div className="bg-gray-950 rounded-lg border border-gray-800 h-96 relative">
          {!hasData ? (
            <div className="h-full w-full flex items-center justify-center text-sm text-gray-400">
              {status === 'error' ? 'Failed to load loss logs.' : 'Waiting for loss points...'}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 16, bottom: 10, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  dataKey="step"
                  tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                  tickLine={{ stroke: 'rgba(255,255,255,0.15)' }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.15)' }}
                  minTickGap={40}
                />
                <YAxis
                  scale={useLogScale ? 'log' : 'linear'}
                  tick={{ fill: 'rgba(255,255,255,0.55)', fontSize: 12 }}
                  tickLine={{ stroke: 'rgba(255,255,255,0.15)' }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.15)' }}
                  width={72}
                  tickFormatter={formatNum}
                  domain={yDomain}
                  allowDataOverflow={clipOutliers}
                />
                <Tooltip
                  cursor={{ stroke: 'rgba(59,130,246,0.25)', strokeWidth: 1 }}
                  content={({ active, payload, label }: any) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      const imagePath = data.image_path;
                      return (
                        <div
                          style={{
                            background: 'rgba(17,24,39,0.96)',
                            border: '1px solid rgba(31,41,55,1)',
                            borderRadius: 10,
                            padding: '8px 12px',
                            color: 'rgba(255,255,255,0.9)',
                            fontSize: 12,
                          }}
                        >
                          <p style={{ color: 'rgba(255,255,255,0.75)', marginBottom: 4 }}>{`step ${label}`}</p>
                          {payload.map((entry: any, index: number) => (
                            <div key={index} style={{ color: entry.color, marginBottom: 2 }}>
                              {`${entry.name}: ${formatNum(Number(entry.value))}`}
                            </div>
                          ))}
                          {imagePath && (
                            <div
                              style={{
                                marginTop: 6,
                                borderTop: '1px solid rgba(255,255,255,0.1)',
                                paddingTop: 4,
                                color: 'rgba(255,255,255,0.6)',
                                maxWidth: 300,
                                wordBreak: 'break-all',
                              }}
                            >
                              {imagePath.split(',').map((path: string, i: number) => (
                                <div key={i} style={{ marginBottom: 2 }}>
                                  {path.trim()}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    }
                    return null;
                  }}
                />

                <Legend
                  wrapperStyle={{
                    paddingTop: 8,
                    color: 'rgba(255,255,255,0.7)',
                    fontSize: 12,
                  }}
                />

                {activeKeys.map(k => {
                  const color = strokeForKey(k);
                  // Render Global
                  return (
                    <g key={k}>
                      {showRaw && (
                        <Line
                          type="monotone"
                          dataKey={`${k}__raw`}
                          name={`${k} (raw)`}
                          stroke={color.replace('1)', '0.40)')}
                          strokeWidth={1.25}
                          dot={false}
                          isAnimationActive={false}
                        />
                      )}
                      {showSmoothed && (
                        <Line
                          type="monotone"
                          dataKey={`${k}__smooth`}
                          name={`${k}`}
                          stroke={color}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                        />
                      )}
                    </g>
                  );
                })}
                {/* Render Per-Dataset */}
                {activeKeys.map(k => {
                  return allDatasets.map(ds => {
                    if (!enabledDatasets[ds]) return null;
                    const fullKey = `${k}__ds__${ds}`;
                    // Derive color from fullKey for uniqueness
                    const color = strokeForKey(fullKey);
                    const name = `${k} (${ds})`;

                    return (
                      <g key={fullKey}>
                        {showRaw && (
                          <Line
                            type="monotone"
                            dataKey={`${fullKey}__raw`}
                            name={`${name} (raw)`}
                            stroke={color.replace('1)', '0.40)')}
                            strokeWidth={1.25}
                            dot={false}
                            isAnimationActive={false}
                          />
                        )}
                        {showSmoothed && (
                          <Line
                            type="monotone"
                            dataKey={`${fullKey}__smooth`}
                            name={name}
                            stroke={color}
                            strokeWidth={2}
                            dot={false}
                            isAnimationActive={false}
                          />
                        )}
                      </g>
                    );
                  });
                })}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="px-4 pb-2">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
            <label className="block text-xs text-gray-400 mb-2">Display</label>
            <div className="flex flex-wrap gap-2">
              <ToggleButton checked={showSmoothed} onClick={() => setShowSmoothed(v => !v)} label="Smoothed" />
              <ToggleButton checked={showRaw} onClick={() => setShowRaw(v => !v)} label="Raw" />
              <ToggleButton checked={useLogScale} onClick={() => setUseLogScale(v => !v)} label="Log Y" />
              <ToggleButton checked={clipOutliers} onClick={() => setClipOutliers(v => !v)} label="Clip outliers" />
            </div>
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
            <label className="block text-xs text-gray-400 mb-2">Series</label>
            {lossKeys.length === 0 ? (
              <div className="text-sm text-gray-400">No loss keys found yet.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {lossKeys.map(k => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setEnabled(prev => ({ ...prev, [k]: !(prev[k] ?? true) }))}
                    className={[
                      'px-3 py-1 rounded-md text-xs border transition-colors',
                      enabled[k] === false
                        ? 'bg-gray-900 text-gray-400 border-gray-800 hover:bg-gray-800/60'
                        : 'bg-gray-900 text-gray-200 border-gray-800 hover:bg-gray-800/60',
                    ].join(' ')}
                    aria-pressed={enabled[k] !== false}
                    title={k}
                  >
                    <span className="inline-block h-2 w-2 rounded-full mr-2" style={{ background: strokeForKey(k) }} />
                    {k}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
            <label className="block text-xs text-gray-400 mb-2">Datasets</label>
            {allDatasets.length === 0 ? (
              <div className="text-sm text-gray-400">No datasets found.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {allDatasets.map(ds => (
                  <button
                    key={ds}
                    type="button"
                    onClick={() => setEnabledDatasets(prev => ({ ...prev, [ds]: !prev[ds] }))}
                    className={[
                      'px-3 py-1 rounded-md text-xs border transition-colors',
                      !enabledDatasets[ds]
                        ? 'bg-gray-900 text-gray-400 border-gray-800 hover:bg-gray-800/60'
                        : 'bg-gray-900 text-gray-200 border-gray-800 hover:bg-gray-800/60',
                    ].join(' ')}
                    aria-pressed={enabledDatasets[ds]}
                    title={ds}
                  >
                    {/* Use color from first active key + dataset for dot, or neutral if multiple keys? */}
                    {/* Using just one color for the dot might be misleading if multiple keys are active. */}
                    {/* Let's try to use the color of the first active key + this dataset. */}
                    <span
                      className="inline-block h-2 w-2 rounded-full mr-2"
                      style={{
                        background:
                          activeKeys.length > 0
                            ? strokeForKey(`${activeKeys[0]}__ds__${ds}`)
                            : 'gray',
                      }}
                    />
                    {ds}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-gray-400">Smoothing</label>
              <span className="text-xs text-gray-300">{smoothing}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={smoothing}
              onChange={e => setSmoothing(Number(e.target.value))}
              className="w-full accent-blue-500"
              disabled={!showSmoothed}
            />
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-gray-400">Plot stride</label>
              <span className="text-xs text-gray-300">every {plotStride} pt</span>
            </div>
            <input
              type="range"
              min={1}
              max={20}
              value={plotStride}
              onChange={e => setPlotStride(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="mt-2 text-[11px] text-gray-500">UI downsample for huge runs.</div>
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 md:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-gray-400">Window (last N points)</label>
              <span className="text-xs text-gray-300">{windowSize === 0 ? 'all' : windowSize.toLocaleString()}</span>
            </div>
            <input
              type="range"
              min={0}
              max={20000}
              step={250}
              value={windowSize}
              onChange={e => setWindowSize(Number(e.target.value))}
              className="w-full accent-blue-500"
            />
            <div className="mt-2 text-[11px] text-gray-500">
              Set to 0 to show all (not recommended for very long runs).
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleButton({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'px-3 py-1 rounded-md text-xs border transition-colors',
        checked
          ? 'bg-blue-500/10 text-blue-300 border-blue-500/30 hover:bg-blue-500/15'
          : 'bg-gray-900 text-gray-300 border-gray-800 hover:bg-gray-800/60',
      ].join(' ')}
      aria-pressed={checked}
    >
      {label}
    </button>
  );
}
