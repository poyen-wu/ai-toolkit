'use client';

import { Job } from '@prisma/client';
import useJobLossLog, { LossPoint } from '@/hooks/useJobLossLog';
import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function getMad(values: number[], med: number): number {
  if (values.length === 0) return 0;
  const devs = values.map(v => Math.abs(v - med));
  return median(devs);
}

function interpolateSmoothPoints(
  points: { step: number; value: number }[],
  bins: number,
  removeOutliers: boolean = true,
) {
  if (points.length === 0) return [];
  if (points.length < 5) return points;

  const minStep = points[0].step;
  const maxStep = points[points.length - 1].step;
  const range = maxStep - minStep;
  if (range <= 0) return points;

  // Helper to build curve (bin centers)
  const buildCurve = (pts: { step: number; value: number }[]) => {
    const binWidth = range / bins;
    const binData: number[][] = Array.from({ length: bins }, () => []);

    for (const p of pts) {
      const binIdx = Math.min(bins - 1, Math.floor((p.step - minStep) / binWidth));
      binData[binIdx].push(p.value);
    }

    const curvePoints: { step: number; value: number }[] = [];
    for (let i = 0; i < bins; i++) {
      if (binData[i].length === 0) continue;
      const val = median(binData[i]);
      const center = minStep + (i + 0.5) * binWidth;
      curvePoints.push({ step: center, value: val });
    }
    return curvePoints;
  };

  // Helper to interpolate
  const evalCurve = (curve: { step: number; value: number }[], x: number) => {
    if (curve.length === 0) return 0;
    if (x <= curve[0].step) return curve[0].value;
    if (x >= curve[curve.length - 1].step) return curve[curve.length - 1].value;

    let i = 0;
    while (i < curve.length - 1 && curve[i + 1].step < x) {
      i++;
    }
    const p0 = curve[i];
    const p1 = curve[i + 1];
    if (p1.step === p0.step) return p0.value;

    const t = (x - p0.step) / (p1.step - p0.step);
    return p0.value + t * (p1.value - p0.value);
  };

  let currentPoints = points;
  let curvePoints: { step: number; value: number }[] = [];

  if (removeOutliers) {
    // Iterations for outlier removal
    const iterations = 3;
    for (let iter = 0; iter < iterations; iter++) {
      curvePoints = buildCurve(currentPoints);
      if (curvePoints.length < 2) break;

      const binWidth = range / bins;
      const binDevs: number[][] = Array.from({ length: bins }, () => []);
      const pointDevs: { idx: number; val: number; binIdx: number }[] = [];

      // Calculate deviations
      for (let i = 0; i < currentPoints.length; i++) {
        const p = currentPoints[i];
        const baseline = evalCurve(curvePoints, p.step);
        // Avoid log(0) or negative
        const v = p.value > 1e-9 ? p.value : 1e-9;
        const b = baseline > 1e-9 ? baseline : 1e-9;
        const dev = Math.log(v / b);

        const binIdx = Math.min(bins - 1, Math.floor((p.step - minStep) / binWidth));
        binDevs[binIdx].push(dev);
        pointDevs.push({ idx: i, val: dev, binIdx });
      }

      const binStats = binDevs.map(devs => {
        if (devs.length < 2) return null;
        const med = median(devs);
        const mad = getMad(devs, med);
        return { med, mad };
      });

      const nextPoints: { step: number; value: number }[] = [];
      const threshold = 3.5;
      const k = 1.4826;

      for (let i = 0; i < currentPoints.length; i++) {
        const { val: dev, binIdx } = pointDevs[i];
        const stats = binStats[binIdx];

        if (!stats || stats.mad === 0) {
          nextPoints.push(currentPoints[i]);
          continue;
        }

        const z = (dev - stats.med) / (k * stats.mad);
        if (Math.abs(z) <= threshold) {
          nextPoints.push(currentPoints[i]);
        }
      }

      if (nextPoints.length === currentPoints.length) break;
      currentPoints = nextPoints;
    }
  }

  // Final curve
  curvePoints = buildCurve(currentPoints);

  // Return smooth values for ORIGINAL points
  return points.map(p => ({
    step: p.step,
    value: evalCurve(curvePoints, p.step),
  }));
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
  if (key === 'loss/loss (timestep corrected)') {
    return 'rgba(52,211,153,1)'; // emerald-400
  }
  return PALETTE[hashToIndex(key, PALETTE.length)];
}

