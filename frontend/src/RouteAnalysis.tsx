import { useState } from 'react';
import { Activity, ArrowDown, ArrowUp, Info, Route, X } from 'lucide-react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Analysis } from './analysisApi';
import type { Point, RouteResult } from './lunar';

type ProfileMetric = 'elevationM' | 'slopeDeg' | 'roughnessM';
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
    <section className="analysis-section" aria-labelledby="analysis-title">
      <header className="panel-heading">
        <h2 id="analysis-title">Route analysis</h2>
        <button type="button" className="icon-button" aria-label="Close route analysis" onClick={onClose}><X size={18} /></button>
      </header>
      <div className="analysis-layout" data-profile={result.profile.length > 0}>
        <div className="analysis-overview">
          {result.lengthKm !== null && result.ascentM !== null && result.descentM !== null && result.steepestDeg !== null ? (
            <div className="metric-grid grid-flow-dense">
              <div><span><Route size={14} /> Route length</span><strong>{result.lengthKm.toFixed(1)} <small>km</small></strong></div>
              <div><span><Activity size={14} /> Maximum grade</span><strong>{result.steepestDeg.toFixed(1)}<small>°</small></strong></div>
              <div><span><ArrowUp size={14} /> Total ascent</span><strong>{Math.round(result.ascentM).toLocaleString()} <small>m</small></strong></div>
              <div><span><ArrowDown size={14} /> Total descent</span><strong>{Math.round(result.descentM).toLocaleString()} <small>m</small></strong></div>
            </div>
          ) : (
            <div className="metric-grid">
              <div>
                <span><Route size={14} /> Direct distance</span>
                <strong>{result.directKm.toFixed(2)} <small>km</small></strong>
              </div>
            </div>
          )}
          <p className="analysis-note"><Info size={16} /> <span>{result.explanation}</span></p>
          <p className="analysis-note">
            {analysis.mode === 'replay' ? 'Validated offline replay. ' : ''}
            A snapped {analysis.endpoints.A.snapDistanceM.toFixed(0)} m · B snapped {analysis.endpoints.B.snapDistanceM.toFixed(0)} m
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
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="chart-caption">{label} ({unit}) by distance along route (km)</p>
            <label className="sample-select">Highlight a profile point
              <select value={selected ?? ''} onChange={event => selectSample(event.target.value === '' ? null : Number(event.target.value))}>
                <option value="">Choose a distance</option>
                {result.profile.map((point, index) => <option key={point.distanceKm} value={index}>
                  {point.distanceKm.toFixed(1)} km · {point[metric].toFixed(metric === 'elevationM' ? 0 : 1)} {unit}
                </option>)}
              </select>
            </label>
          </div>
        )}
      </div>
    </section>
  );
}
