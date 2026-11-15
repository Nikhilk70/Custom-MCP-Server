"""TEST-ONLY helper: write plain text into a multi-page PDF (used by the fake compiler in tests)."""
import sys

import fitz

lines = [l.strip() for l in open(sys.argv[1], encoding="utf-8").read().splitlines() if l.strip()]
doc = fitz.open()
page, y = None, 800
for line in lines:
    for i in range(0, len(line), 150):
        if y > 780:
            page, y = doc.new_page(), 40
        page.insert_text((36, y), line[i : i + 150], fontsize=6)
        y += 8
doc.save(sys.argv[2])
