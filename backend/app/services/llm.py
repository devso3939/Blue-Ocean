"""Free LLM integration for analysis insights.

Uses Groq free tier (llama-3.3-70b-versatile) for generating
business analysis insights. Falls back to deterministic analysis
when LLM is unavailable.
"""
from __future__ import annotations

import json
import os
import urllib.request
from typing import Any, Optional

from ..cache import cache

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_BASE = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "llama-3.3-70b-versatile"


def _call_groq(prompt: str, max_tokens: int = 1024) -> Optional[str]:
    """Call Groq API for free LLM inference."""
    if not GROQ_API_KEY:
        return None
    try:
        body = json.dumps({
            "model": GROQ_MODEL,
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": max_tokens,
            "temperature": 0.3,
        }).encode("utf-8")
        req = urllib.request.Request(GROQ_BASE, data=body, headers={
            "Authorization": f"Bearer {GROQ_API_KEY}",
            "Content-Type": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
            return data["choices"][0]["message"]["content"]
    except Exception:
        return None


def generate_analysis_insight(
    city_name: str,
    country: str,
    category_label: str,
    existing_count: int,
    population: int,
    gap: Optional[float],
    score: Optional[int],
    peer_count: int,
    demand_score: Optional[float] = None,
    market_context: dict[str, Any] | None = None,
) -> str:
    """Generate an AI-powered analysis insight for a business opportunity.
    
    Tries LLM first, falls back to deterministic insight.
    """
    cache_key = f"llm:insight:{city_name}:{category_label}:{existing_count}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    # Build context for the LLM
    per_10k = round(existing_count / max(population, 1) * 10000, 2) if population else 0
    gap_str = f"~{abs(int(gap))} businesses" if gap and gap > 0 else "none identified" if gap == 0 else f"~{abs(int(gap))} oversupply" if gap and gap < 0 else "unknown"
    demand_str = f"{demand_score}/100" if demand_score else "not measured"
    
    market_info = ""
    if market_context:
        indicators = market_context.get("indicators", {})
        gdp = indicators.get("gdp_per_capita_ppp")
        growth = indicators.get("gdp_growth")
        if gdp:
            market_info += f"\n- GDP per capita (PPP): ${gdp:,.0f}" if isinstance(gdp, (int, float)) else ""
        if growth:
            market_info += f"\n- GDP growth: {growth}%" if isinstance(growth, (int, float)) else ""
    
    prompt = f"""You are a business intelligence analyst. Provide a concise, actionable analysis of this business opportunity. Be specific with numbers.

City: {city_name}, {country}
Business type: {category_label}
Existing businesses: {existing_count} ({per_10k} per 10,000 residents)
Population: {population:,}
Identified gap: {gap_str}
Opportunity Score: {score}/100
Comparable cities analyzed: {peer_count}
Demand signal: {demand_str}{market_info}

Provide:
1. A 2-3 sentence executive summary of the opportunity
2. Key risk factors (1-2 sentences)
3. One specific recommendation

Be data-driven and honest about limitations. Do not fabricate statistics."""

    # Try LLM first
    llm_result = _call_groq(prompt)
    if llm_result:
        cache.set(cache_key, llm_result, 30 * 86400)
        return llm_result

    # Deterministic fallback
    if score and score >= 80:
        verdict = f"Exceptional opportunity: {category_label} in {city_name} shows a strong supply gap of {gap_str} compared to {peer_count} peer cities."
    elif score and score >= 65:
        verdict = f"Promising opportunity: {category_label} in {city_name} has moderate undersupply ({gap_str}) with {per_10k} businesses per 10k residents."
    elif score and score >= 50:
        verdict = f"Moderate potential: {category_label} in {city_name} has near-benchmark supply levels. Differentiation or niche focus would be key."
    else:
        verdict = f"Competitive/saturated: {category_label} in {city_name} shows {'oversupply' if gap and gap < 0 else 'limited gap'} relative to peer cities."
    
    if demand_score and demand_score > 60:
        verdict += f" Demand signals are strong ({demand_score}/100)."
    elif demand_score and demand_score < 30:
        verdict += f" Demand signals are weak ({demand_score}/100) — validate locally."
    
    cache.set(cache_key, verdict, 30 * 86400)
    return verdict


def generate_country_summary(
    country_name: str,
    cities_data: list[dict[str, Any]],
    top_opportunities: list[dict[str, Any]],
) -> str:
    """Generate an AI summary for a country comparison page."""
    cache_key = f"llm:country:{country_name}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    cities_summary = "\n".join(
        f"- {c['name']}: pop {c.get('population', 'N/A'):,}, "
        f"{c.get('snapshot', {}).get('total_places', 'N/A')} businesses" if c.get('snapshot') else
        f"- {c['name']}: pop {c.get('population', 'N/A'):,}, not scanned"
        for c in cities_data[:10]
    )
    opps_summary = "\n".join(
        f"- {o.get('label', 'N/A')}: score {o.get('score', 'N/A')}, gap {o.get('gap', 'N/A')}"
        for o in top_opportunities[:5]
    )

    prompt = f"""Summarize the business landscape of {country_name} based on this data:

Cities analyzed:
{cities_summary}

Top opportunities:
{opps_summary if opps_summary else 'No scans completed yet'}

Provide a 3-4 sentence executive summary of the best business opportunities in this country, focusing on which cities and industries have the highest potential."""

    llm_result = _call_groq(prompt, max_tokens=512)
    if llm_result:
        cache.set(cache_key, llm_result, 30 * 86400)
        return llm_result

    # Deterministic fallback
    scanned = [c for c in cities_data if c.get("snapshot")]
    if scanned:
        biggest = max(scanned, key=lambda c: c.get("population") or 0)
        result = f"{country_name} has {len(scanned)} cities with business data. "
        result += f"{biggest['name']} (pop. {biggest.get('population', 0):,}) is the largest market. "
        if top_opportunities:
            best = top_opportunities[0]
            result += f"Top opportunity: {best.get('label', 'N/A')} (score {best.get('score', 'N/A')})."
        else:
            result += "Run city scans to identify specific opportunities."
    else:
        result = f"{country_name} has {len(cities_data)} cities available. Scan the largest cities to discover business opportunities."
    
    cache.set(cache_key, result, 30 * 86400)
    return result
