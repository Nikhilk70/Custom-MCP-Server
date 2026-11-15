"""Extract text and hyperlinks from the user's resume PDF.

The output is the evidence base that `npm run import-profile -- --verify`
checks every MY_DATA fact against. It never interprets or rewrites content.

Usage: python scripts/extract_resume_text.py <resume.pdf> <out-dir>
Requires PyMuPDF (`pip install pymupdf`).
"""
import hashlib
import json
import sys
from pathlib import Path

import fitz  # PyMuPDF


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: extract_resume_text.py <resume.pdf> <out-dir>", file=sys.stderr)
        return 2
    pdf_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)

    data = pdf_path.read_bytes()
    doc = fitz.open(stream=data, filetype="pdf")
    pages = [page.get_text() for page in doc]
    links = sorted({l["uri"] for page in doc for l in page.get_links() if l.get("uri")})

    (out_dir / "resume.txt").write_text("\n".join(pages), encoding="utf-8")
    meta = {
        "sourceFile": pdf_path.name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "pageCount": doc.page_count,
        "links": links,
    }
    (out_dir / "resume.meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "pageCount": doc.page_count, "links": len(links)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