interface DualSliderProps {
  min: number;
  max: number;
  value: [number, number];
  onChange: (value: [number, number]) => void;
  className?: string;
  disabled?: boolean;
}

function DualSlider({ min, max, value, onChange, className, disabled }: DualSliderProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'min' | 'max' | null>(null);

  const getPercent = useCallback(
    (v: number) => {
      if (max === min) return 0;
      return Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100));
    },
    [min, max],
  );

  const handlePointerDown = (e: React.PointerEvent, thumb: 'min' | 'max') => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();
    setDragging(thumb);
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
  };

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging || disabled || !trackRef.current) return;
      const rect = trackRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const val = Math.round(min + ratio * (max - min));

      const [currMin, currMax] = value;
      if (dragging === 'min') {
        const newMin = Math.min(val, currMax - 1); // Ensure min < max
        const clampedMin = Math.max(min, newMin);
        onChange([clampedMin, currMax]);
      } else {
        const newMax = Math.max(val, currMin + 1); // Ensure max > min
        const clampedMax = Math.min(max, newMax);
        onChange([currMin, clampedMax]);
      }
    },
    [dragging, disabled, min, max, value, onChange],
  );

  const handlePointerUp = (e: React.PointerEvent) => {
    setDragging(null);
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  };

  const minPercent = getPercent(value[0]);
  const maxPercent = getPercent(value[1]);

  return (
    <div className={className}>
      <div
        ref={trackRef}
        className={`relative w-full h-6 select-none touch-none ${disabled ? 'opacity-50 pointer-events-none' : ''}`}
        onPointerMove={handlePointerMove}
      >
        {/* Track */}
        <div className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-2 bg-gray-700 rounded-full" />

        {/* Fill */}
        <div
          className="absolute top-1/2 -translate-y-1/2 h-2 bg-blue-500 rounded-full"
          style={{ left: `${minPercent}%`, width: `${maxPercent - minPercent}%` }}
        />

        {/* Thumb Min */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow cursor-pointer border border-gray-300 hover:scale-110 transition-transform -ml-2"
          style={{ left: `${minPercent}%`, zIndex: dragging === 'min' ? 20 : 10 }}
          onPointerDown={e => handlePointerDown(e, 'min')}
          onPointerUp={handlePointerUp}
        />

        {/* Thumb Max */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white rounded-full shadow cursor-pointer border border-gray-300 hover:scale-110 transition-transform -ml-2"
          style={{ left: `${maxPercent}%`, zIndex: dragging === 'max' ? 20 : 10 }}
          onPointerDown={e => handlePointerDown(e, 'max')}
          onPointerUp={handlePointerUp}
        />
      </div>
    </div>
  );
}

export default function JobLossGraph({ job }: Props) {
  const { series, lossKeys, status, refreshLoss } = useJobLossLog(job.id, 2000);

  // Parse job config to get total steps
  const trainSteps = useMemo(() => {
    try {
      if (!job.job_config) return 10000;
      const c = JSON.parse(job.job_config);
      // Try to find steps in various locations
      const steps = c?.config?.process?.[0]?.train?.steps ?? c?.process?.[0]?.train?.steps ?? c?.train?.steps;
      if (typeof steps === 'number') return steps;
    } catch {}
    return 10000;
  }, [job.job_config]);

  // Controls
  const [useLogScale, setUseLogScale] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [showSmoothed, setShowSmoothed] = useState(false);
  const [showInterpolated, setShowInterpolated] = useState(true);
  const [showGlobal, setShowGlobal] = useState(true);

  // 0..100 slider. 100 = no smoothing, 0 = heavy smoothing.
  const [smoothing, setSmoothing] = useState(90);
  const [interpolateBins, setInterpolateBins] = useState(5);
  const [correctedBins, setCorrectedBins] = useState(15);
  const [removeOutliers, setRemoveOutliers] = useState(false);

  // UI-only downsample for rendering speed
  const [plotStride, setPlotStride] = useState(1);

  // Start/End range for windowing
  const [windowRange, setWindowRange] = useState<[number, number]>([1, trainSteps]);
  const [timestepRange, setTimestepRange] = useState<[number, number]>([50, 950]);

  // quick y clipping for readability
  const [clipOutliers, setClipOutliers] = useState(false);

  // which loss series are enabled (default: all enabled)
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});

  // which datasets are enabled
  const [enabledDatasets, setEnabledDatasets] = useState<Record<string, boolean>>({});

  const timestepKey = useMemo(() => Object.keys(series).find(k => /timestep/i.test(k)), [series]);

  // Determine the actual range of timesteps available in the data
  const dataTimestepRange = useMemo((): [number, number] => {
    if (!timestepKey) return [0, 1000];
    const pts = series[timestepKey] || [];
    if (pts.length === 0) return [0, 1000];
    let min = Infinity;
    let max = -Infinity;
    for (const p of pts) {
      if (p.value !== null && Number.isFinite(p.value)) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
      }
    }
    if (min === Infinity) return [0, 1000];
    return [Math.floor(min), Math.ceil(max)];
  }, [series, timestepKey]);

  // Update timestepRange if data range changes significantly
  useEffect(() => {
    setTimestepRange(prev => {
      const [min, max] = dataTimestepRange;
      if (prev[0] === 0 && prev[1] === 1000) {
        return [min, max];
      }
      return [Math.max(prev[0], min), Math.min(prev[1], max)];
    });
  }, [dataTimestepRange]);

  const correctedKey = 'loss/loss (timestep corrected)';

  const selectableKeys = useMemo(() => {
    const k = [...lossKeys];
    if (timestepKey && !k.includes(timestepKey)) k.push(timestepKey);
    if (series['loss/loss'] && timestepKey) {
      k.push(correctedKey);
    }
    return k.sort();
  }, [lossKeys, timestepKey, series]);

  // keep enabled map in sync with discovered keys (enable new ones automatically)
  useEffect(() => {
    setEnabled(prev => {
      const next = { ...prev };
      for (const k of selectableKeys) {
        if (next[k] === undefined) {
          if (k === correctedKey) {
            next[k] = false;
          } else {
            next[k] = true;
          }
        }
      }
      // drop removed keys
      for (const k of Object.keys(next)) {
        if (!selectableKeys.includes(k)) delete next[k];
      }
      return next;
    });
  }, [selectableKeys]);

  // Update windowRange if trainSteps changes drastically and range is out of bounds
  useEffect(() => {
    setWindowRange(prev => {
      const [s, e] = prev;
      if (e > trainSteps) {
        return [Math.min(s, trainSteps), trainSteps];
      }
      return prev;
    });
  }, [trainSteps]);

  const activeKeys = useMemo(() => selectableKeys.filter(k => enabled[k] !== false), [selectableKeys, enabled]);
  
  const isTimestepMode = useMemo(() => activeKeys.length === 1 && activeKeys[0] === timestepKey, [activeKeys, timestepKey]);

  const allDatasets = useMemo(() => {
    const set = new Set<string>();
    for (const key of activeKeys) {
      if (key === timestepKey && isTimestepMode) continue; // Skip dataset grouping for timestep mode
      const pts = series[key] ?? [];
      for (const p of pts) {
        if (p.image_path) {
          set.add(getDatasetFromPath(p.image_path));
        }
      }
    }
    return Array.from(set).sort();
  }, [series, activeKeys, timestepKey, isTimestepMode]);

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
    let augmentedSeries = { ...series };
    if (series['loss/loss'] && timestepKey) {
      const lossPts = series['loss/loss'];
      const tsPts = series[timestepKey]!;

      const stepToTs = new Map<number, number>();
      tsPts.forEach(p => {
        if (p.value !== null && Number.isFinite(p.value)) stepToTs.set(p.step, p.value!);
      });

      const matched: { step: number; loss: number; ts: number }[] = [];
      let totalLoss = 0;
      lossPts.forEach(p => {
        const ts = stepToTs.get(p.step);
        if (ts !== undefined && p.value !== null && Number.isFinite(p.value)) {
          matched.push({ step: p.step, loss: p.value!, ts });
          totalLoss += p.value!;
        }
      });

      if (matched.length > 5) {
        const avgLoss = totalLoss / matched.length;

        // Use the robust interpolateSmoothPoints algorithm
        // We need to pass it points where "step" is actually "timestep"
        const pointsByTs = matched
          .map(m => ({ step: m.ts, value: m.loss }))
          .sort((a, b) => a.step - b.step);

        const smoothedTsCurve = interpolateSmoothPoints(pointsByTs, correctedBins, removeOutliers);
        // smoothedTsCurve has the same length as pointsByTs and corresponds 1:1
        const tsToExpected = new Map<number, number>();
        smoothedTsCurve.forEach(p => {
          tsToExpected.set(p.step, p.value);
        });

        const correctedPts: LossPoint[] = matched.map(m => {
          const expected = tsToExpected.get(m.ts) || avgLoss;
          const factor = expected > 1e-9 ? avgLoss / expected : 1;
          return {
            step: m.step,
            value: m.loss * factor,
            image_path: null,
          };
        });
        augmentedSeries[correctedKey] = correctedPts;
      }
    }

    // Build per-series processed point arrays (raw + smoothed), then merge by step for charting.
    const stride = Math.max(1, plotStride | 0);

    // smoothing%: 0 => no smoothing (alpha=1.0), 100 => heavy smoothing (alpha=0.02)
    const t = clamp01(smoothing / 100);
    const alpha = 1.0 - t * 0.98; // 1.0 -> 0.02

    const out: Record<
      string,
      {
        raw: { step: number; value: number; image_path?: string | null }[];
        smooth: { step: number; value: number }[];
        interp: { step: number; value: number }[];
      }
    > = {};

    // Create a mapping of step to timestep for filtering
    const stepToTimestep = new Map<number, number>();
    if (timestepKey) {
      (series[timestepKey] || []).forEach(p => {
        if (p.value !== null && Number.isFinite(p.value)) {
          stepToTimestep.set(p.step, p.value);
        }
      });
    }

    const processPoints = (rawPts: { step: number; value: number; image_path?: string | null }[], outKey: string) => {
      let r = rawPts;

      // Windowing by step range
      const [startStep, endStep] = windowRange;
      if (startStep > 1 || endStep < trainSteps) {
        r = r.filter(p => p.step >= startStep && p.step <= endStep);
      }

      // Windowing by timestep range
      if (timestepKey) {
        const [minTs, maxTs] = timestepRange;
        r = r.filter(p => {
          const ts = stepToTimestep.get(p.step);
          if (ts === undefined) return true; // Keep points without timestep info? Or filter them? 
          // Usually we want to filter if we have the info.
          return ts >= minTs && ts <= maxTs;
        });
      }

      const smooth = emaSmoothPoints(r, alpha);
      const interp = showInterpolated ? interpolateSmoothPoints(r, interpolateBins, removeOutliers) : [];
      out[outKey] = { raw: r, smooth, interp };
    };

    const keysToProcess = [...activeKeys];
    if (timestepKey && !keysToProcess.includes(timestepKey)) {
      keysToProcess.push(timestepKey);
    }

    for (const key of keysToProcess) {
      // Special Mode: Timestep only
      if (isTimestepMode && key === timestepKey) {
        const lossKey = selectableKeys.find(k => k !== timestepKey && /loss/i.test(k)) || selectableKeys[0];
        const lossPts = augmentedSeries[lossKey] || [];
        const tsPts = augmentedSeries[timestepKey] || [];

        const stepLoss = new Map<number, number>();
        lossPts.forEach(p => {
          if (p.value !== null && Number.isFinite(p.value)) stepLoss.set(p.step, p.value!);
        });

        const [startStep, endStep] = windowRange;
        const byTs = new Map<number, number[]>();

        for (let i = 0; i < tsPts.length; i += stride) {
          const p = tsPts[i];
          if (p.step < startStep || p.step > endStep) continue;
          if (p.value === null || !Number.isFinite(p.value)) continue;

          const l = stepLoss.get(p.step);
          if (l !== undefined) {
             const ts = Math.round(p.value!);
             const arr = byTs.get(ts);
             if (arr) arr.push(l);
             else byTs.set(ts, [l]);
          }
        }

        const raw: { step: number; value: number; image_path?: string | null }[] = [];
        for (const [ts, vals] of byTs.entries()) {
          const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
          raw.push({ step: ts, value: avg, image_path: null });
        }
        raw.sort((a, b) => a.step - b.step);

        const smooth = emaSmoothPoints(raw, alpha);
        const interp = showInterpolated ? interpolateSmoothPoints(raw, interpolateBins, removeOutliers) : [];
        out[key] = { raw, smooth, interp };
        continue;
      }

      // Normal processing
      const pts: LossPoint[] = augmentedSeries[key] ?? [];

      // Filter and stride first
      const rawAll = pts
        .filter((p: LossPoint) => p.value !== null && Number.isFinite(p.value as number))
        .map((p: LossPoint) => ({ step: p.step, value: p.value as number, image_path: p.image_path }))
        .filter((p: { step: number; value: number }) => (useLogScale ? p.value > 0 : true))
        .filter((_: any, idx: number) => idx % stride === 0);

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
  }, [
    series,
    activeKeys,
    smoothing,
    interpolateBins,
    correctedBins,
    removeOutliers,
    showInterpolated,
    plotStride,
    windowRange,
    timestepRange,
    useLogScale,
    enabledDatasets,
    trainSteps,
    isTimestepMode,
    timestepKey,
    selectableKeys,
  ]);

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
      for (const p of s.interp) {
        const row = map.get(p.step) ?? { step: p.step };
        row[`${fullKey}__interp`] = p.value;
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
        // Exclude timestep values from Y domain if not in Timestep Mode
        if (!isTimestepMode && timestepKey && key.includes(timestepKey)) continue;

        if (showSmoothed) {
          const v = row[`${key}__smooth`];
          if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
        }
        if (showInterpolated) {
          const v = row[`${key}__interp`];
          if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
        }
        if (!showSmoothed && !showInterpolated) {
          const v = row[`${key}__raw`];
          if (typeof v === 'number' && Number.isFinite(v)) vals.push(v);
        }
      }
    }
    if (vals.length < 10) return ['auto', 'auto'];

    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.02)];
    const hi = vals[Math.ceil(vals.length * 0.98) - 1];

    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return ['auto', 'auto'];
    return [lo, hi];
  }, [clipOutliers, chartData, perSeries, showSmoothed, showInterpolated, isTimestepMode, timestepKey]);

  const latestSummary = useMemo(() => {
    // Provide a simple “latest” readout for the first active series
    const firstKey = activeKeys[0];
    if (!firstKey) return null;

    const s = perSeries[firstKey];
    if (!s) return null;

    const lastRaw = s.raw.length ? s.raw[s.raw.length - 1] : null;
    const lastSmooth = s.smooth.length ? s.smooth[s.smooth.length - 1] : null;
    const lastInterp = s.interp.length ? s.interp[s.interp.length - 1] : null;

    return {
      key: firstKey,
      step: lastRaw?.step ?? lastSmooth?.step ?? lastInterp?.step ?? null,
      raw: lastRaw?.value ?? null,
      smooth: lastSmooth?.value ?? null,
      interp: lastInterp?.value ?? null,
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
            {status === 'success' && hasData && `${chartData[chartData.length - 1].step.toLocaleString()} steps`}
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
                      if (isTimestepMode) {
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
                            <p style={{ color: 'rgba(255,255,255,0.75)', marginBottom: 4 }}>{`timestep ${label}`}</p>
                            {payload.map((entry: any, index: number) => (
                              <div key={index} style={{ color: entry.color, marginBottom: 2 }}>
                                {`Loss: ${formatNum(Number(entry.value))}`}
                              </div>
                            ))}
                          </div>
                        );
                      }

                      const data = payload[0].payload;
                      const imagePath = data.image_path;
                      const tsKeyRaw = Object.keys(data).find(k => /timestep.*__raw/i.test(k));
                      const tsKeySmooth = Object.keys(data).find(k => /timestep.*__smooth/i.test(k));
                      const tsKeyInterp = Object.keys(data).find(k => /timestep.*__interp/i.test(k));
                      const timestep =
                        (tsKeyRaw ? data[tsKeyRaw] : null) ??
                        (tsKeySmooth ? data[tsKeySmooth] : null) ??
                        (tsKeyInterp ? data[tsKeyInterp] : null);
                      return (
                        <div
                          style={{
                            background: 'rgba(17,24,39,0.96)',
                            border: '1px solid rgba(31,41,55,1)',
                            borderRadius: 10,
                            padding: '8px 12px',
                            color: 'rgba(255,255,255,0.9)',
                            fontSize: 12,
                            zIndex: 100,
                          }}
                        >
                          <p style={{ color: 'rgba(255,255,255,0.75)', marginBottom: 4 }}>{`step ${label}`}</p>
                          {typeof timestep === 'number' && (
                            <div style={{ color: 'rgba(255,255,255,0.5)', marginBottom: 2 }}>
                              {`timestep: ${formatNum(timestep)}`}
                            </div>
                          )}
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
                  if (!showGlobal) return null;
                  // In mixed mode, don't plot timestep as a line, only keep it for tooltip
                  if (!isTimestepMode && k === timestepKey) return null;
                  
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
                          connectNulls
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
                          connectNulls
                        />
                      )}
                      {showInterpolated && (
                        <Line
                          type="monotone"
                          dataKey={`${k}__interp`}
                          name={`${k} (interp)`}
                          stroke={color}
                          strokeWidth={2}
                          dot={false}
                          isAnimationActive={false}
                          connectNulls
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
                            connectNulls
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
                            connectNulls
                          />
                        )}
                        {showInterpolated && (
                          <Line
                            type="monotone"
                            dataKey={`${fullKey}__interp`}
                            name={`${name} (interp)`}
                            stroke={color}
                            strokeWidth={2}
                            strokeDasharray="8 1"
                            dot={false}
                            isAnimationActive={false}
                            connectNulls
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
              <ToggleButton checked={showGlobal} onClick={() => setShowGlobal(v => !v)} label="Global" />
              <ToggleButton
                checked={showSmoothed}
                onClick={() => setShowSmoothed(v => !v)}
                label="Smoothed (Linear)"
              />
              <ToggleButton
                checked={showInterpolated}
                onClick={() => setShowInterpolated(v => !v)}
                label="Smooth (Interpolate)"
              />
              <ToggleButton checked={showRaw} onClick={() => setShowRaw(v => !v)} label="Raw" />
              <ToggleButton checked={useLogScale} onClick={() => setUseLogScale(v => !v)} label="Log Y" />
              <ToggleButton checked={clipOutliers} onClick={() => setClipOutliers(v => !v)} label="Clip outliers" />
            </div>
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
            <label className="block text-xs text-gray-400 mb-2">Series</label>
            {selectableKeys.length === 0 ? (
              <div className="text-sm text-gray-400">No loss keys found yet.</div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {selectableKeys.map(k => (
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
              <div className="flex items-center gap-2">
                <label className="block text-xs text-gray-400">Interpolate Bins</label>
                <button
                  type="button"
                  onClick={() => setRemoveOutliers(v => !v)}
                  disabled={!showInterpolated}
                  className={[
                    'px-1.5 py-0.5 rounded text-[10px] border transition-colors',
                    removeOutliers
                      ? 'bg-blue-500/10 text-blue-300 border-blue-500/30 hover:bg-blue-500/15'
                      : 'bg-gray-900 text-gray-500 border-gray-800 hover:bg-gray-800/60',
                  ].join(' ')}
                >
                  Remove outliers
                </button>
              </div>
              <span className="text-xs text-gray-300">{interpolateBins}</span>
            </div>
            <input
              type="range"
              min={1}
              max={trainSteps}
              value={interpolateBins}
              onChange={e => setInterpolateBins(Number(e.target.value))}
              className="w-full accent-blue-500"
              disabled={!showInterpolated}
            />
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <label className="block text-xs text-gray-400">Corrected Bins</label>
                <button
                  type="button"
                  onClick={() => setRemoveOutliers(v => !v)}
                  disabled={!enabled[correctedKey]}
                  className={[
                    'px-1.5 py-0.5 rounded text-[10px] border transition-colors',
                    removeOutliers
                      ? 'bg-blue-500/10 text-blue-300 border-blue-500/30 hover:bg-blue-500/15'
                      : 'bg-gray-900 text-gray-500 border-gray-800 hover:bg-gray-800/60',
                  ].join(' ')}
                >
                  Remove outliers
                </button>
              </div>
              <span className="text-xs text-gray-300">{correctedBins}</span>
            </div>
            <input
              type="range"
              min={1}
              max={2000}
              value={correctedBins}
              onChange={e => setCorrectedBins(Number(e.target.value))}
              className="w-full accent-blue-500"
              disabled={!enabled[correctedKey]}
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
              <label className="block text-xs text-gray-400">Window (steps)</label>
              <span className="text-xs text-gray-300">
                {windowRange[0]} - {windowRange[1]}
              </span>
            </div>
            <DualSlider
              min={1}
              max={trainSteps}
              value={windowRange}
              onChange={setWindowRange}
              className="w-full pt-1"
            />
            <div className="mt-2 text-[11px] text-gray-500">
              Select step range to display (total steps: {trainSteps.toLocaleString()}).
            </div>
          </div>

          <div className="bg-gray-950 border border-gray-800 rounded-lg p-3 md:col-span-2">
            <div className="flex items-center justify-between mb-1">
              <label className="block text-xs text-gray-400">Timestep Filter</label>
              <span className="text-xs text-gray-300">
                {timestepRange[0]} - {timestepRange[1]}
              </span>
            </div>
            <DualSlider
              min={dataTimestepRange[0]}
              max={dataTimestepRange[1]}
              value={timestepRange}
              onChange={setTimestepRange}
              className="w-full pt-1"
              disabled={!timestepKey}
            />
            <div className="mt-2 text-[11px] text-gray-500">
              Filter data by timestep range (available: {dataTimestepRange[0]} - {dataTimestepRange[1]}).
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
