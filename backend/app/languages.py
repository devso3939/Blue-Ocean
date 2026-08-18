"""ISO 3166-1 alpha-2 -> primary spoken language (ISO 639-1).

Used to share learned name-signals across cities of the same language, so a
signal learned in one city (e.g. Georgian "გრუმინგი" for grooming, learned in
Tbilisi) immediately benefits every other city in that language — live, per
analysis — instead of waiting for each city to re-learn it from scratch.
"""
from __future__ import annotations

# Compact map for the countries most likely to be analysed. Unknown codes
# simply fall back to country-only signal sharing (no language bucket).
COUNTRY_LANGUAGE: dict[str, str] = {
    # Europe
    "AD": "ca", "AL": "sq", "AT": "de", "AX": "sv", "BA": "bs", "BE": "nl",
    "BG": "bg", "BY": "be", "CH": "de", "CY": "el", "CZ": "cs", "DE": "de",
    "DK": "da", "EE": "et", "ES": "es", "FI": "fi", "FO": "fo", "FR": "fr",
    "GB": "en", "GE": "ka", "GR": "el", "HR": "hr", "HU": "hu", "IE": "en",
    "IS": "is", "IT": "it", "LI": "de", "LT": "lt", "LU": "lb", "LV": "lv",
    "MC": "fr", "MD": "ro", "ME": "sr", "MK": "mk", "MT": "mt", "NL": "nl",
    "NO": "no", "PL": "pl", "PT": "pt", "RO": "ro", "RS": "sr", "RU": "ru",
    "SE": "sv", "SI": "sl", "SK": "sk", "SM": "it", "TR": "tr", "UA": "uk",
    "XK": "sq", "JE": "en", "GG": "en", "IM": "en",
    # Asia & Pacific
    "AE": "ar", "AF": "ps", "AM": "hy", "AZ": "az", "BD": "bn", "BH": "ar",
    "BN": "ms", "CN": "zh", "HK": "zh", "ID": "id", "IL": "he", "IN": "hi",
    "IQ": "ar", "IR": "fa", "JO": "ar", "JP": "ja", "KG": "ky", "KH": "km",
    "KP": "ko", "KR": "ko", "KW": "ar", "KZ": "kk", "LA": "lo", "LB": "ar",
    "LK": "si", "MM": "my", "MN": "mn", "MO": "zh", "MV": "dv", "MY": "ms",
    "NP": "ne", "OM": "ar", "PH": "tl", "PK": "ur", "PS": "ar", "QA": "ar",
    "SA": "ar", "SG": "en", "SY": "ar", "TH": "th", "TJ": "tg", "TL": "pt",
    "TM": "tk", "TW": "zh", "UZ": "uz", "VN": "vi", "YE": "ar",
    # Africa & Middle East
    "AO": "pt", "BF": "fr", "BI": "fr", "BJ": "fr", "BW": "en", "CD": "fr",
    "CF": "fr", "CG": "fr", "CI": "fr", "CM": "fr", "DJ": "fr", "DZ": "ar",
    "EG": "ar", "ER": "ti", "ET": "am", "GA": "fr", "GH": "en", "GM": "en",
    "GN": "fr", "GQ": "es", "GW": "pt", "KE": "sw", "KM": "ar", "LR": "en",
    "LS": "en", "LY": "ar", "MA": "ar", "MG": "mg", "ML": "fr", "MR": "ar",
    "MU": "en", "MW": "en", "MZ": "pt", "NA": "en", "NE": "fr", "NG": "en",
    "RW": "rw", "SC": "en", "SD": "ar", "SL": "en", "SN": "fr", "SO": "so",
    "SS": "en", "ST": "pt", "SZ": "en", "TD": "fr", "TG": "fr", "TN": "ar",
    "TZ": "sw", "UG": "en", "ZA": "en", "ZM": "en", "ZW": "en",
    # Americas
    "AG": "en", "AR": "es", "BB": "en", "BO": "es", "BR": "pt", "BS": "en",
    "BZ": "en", "CA": "en", "CL": "es", "CO": "es", "CR": "es", "CU": "es",
    "DM": "en", "DO": "es", "EC": "es", "GD": "en", "GT": "es", "GY": "en",
    "HN": "es", "HT": "fr", "JM": "en", "KN": "en", "LC": "en", "MX": "es",
    "NI": "es", "PA": "es", "PE": "es", "PY": "es", "SR": "nl", "SV": "es",
    "TT": "en", "UY": "es", "VC": "en", "VE": "es",
    # Oceania
    "AU": "en", "FJ": "en", "FM": "en", "MH": "en", "NZ": "en", "PG": "en",
    "SB": "en", "TO": "to", "VU": "en", "WS": "sm",
    # Others
    "GL": "kl", "PR": "es", "VI": "en", "KY": "en", "BM": "en", "AW": "nl",
    "CW": "nl", "HK": "zh",
}


def language_for_country(cca2: str) -> str | None:
    return COUNTRY_LANGUAGE.get((cca2 or "").upper())
