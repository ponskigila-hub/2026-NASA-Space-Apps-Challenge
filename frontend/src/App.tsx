import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent, type Ref } from 'react';
import { ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, Crosshair, Layers, MapPin, Orbit, RotateCcw, Route, Sun } from 'lucide-react';
import LunarMap from './LunarMap';
import AnalysisLoading from './AnalysisLoading';
import { MissionHeader } from './MissionSummary';
import RouteAnalysis from './RouteAnalysis';
import { previewRoute, HADLEY_REGION, type LunarRegion, type Endpoint, type Endpoints, type Point } from './lunar';

import { analyze, applyPreset, defaultEarthStart, defaultLunarUtc, getEarthSites, getLunarRegions, presets, replay, terrainRoute, type Analysis, type Preset, type Replay, type RouteOverlay } from './analysisApi';

gsap.registerPlugin(useGSAP);

const moonStill = `${import.meta.env.BASE_URL}moon-still.webp`;
const Moon = lazy(() => import('./Moon'));
const EarthComparison = lazy(() => import('./EarthComparison'));
const endpoints = ['A', 'B'] as const;
const objectiveHelp: Record<Preset, string> = {
  rover_navigation: 'Gives more weight to steepness and roughness.',
  camera_lighting: 'Gives more weight to Sun angles and shadows when comparable lighting data is available.',
  mineral_mapping: 'Gives more weight to rock signals when the ranked sites have comparable satellite measurements.',
};

function Intro({ buttonRef, onEnter }: { buttonRef: Ref<HTMLButtonElement>; onEnter: () => void }) {
  const intro = useRef<HTMLElement>(null);

  useGSAP(() => {
    const motion = gsap.matchMedia();
    motion.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.timeline({ defaults: { ease: 'power2.out', clearProps: 'opacity,transform' } })
        .from('.intro-moon', { opacity: 0, scale: 0.96, duration: 0.85 })
        .from('.intro-copy', { opacity: 0, y: 14, duration: 0.48 }, '<0.16');
    });
    return () => motion.revert();
  }, { scope: intro });

  return (
    <section ref={intro} className="intro" aria-labelledby="intro-title">
      <div className="intro-orbit" aria-hidden="true">
        <div className="intro-moon">
          <img src={moonStill} alt="" width={840} height={840} fetchPriority="high" />
          <Suspense fallback={null}><Moon /></Suspense>
        </div>
      </div>
      <div className="intro-copy">
        <h1 id="intro-title">AstroScan<span aria-hidden="true">.</span></h1>
        <p>Explore the lunar surface and plot a route of your own.</p>
        <button ref={buttonRef} type="button" className="primary-button intro-button" onClick={onEnter}>
          Explore the Moon <ArrowUpRight size={17} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

interface CoordinateFormProps {
  endpoint: Endpoint;
  point: Point | null;
  active: boolean;
  onSelect: () => void;
  onSave: (point: Point) => void;
}

function CoordinateForm({ endpoint, point, active, onSelect, onSave }: CoordinateFormProps) {
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const coordinates = new FormData(event.currentTarget);
    onSave({ lat: Number(coordinates.get('lat')), lon: Number(coordinates.get('lon')) });
  }

  return (
    <form className="coordinate-form" data-active={active} onSubmit={save}>
      <div className="point-heading">
        <h3><span className={`point-letter point-${endpoint.toLowerCase()}`}>{endpoint}</span>
          {endpoint === 'A' ? 'Start point' : 'End point'}</h3>
        <button className="pick-button" type="button" title={`Pick point ${endpoint} on the map`}
          aria-label={`Pick point ${endpoint} on the map`} aria-pressed={active} onClick={onSelect}>
          <Crosshair size={14} /> Pick on map
        </button>
      </div>
      <div className="coordinate-inputs">
        <label>Latitude<input name="lat" type="number" required min={-90} max={90} step="any"
          placeholder="0.000000" defaultValue={point?.lat.toFixed(6)} /></label>
        <label>Longitude<input name="lon" type="number" required min={-180} max={180} step="any"
          placeholder="0.000000" defaultValue={point?.lon.toFixed(6)} /></label>
        <button className="text-button" type="submit" aria-label={`Set coordinates for point ${endpoint}`}>Set</button>
      </div>
    </form>
  );
}

