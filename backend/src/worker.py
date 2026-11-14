"""Process entrypoint for a deadline-bound terrain analysis."""
import json
import sys

from .pipeline import AnalysisError, compute


def main():
    try:
        request = json.load(sys.stdin)
        if sys.argv[1:] == ["science"]:
            from .science import enrich
            output = {"data": enrich(request["terrain"], request["lunarUtc"], request["earthStart"])}
        else:
            output = {"data": compute(request)}
    except AnalysisError as error:
        output = {"error": {"code": error.code, "message": str(error)}}
    json.dump(output, sys.stdout, allow_nan=False, separators=(",", ":"))


if __name__ == "__main__":
    main()
