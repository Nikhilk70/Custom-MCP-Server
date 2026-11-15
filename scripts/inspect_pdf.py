"""Print page count, text and links of a PDF as JSON (used by resume validation).

Usage: python scripts/inspect_pdf.py <file.pdf>
"""
import json
import sys

import fitz  # PyMuPDF


def main() -> int:
    path = sys.argv[1]
    with open(path, "rb") as fh:
        head = fh.read(5)
    if head != b"%PDF-":
        print(json.dumps({"ok": False, "error": "not a PDF (missing %PDF- header)"}))
        return 0
    doc = fitz.open(path)
    text = "\n".join(page.get_text() for page in doc)
    links = sorted({l["uri"] for page in doc for l in page.get_links() if l.get("uri")})
    print(json.dumps({"ok": True, "pageCount": doc.page_count, "text": text, "links": links}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
