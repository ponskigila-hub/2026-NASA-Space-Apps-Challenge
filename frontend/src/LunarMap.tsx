import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import L from 'leaflet';
import type { RouteOverlay } from './analysisApi';
import wacMetadata from '../public/terrain/hadley-wac.json';
import { Crosshair, Map, Minus, Plus, MousePointer2, Navigation, RotateCcw } from 'lucide-react';
import { formatPoint, lunarDistance, type LunarRegion, type Endpoint, type Endpoints, type Point, type RouteResult } from './lunar';

const BASE = import.meta.env.BASE_URL;
const WMTS = 'https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0';
const HADLEY_BOUNDS: L.LatLngBoundsExpression = [[23.7, -1], [29.1, 8.9]];
const [wacWest, wacSouth, wacEast, wacNorth] = wacMetadata.bounds;
const LOCAL_WAC: L.LatLngBoundsExpression = [[wacSouth, wacWest], [wacNorth, wacEast]];
const MAP_BOUNDS: L.LatLngBoundsExpression = [[-90, -180], [90, 180]];
type MapSource = 'loading' | 'live' | 'local';

const lunarCrs: L.CRS = {
  ...L.CRS.EPSG4326,
  distance(a, b) {
    return 1000 * lunarDistance(fromLatLng(L.latLng(a)), fromLatLng(L.latLng(b)));
  },
};

const toLatLng = ({ lat, lon }: Point): L.LatLngTuple => [lat, lon];
const fromLatLng = ({ lat, lng }: L.LatLng): Point => ({ lat, lon: lng });

function regionBounds([west, south, east, north]: LunarRegion['bounds']) {
  return L.latLngBounds([south, west], [north, east]);
}

function continuousPath(path: Point[]): L.LatLngTuple[] {
  const line: L.LatLngTuple[] = [];
  for (const point of path) {
    const previous = line.at(-1);
    const lon = previous ? point.lon + 360 * Math.round((previous[1] - point.lon) / 360) : point.lon;
    line.push([point.lat, lon]);
  }
  return line;
}

interface Props {
  region: LunarRegion;
  regions: LunarRegion[];
  regionSelectionDisabled: boolean;
  points: Endpoints;
  active: Endpoint | null;
  route: RouteResult | null;
  highlight: Point | null;
  resetSignal: number;
  replay: boolean;
  overlay: RouteOverlay[];
  overlayControls?: ReactNode;
  snapped?: Record<Endpoint, { requested: Point; snapped: Point; snapDistanceM: number }>;
  onPick: (point: Point) => void;
  onMove: (endpoint: Endpoint, point: Point) => void;
  onSelectRegion: (region: LunarRegion) => void;
}

