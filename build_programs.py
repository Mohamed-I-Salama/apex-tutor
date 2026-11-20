"""Build programs.json, the university programmes students can pick in the "Your studies" panel.

Usage:
    python build_programs.py [path to the starter-kit zip]

Reads the kit's curriculum/programs/*.yaml overlays (ADR 0002) and keeps what the website needs:
each programme's terms, courses per term and exam weights, plus the faculties not yet mapped.
build.py inlines the result into index.html.
"""

import json
import pathlib
import sys
import zipfile

import yaml

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_KIT = HERE.parent / "apex-starter-kit-v8.zip"
PREFIX = "apex-starter-kit/curriculum/programs/"


def main() -> None:
    kit = zipfile.ZipFile(pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_KIT)
    programs, unmapped = [], []
    for name in sorted(n for n in kit.namelist() if n.startswith(PREFIX) and n.endswith(".yaml")):
        data = yaml.safe_load(kit.read(name).decode("utf-8"))
        base = name[len(PREFIX):]
        if base == "_not_yet_mapped.yaml":
            for row in data.get("not_yet_mapped") or []:
                # why: one entry lists several universities, which YAML read as extra keys.
                names = [row.get("institution")] + [k for k in row if k not in ("institution", "faculty", "reason")]
                for inst in names:
                    for part in str(inst or "").replace(" and ", ", ").split(","):
                        if part.strip():
                            unmapped.append({"institution": part.strip(), "faculty": row.get("faculty") or ""})
            continue
        if base.startswith("_"):
            continue
        structure = data.get("structure") or {}
        weights = (data.get("assessment") or {}).get("weights") or None
        programs.append({
            "id": data["id"],
            "institution": data.get("institution"),
            "short": data.get("short_name"),
            "faculty": data.get("faculty"),
            "degree": data.get("degree"),
            "specialty": data.get("specialty"),
            "track": data.get("track"),
            "format": data.get("format"),
            "completeness": data.get("completeness"),
            "terms": structure.get("terms") or [],
            "parts": structure.get("parts") or None,
            "courses": [
                {"term": c.get("term"), "code": str(c.get("code") or ""), "title": c.get("title"), "credits": c.get("credits")}
                for c in data.get("courses") or [] if c.get("title")
            ],
            "weights": weights,
        })
    out = {"programs": programs, "unmapped": unmapped}
    path = HERE / "programs.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"programs.json: {len(programs)} programmes, {len(unmapped)} faculties not yet mapped, {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
