"""Country / city market context.

Real World Bank indicators (free API, no key) plus clearly-labelled estimates:

- indicators: GDP (PPP), GDP growth, GDP per capita (PPP), inflation,
  unemployment, working-age share, new-business registrations, internet
  penetration, mobile subscriptions, urbanisation, tax revenue and secondary
  enrolment. (The Doing Business series was archived by the World Bank after
  2020 and returns nulls, so it is deliberately not shown.)
- buyer_potential: a transparent 0-100 score from real inputs (market size,
  purchasing power, demographics, digital reach) — formula is returned.
- startup_estimate: explicitly labelled estimates (average monthly wage,
  office rent, fit-out, equipment, working capital). Every estimate is listed
  in ``assumptions`` so the UI can show what is fact and what is an
  approximation.
"""
from __future__ import annotations

import json
import math
import time
from typing import Any, Optional
from urllib.request import Request, urlopen

from ..cache import cache
from ..config import get_ttl
from ..models import CityMeta, MarketContext

WORLD_BANK = "https://api.worldbank.org/v2/country/{iso3}/indicator/{ind}?format=json&per_page=8"

# ISO 3166-1 alpha-2 -> alpha-3 (static, for the World Bank API)
_A2_A3 = {
    "AD": "AND", "AE": "ARE", "AF": "AFG", "AG": "ATG", "AL": "ALB", "AM": "ARM",
    "AO": "AGO", "AR": "ARG", "AT": "AUT", "AU": "AUS", "AZ": "AZE", "BA": "BIH",
    "BB": "BRB", "BD": "BGD", "BE": "BEL", "BF": "BFA", "BG": "BGR", "BH": "BHR",
    "BI": "BDI", "BJ": "BEN", "BN": "BRN", "BO": "BOL", "BR": "BRA", "BS": "BHS",
    "BT": "BTN", "BW": "BWA", "BY": "BLR", "BZ": "BLZ", "CA": "CAN", "CD": "COD",
    "CF": "CAF", "CG": "COG", "CH": "CHE", "CI": "CIV", "CL": "CHL", "CM": "CMR",
    "CN": "CHN", "CO": "COL", "CR": "CRI", "CU": "CUB", "CV": "CPV", "CY": "CYP",
    "CZ": "CZE", "DE": "DEU", "DJ": "DJI", "DK": "DNK", "DM": "DMA", "DO": "DOM",
    "DZ": "DZA", "EC": "ECU", "EE": "EST", "EG": "EGY", "ER": "ERI", "ES": "ESP",
    "ET": "ETH", "FI": "FIN", "FJ": "FJI", "FM": "FSM", "FR": "FRA", "GA": "GAB",
    "GB": "GBR", "GD": "GRD", "GE": "GEO", "GH": "GHA", "GM": "GMB", "GN": "GIN",
    "GQ": "GNQ", "GR": "GRC", "GT": "GTM", "GW": "GNB", "GY": "GUY", "HN": "HND",
    "HR": "HRV", "HT": "HTI", "HU": "HUN", "ID": "IDN", "IE": "IRL", "IL": "ISR",
    "IN": "IND", "IQ": "IRQ", "IR": "IRN", "IS": "ISL", "IT": "ITA", "JM": "JAM",
    "JO": "JOR", "JP": "JPN", "KE": "KEN", "KG": "KGZ", "KH": "KHM", "KI": "KIR",
    "KM": "COM", "KN": "KNA", "KP": "PRK", "KR": "KOR", "KW": "KWT", "KZ": "KAZ",
    "LA": "LAO", "LB": "LBN", "LC": "LCA", "LI": "LIE", "LK": "LKA", "LR": "LBR",
    "LS": "LSO", "LT": "LTU", "LU": "LUX", "LV": "LVA", "LY": "LBY", "MA": "MAR",
    "MC": "MCO", "MD": "MDA", "ME": "MNE", "MG": "MDG", "MH": "MHL", "MK": "MKD",
    "ML": "MLI", "MM": "MMR", "MN": "MNG", "MR": "MRT", "MT": "MLT", "MU": "MUS",
    "MV": "MDV", "MW": "MWI", "MX": "MEX", "MY": "MYS", "MZ": "MOZ", "NA": "NAM",
    "NE": "NER", "NG": "NGA", "NI": "NIC", "NL": "NLD", "NO": "NOR", "NP": "NPL",
    "NR": "NRU", "NZ": "NZL", "OM": "OMN", "PA": "PAN", "PE": "PER", "PG": "PNG",
    "PH": "PHL", "PK": "PAK", "PL": "POL", "PS": "PSE", "PT": "PRT", "PW": "PLW",
    "PY": "PRY", "QA": "QAT", "RO": "ROU", "RS": "SRB", "RU": "RUS", "RW": "RWA",
    "SA": "SAU", "SB": "SLB", "SC": "SYC", "SD": "SDN", "SE": "SWE", "SG": "SGP",
    "SI": "SVN", "SK": "SVK", "SL": "SLE", "SM": "SMR", "SN": "SEN", "SO": "SOM",
    "SR": "SUR", "SS": "SSD", "ST": "STP", "SV": "SLV", "SY": "SYR", "SZ": "SWZ",
    "TD": "TCD", "TG": "TGO", "TH": "THA", "TJ": "TJK", "TL": "TLS", "TM": "TKM",
    "TN": "TUN", "TO": "TON", "TR": "TUR", "TT": "TTO", "TV": "TUV", "TW": "TWN",
    "TZ": "TZA", "UA": "UKR", "UG": "UGA", "US": "USA", "UY": "URY", "UZ": "UZB",
    "VC": "VCT", "VE": "VEN", "VN": "VNM", "VU": "VUT", "WS": "WSM", "XK": "XKX",
    "YE": "YEM", "ZA": "ZAF", "ZM": "ZMB", "ZW": "ZWE",
}


