"""Process entrypoint for a deadline-bound terrain analysis."""
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
import sys

from .lunar_regions import DEFAULT_LUNAR_REGION
from .pipeline import AnalysisError, compute, snap_endpoints


def compute_remote(request):
    from rasterio.errors import RasterioError
    from .analog_sites import NASA_ANALOGS
    from .remote_terrain import custom_region, read_terrain
    from .science import enrich

    def read_site(selection):
        site_id, center = selection
        region = custom_region(center)
        site = NASA_ANALOGS.get(site_id)
        if site:
            region.update({key: site[key] for key in ("name", "location", "description")})
        sources = []
        if site:
            sources.append({"id": f"NASA-analog-{site_id}", "regions": [site_id],
                            "kind": "analog site documentation", "version": "NASA publication",
                            "url": site["sourceUrl"], "license": "See source"})
        for _ in range(2):
            try:
                grid, source, relief = read_terrain(region, site_id)
            except RasterioError:
                continue
            except ValueError:
                break
            return (site_id, grid, region), relief, [*sources, source]
        return (site_id, None, region), None, sources

    region_id = request.get("lunarRegion", DEFAULT_LUNAR_REGION)
    lunar_grid = region = files = snapped = None
    cells = request["cells"]
    if region_id == "auto":
        from .lunar_terrain import prepare_route_grid
        lunar_grid, region, files = prepare_route_grid(request["requested"])
        cells, snapped = snap_endpoints(request["requested"], region_id, lunar_grid)

    selections = request["regions"].items()
    with ThreadPoolExecutor(max_workers=3) as pool:
        prepared = list(pool.map(read_site, selections))
    data = compute(cells, [entry for entry, _, _ in prepared], region_id, lunar_grid, region)
    if files is not None:
        data["lunarSource"] = {"id": "SLDEM2015-ON-DEMAND", "kind": "elevation", "version": "SLDEM2015 V2.0",
                               "url": "https://pgda.gsfc.nasa.gov/products/54", "regions": ["auto"],
                               "license": "NASA Planetary Data System public archive", "files": files}
        data["lunarDataVersion"] = sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()[:16]
    data["customSources"] = [source for _, _, sources in prepared for source in sources]
    candidates = {candidate["id"]: candidate for candidate in data["candidates"]}
    grids = {}
    for (site_id, grid, _), relief, _ in prepared:
        if grid is not None:
            grids[site_id] = grid
            candidates[site_id]["relief"] = relief
    science = enrich(data, request["lunarUtc"], request["earthStart"], grids, lunar_grid)
    return {"data": data, "science": science, "snapped": snapped}


def main():
    try:
        request = json.load(sys.stdin)
        if sys.argv[1:] == ["science"]:
            from .science import enrich
            output = {"data": enrich(request["terrain"], request["lunarUtc"], request["earthStart"])}
        elif sys.argv[1:] == ["custom"]:
            output = compute_remote(request)
        elif isinstance(request, dict):
            output = {"data": compute(request["cells"], region_id=request["lunarRegion"])}
        else:
            output = {"data": compute(request)}
    except AnalysisError as error:
        output = {"error": {"code": error.code, "message": str(error)}}
    json.dump(output, sys.stdout, allow_nan=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
