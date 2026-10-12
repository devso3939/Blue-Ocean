"""PDF contact-text extraction roundtrip (run from backend/).

Mirrors the client-side test in ../client/test_pdf.ts: build a tiny PDF whose
text carries an email + phone, then assert the service extracts them. Uses the
same hand-built document so the two lanes are tested against identical input.
"""
from app.services.pdf_extract import _ligatures_and_spaces, extract_pdf_text


def build_pdf(pages: list[str]) -> bytes:
    objs: list[bytes] = []
    kids = " ".join(f"{3 + i} 0 R" for i in range(len(pages)))
    objs.append(b"<</Type/Catalog/Pages 2 0 R>>")
    objs.append(f"<</Type/Pages/Kids[{kids}]/Count {len(pages)}>>".encode("latin1"))
    for i in range(len(pages)):
        content_obj = 3 + len(pages) + i
        objs.append(
            f"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents {content_obj} 0 R"
            "/Resources<</Font<</F1 5 0 R>>>>>>".encode("latin1")
        )
    for text in pages:
        stream = f"BT /F1 18 Tf 60 700 Td ({text}) Tj ET".encode("latin1")
        objs.append(b"<</Length %d>>\nstream\n" % len(stream) + stream + b"\nendstream")
    objs.append(b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>")

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for i, obj in enumerate(objs):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % (i + 1) + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF" % (len(objs) + 1, xref)
    return bytes(out)


# ── normalization (mirrors the client's normalizePdfText) ──────────────
assert _ligatures_and_spaces("o\ufb03ce") == "office"
assert _ligatures_and_spaces("con\ufb01rm") == "confirm"
assert _ligatures_and_spaces("billing @ acme .ge") == "billing@acme .ge"
assert _ligatures_and_spaces("a   b\u00a0c\n\n\n\nd") == "a b c\nd"
assert _ligatures_and_spaces("") == ""

# ── extraction ─────────────────────────────────────────────────────────
pdf = build_pdf(["Contact: info@example-cafe.ge  Call +995 322 19 66 69"])
text = extract_pdf_text(pdf)
assert "info@example-cafe.ge" in text, f"email missing: {text!r}"
assert "+995 322 19 66 69" in text, f"phone missing: {text!r}"

multi = extract_pdf_text(build_pdf(["Page one: sales@acme.ge", "Page two: hr@acme.ge"]))
assert "sales@acme.ge" in multi and "hr@acme.ge" in multi, f"multi-page: {multi!r}"

capped = extract_pdf_text(build_pdf(["Page one: sales@acme.ge", "Page two: hr@acme.ge"]), max_pages=1)
assert "sales@acme.ge" in capped and "hr@acme.ge" not in capped, f"maxPages: {capped!r}"

assert extract_pdf_text(b"") == ""
assert extract_pdf_text(b"\x00\x01\x02\x03\x04\x05") == ""

print("PDF extract OK")
