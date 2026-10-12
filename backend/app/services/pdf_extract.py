"""PDF contact-text extraction (server side) — v6.9.155.

Menus, brochures, price lists and company profiles are PDFs, and business
contact details hide in them. The browser client extracts this text with
pdf.js (client/src/pdfSkills.ts), but a cross-origin PDF that the browser
cannot fetch (CORS) is fetched and read here instead.

This module returns TEXT ONLY — no per-field parsing and no contact
validation. Callers run their own validators on the returned text exactly
like the client does, so the trust boundary stays in one place.

Backends, in order:
  1. PyMuPDF (``pymupdf``/``fitz``) — fastest, best layout handling.
  2. pdfplumber (pure Python) — guaranteed to import; used when PyMuPDF is
     missing OR fails to load (its native ``_extra`` DLL is not present on
     every host — that must never take the endpoint down).

A malformed, encrypted or unreadable PDF returns "" and never raises.
"""
from __future__ import annotations

# Caps mirror the client skill so a hostile/degenerate PDF cannot blow up
# memory or response size.
MAX_PAGES = 12
MAX_CHARS = 60_000
MAX_BYTES = 6_000_000


def _ligatures_and_spaces(raw: str) -> str:
    """Normalize text pulled from a PDF, mirroring normalizePdfText() client-side."""
    if not raw:
        return ""
    for src, dst in (
        ("\ufb00", "ff"), ("\ufb01", "fi"), ("\ufb02", "fl"),
        ("\ufb03", "ffi"), ("\ufb04", "ffl"), ("\ufb05", "st"), ("\ufb06", "st"),
    ):
        raw = raw.replace(src, dst)
    # PDF text runs frequently split an address around the @ — join it.
    import re
    raw = re.sub(r"\s*@\s*", "@", raw)
    raw = re.sub(r"[ \t\u00a0\u2007\u202f]+", " ", raw)
    raw = raw.replace("\r", "\n")
    raw = re.sub(r"\n{2,}", "\n", raw)
    return raw.strip()


def _extract_pymupdf(data: bytes, max_pages: int, max_chars: int) -> str:
    import pymupdf  # noqa: F401  (module-level import so DLL failure is caught here)

    out: list[str] = []
    total = 0
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        for i in range(min(doc.page_count, max_pages)):
            try:
                text = doc.load_page(i).get_text("text") or ""
            except Exception:  # noqa: BLE001 — one bad page must not kill the doc
                continue
            out.append(text)
            total += len(text)
            if total >= max_chars:
                break
    return "\n".join(out)


def _extract_pdfplumber(data: bytes, max_pages: int, max_chars: int) -> str:
    import io

    import pdfplumber

    out: list[str] = []
    total = 0
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for page in pdf.pages[:max_pages]:
            try:
                text = page.extract_text() or ""
            except Exception:  # noqa: BLE001
                continue
            out.append(text)
            total += len(text)
            if total >= max_chars:
                break
    return "\n".join(out)


def extract_pdf_text(data: bytes, max_pages: int = MAX_PAGES, max_chars: int = MAX_CHARS) -> str:
    """Extract plain text from PDF bytes. Returns '' when nothing is readable."""
    if not data or len(data) < 5:
        return ""
    raw = ""
    for backend in (_extract_pymupdf, _extract_pdfplumber):
        try:
            raw = backend(data, max_pages, max_chars)
        except Exception:  # noqa: BLE001 — missing DLL / bad PDF → try the next backend
            raw = ""
            continue
        if raw.strip():
            break
    return _ligatures_and_spaces(raw)[:max_chars]
