"""Optional AI insight layer.

The Opportunity Score itself is always deterministic. This module adds an
optional human-language overview written by an LLM *from the real numbers* —
only when the operator configures an API key. Without a key the app simply
uses the deterministic explanation (the default), so AI is a bonus, never a
requirement and never a source of invented facts.
"""
from __future__ import annotations

import json
import os
from typing import Any, Optional

import httpx

_API_KEY = os.environ.get("BLUEOCEAN_LLM_API_KEY", "")
_API_URL = os.environ.get(
    "BLUEOCEAN_LLM_API_URL", "https://api.openai.com/v1/chat/completions"
)
_MODEL = os.environ.get("BLUEOCEAN_LLM_MODEL", "gpt-4o-mini")


def analyst_brief(stats: dict[str, Any], market: Optional[dict[str, Any]] = None, places: Optional[list[Any]] = None) -> str:
    """Deterministic AI-analyst brief written from the real numbers only.

    Runs with or without an LLM key: it composes the same facts the page shows
    into a short plain-language market brief. Never invents figures.
    """
    label = (stats.get("label") or "this category").lower()
    count = stats.get("count") or 0
    per_10k = stats.get("per_10k")
    bench = stats.get("expected_per_10k")
    expected = stats.get("expected_count")
    gap = stats.get("gap")
    score = stats.get("opportunity_score")
    conf = stats.get("data_confidence")
    warnings = stats.get("warnings") or []

    parts: list[str] = []

    # Supply vs benchmark
    if per_10k is None or bench is None:
        parts.append(f"There are {count:,} detected {label} businesses in this city.")
        ratio = per_10k / bench if bench > 0 else None
        if ratio is None:
            verdict = "no peer benchmark is available"
        elif ratio < 0.3:
            verdict = "well below the peer benchmark"
        elif ratio < 0.8:
            verdict = "below the peer benchmark"
        elif ratio <= 1.2:
            verdict = "roughly in line with the peer benchmark"
        else:
            verdict = "above the peer benchmark (relatively saturated)"
        parts.append(
            f"Supply sits at {per_10k:.2f} per 10,000 residents ({count:,} detected {label} businesses), "
            f"{verdict} ({bench:.2f} per 10,000 in comparable cities)."
        )

    # Where the count came from
    sig = stats.get("name_signal_matches")
    if sig:
        parts.append(
            f"Of the {count:,} detected, {sig:,} were identified by learned local name patterns "
            f"(the open-data taxonomy classifies them generically), so they might be missed by "
            "a name-blind count."
        )

    # Gap
    if expected is not None and gap is not None:
        if gap > 0:
            parts.append(
                f"The estimated gap is about {gap:,.0f} businesses — comparable cities average "
                f"{bench:.2f} per 10,000 (≈{expected:,.0f} expected here) versus the {count:,} found."
            )
        else:
            parts.append(
                f"Detected supply ({count:,}) is at or above the peer estimate (~{expected:,.0f}), "
                "so this is not an underserved category here."
            )
    if score is not None:
        parts.append(f"Overall opportunity score: {score}/100 ({stats.get('score_label') or ''}).")

    # Competition structure from the real point data
    if places:
        named = [p for p in places if getattr(p, "name", None)]
        brands: dict[str, int] = {}
        for p in places:
            b = (getattr(p, "brand", None) or "").strip()
            if b:
                brands[b] = brands.get(b, 0) + 1
        if named:
            top_brand, top_n = (max(brands.items(), key=lambda kv: kv[1]) if brands else (None, 0))
            if top_brand and top_n / len(named) >= 0.3:
                parts.append(
                    f"Competition structure: supply is concentrated — the largest chain/operator "
                    f"({top_brand}) accounts for {top_n / len(named):.0%} of the {len(named):,} named businesses."
                )
            elif top_brand and top_n / len(named) >= 0.15:
                parts.append(
                    f"Competition structure: moderately concentrated — the largest operator ({top_brand}) "
                    f"holds {top_n / len(named):.0%} of the {len(named):,} named businesses."
                )
            else:
                parts.append(
                    f"Competition structure: fragmented across many independent operators "
                    f"({len(named):,} named businesses, no dominant chain)."
                )

    # Market context (World Bank)
    if market:
        bp = (market.get("buyer_potential") or {})
        ind = market.get("indicators") or {}
        internet = (ind.get("internet_users") or {}).get("value")
        urban = (ind.get("urban_share") or {}).get("value")
        digital: list[str] = []
        if internet is not None:
            digital.append(f"{internet:.0f}% internet penetration")
        if urban is not None:
            digital.append(f"{urban:.0f}% urban population")
        if bp.get("score") is not None:
            note = f"Potential-buyer score: {bp['score']}/100"
            if digital:
                note += f" (backed by {', '.join(digital)})"
            parts.append(note + ".")
        se = market.get("startup_estimate") or {}
        total = se.get("total_investment_est")
        wage = se.get("avg_monthly_wage_est")
        rent = se.get("monthly_rent_est")
        if total:
            bits = []
            if wage:
                bits.append(f"avg. wage ~${wage:,.0f}/month")
            if rent:
                bits.append(f"rent ~${rent:,.0f}/month")
            cost = f"A typical opening is estimated at ~${total:,.0f} total"
            if bits:
                cost += " (" + ", ".join(bits) + ")"
            parts.append(cost + " — estimates, not quotes.")

    # Honesty guard
    if stats.get("sparse"):
        parts.append(
            "Caveat: open-map coverage for this city is sparse, so the real count is likely higher — "
            "treat the gap as a lower bound and cross-check on Google Maps."
        )
    elif warnings:
        parts.append("Caveat: " + warnings[0].rstrip(".") + ".")
    if conf is not None and conf < 70:
        parts.append(f"Data confidence is {conf}/100 — verify locally before committing capital.")

    return "\n".join(parts)


def llm_insight(stats: dict[str, Any], city_name: str) -> Optional[str]:
    """Return an LLM-written 3-bullet insight, or None (unconfigured/error).

    The prompt passes only the actual computed statistics and instructs the
    model to never invent figures. Any failure degrades to the deterministic
    explanation already shown on the page.
    """
    if not _API_KEY:
        return None
    s = stats
    payload = {
        "city": city_name,
        "label": s.get("label"),
        "count": s.get("count"),
        "per_10k": s.get("per_10k"),
        "expected_per_10k": s.get("expected_per_10k"),
        "expected_count": s.get("expected_count"),
        "gap": s.get("gap"),
        "gap_pct": s.get("gap_pct"),
        "opportunity_score": s.get("opportunity_score"),
        "score_label": s.get("score_label"),
        "data_confidence": s.get("data_confidence"),
        "warnings": s.get("warnings", []),
    }
    system = (
        "You are a market-intelligence analyst. Write a concise 3-bullet summary "
        "of a supply-gap analysis. Use ONLY the numbers provided. Never invent or "
        "round away figures; never add claims about demand, purchasing power or "
        "specific openings. Frame the estimated gap as statistical market "
        "intelligence, not guaranteed demand. 90 words max."
    )
    try:
        r = httpx.post(
            _API_URL,
            headers={
                "Authorization": f"Bearer {_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": _MODEL,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
                ],
                "max_tokens": 300,
                "temperature": 0.4,
            },
            timeout=25.0,
        )
        r.raise_for_status()
        text = r.json()["choices"][0]["message"]["content"].strip()
        return text or None
    except Exception:
        return None