export default function App() {
  const [entered, setEntered] = useState(false);
  const [points, setPoints] = useState<Endpoints>({ A: null, B: null });
  const [active, setActive] = useState<Endpoint | null>('A');
  const [lunarRegion, setLunarRegion] = useState(HADLEY_REGION);
  const [lunarRegions, setLunarRegions] = useState<LunarRegion[]>([HADLEY_REGION]);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [lunarUtc, setLunarUtc] = useState(defaultLunarUtc);
  const [earthStart, setEarthStart] = useState(defaultEarthStart);
  const [overlay, setOverlay] = useState<RouteOverlay[]>([]);
  const [overlayMode, setOverlayMode] = useState<'lighting' | 'minerals' | null>(null);
  const [preset, setPreset] = useState<Preset>('rover_navigation');
  const [rankingEarthSites, setRankingEarthSites] = useState(false);
  const [loadingReplay, setLoadingReplay] = useState(false);
  const [replayCase, setReplayCase] = useState<Replay | null>(null);
  const request = useRef<AbortController | null>(null);
  const [highlight, setHighlight] = useState<Point | null>(null);
  const [resetSignal, setResetSignal] = useState(0);
  const [formRevision, setFormRevision] = useState({ A: 0, B: 0 });
  const workspaceHeading = useRef<HTMLHeadingElement>(null);
  const workspace = useRef<HTMLElement>(null);
  const analysis = useRef<HTMLDivElement>(null);
  const analyzeButton = useRef<HTMLButtonElement>(null);
  const introButton = useRef<HTMLButtonElement>(null);

  const preview = useMemo(() => points.A && points.B ? previewRoute(points.A, points.B) : null, [points]);
  const route = useMemo(() => result ? terrainRoute(result) : preview, [preview, result]);

  useEffect(() => () => request.current?.abort(), []);

  useEffect(() => {
    if (!entered) return;
    const controller = new AbortController();
    getLunarRegions(controller.signal).then(regions => {
      if (controller.signal.aborted || !regions.length) return;
      setLunarRegions(regions);
      setLunarRegion(previous => regions.find(region => region.id === previous.id) ?? previous);
    }).catch(() => {
      // The bundled Hadley replays remain available offline.
    });
    return () => controller.abort();
  }, [entered]);

  useEffect(() => {
    if (entered) workspaceHeading.current?.focus({ preventScroll: true });
  }, [entered]);

  useGSAP(() => {
    if (!entered || !workspace.current) return;
    const motion = gsap.matchMedia();
    motion.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from(workspace.current?.querySelectorAll('.workspace-heading, .map-shell, .planner') ?? [], {
        opacity: 0, y: 16, duration: 0.48, stagger: 0.075, ease: 'power2.out', clearProps: 'opacity,transform',
      });
    });
    return () => motion.revert();
  }, { dependencies: [entered], revertOnUpdate: true });

  function mapOverlayControls(hasShadows: boolean, hasRocks: boolean) {
    if (!hasShadows && !hasRocks) return null;
    return <div className="map-overlay-controls" role="group" aria-label="Overlays on both main maps">
      {hasShadows && <button type="button" className="pick-button map-shadow-control"
        aria-pressed={overlayMode === 'lighting'} onClick={() => setOverlayMode(mode => mode === 'lighting' ? null : 'lighting')}>
        <Sun size={15} aria-hidden="true" /> Shadows
      </button>}
      {hasRocks && <button type="button" className="pick-button map-rock-control"
        aria-pressed={overlayMode === 'minerals'} onClick={() => setOverlayMode(mode => mode === 'minerals' ? null : 'minerals')}>
        <Layers size={15} aria-hidden="true" /> Rock units
      </button>}
    </div>;
  }

  function clearAnalysis() {
    request.current?.abort();
    setResult(null);
    setStatus('');
    setLoading(false);
    setRankingEarthSites(false);
    setReplayCase(null);
    setOverlay([]);
    setOverlayMode(null);
    setAnalysisOpen(false);
    setHighlight(null);
  }

  async function runAnalysis(demo?: Replay) {
    if (!demo && (!points.A || !points.B)) return;
    if (demo) {
      request.current?.abort();
      setRankingEarthSites(false);
      setStatus('');
    } else {
      clearAnalysis();
    }
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setLoadingReplay(Boolean(demo));
    setAnalysisOpen(true);
    if (!demo) {
      requestAnimationFrame(() => {
        if (controller.signal.aborted) return;
        analysis.current?.focus({ preventScroll: true });
        analysis.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
      });
    }
    try {
      const earthSites = demo ? [] : (await getEarthSites(controller.signal)).map(site => site.id);
      const calculated = demo
        ? await replay(demo, controller.signal)
        : await analyze(points.A!, points.B!, preset, new Date(lunarUtc + 'Z').toISOString(), earthStart, controller.signal, { earthSites, lunarRegion: lunarRegion.id });
      if (controller.signal.aborted) return;
      if (demo) {
        setOverlayMode(null);
        setReplayCase(demo);
        setLunarRegion(calculated.lunarRegion ?? HADLEY_REGION);
        setOverlay([]);
        setHighlight(null);
        setPoints({ A: calculated.endpoints.A.requested, B: calculated.endpoints.B.requested });
        setFormRevision(previous => ({ A: previous.A + 1, B: previous.B + 1 }));
        setActive(null);
        setResetSignal(value => value + 1);
        setPreset(calculated.preset);
        if (calculated.lighting?.utc) setLunarUtc(calculated.lighting.utc.slice(0, 16));
        if (calculated.lighting?.earthStart) setEarthStart(calculated.lighting.earthStart);
      }
      setResult(calculated);
      requestAnimationFrame(() => {
        if (controller.signal.aborted) return;
        analysis.current?.focus({ preventScroll: true });
        analysis.current?.scrollIntoView({ behavior: 'instant', block: 'start' });
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setStatus(error instanceof Error ? error.message : 'The analysis could not load.');
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  function setPoint(endpoint: Endpoint, point: Point) {
    clearAnalysis();
    setPoints(previous => ({ ...previous, [endpoint]: point }));
    setFormRevision(previous => ({ ...previous, [endpoint]: previous[endpoint] + 1 }));
    setHighlight(null);
  }

  function selectPoint(endpoint: Endpoint, point: Point) {
    setPoint(endpoint, point);
    const next = endpoint === 'A' ? 'B' : 'A';
    setActive(points[next] ? null : next);
  }

  function loadExample() {
    clearAnalysis();
    setPoints(lunarRegion.example);
    setFormRevision(previous => ({ A: previous.A + 1, B: previous.B + 1 }));
    setActive(null);
    setHighlight(null);
    setResetSignal(value => value + 1);
  }

  function clearPoints() {
    clearAnalysis();
    setPoints({ A: null, B: null });
    setFormRevision(previous => ({ A: previous.A + 1, B: previous.B + 1 }));
    setActive('A');
    setAnalysisOpen(false);
    setHighlight(null);
  }

  function selectRegion(selected: LunarRegion) {
    if (selected.id === lunarRegion.id || loading || rankingEarthSites) return;
    clearPoints();
    setLunarRegion(selected);
  }

  return (
    <div className={`app ${entered ? 'app-explorer' : 'app-intro'}`}>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><span className="brand-mark" aria-hidden="true"><Orbit size={19} strokeWidth={1.65} /></span>AstroScan</div>
          {entered ? (
            <button className="back-button" type="button" onClick={() => {
              setEntered(false);
              window.scrollTo(0, 0);
              requestAnimationFrame(() => introButton.current?.focus());
            }}><ArrowLeft size={15} /> Back to intro</button>
          ) : <span className="challenge-credit">NASA Space Apps Challenge</span>}
        </div>
      </header>

      <main>
        {!entered ? (
          <Intro buttonRef={introButton} onEnter={() => setEntered(true)} />
        ) : (
          <section ref={workspace} className="workspace" aria-labelledby="workspace-title">
            <header className="workspace-heading">
              <div className="workspace-heading-copy">
                <div className="workspace-location"><MapPin size={15} /> Moon <span>/</span> Lunar terrain</div>
                <h1 id="workspace-title" ref={workspaceHeading} tabIndex={-1}>{lunarRegion.name}<span aria-hidden="true">.</span></h1>
              </div>
              <p className="workspace-description">Explore the lunar surface and plan a traverse between two points.</p>
            </header>
            <div className="workspace-grid">
              <LunarMap key={lunarRegion.id} region={lunarRegion} regions={lunarRegions} regionSelectionDisabled={loading || rankingEarthSites}
                points={points} active={active} route={route} highlight={highlight} replay={replayCase !== null} overlay={overlay} snapped={result?.endpoints} resetSignal={resetSignal}
                overlayControls={analysisOpen && !loading && !rankingEarthSites && result ? mapOverlayControls(
                  Boolean(result.lighting?.states?.length), Boolean(result.minerals?.lithology?.segments.length)) : undefined}
                onSelectRegion={selected => {
                  selectRegion(selected);
                  workspaceHeading.current?.focus({ preventScroll: true });
                }}
                onPick={point => { if (active) selectPoint(active, point); }} onMove={setPoint} />
              <aside className="planner" aria-label="Route planner">
                <div className="planner-body">
                  <div className="planner-heading">
                    <header className="panel-heading">
                      <h2><span className="planner-icon"><Route size={20} /></span> Route planner</h2>
                      <button className="icon-button" type="button" aria-label="Clear route" title="Clear route"
                        disabled={!points.A && !points.B} onClick={clearPoints}><RotateCcw size={17} /></button>
                    </header>
                    <p className="planner-instructions">Pick two points inside the selected region. Routes can be up to {lunarRegion.maxRouteKm} km.</p>
                    <label className="sample-select lunar-region-picker">Lunar region
                      <select value={lunarRegion.id} disabled={loading || rankingEarthSites} onChange={event => {
                        const selected = lunarRegions.find(region => region.id === event.target.value);
                        if (selected) selectRegion(selected);
                      }}>
                        {lunarRegions.map(region => <option key={region.id} value={region.id}>{region.name}</option>)}
                      </select>
                    </label>
                  </div>
                  <div className="planner-endpoints">
                    {endpoints.map(endpoint => (
                      <CoordinateForm key={`${endpoint}-${formRevision[endpoint]}`} endpoint={endpoint} point={points[endpoint]}
                        active={active === endpoint} onSelect={() => setActive(active === endpoint ? null : endpoint)}
                        onSave={point => selectPoint(endpoint, point)} />
                    ))}
                  </div>
                  <div className="planner-actions">
                    <div className="route-summary" aria-live="polite"><div><span>Direct distance</span><small>Shortest surface distance from A to B</small></div>
                      <strong>{route ? <>{route.directKm.toFixed(2)} <small>km</small></> : <small>Set two points</small>}</strong>
                    </div>
                    <label className="sample-select">Mission objective
                      <select aria-describedby="objective-help" value={preset} disabled={loading} onChange={event => {
                        const objective = event.target.value as Preset;
                        setPreset(objective);
                        setResult(previous => previous ? applyPreset(previous, objective) : null);
                      }}>
                        {Object.entries(presets).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
                      </select>
                    </label>
                    <p className="planner-help" id="objective-help">Changes how Earth sites are ranked. {objectiveHelp[preset]} The lunar path stays the same.</p>
                    <details className="scenario-controls">
                      <summary>Lighting scenario</summary>
                      <p className="planner-help">Set the Moon’s Sun angle and modeled route shadows, then choose when to start looking for similar daylight on Earth.</p>
                      <label className="sample-select">Lunar date and time (UTC)
                        <input type="datetime-local" value={lunarUtc} min="1900-01-01T00:00" max="2100-12-31T23:59"
                          onChange={event => { clearAnalysis(); setLunarUtc(event.target.value); }} />
                      </label>
                      <label className="sample-select">First day to search on Earth (UTC)
                        <input type="date" value={earthStart} min="1900-01-01" max="2100-12-31"
                          onChange={event => { clearAnalysis(); setEarthStart(event.target.value); }} />
                      </label>
                      <p className="planner-help">The app searches the next 30 days for similar Sun angles and shadow coverage. Click Analyze route after changing these settings.</p>
                    </details>
                    <button ref={analyzeButton} className="primary-button analyze-button" type="button" disabled={!preview || loading || !lunarUtc || !earthStart}
                      aria-expanded={analysisOpen} onClick={() => void runAnalysis()}>
                      {loading ? 'Analyzing…' : 'Analyze route'} <ArrowDownRight size={18} />
                    </button>
                    <button type="button" className="example-button" onClick={loadExample}>
                      <Route size={15} /> Load {lunarRegion.shortName} example <ArrowRight size={15} />
                    </button>
                    <div className="replay-controls" aria-label="Offline replay">
                      <button className="pick-button" type="button" onClick={() => void runAnalysis('hadley')}>Replay Hadley</button>
                      <button className="pick-button" type="button" onClick={() => void runAnalysis('rille')}>Replay the rille</button>
                    </div>
                  </div>
                </div>
              </aside>
            </div>
            {analysisOpen && (
              <div ref={analysis} className="analysis-target" tabIndex={-1} role="group" aria-label="Route analysis">
                {loading && (loadingReplay
                  ? <AnalysisLoading title="Opening replay" detail="Loading the saved route and Earth comparisons." />
                  : <AnalysisLoading title="Analyzing your lunar route" detail="Calculating the lunar path and ranking Earth sites. Results appear once every site has been processed."
                      estimate={{ seconds: 120, label: 'Estimated total · About 1–2 minutes for a new route' }} />)}
                {status && <div className="analysis-section" role="alert">{status}</div>}
                {!loading && result && route && (
                  <>
                    <MissionHeader ranking={rankingEarthSites} result={result} />
                    <RouteAnalysis key={result.id} result={route} analysis={result} onHighlight={setHighlight}
                      onClose={() => {
                        setAnalysisOpen(false);
                        setOverlayMode(null);
                        setRankingEarthSites(false);
                        setHighlight(null);
                        analyzeButton.current?.focus();
                      }} />
                    <Suspense fallback={<p className="analysis-note" role="status">Loading Earth comparison…</p>}>
                      <EarthComparison key={result.id} result={result} replayCase={result.mode === 'replay' ? replayCase : null} onUpdate={updated =>
                        setResult(current => current?.id === result.id ? applyPreset(updated, current.preset) : current)}
                        ranking={rankingEarthSites} onRankingChange={setRankingEarthSites}
                        onHighlight={setHighlight} onMoonOverlay={setOverlay} mapOverlayControls={mapOverlayControls} overlayMode={overlayMode} />
                    </Suspense>
                  </>
                )}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
