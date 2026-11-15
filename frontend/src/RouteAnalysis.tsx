import { useState } from 'react';
import { Activity, ArrowDown, ArrowUp, MapPin, Route, X } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ReferenceDot, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import RouteStat from './RouteStat';
import type { Analysis } from './analysisApi';
import type { Point, RouteResult } from './lunar';

type ProfileMetric = 'elevationM' | 'slopeDeg' | 'roughnessM';
const chartDescription: Record<ProfileMetric, string> = {
  elevationM: 'Ground height (m) at each distance from point A (km).',
  slopeDeg: 'Ground steepness (°) at each distance from point A (km).',
  roughnessM: 'Variation in nearby ground height (m) at each distance from point A (km).',
};
const metrics = { elevationM: ['Elevation', 'm'], slopeDeg: ['Slope', '°'], roughnessM: ['Roughness', 'm'] } as const;

interface Props {
  result: RouteResult;
  analysis: Analysis;
  onClose: () => void;
  onHighlight: (point: Point | null) => void;
}

export default function RouteAnalysis({ result, analysis, onClose, onHighlight }: Props) {
  const [metric, setMetric] = useState<ProfileMetric>('elevationM');
  const [selected, setSelected] = useState<number | null>(null);
  const [label, unit] = metrics[metric];
  const sample = selected === null ? null : result.profile[selected];

  function selectSample(index: number | null) {
    setSelected(index);
    onHighlight(index === null ? null : result.profile[index].point);
  }

  return (
    <section className="analysis-section route-analysis" aria-labelledby="analysis-title">
      <header className="panel-heading">
        <h2 id="analysis-title"><span className="planner-icon"><Route size={19} aria-hidden="true" /></span> Route analysis</h2>
        <button type="button" className="icon-button" aria-label="Close route analysis" onClick={onClose}><X size={18} /></button>
      </header>
      <p className="analysis-note"><span>These measurements describe the calculated lunar route from <strong>A to B</strong>, using elevation data from NASA’s Lunar Reconnaissance Orbiter.</span></p>
      <div className="analysis-layout" data-profile={result.profile.length > 0}>
        <div className="analysis-overview">
          {result.lengthKm !== null && result.ascentM !== null && result.descentM !== null && result.steepestDeg !== null ? (
            <div className="metric-grid grid-flow-dense">
              <RouteStat label="Route length" icon={<Route size={14} />} description="Total distance traveled along the calculated path.">
                {result.lengthKm.toFixed(1)} <small>km</small>
              </RouteStat>
              <RouteStat label="Maximum grade" icon={<Activity size={14} />} description="The steepest uphill or downhill step along the route, measured in degrees from level ground.">
                {result.steepestDeg.toFixed(1)}<small>°</small>
              </RouteStat>
              <RouteStat label="Total ascent" icon={<ArrowUp size={14} />} description="The total height gained across all uphill sections.">
                {Math.round(result.ascentM).toLocaleString()} <small>m</small>
              </RouteStat>
              <RouteStat label="Total descent" icon={<ArrowDown size={14} />} description="The total height lost across all downhill sections.">
                {Math.round(result.descentM).toLocaleString()} <small>m</small>
              </RouteStat>
            </div>
          ) : (
            <div className="metric-grid">
              <RouteStat label="Direct distance" icon={<Route size={14} />} description="The shortest surface distance between points A and B.">
                {result.directKm.toFixed(2)} <small>km</small>
              </RouteStat>
            </div>
          )}
          <p className="analysis-note route-data-details">
            <span><strong>Terrain data</strong> · 90 m grid · <strong>{(analysis.lunar.corridor.coverage * 100).toFixed(1)}%</strong> usable coverage around the route.</span>
          </p>
        </div>
        {result.profile.length > 0 && (
          <div className="profile">
            <div className="profile-heading">
              <h3>Terrain profile</h3>
              <div className="segmented" role="group" aria-label="Terrain profile metric">
                {(Object.keys(metrics) as ProfileMetric[]).map(key => (
                  <button key={key} type="button" aria-pressed={metric === key} onClick={() => setMetric(key)}>{metrics[key][0]}</button>
                ))}
              </div>
            </div>
            <p className="chart-caption">{chartDescription[metric]}</p>
            <div className="chart-container" onMouseLeave={() => onHighlight(sample?.point ?? null)}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={result.profile} margin={{ top: 10, right: 12, left: 0, bottom: 3 }}
                  onClick={state => {
                    const index = Number(state?.activeTooltipIndex);
                    if (state?.activeTooltipIndex !== undefined && Number.isInteger(index) && result.profile[index]) {
                      selectSample(index);
                      return;
                    }
                    const distance = Number(state?.activeLabel);
                    if (!Number.isFinite(distance)) return;
                    const match = result.profile.findIndex(point => point.distanceKm === distance);
                    if (match >= 0) selectSample(match);
                  }}
                  onMouseMove={state => {
                    const distance = Number(state?.activeLabel);
                    const next = result.profile.find(point => point.distanceKm === distance);
                    onHighlight(next?.point ?? sample?.point ?? null);
                  }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="distanceKm" type="number" domain={[0, 'dataMax']}
                    tickFormatter={value => `${Number(value).toFixed(result.profile.at(-1)!.distanceKm < 2 ? 2 : 0)}`} tickCount={5}
                    stroke="var(--muted)" tick={{ fontSize: 11 }} />
                  <YAxis width={48} domain={metric === 'elevationM' ? ['dataMin - 50', 'dataMax + 50'] : [0, 'dataMax + 1']}
                    tickFormatter={value => `${Number(value).toFixed(0)}`} stroke="var(--muted)" tick={{ fontSize: 11 }} />
                  <Tooltip labelFormatter={value => `${Number(value).toFixed(1)} km`}
                    formatter={value => [`${Number(value).toFixed(metric === 'elevationM' ? 0 : 1)} ${unit}`, label]}
                    contentStyle={{ background: 'var(--panel)', borderColor: 'var(--line)', borderRadius: 8, fontSize: 12 }} />
                  <Line type="linear" dataKey={metric} stroke="var(--accent)" strokeWidth={2.4} dot={false}
                    activeDot={{ r: 5 }} isAnimationActive={false} />
                  {sample && <ReferenceDot x={sample.distanceKm} y={sample[metric]} r={6}
                    fill="var(--mission-cyan)" stroke="var(--panel)" strokeWidth={2} />}
                </LineChart>
              </ResponsiveContainer>
            </div>
            <div className="route-point-controls">
              <label className="sample-select route-distance-slider">
                <strong>Inspect distance from point A</strong>
                <input type="range" min={0} max={result.profile.length - 1} step={1} value={selected ?? 0}
                  aria-valuetext={`${(sample?.distanceKm ?? 0).toFixed(2)} kilometers from point A`}
                  onChange={event => selectSample(Number(event.target.value))} />
              </label>
              {sample && <div className="route-point-selection">
                <output><strong>{sample.distanceKm.toFixed(2)} km</strong> from A · {label} <strong>{sample[metric].toFixed(metric === 'elevationM' ? 0 : 1)} {unit}</strong></output>
                <a className="pick-button" href="#lunar-map-title" onClick={() => onHighlight(sample.point)}>
                  <MapPin size={15} aria-hidden="true" /> Show on lunar map
                </a>
              </div>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