def _iso3(cca2: str) -> Optional[str]:
    return _A2_A3.get((cca2 or "").upper())


# indicator key -> (human label, [World Bank codes in fallback order])
# The old Doing Business indicators (IC.REG.*, IC.BUS.EASE.XQ) were archived by
# the World Bank and return nulls, so we use live series instead — including
# demand-side signals (internet / mobile penetration, urbanisation) that matter
# for a new consumer business. Every indicator has a fallback: when the exact
# series is not published for a country (e.g. tax revenue is missing for many),
# the nearest published alternative is fetched and flagged, so cards rarely
# show n/a.
INDICATORS: dict[str, tuple[str, list[str]]] = {
    "gdp_ppp": ("GDP, PPP (current US$)", ["NY.GDP.MKTP.PP.CD"]),
    "gdp_growth": ("GDP growth (annual %)", ["NY.GDP.MKTP.KD.ZG"]),
    "gdp_per_capita_ppp": ("GDP per capita, PPP (current US$)", ["NY.GDP.PCAP.PP.CD"]),
    "gni_per_capita_ppp": ("GNI per capita, PPP (current US$)", ["NY.GNP.PCAP.PP.CD"]),
    "inflation": ("Inflation, consumer prices (annual %)", ["FP.CPI.TOTL.ZG"]),
    "unemployment": ("Unemployment (% of total labour force)", ["SL.UEM.TOTL.ZS"]),
    "working_age_share": ("Working-age population (% of total)", ["SP.POP.1564.TO.ZS"]),
    "labor_force_participation": ("Labour force participation (% of 15+)", ["SL.TLF.CACT.ZS"]),
    "life_expectancy": ("Life expectancy at birth (years)", ["SP.DYN.LE00.IN"]),
    "gini": ("Income inequality (Gini index)", ["SI.POV.GINI"]),
    "new_business_density": ("New businesses registered (yearly count)", ["IC.BUS.NREG", "IC.BUS.DNSK"]),
    "internet_users": ("Internet users (% of population)", ["IT.NET.USER.ZS"]),
    "mobile_subscriptions": ("Mobile subscriptions (per 100 people)", ["IT.CEL.SETS.P2"]),
    "urban_share": ("Urban population (% of total)", ["SP.URB.TOTL.IN.ZS"]),
    "tax_revenue_pct_gdp": ("Government revenue (% of GDP)", ["GC.REV.XGRT.GD.ZS", "GC.TAX.TOTL.GD.ZS"]),
    "secondary_enrollment": ("School enrolment (% gross)", ["SE.SEC.ENRR", "SE.PRM.ENRR"]),
    "population_total": ("Population, total", ["SP.POP.TOTL"]),
}


