"""Learn category name-signals from a city's own data.

The static ``NAME_SIGNALS`` in taxonomy.py cover well-known patterns
("coworking", "laundromat", ...). This module goes further: for every city it
*learns* new signals from the places already matched to a category by the
taxonomy, so names that are distinctive locally — including local-language
equivalents like ზოოსალონი (Georgian "pet salon") or груминг (Russian
"grooming") — catch businesses that a coarse taxonomy would miss.

Precision guards (learned signals are deliberately more conservative than the
static ones):

- a signal must appear in >= 2 taxonomy-matched places and be strongly
  over-represented in that category vs the whole city (lift >= 3);
- a signal that also shows up meaningfully in places of *other* business
  types is dropped (not distinctive);
- weak words (pet, dog, salon, studio, ...) are never learned standalone —
  only as part of a biggerram ("dog groom");
- a learned signal is applied to a place only when the place's own taxonomy
  is generic (no leaf, or a broad catch-all like ``animal_or_pet_service``)
  or is an equivalent of the target category — never overriding a specific
  different business type (e.g. a place tagged ``beauty_salon`` or
  ``pet_store`` is left alone).
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from typing import Any, Optional

from ..taxonomy import CATEGORY_EQUIVALENTS, all_categories, family_for

# Words too generic to ever be a standalone learned signal (they appear across
# many business types). They are still allowed inside biggerrams
# ("dog groom", "grooming studio", "pet spa").
WEAK_WORDS = {
    "pet", "dog", "cat", "animal", "zoo", "salon", "studio", "shop", "store",
    "service", "services", "care", "house", "club", "center", "centre",
    "school", "academy", "boutique", "spa", "park", "garden", "beach", "lake",
    "river", "street", "road", "city", "town", "home", "group", "world", "best",
    "barber", "hair", "nail", "beauty", "style", "stylist", "makeup", "brow",
    "lash", "tan", "tanning", "sport", "fitness", "food", "coffee", "bar",
}

# Stop words (EN/RU/KA) never learned at all, even inside biggerrams.
STOP_WORDS = {
    "the", "and", "for", "with", "from", "ltd", "llc", "inc", "gmbh", "srl",
    "co", "corp", "ооо", "ип", "оо", "с", "и", "в", "на", "по", "от", "для",
    "со", "оао", "зао", "შპს", "ს", "და", "სთვის", "ქ", "ამ", "არ",
}

# Overture categories that are broad catch-alls: the taxonomy does not tell
# you what the business actually does, so a distinctive name signal is allowed
# to refine them (family-compatible only).
BROAD_LEAVES = {
    "animal_or_pet_service", "holistic_animal_care", "pet_training",
    "professional_service", "home_service", "corporate_or_business_office",
    "b2b_service", "business_service", "general_business",
    "personal_or_beauty_service", "wellness_service",
    "service", "services", "shopping", "retail", "store", "shop",
    "lifestyle_service", "food_service",
}

# Minimum occurrences of a token in taxonomy-matched places to be learnable.
MIN_OCCURRENCES = 2
# Minimum lift vs the whole city (distinctiveness).
MIN_LIFT = 3.0
# A token appearing in this many places of other business types is not
# distinctive enough (relative to its occurrences in the matched category).
CONTAMINATION_RATIO = 0.3

# Letter ranges: Latin (+diacritics), Cyrillic, Georgian.
_LETTER_RE = re.compile(
    r"[a-z\u00c0-\u024f\u0400-\u04ff\u10a0-\u10ff]{3,}", re.IGNORECASE
)


def _strip_diacritics(s: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFD", s)
        if unicodedata.category(c) != "Mn"
    )


def extract_tokens(name: Optional[str]) -> set[str]:
    """Lowercased strong unigrams + biggerrams from a business name."""
    if not name:
        return set()
    words = [_strip_diacritics(w) for w in _LETTER_RE.findall(name.lower())]
    unigrams = {w for w in words if w not in STOP_WORDS and w not in WEAK_WORDS}
    bigrams: set[str] = set()
    for a, b in zip(words, words[1:]):
        if a in STOP_WORDS or b in STOP_WORDS:
            continue
        if a in WEAK_WORDS and b in WEAK_WORDS:
            continue  # "pet shop" is not a signal
        bigrams.add(f"{a} {b}")
    return unigrams | bigrams


def learn_signals(places: list[dict[str, Any]]) -> dict[str, list[str]]:
    """Learn distinctive name signals per category from taxonomy-matched places.

    ``places``: dicts with keys ``name``, ``matched`` (set of category ids),
    ``matched_signal`` (set — excludes places already matched purely by a
    previous learning pass, so re-runs are stable) and ``leaf`` (str|None).

    Returns ``{category_id: [tokens...]}`` ordered by strength.
    """
    known = frozenset(c["id"] for c in all_categories())
    city = [p for p in places if p.get("name")]
    if len(city) < 4:
        return {}
    city_n = len(city)

    # token -> indexes of places containing it
    token_docs: dict[str, list[int]] = {}
    place_tokens: list[set[str]] = []
    for i, p in enumerate(city):
        ts = extract_tokens(p["name"])
        place_tokens.append(ts)
        for t in ts:
            token_docs.setdefault(t, []).append(i)

    # Seed groups: places matched by taxonomy (never purely by a previous
    # learning pass), for categories the app actually tracks.
    seeds: dict[str, list[int]] = {}
    for i, p in enumerate(city):
        matched = p.get("matched") or set()
        signal_matched = p.get("matched_signal") or set()
        for c in matched:
            if c in signal_matched or c not in known:
                continue
            seeds.setdefault(c, []).append(i)

    signals: dict[str, list[tuple[str, int]]] = {}
    for cat, idxs in seeds.items():
        if len(idxs) < MIN_OCCURRENCES:
            continue
        seed_n = len(idxs)
        seed_set = set(idxs)
        # baseline: places of a *different specific* business type. Generic
        # catch-alls (animal_or_pet_service, untagged, ...) are excluded — they
        # are exactly the places a learned signal should rescue, so they must
        # not count as contamination.
        specific_idx: list[int] = []
        for j in range(city_n):
            if j in seed_set:
                continue
            leaf_j = city[j].get("leaf")
            if leaf_j is None or leaf_j in BROAD_LEAVES:
                continue
            if leaf_j == cat or leaf_j in CATEGORY_EQUIVALENTS.get(cat, set()):
                continue
            specific_idx.append(j)
        spec_set = set(specific_idx)
        spec_n = len(specific_idx)

        mf: Counter[str] = Counter()
        for i in idxs:
            mf.update(place_tokens[i])
        for t, n in mf.items():
            if n < MIN_OCCURRENCES:
                continue
            docs = token_docs.get(t, ())
            # how often the token appears in places of other specific business types
            other = sum(1 for j in docs if j in spec_set)
            if other and spec_n:
                # distinctiveness = frequency in category / frequency in other
                # specific business types
                if (n / seed_n) / (other / spec_n) < MIN_LIFT:
                    continue
            # Contamination: token is also common in other specific business types
            if other >= max(3, int(CONTAMINATION_RATIO * n)):
                continue
            signals.setdefault(cat, []).append((t, n))

    out: dict[str, list[str]] = {}
    for cat, items in signals.items():
        items.sort(key=lambda x: (-x[1], x[0]))
        out[cat] = [t for t, _ in items]
    return out


def _leaf_allows(leaf: Optional[str], cat: str) -> bool:
    """Can a learned signal refine a place whose taxonomy leaf is ``leaf``?"""
    if leaf is None:
        return True  # no specific taxonomy — name is the best signal
    fam = family_for(cat)
    leaf_fam = family_for(leaf)
    if leaf in BROAD_LEAVES or leaf_fam == "other":
        # generic catch-all: allowed when families are compatible (or unknown)
        return leaf_fam in ("other", fam)
    if leaf == cat or leaf in CATEGORY_EQUIVALENTS.get(cat, set()):
        return True  # already matched anyway
    return False


def merge_signals(*sets: dict[str, list[str]]) -> dict[str, list[str]]:
    """Union of several signal maps (city + country + language buckets)."""
    merged: dict[str, dict[str, None]] = {}
    for s in sets:
        for cat, toks in (s or {}).items():
            bucket = merged.setdefault(cat, {})
            for t in toks:
                bucket[t] = None
    return {cat: sorted(bucket) for cat, bucket in merged.items()}


def apply_signals(places: list[dict[str, Any]], signals: dict[str, list[str]]) -> list[dict[str, Any]]:
    """Apply learned signals to places with the precision guards.

    Mutates each place dict in place (adds to ``matched`` / ``matched_signal``)
    and returns the list of places that gained at least one category.
    """
    token_to_cats: dict[str, set[str]] = {}
    for cat, toks in signals.items():
        for t in toks:
            token_to_cats.setdefault(t, set()).add(cat)

    changed: list[dict[str, Any]] = []
    for p in places:
        if not p.get("name"):
            continue
        ts = extract_tokens(p["name"])
        if not ts:
            continue
        matched = p.setdefault("matched", set())
        signal_matched = p.setdefault("matched_signal", set())
        leaf = p.get("leaf")
        added = False
        for t in ts:
            for cat in token_to_cats.get(t, set()):
                if cat in matched or not _leaf_allows(leaf, cat):
                    continue
                matched.add(cat)
                signal_matched.add(cat)
                added = True
        if added:
            changed.append(p)
    return changed
