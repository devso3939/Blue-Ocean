/**
 * PDF contact-extraction skill — v6.9.155
 *
 * Menus, brochures, price lists and company profiles are PDFs, and until now
 * the crawler dropped every `.pdf` link on the floor (`.pdf` sat in every
 * skip list). This skill turns PDF bytes into plain text so that text can be
 * handed to the SAME validators the HTML path already uses — nothing new has
 * to trust raw prose.
 *
 * Wraps Mozilla's pdf.js (github.com/mozilla/pdf.js) through its `legacy`
 * build, which runs identically in the browser (bundled by Vite) and in the
 * Node test runner. The import is lazy: the pdf.js bundle is large and most
 * scans never touch a PDF, so it must not be in the initial payload.
 *
 * Everything here is pure and defensive — a malformed, encrypted or
 * unreadable PDF returns '' and never throws into the scan.
 */

export interface PdfTextOptions {
  /** Pages to read (default 8 — contact info is on the first pages). */
  maxPages?: number;
  /** Hard cap on returned characters (default 40000). */
  maxChars?: number;
}

let _pdfjs: unknown | null = null;

/** Lazily load the legacy pdf.js build (browser + Node compatible). */
async function loadPdfjs(): Promise<any> {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return _pdfjs;
}

/**
 * True for URLs whose PATH ends in `.pdf` (query string / hash ignored, so
 * `/menu.pdf?v=2` and `/file.pdf#page=3` both count). Never throws.
 */
export function looksLikePdfUrl(url: string): boolean {
  if (!url) return false;
  try {
    return /\.pdf$/i.test(new URL(url).pathname);
  } catch {
    return /\.pdf([?#].*)?$/i.test(url);
  }
}

/** True when an HTTP Content-Type header advertises a PDF. */
export function isPdfContentType(ct: string | null | undefined): boolean {
  return !!ct && /application\/(x-)?pdf/i.test(ct);
}

/**
 * Normalize text pulled from a PDF. pdf.js emits text in layout order but
 * split into items, so we:
 *   - expand the common ligatures (ﬁ ﬂ ﬀ ﬃ ﬄ ﬅ ﬆ) some fonts ship as glyphs,
 *   - collapse the spaces PDF text runs put around `@` (`info @ acme . ge`),
 *   - squash runs of whitespace / NBSP and blank lines.
 * Every downstream gate still re-validates whatever comes out, so this can
 * be liberal without inventing contacts.
 */
export function normalizePdfText(raw: string): string {
  if (!raw) return '';
  let t = raw
    .replace(/\uFB00/g, 'ff')
    .replace(/\uFB01/g, 'fi')
    .replace(/\uFB02/g, 'fl')
    .replace(/\uFB03/g, 'ffi')
    .replace(/\uFB04/g, 'ffl')
    .replace(/[\uFB05\uFB06]/g, 'st');
  t = t.replace(/\s*@\s*/g, '@'); // pdf.js often splits an address around the @
  t = t.replace(/[ \t\u00A0\u2007\u202F]+/g, ' ')
       .replace(/\r/g, '\n')
       .replace(/\n{2,}/g, '\n')
       .trim();
  return t;
}

/**
 * Server fallback: ask the Blue Ocean backend to fetch + extract a PDF when
 * the browser cannot retrieve the bytes (cross-origin CORS). The backend
 * endpoint is POST /api/pdf/text (backend/app/main.py). Enabled only when
 * VITE_BACKEND_URL is configured — returns '' (and the caller moves on) when
 * it is not, so this is a pure, safe no-op without the backend.
 */
export async function fetchPdfTextViaBackend(url: string): Promise<string> {
  let base = '';
  try { base = String((import.meta as any).env?.VITE_BACKEND_URL || '').replace(/\/+$/, ''); } catch { /* non-Vite host */ }
  if (!base) return '';
  try {
    const r = await fetch(base + '/api/pdf/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return '';
    const j = await r.json();
    return typeof j?.text === 'string' ? j.text : '';
  } catch {
    return '';
  }
}

/**
 * Extract the text of a PDF from its bytes. Returns '' on any failure
 * (not a PDF, encrypted, corrupt, unsupported) — callers treat '' as "no
 * contacts here" and move on.
 */
export async function extractPdfText(
  data: ArrayBuffer | Uint8Array,
  opts: PdfTextOptions = {},
): Promise<string> {
  const maxPages = Math.max(1, Math.floor(opts.maxPages ?? 8));
  const maxChars = Math.max(1000, Math.floor(opts.maxChars ?? 40000));
  let bytes: Uint8Array;
  if (data instanceof Uint8Array) bytes = data;
  else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else return '';
  if (bytes.byteLength < 5) return '';
  try {
    const pdfjs = await loadPdfjs();
    const doc = await pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: false,
    }).promise;
    const pages = Math.min(doc.numPages || 0, maxPages);
    let out = '';
    for (let i = 1; i <= pages; i++) {
      if (out.length >= maxChars) break;
      try {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        const items = (content?.items || []) as Array<{ str?: string }>;
        out += items.map(it => (it && typeof it.str === 'string' ? it.str : '')).join(' ') + '\n';
      } catch { /* one unreadable page must not kill the document */ }
    }
    return normalizePdfText(out).slice(0, maxChars);
  } catch {
    return '';
  }
}
