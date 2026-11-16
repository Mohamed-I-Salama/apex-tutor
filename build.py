"""Build the shareable Apex Tutor website from the artifact page.

Usage:
    python build.py [the starter-kit zip, or apex-chat.html]

Writes index.html next to this file. Commit and push this folder to update the live site.

why: the artifact asks Claude through the claude.ai viewer, which a plain website lacks,
so shim.js stands in for it and answers through a free, keyless AI service.
"""

import pathlib
import sys
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_SOURCE = HERE.parent / "apex-starter-kit-v8.zip"
KIT_PAGE = "apex-starter-kit/prototype/apex-chat.html"

TAGLINE = (
    "Ask about anything from ferrules to apex locators to NPV. Apex checks what you need "
    "first, teaches it properly, and ends with the best videos in English and Arabic."
)

# why: on this site the answers come from the free AI service, not Claude, so the page must not say Claude.
REWORD = {
    "Only the pages an answer needs are sent to Claude.": "Only the pages an answer needs are sent to the AI that answers.",
    "Pictures can't be sent to Claude from this view.": "Pictures can't be sent from this site.",
}

HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Apex Tutor</title>
<meta name="description" content="{tagline}">
<meta property="og:title" content="Apex Tutor">
<meta property="og:description" content="{tagline}">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%231d2430'/%3E%3Ctext x='32' y='45' font-family='Arial,sans-serif' font-size='38' font-weight='700' text-anchor='middle' fill='%23ffffff'%3EA%3C/text%3E%3C/svg%3E">
<style>:root{{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}}body{{margin:0;font:14px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}}img{{max-width:100%}}[hidden]{{display:none!important}}</style>
<script>
{shim}
</script>
</head>
<body>
"""

TAIL = "\n</body>\n</html>\n"


def read_page(source: pathlib.Path) -> str:
    if source.suffix == ".zip":
        with zipfile.ZipFile(source) as kit:
            return kit.read(KIT_PAGE).decode("utf-8")
    return source.read_text(encoding="utf-8")


def main() -> None:
    source = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SOURCE
    page = read_page(source)
    for old, new in REWORD.items():
        if old not in page:
            sys.exit(f"The page no longer contains: {old}")
        page = page.replace(old, new)
    shim = (HERE / "shim.js").read_text(encoding="utf-8")
    html = HEAD.format(tagline=TAGLINE, shim=shim) + page + TAIL
    (HERE / "index.html").write_text(html, encoding="utf-8", newline="\n")
    print(f"index.html written ({len(html.encode('utf-8')):,} bytes) from {source.name}")


if __name__ == "__main__":
    main()
