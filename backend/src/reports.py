"""Build portable exports from the exact analysis the client displayed."""
from io import BytesIO
import json
from zipfile import ZIP_DEFLATED, ZipFile

from .config import PRESETS


def report_text(result, site):
    site_name = site["name"] if site else "No site selected"
    title = f"# AstroScan field-test report — {site_name}"
    weights = ", ".join(f"{feature} {weight:.0%}" for feature, weight in result["effectiveWeights"].items())
    lunar = result["lunar"]
    lines = [title, "", f"Analysis `{result['id']}` ({result['mode']})",
             f"Data `{result['dataVersion']}` · Model `{result['algorithmVersion']}`", "",
             f"**Objective** {PRESETS[result['preset']]} · Effective weights ({weights})", "",
             "## Lunar traverse", "", f"Frame — {result['moonFrame']}",
             f"Traverse length {lunar['lengthKm']:.2f} km · Direct {result['directKm']:.2f} km",
             f"Ascent {lunar['ascentM']:.0f} m · Descent {lunar['descentM']:.0f} m · Maximum grade {lunar['steepestDeg']:.1f}°",
             f"Valid corridor {lunar['corridor']['coverage']:.1%} · Coverage confidence {lunar['evidence']['confidence']}"]
    for label, endpoint in result["endpoints"].items():
        requested, snapped = endpoint["requested"], endpoint["snapped"]
        lines.append(f"- {label} requested {requested['lat']:.6f}°, {requested['lon']:.6f}°"
                     f" → snapped {snapped['lat']:.6f}°, {snapped['lon']:.6f}° ({endpoint['snapDistanceM']:.0f} m).")
    lines += ["", "## Earth matches", ""]
    for candidate in result["candidates"]:
        if candidate["status"] == "matched":
            route = candidate["route"]
            features = candidate["featureScores"]
            lines.append(f"- {candidate['rank']}. **{candidate['name']}** · {route['lengthKm']:.2f} km"
                         f" · similarity {candidate['score']:.3f} · slope {features['slope']:.3f}"
                         f" · roughness {features['roughness']:.3f} · coverage {route['corridor']['coverage']:.1%}"
                         f" · coverage confidence {candidate['evidence']['confidence']}.")
        else:
            lines.append(f"- **{candidate['name']}** · {candidate['reason']}")
    lines += ["", "## Field test", ""]
    if site and site["status"] == "matched":
        start, end = site["route"]["path"][0], site["route"]["path"][-1]
        lines.append(f"Selected traverse runs from {start['lat']:.6f}°, {start['lon']:.6f}° "
                     f"to {end['lat']:.6f}°, {end['lon']:.6f}°. See the Earth route in the accompanying GeoJSON.")
        lines.append({
            "rover_navigation": "Measure traction and camera-based navigation performance across resolved grades.",
            "camera_lighting": "Measure obstacle detection and position error across sunlit and shaded route segments.",
            "mineral_mapping": "Record field spectra and sample location across mapped rock-unit boundaries.",
        }[result["preset"]])
    elif site:
        lines.append(f"The selected site is unevaluable. {site['reason']}")
    else:
        lines.append("No eligible matched site is available for a field test.")
    light = result.get("lighting") or {}
    lines += ["", "## Illumination and test windows", ""]
    if light.get("elevationDeg") is not None:
        lines.append(f"Lunar scenario {light['utc']} · Sun {light['elevationDeg']:.1f}° above the horizon "
                     f"· azimuth {light['azimuthDeg']:.1f}° · shadow {light['shadowFraction']:.1%} "
                     f"of evaluable route samples · coverage {light['coverage']:.1%}.")
        lines.append(light["method"])
    if light.get("reason"):
        lines.append(light["reason"])
    site_light = (site or {}).get("lighting") or {}
    if light.get("earthStart"):
        lines.append(f"Earth search started {light['earthStart']} UTC.")
    for window in site_light.get("windows", []):
        best = window["frames"][window["bestFrame"]]
        lines.append(f"- {window['startLocal']} to {window['endLocal']} ({window['timeZone']}) "
                     f"· UTC {window['startUtc']} to {window['endUtc']} · best frame {best['utc']}, "
                     f"shadow {best['shadowFraction']:.1%} · coverage {best['coverage']:.1%}.")
    if site_light.get("reason"):
        lines.append(site_light["reason"])
    lines += ["", "## Mineral evidence and mapped geology", ""]
    for label, evidence in [("Moon", result.get("minerals")), (site_name, (site or {}).get("minerals"))]:
        if not evidence:
            continue
        mapped = evidence.get("lithology", {})
        units = ", ".join(f"{unit['name']} {unit['fraction']:.1%}" for unit in mapped.get("units", []))
        if units:
            lines.append(f"- {label} mapped units · {units} · coverage {mapped['coverage']:.1%}.")
        spectral = evidence["spectral"]
        if spectral.get("reason"):
            lines.append(f"- {label} spectra · {spectral['reason']}")
        for name, band in spectral.get("bands", {}).items():
            lines.append(f"- {label} {name} · median depth {band['medianDepth']:.1%} · center {band['medianCenterNm']:.0f} nm "
                         f"· {band['independentPixels']} pixels · coverage {band['coverage']:.1%}.")
    lines.append("Mapped units provide qualitative rock-type context. Spectral scoring requires shared calibrated bands across every eligible candidate.")
    lines += ["", "## Limitations", "", *(f"- {item}" for item in result["limitations"]), "",
              "## Sources", ""]
    lines.extend(f"- [{source['id']}]({source['url']}) · {source['version']} · {source['license']}"
                 for source in result["sources"])
    return "\n".join(lines) + "\n"


def export_bundle(result, site_id=None):
    site = next((c for c in result["candidates"] if c["id"] == site_id), None) if site_id else next(
        (c for c in result["candidates"] if c["status"] == "matched"), None)
    if site_id and site is None:
        raise ValueError("Unknown Earth site.")
    earth = [
        {"type": "Feature", "properties": {"site": c["id"], "rank": c["rank"]}, "geometry": {
            "type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in c["route"]["path"]],
        }}
        for c in result["candidates"] if c["status"] == "matched"
    ]
    data = {
        "analysis.json": result,
        "candidates.json": result["candidates"],
        "earth-routes.geojson": {"type": "FeatureCollection", "features": earth},
        "lunar-route.json": {"body": "Moon", "frame": result["moonFrame"], "radiusM": result["moonRadiusM"],
                             "coordinateOrder": ["longitude", "latitude"], "units": "degrees",
                             "type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in result["lunar"]["path"]]},
        "profiles.json": {"moon": result["lunar"]["profile"], "earth": {
            c["id"]: c["route"]["profile"] for c in result["candidates"] if c["status"] == "matched"}},
        "sources.json": {"dataVersion": result["dataVersion"], "scienceVersion": result.get("scienceVersion"),
                         "sources": result["sources"]},
        "shadows/manifest.json": {"moon": result.get("lighting"),
                                 "earth": {c["id"]: c.get("lighting") for c in result["candidates"]}},
        "minerals.json": {"moon": result.get("minerals"),
                          "earth": {c["id"]: c.get("minerals") for c in result["candidates"]}},
    }
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        for name, value in data.items():
            archive.writestr(name, json.dumps(value, ensure_ascii=False, allow_nan=False))
        archive.writestr("report.md", report_text(result, site))
    return output.getvalue()
