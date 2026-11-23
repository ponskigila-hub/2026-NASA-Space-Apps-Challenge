import L from 'leaflet';
import { useEffect, useRef, type ReactNode } from 'react';
import type { Candidate, RouteOverlay, TerrainRoute } from './analysisApi';
import type { Point } from './lunar';
import wacMetadata from '../public/terrain/hadley-wac.json';

const toLatLng = ({ lat, lon }: Point): L.LatLngTuple => [lat, lon];
const base = import.meta.env.BASE_URL;
const moonBounds = wacMetadata.bounds as [number, number, number, number];

export default function TerrainRouteInset({ name, route, overlays, site, caption, description, marker, pathColor = '#e1f78e' }: {
  name: string;
  route: TerrainRoute;
  overlays: RouteOverlay[];
  site?: Pick<Candidate, 'id' | 'bounds' | 'relief'>;
  caption?: ReactNode;
  description?: string;
  marker?: Point | null;
  pathColor?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const highlights = useRef<L.LayerGroup | null>(null);
  const markers = useRef<L.LayerGroup | null>(null);
  const lunar = !site;
  const [west, south, east, north] = site?.bounds ?? moonBounds;
  const image = site ? site.relief ?? `${base}terrain/${site.id}-relief.webp` : `${base}terrain/hadley-wac.webp`;

  useEffect(() => {
    if (!container.current || !route.path.length) return;
    const element = container.current;
    const map = L.map(element, {
      crs: lunar ? L.CRS.EPSG4326 : L.CRS.EPSG3857,
      attributionControl: false, zoomControl: false, zoomSnap: .25, zoomAnimation: false,
      dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false,
      keyboard: false, touchZoom: false, trackResize: false,
    });
    const path = route.path.map(toLatLng);
    if (image && west < east && south < north) {
      L.imageOverlay(image, [[south, west], [north, east]], { alt: '' }).addTo(map);
    }
    L.polyline(path, { color: '#161b19', weight: 5, interactive: false }).addTo(map);
    L.polyline(path, { color: pathColor, weight: 2, interactive: false }).addTo(map);
    highlights.current = L.layerGroup().addTo(map);
    for (const point of [path[0], path.at(-1)!]) {
      L.circleMarker(point, { radius: 3, color: '#f5f4e9', weight: 1, fillColor: '#161b19',
        fillOpacity: 1, interactive: false }).addTo(map);
    }
    markers.current = L.layerGroup().addTo(map);
    function fit() {
      map.invalidateSize({ pan: false });
      map.fitBounds(L.latLngBounds(path), { animate: false, padding: [17, 17], maxZoom: lunar ? 12 : 15 });
    }
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => { observer.disconnect(); map.remove(); highlights.current = null; markers.current = null; };
  }, [route, image, west, south, east, north, lunar, pathColor]);

  useEffect(() => {
    const group = highlights.current;
    if (!group) return;
    group.clearLayers();
    for (const section of overlays) {
      L.polyline(section.points.map(toLatLng), { color: '#161b19', weight: 7, interactive: false }).addTo(group);
      L.polyline(section.points.map(toLatLng), { color: section.color, weight: 4, interactive: false }).addTo(group);
    }
  }, [route, image, west, south, east, north, lunar, pathColor, overlays]);

  useEffect(() => {
    const group = markers.current;
    if (!group) return;
    group.clearLayers();
    if (marker) L.circleMarker(toLatLng(marker), { radius: 5, color: '#171a13', weight: 2, fillColor: '#fff',
      fillOpacity: 1, interactive: false }).addTo(group);
  }, [route, image, west, south, east, north, lunar, pathColor, marker, overlays]);

  return <figure className="terrain-inset">
    <figcaption>{name}{caption}</figcaption>
    <div className="terrain-inset-map" ref={container} role="img" aria-label={
      description ?? (overlays.length ? `${name} route with ${overlays.length} highlighted stretches` : `${name} route`)}
    />
  </figure>;
}