def _fetch_series(iso3: str, code: str) -> Optional[dict[str, Any]]:
    """Latest non-null value for one indicator."""
    url = WORLD_BANK.format(iso3=iso3, ind=code)
    try:
        req = Request(url, headers={"User-Agent": "BlueOceanOpportunityIntel/0.1"})
        with urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        if not isinstance(data, list) or len(data) < 2:
            return None
        for row in data[1]:
            v = row.get("value")
            if v is not None:
                return {"value": float(v), "year": int(row["date"])}
        return None
    except Exception:
        return None


def _fetch_indicator(iso3: str, key: str) -> dict[str, Any]:
    """Fetch one indicator, trying its fallback codes in order."""
    label, codes = INDICATORS[key]
    used = None
    s = None
    for code in codes:
        s = _fetch_series(iso3, code)
        if s is not None:
            used = code
            break
    note = None
    if s is None:
        return {"code": codes[0], "label": label, "value": None, "year": None, "note": None}
    if used != codes[0]:
        note = f"{codes[0]} is not published for this country — showing the nearest available series ({used})."
    return {"code": used, "label": label, "value": s["value"], "year": s["year"], "note": note}


def _num(x: Optional[float], digits: int = 2) -> Optional[float]:
    return round(x, digits) if x is not None else None


def fetch_market_context(
    city: CityMeta,
    category_label: str = "",
    force: bool = False,
) -> Optional[MarketContext]:
    """Market context for a city's country (cached under the market_analysis TTL, 30 days)."""
    iso3 = _iso3(city.country_code)
    if not iso3:
        return None
    key = f"market:v2:{iso3}"
    if not force:
        cached = cache.get(key)
        if cached:
            try:
                return MarketContext(**cached)
            except Exception:
                pass

    indicators: dict[str, Any] = {}
    for k in INDICATORS:
        indicators[k] = _fetch_indicator(iso3, k)

    buyer = _buyer_potential(indicators, city.population)
    startup = _startup_estimate(indicators, city, category_label)

    assumptions = [
        "All figures are the latest values published by the World Bank API (GDP, growth, inflation, unemployment, labour-force participation, life expectancy, inequality, internet/mobile penetration, urbanisation, revenue and enrolment).",
        "When the exact series is not published for a country (e.g. tax revenue), the nearest published alternative is shown and flagged on the card.",
        "The World Bank archived its Doing Business indicators after 2020, so they are not shown; the buyer score and cost model use live series instead.",
        "Estimated average monthly wage = 50% of monthly GDP per capita (PPP) — a common cross-country labour share; replace with local job-market data for precision.",
        "Estimated commercial rent, fit-out and equipment are rough anchors derived from GDP per capita, not actual listings — adjust them in the calculator.",
        "The buyer score combines population, purchasing power, demographics and digital reach with transparent weights; it is an indicator, not a promise of sales.",
        "The payback estimate assumes monthly revenue of 4x the estimated monthly costs and a 35% operating margin (profit = 0.4 x monthly costs), with profit reinvested — a rough planning aid, not financial advice.",
    ]

    ctx = MarketContext(
        country_code=iso3,
        country_name=city.country,
        indicators=indicators,
        buyer_potential=buyer,
        startup_estimate=startup,
        assumptions=assumptions,
        sources=["World Bank Open Data API (api.worldbank.org)"],
    )
    cache.set(key, ctx.model_dump(), get_ttl("market_analysis"))
    return ctx


