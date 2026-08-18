"""Deduplication helpers for city names from different administrative divisions."""
from __future__ import annotations

import re
import unicodedata


def _strip_script(name: str) -> str:
    """Remove characters from non-Latin scripts, keeping Latin/digits/spaces."""
    return re.sub(r"[^\x00-\x7F]+", "", name).strip()


def _strip_non_latin(name: str) -> str:
    """Keep only non-Latin characters (for Khmer, Arabic, etc.)."""
    return re.sub(r"[\x00-\x7F]+", "", name).strip()


def _normalize(name: str) -> str:
    """Lowercase, strip diacritics, collapse whitespace."""
    n = name.lower().strip()
    n = unicodedata.normalize("NFD", n)
    n = "".join(c for c in n if unicodedata.category(c) != "Mn")
    n = re.sub(r"\s+", " ", n)
    return n


def _is_pure_non_latin(name: str) -> bool:
    """Check if a name is entirely non-Latin script."""
    latin_chars = sum(1 for c in name if '\x00' <= c <= '\x7f')
    total = len(name.strip())
    return total > 0 and latin_chars == 0


# Known city prefix patterns by script (for stripping administrative prefixes)
_PREFIXES_BY_SCRIPT = [
    # Khmer
    ("ក្រុង", "ក្រុង"),   # "city"
    ("សង្កាត់", "សង្កាត់"),  # "commune"
    # Georgian
    ("ქალაქი", ""),
    # Russian
    ("город ", ""),
]

def _strip_known_prefixes(name: str) -> str:
    """Strip common administrative prefixes that obscure the core city name."""
    for prefix, replacement in _PREFIXES_BY_SCRIPT:
        if name.startswith(prefix):
            name = name[len(prefix):]
    return name.strip()


def are_same_city(a: str, b: str) -> bool:
    """Return True if two city names likely refer to the same place.

    Handles:
      • Same Latin names (case-insensitive)
      • Non-Latin names where one is a substring/prefix of the other
        (e.g. Khmer "បាត់ដំបង" vs "ក្រុងបាត់ដំបង")
      • Cross-script: when one name is pure non-Latin and other is Latin,
        we can only match if stripped non-Latin of one == stripped Latin of the
        other after stripping known prefixes, OR via population proximity
        (handled upstream).
    """
    na, nb = _normalize(a), _normalize(b)
    if na == nb:
        return True

    # Substring containment (common when one adds "city" / "province" prefix)
    if na in nb or nb in na:
        return True

    # Strip known administrative prefixes and re-check
    sa = _normalize(_strip_known_prefixes(a))
    sb = _normalize(_strip_known_prefixes(b))
    if sa == sb or sa in sb or sb in sa:
        return True

    # Cross-script comparison: strip both to Latin-only
    la = _strip_script(a)
    lb = _strip_script(b)
    if la and lb:
        nla, nlb = _normalize(la), _normalize(lb)
        if nla == nlb:
            return True
        if nla in nlb or nlb in nla:
            return True
        # Token overlap: if ≥ 80% of shorter name's tokens are in longer name
        ta, tb = set(nla.split()), set(nlb.split())
        if ta and tb:
            shorter, longer = (ta, tb) if len(ta) <= len(tb) else (tb, ta)
            if shorter and len(shorter & longer) / len(shorter) >= 0.8:
                return True
    elif (la and not lb) or (lb and not la):
        # One is pure Latin, the other pure non-Latin.
        # Check stripped non-Latin substrings: if the shorter non-Latin name
        # is contained in the longer, they're the same (handles prefix variants).
        na_stripped = _normalize(_strip_known_prefixes(a))
        nb_stripped = _normalize(_strip_known_prefixes(b))
        if na_stripped != na or nb_stripped != nb:
            # Prefix was stripped — re-check containment
            if na_stripped == nb_stripped or na_stripped in nb_stripped or nb_stripped in na_stripped:
                return True

    return False