export default function LunarMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{ imagery: L.LayerGroup; coverage: L.LayerGroup; points: L.LayerGroup; route: L.LayerGroup; highlight: L.LayerGroup } | null>(null);
  const [overview, setOverview] = useState(false);
  const current = useRef({ ...props, overview });
  current.current = { ...props, overview };
  const [coordinate, setCoordinate] = useState(() => fromLatLng(regionBounds(props.region.bounds).getCenter()));
  const [source, setSource] = useState<MapSource>('loading');
  const [mapAttempt, setMapAttempt] = useState(0);

  function resetView(instance = map.current) {
    if (!instance) return;
    const { region, regions, overview } = current.current;
    const bounds = regionBounds(region.bounds);
    if (overview) {
      for (const available of regions) bounds.extend(regionBounds(available.bounds));
    }
    instance.fitBounds(bounds, { animate: false, padding: overview ? [58, 55] : [10, 10], maxZoom: overview ? 6 : 9 });
  }

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, {
      crs: lunarCrs, zoomControl: false, attributionControl: false,
      minZoom: 0, maxZoom: 11, maxBounds: MAP_BOUNDS, maxBoundsViscosity: 1,
      doubleClickZoom: false, wheelPxPerZoomLevel: 100,
    });
    map.current = instance;
    resetView(instance);
    const pane = instance.createPane('localImagery');
    const coveragePane = instance.createPane('coverage');
    coveragePane.style.zIndex = '410';
    pane.style.zIndex = '199';
    L.imageOverlay(`${BASE}terrain/moon-wac-overview.webp`, MAP_BOUNDS, { pane: 'localImagery', zIndex: 0 }).addTo(instance);
    layers.current = {
      imagery: L.layerGroup().addTo(instance),
      coverage: L.layerGroup().addTo(instance),
      route: L.layerGroup().addTo(instance),
      points: L.layerGroup().addTo(instance),
      highlight: L.layerGroup().addTo(instance),
    };
    L.control.scale({ imperial: false, maxWidth: 92, position: 'bottomleft' }).addTo(instance);

    instance.on('click', (event: L.LeafletMouseEvent) => {
      const chosen = fromLatLng(event.latlng);
      if (Math.abs(chosen.lat) > 90 || Math.abs(chosen.lon) > 180) return;
      setCoordinate(chosen);
      if (!current.current.overview) current.current.onPick(chosen);
    });
    instance.on('mousemove', (event: L.LeafletMouseEvent) => setCoordinate(fromLatLng(event.latlng)));
    instance.on('moveend', () => setCoordinate(fromLatLng(instance.getCenter())));
    const resize = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    resize.observe(container.current);

    return () => {
      resize.disconnect();
      instance.remove();
      map.current = null;
      layers.current = null;
    };
  }, []);

  useEffect(() => {
    const group = layers.current?.imagery;
    if (!group) return;
    group.clearLayers();
    const options = { pane: 'localImagery' };
    for (const region of props.regions) {
      if (region.relief) {
        L.imageOverlay(BASE + region.relief, regionBounds(region.bounds), options).addTo(group);
      } else if (region.id === 'hadley') {
        L.imageOverlay(`${BASE}hadley-basemap.webp`, HADLEY_BOUNDS, options).addTo(group);
        L.imageOverlay(`${BASE}terrain/hadley-wac.webp`, LOCAL_WAC, options).addTo(group);
      }
    }
  }, [props.regions]);

  useEffect(() => {
    const group = layers.current?.coverage;
    if (!group) return;
    group.clearLayers();
    const visibleRegions = overview ? props.regions : [props.region];
    for (const [index, region] of visibleRegions.entries()) {
      const bounds = regionBounds(region.bounds);
      L.rectangle(bounds, { pane: 'coverage', color: '#e1f78e', weight: overview ? 2 : 1, opacity: 0.85,
        fill: overview, fillOpacity: 0.18, dashArray: overview ? undefined : '5 6', interactive: false }).addTo(group);
      if (!overview) continue;
      const label = document.createElement('span');
      label.textContent = region.name;
      const icon = L.divIcon({ className: `lunar-coverage-label${index % 2 ? ' label-above' : ''}`,
        html: label, iconSize: [140, 44], iconAnchor: [70, 22] });
      const enabled = !props.regionSelectionDisabled;
      const marker = L.marker(bounds.getCenter(), { icon, interactive: enabled, keyboard: enabled });
      marker.on('click', () => {
        setOverview(false);
        current.current.onSelectRegion(region);
      });
      marker.on('keydown', (event: L.LeafletKeyboardEvent) => {
        if (event.originalEvent.key === 'Enter' || event.originalEvent.key === ' ') {
          L.DomEvent.stop(event.originalEvent);
          marker.fire('click');
        }
      });
      marker.addTo(group);
      marker.getElement()?.setAttribute('aria-label', `Open ${region.name}`);
    }
  }, [overview, props.region, props.regions, props.regionSelectionDisabled]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (props.replay) {
      setSource('local');
      return;
    }
    setSource('loading');
    let loaded = false;
    const tiles = L.tileLayer(`${WMTS}/default/default028mm/{z}/{y}/{x}.jpg`, {
      bounds: MAP_BOUNDS, noWrap: true, maxNativeZoom: 8, maxZoom: 11,
      opacity: 0, keepBuffer: 3,
    });
    const timeout = window.setTimeout(() => {
      if (!loaded) setSource('local');
    }, 6500);
    tiles.on('tileload', () => {
      if (loaded) return;
      loaded = true;
      window.clearTimeout(timeout);
      tiles.setOpacity(1);
      setSource('live');
    });
    tiles.on('load', () => {
      if (!loaded) setSource('local');
    });
    tiles.addTo(instance);
    return () => {
      window.clearTimeout(timeout);
      tiles.off();
      tiles.remove();
    };
  }, [mapAttempt, props.replay]);

  useEffect(() => {
    const group = layers.current?.points;
    if (!group) return;
    group.clearLayers();
    if (overview) return;
    for (const endpoint of ['A', 'B'] as const) {
      const point = props.points[endpoint];
      if (!point) continue;
      const icon = L.divIcon({
        className: `lunar-pin lunar-pin-${endpoint.toLowerCase()}`,
        html: `<span aria-hidden="true">${endpoint}</span>`,
        iconSize: [31, 31], iconAnchor: [15, 15],
      });
      const marker = L.marker(toLatLng(point), { icon, draggable: true, title: `Point ${endpoint}` });
      marker.on('dragend', () => {
        const { lat, lng } = marker.getLatLng();
        const clamped = { lat: Math.max(-90, Math.min(90, lat)), lon: Math.max(-180, Math.min(180, lng)) };
        marker.setLatLng(toLatLng(clamped));
        current.current.onMove(endpoint, clamped);
      });
      marker.addTo(group);
      marker.getElement()?.setAttribute('aria-label', `Point ${endpoint} marker`);
      const snapped = props.snapped?.[endpoint];
      if (snapped && snapped.snapDistanceM >= 1) {
        L.polyline([toLatLng(point), toLatLng(snapped.snapped)], {
          color: '#e1f78e', weight: 2, dashArray: '2 3', interactive: false,
        }).addTo(group);
        L.circleMarker(toLatLng(snapped.snapped), { radius: 4, color: '#e1f78e', weight: 1, fillOpacity: 1 })
          .bindTooltip(`Point ${endpoint} snapped ${snapped.snapDistanceM.toFixed(0)} m`).addTo(group);
      }
    }
  }, [overview, props.points, props.snapped]);

  useEffect(() => {
    const group = layers.current?.route;
    if (!group) return;
    group.clearLayers();
    if (overview || !props.route) return;
    const { kind, path } = props.route;
    const line = continuousPath(path);
    const direct = kind === 'direct';
    const offsets = line.every(([, lon]) => Math.abs(lon) <= 180) ? [0] : [-360, 0, 360];
    for (const offset of offsets) {
      const variant: L.LatLngTuple[] = line.map(([lat, lon]) => [lat, lon + offset]);
      L.polyline(variant, { color: '#171a13', weight: 7, opacity: 0.8, interactive: false }).addTo(group);
      L.polyline(variant, {
        color: '#e1f78e', weight: direct ? 2 : 3,
        dashArray: direct ? '7 7' : undefined, interactive: false,
      }).addTo(group);
    }
    for (const section of props.overlay) {
      L.polyline(section.points.map(toLatLng), { color: section.color, weight: 5, interactive: false }).addTo(group);
    }
  }, [overview, props.route, props.overlay]);

  useEffect(() => {
    const group = layers.current?.highlight;
    if (!group) return;
    group.clearLayers();
    if (!overview && props.highlight) {
      L.circleMarker(toLatLng(props.highlight), {
        radius: 7, color: '#f5f4e9', weight: 2, fillColor: '#e1f78e', fillOpacity: 1,
        interactive: false,
      }).addTo(group);
    }
  }, [overview, props.highlight]);

  useLayoutEffect(() => {
    resetView();
  }, [overview, props.resetSignal, props.regions]);

  return (
    <section className="map-shell" aria-label="Interactive lunar map">
      <div className="map-header lunar-map-header">
        <h2 id="lunar-map-title"><Crosshair size={18} /> Lunar map</h2>
        <button type="button" className="pick-button lunar-coverage-toggle" aria-pressed={overview}
          onClick={() => setOverview(value => !value)}><Map size={16} aria-hidden="true" /> Coverage map</button>
        <div className="map-source" role="status">
          <span className={`status-dot status-${source}`} />
          {source === 'live' ? 'Live NASA imagery' : source === 'loading' ? 'Loading NASA imagery' : overview ? 'Offline lunar imagery' : props.region.relief ? 'Offline elevation relief' : 'Hadley offline imagery'}
          {source === 'local' && !props.replay && <button type="button" className="source-retry" aria-label="Retry NASA imagery"
            onClick={() => setMapAttempt(value => value + 1)}><RotateCcw size={14} /></button>}
        </div>
      </div>
      <div className="map-stage">
        <div className={`map-canvas ${!overview && props.active ? 'is-selecting' : ''}`} ref={container}
          role="region" aria-label={overview ? 'Lunar routing coverage. Select a labeled region to open it.' : 'Moon map. Use arrow keys to pan, or enter coordinates in the route planner.'} />
        <div className="map-controls">
          <div className="map-glass zoom-controls">
            <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => map.current?.zoomIn()}><Plus size={18} /></button>
            <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => map.current?.zoomOut()}><Minus size={18} /></button>
          </div>
          <button type="button" className="map-glass reset-map" aria-label="Reset view" title="Reset view"
            onClick={() => resetView()}><Crosshair size={18} /></button>
        </div>
        {!overview && props.overlayControls}
        <div className="map-glass map-hint" role="status">
          <MousePointer2 size={15} />
          {overview ? 'Outlined areas support route planning' : props.active ? `Select point ${props.active} on the map` : props.points.A || props.points.B ? 'Drag a pin to move it' : 'Choose a point in the route planner'}
        </div>
      </div>
      <div className="map-footer">
        <span className="map-position"><Navigation size={13} />{formatPoint(coordinate, 3)}</span>
        <span className="map-credit">
          <a href="https://trek.nasa.gov/moon/" target="_blank" rel="noreferrer">NASA / JPL · LROC WAC</a>
        </span>
      </div>
    </section>
  );
}