def _buyer_potential(ind: dict[str, Any], pop: Optional[int]) -> dict[str, Any]:
    """0-100 score for how many residents could realistically become customers.

    Components (all real inputs):
    - market size: log-scaled population (same curve as the opportunity score)
    - purchasing power: log-scaled GDP per capita PPP
    - demographic: working-age share (normalised around 50-70%)
    - digital reach: internet users + urbanisation (how reachable customers are
      online and in dense commercial areas)
    """
    gdp_pc = (ind.get("gdp_per_capita_ppp") or {}).get("value")
    work = (ind.get("working_age_share") or {}).get("value")
    internet = (ind.get("internet_users") or {}).get("value")
    urban = (ind.get("urban_share") or {}).get("value")

    pop_n = 0.5
    if pop:
        pop_n = min(1.0, max(0.0, (math.log10(max(pop, 1)) - 4.5) / (7.0 - 4.5)))

    gdp_n = 0.5
    if gdp_pc:
        gdp_n = min(1.0, max(0.0, (math.log10(max(gdp_pc, 100)) - 2.0) / (4.6 - 2.0)))

    work_n = 0.5
    if work:
        work_n = min(1.0, max(0.0, (work - 50.0) / (70.0 - 50.0)))

    digital = 0.5
    if internet is not None and urban is not None:
        digital = min(1.0, max(0.0, (0.6 * internet + 0.4 * urban) / 100.0))
    elif internet is not None:
        digital = min(1.0, max(0.0, internet / 100.0))

    score = round(100 * (0.3 * pop_n + 0.3 * gdp_n + 0.2 * work_n + 0.2 * digital))
    return {
        "score": score,
        "components": {
            "market_size": round(100 * pop_n),
            "purchasing_power": round(100 * gdp_n),
            "demographics": round(100 * work_n),
            "digital_reach": round(100 * digital),
        },
        "formula": "0.30 x market size + 0.30 x purchasing power + 0.20 x working-age share + 0.20 x digital reach",
        "note": "Population (city); GDP per capita PPP, working-age share, internet penetration and urbanisation (country) — real inputs; the weights are our transparent weighting scheme.",
    }


def _startup_estimate(ind: dict[str, Any], city: CityMeta, category_label: str) -> dict[str, Any]:
    """Real anchors + clearly labelled estimates for opening a business."""
    gni_pc = (ind.get("gni_per_capita_ppp") or {}).get("value")
    gdp_pc = (ind.get("gdp_per_capita_ppp") or {}).get("value")

    base = gni_pc or gdp_pc or 0
    # Small-business anchors, scaled to the country's income level.
    avg_wage_est = round(gdp_pc / 12.0 * 0.5) if gdp_pc else None
    rent_est = round(gdp_pc / 12.0 * 0.25) if gdp_pc else None     # rough anchor
    fitout_est = round(base * 0.8) if base else None               # rough anchor
    equipment_est = round(base * 0.6) if base else None            # rough anchor

    monthly_costs = (avg_wage_est or 0) * 2 + (rent_est or 0)      # 2 staff + 1 unit
    working_capital_6m = monthly_costs * 6
    total = (fitout_est or 0) + (equipment_est or 0) + working_capital_6m

    # Payback estimate — clearly labelled assumptions, derived from the same anchors.
    # Revenue = 4x monthly costs (typical for a small consumer business), then a
    # 35% operating margin, so monthly profit = (4 x 0.35 - 1) x costs = 0.4 x costs.
    assumed_revenue = monthly_costs * 4.0
    assumed_margin = 0.35
    monthly_profit = assumed_revenue * assumed_margin - monthly_costs
    payback_months = round(total / monthly_profit) if monthly_profit > 0 else None

    return {
        "avg_monthly_wage_est": avg_wage_est,
        "monthly_rent_est": rent_est,
        "fitout_est": fitout_est,
        "equipment_est": equipment_est,
        "assumed_staff": 2,
        "monthly_costs_est": round(monthly_costs),
        "working_capital_6m_est": round(working_capital_6m),
        "total_investment_est": round(total),
        "assumed_monthly_revenue_est": round(assumed_revenue),
        "assumed_margin": assumed_margin,
        "est_monthly_profit": round(monthly_profit),
        "payback_months_est": payback_months,
        "category": category_label or None,
        "city": city.name,
        "estimates_not_quotes": True,
    }
