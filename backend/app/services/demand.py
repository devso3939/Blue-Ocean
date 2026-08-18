"""Demand detection service.

Aggregates real demand signals from multiple free sources:
- Google Trends (via pytrends or web scraping)
- Reddit mentions (public API)
- Wikipedia page views (public REST API)
- Web search result density (DuckDuckGo)
- Social mention estimation

All data is cached for 7 days. No paid APIs required.
"""
from __future__ import annotations

import json
import math
import re
import time
import urllib.request
import urllib.parse
from typing import Any, Optional

from ..cache import cache


# ---------------------------------------------------------------------------
# Google Trends (via web scraping — no API key needed)
# ---------------------------------------------------------------------------

def _google_trends_score(keyword: str, location: str = "") -> dict[str, Any]:
    """Get Google Trends interest score for a keyword.
    
    Uses the Google Trends explore page to extract interest data.
    Falls back to search result count estimation.
    """
    cache_key = f"demand:trends:{keyword.lower()}:{location.lower()}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    
    query = f"{keyword} {location}".strip()
    result = {"source": "google_trends", "score": 0, "raw": None}
    
    try:
        # Use Google Trends RSS-like endpoint for interest over time
        encoded = urllib.parse.quote(query)
        url = f"https://trends.google.com/trends/explore?q={encoded}&date=today+12-m"
        req = urllib.request.Request(url, headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode("utf-8", errors="ignore")
            # Extract interest value from the page
            # Google embeds data as JSON in the page
            match = re.search(r'"timelineData":\s*(\[.*?\])\s*[,}]', html)
            if match:
                timeline = json.loads(match.group(1))
                values = [int(point.get("value", [0])[0]) for point in timeline]
                avg_interest = sum(values) / max(len(values), 1)
                result["score"] = min(100, round(avg_interest))
                result["raw"] = {"avg_interest": avg_interest, "data_points": len(values)}
    except Exception:
        pass
    
    # Fallback: estimate from web search results
    if result["score"] == 0:
        try:
            encoded = urllib.parse.quote(f'"{query}"')
            url = f"https://html.duckduckgo.com/html/?q={encoded}"
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
                # Count result snippets as a proxy for interest
                results = re.findall(r'class="result__snippet"', html)
                count = len(results)
                result["score"] = min(100, count * 10)
                result["raw"] = {"search_results": count}
        except Exception:
            pass
    
    cache.set(cache_key, result, 7 * 86400)
    return result


# ---------------------------------------------------------------------------
# Reddit mentions (free, no auth needed for public search)
# ---------------------------------------------------------------------------

def _reddit_mentions(keyword: str, location: str = "") -> dict[str, Any]:
    """Count recent Reddit mentions for a keyword."""
    cache_key = f"demand:reddit:{keyword.lower()}:{location.lower()}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    
    query = f"{keyword} {location}".strip()
    result = {"source": "reddit", "score": 0, "mentions": 0, "subreddits": []}
    
    try:
        encoded = urllib.parse.quote(query)
        url = f"https://www.reddit.com/search.json?q={encoded}&sort=new&t=month&limit=100"
        req = urllib.request.Request(url, headers={
            "User-Agent": "BlueOcean/1.0 (demand research bot)",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            children = data.get("data", {}).get("children", [])
            count = len(children)
            result["mentions"] = count
            result["score"] = min(100, count * 5)
            
            # Extract top subreddits
            subs = {}
            for child in children:
                sub = child.get("data", {}).get("subreddit", "")
                if sub:
                    subs[sub] = subs.get(sub, 0) + 1
            result["subreddits"] = sorted(subs.keys(), key=lambda s: -subs[s])[:5]
    except Exception:
        pass
    
    cache.set(cache_key, result, 3 * 86400)
    return result


# ---------------------------------------------------------------------------
# Wikipedia page views (free REST API)
# ---------------------------------------------------------------------------

def _wikipedia_views(article: str) -> dict[str, Any]:
    """Get Wikipedia page views for an article (last 30 days)."""
    cache_key = f"demand:wiki:{article.lower()}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    
    result = {"source": "wikipedia", "score": 0, "views": 0}
    
    try:
        # Wikimedia REST API — no auth needed
        encoded = urllib.parse.quote(article.replace(" ", "_"))
        url = f"https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/all-agents/{encoded}/monthly/20240101/20260101"
        req = urllib.request.Request(url, headers={
            "User-Agent": "BlueOcean/1.0 (demand research; contact@example.com)",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            items = data.get("items", [])
            total_views = sum(item.get("views", 0) for item in items)
            result["views"] = total_views
            # Normalize to 0-100 (log scale, 100K views = score 100)
            if total_views > 0:
                result["score"] = min(100, round(math.log10(total_views + 1) * 16.7))
    except Exception:
        pass
    
    cache.set(cache_key, result, 7 * 86400)
    return result


# ---------------------------------------------------------------------------
# Aggregate demand score
# ---------------------------------------------------------------------------

def compute_demand_score(
    category_label: str,
    city_name: str = "",
    country_name: str = "",
    category_aliases: list[str] | None = None,
) -> dict[str, Any]:
    """Compute an aggregate demand score from multiple signal sources.
    
    Returns:
        {
            "score": 0-100,           # overall demand score
            "confidence": 0-100,      # how confident we are in the score
            "signals": {              # individual signal breakdown
                "search_interest": {...},
                "social_mentions": {...},
                "knowledge_demand": {...},
            },
            "explanation": "...",     # human-readable explanation
        }
    """
    cache_key = f"demand:agg:{category_label.lower()}:{city_name.lower()}:{country_name.lower()}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached
    
    # Collect signals from all sources
    signals = {}
    weights = {}
    
    # 1. Google search interest (weight: 35%)
    search_q = f"{category_label} {city_name or country_name}".strip()
    trends = _google_trends_score(search_q)
    signals["search_interest"] = trends
    weights["search_interest"] = 0.35
    
    # 2. Reddit social mentions (weight: 25%)
    reddit = _reddit_mentions(category_label, city_name or country_name)
    signals["social_mentions"] = reddit
    weights["social_mentions"] = 0.25
    
    # 3. Wikipedia knowledge demand (weight: 20%)
    wiki = _wikipedia_views(category_label)
    signals["knowledge_demand"] = wiki
    weights["knowledge_demand"] = 0.20
    
    # 4. Category-specific demand (weight: 20%)
    # Use category aliases to get broader signal
    alias_signal = 0
    if category_aliases:
        for alias in category_aliases[:3]:
            q = f"{alias} {city_name or country_name}".strip()
            t = _google_trends_score(q)
            alias_signal = max(alias_signal, t.get("score", 0))
    signals["category_breadth"] = {"source": "category_aliases", "score": alias_signal}
    weights["category_breadth"] = 0.20
    
    # Compute weighted average
    total_weight = sum(weights.values())
    score = 0
    for key, weight in weights.items():
        signal_score = signals.get(key, {}).get("score", 0)
        score += signal_score * (weight / total_weight)
    score = round(min(100, max(0, score)), 1)
    
    # Compute confidence (how many sources returned data)
    active_sources = sum(1 for s in signals.values() if s.get("score", 0) > 0)
    confidence = min(100, round(active_sources / len(signals) * 100))
    
    # Build explanation
    explanations = []
    if signals.get("search_interest", {}).get("score", 0) > 50:
        explanations.append("strong search interest")
    elif signals.get("search_interest", {}).get("score", 0) > 20:
        explanations.append("moderate search interest")
    
    if signals.get("social_mentions", {}).get("mentions", 0) > 10:
        explanations.append(f"{signals['social_mentions']['mentions']} recent social mentions")
    
    if signals.get("knowledge_demand", {}).get("views", 0) > 1000:
        explanations.append("active knowledge-seeking")
    
    explanation = "Demand signals: " + (", ".join(explanations) if explanations else "limited data available")
    
    result = {
        "score": score,
        "confidence": confidence,
        "signals": signals,
        "explanation": explanation,
    }
    
    cache.set(cache_key, result, 7 * 86400)
    return result
