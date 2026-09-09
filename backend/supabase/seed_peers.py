#!/usr/bin/env python3
"""One-time seed of the Blue Ocean peer-city pool (100 major world cities).

Idempotent: upserts into bo.cities with on-conflict do nothing, so real
resolve_city rows always win. Also fixes country_code when it's null.
"""
import os, sys, json
import psycopg
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env"))
KW = dict(host="aws-1-eu-west-1.pooler.supabase.com", port=6543,
          user="postgres.bfoagnqjkoqhogxvkvkw", password=os.environ["SUPABASE_DB_PASSWORD"],
          dbname="postgres", connect_timeout=15, prepare_threshold=None)

# name, country_code, population, lat, lon  (curated major cities)
CITIES = [
    ("London", "GB", 8908081, 51.5074, -0.1278), ("Paris", "FR", 2161000, 48.8566, 2.3522),
    ("Berlin", "DE", 3664088, 52.5200, 13.4050), ("Madrid", "ES", 3223334, 40.4168, -3.7038),
    ("Rome", "IT", 2873000, 41.9028, 12.4964), ("Amsterdam", "NL", 872680, 52.3676, 4.9041),
    ("Vienna", "AT", 1897491, 48.2082, 16.3738), ("Warsaw", "PL", 1790658, 52.2297, 21.0122),
    ("Prague", "CZ", 1309000, 50.0755, 14.4378), ("Budapest", "HU", 1752286, 47.4979, 19.0402),
    ("Bucharest", "RO", 1836889, 44.4268, 26.1025), ("Sofia", "BG", 1286383, 42.6977, 23.3219),
    ("Belgrade", "RS", 1378682, 44.7866, 20.4489), ("Zagreb", "HR", 806342, 45.8150, 15.9819),
    ("Athens", "GR", 664046, 37.9838, 23.7275), ("Lisbon", "PT", 545796, 38.7223, -9.1393),
    ("Dublin", "IE", 1173179, 53.3498, -6.2603), ("Copenhagen", "DK", 616278, 55.6761, 12.5683),
    ("Stockholm", "SE", 975904, 59.3293, 18.0686), ("Oslo", "NO", 709037, 59.9139, 10.7522),
    ("Helsinki", "FI", 656920, 60.1699, 24.9384), ("Tallinn", "EE", 437619, 59.4370, 24.7536),
    ("Riga", "LV", 605802, 56.9496, 24.1052), ("Vilnius", "LT", 588412, 54.6872, 25.2797),
    ("Kyiv", "UA", 2962181, 50.4501, 30.5234), ("Istanbul", "TR", 15519267, 41.0082, 28.9784),
    ("Moscow", "RU", 12615279, 55.7558, 37.6173), ("Minsk", "BY", 1996553, 53.9006, 27.5590),
    ("Tbilisi", "GE", 1118035, 41.7151, 44.8271), ("Yerevan", "AM", 1075225, 40.1792, 44.4991),
    ("Baku", "AZ", 2293040, 40.4093, 49.8671), ("Almaty", "KZ", 2000000, 43.2220, 76.8512),
    ("Tel Aviv", "IL", 460613, 32.0853, 34.7818), ("Dubai", "AE", 3478300, 25.2048, 55.2708),
    ("Riyadh", "SA", 7676654, 24.7136, 46.6753), ("Cairo", "EG", 9500400, 30.0444, 31.2357),
    ("Casablanca", "MA", 3359818, 33.5731, -7.5898), ("Lagos", "NG", 14886000, 6.5244, 3.3792),
    ("Nairobi", "KE", 4397073, -1.2921, 36.8219), ("Johannesburg", "ZA", 5635131, -26.2041, 28.0473),
    ("Cape Town", "ZA", 4618003, -33.9249, 18.4241), ("New York", "US", 8335897, 40.7128, -74.0060),
    ("Los Angeles", "US", 3979576, 34.0522, -118.2437), ("Chicago", "US", 2693976, 41.8781, -87.6298),
    ("Toronto", "CA", 2731571, 43.6532, -79.3832), ("Vancouver", "CA", 631486, 49.2827, -123.1207),
    ("Mexico City", "MX", 9209944, 19.4326, -99.1332), ("Sao Paulo", "BR", 12330000, -23.5505, -46.6333),
    ("Rio de Janeiro", "BR", 6748000, -22.9068, -43.1729), ("Buenos Aires", "AR", 15150000, -34.6037, -58.3816),
    ("Santiago", "CL", 6811700, -33.4489, -70.6693), ("Bogota", "CO", 7412803, 4.7110, -74.0721),
    ("Lima", "PE", 9752000, -12.0464, -77.0428), ("Tokyo", "JP", 13960000, 35.6762, 139.6503),
    ("Seoul", "KR", 9729000, 37.5665, 126.9780), ("Beijing", "CN", 21540000, 39.9042, 116.4074),
    ("Shanghai", "CN", 26320000, 31.2304, 121.4737), ("Singapore", "SG", 5685807, 1.3521, 103.8198),
    ("Bangkok", "TH", 10539000, 13.7563, 100.5018), ("Jakarta", "ID", 10560000, -6.2088, 106.8456),
    ("Kuala Lumpur", "MY", 1808000, 3.1390, 101.6869), ("Manila", "PH", 1348447, 14.5995, 120.9842),
    ("Mumbai", "IN", 12442373, 19.0760, 72.8777), ("Delhi", "IN", 16787941, 28.6139, 77.2090),
    ("Bengaluru", "IN", 8443675, 12.9716, 77.5946), ("Sydney", "AU", 5312163, -33.8688, 151.2093),
    ("Melbourne", "AU", 5078193, -37.8136, 144.9631), ("Auckland", "NZ", 1657000, -36.8485, 174.7633),
    ("Batumi", "GE", 169100, 41.6168, 41.6367), ("Kutaisi", "GE", 135201, 42.2679, 42.7180),
    ("Rustavi", "GE", 125103, 41.5495, 44.9930), ("Gyumri", "AM", 121976, 40.7894, 43.8428),
    ("Tashkent", "UZ", 2603500, 41.2995, 69.2401), ("Bishkek", "KG", 1074075, 42.8746, 74.5698),
    ("Dushanbe", "TJ", 863500, 38.5598, 68.7870), ("Tirana", "AL", 418495, 41.3275, 19.8187),
    ("Skopje", "MK", 544586, 41.9981, 21.4254), ("Sarajevo", "BA", 275524, 43.8563, 18.4131),
    ("Chisinau", "MD", 695400, 47.0105, 28.8638), ("Bratislava", "SK", 437725, 48.1486, 17.1077),
    ("Ljubljana", "SI", 295888, 46.0569, 14.5058), ("Porto", "PT", 231800, 41.1579, -8.6291),
    ("Barcelona", "ES", 1620343, 41.3874, 2.1686), ("Munich", "DE", 1471508, 48.1351, 11.5820),
    ("Hamburg", "DE", 1845229, 53.5511, 9.9937), ("Milan", "IT", 1371498, 45.4642, 9.1900),
    ("Lyon", "FR", 518635, 45.7640, 4.8357), ("Manchester", "GB", 552858, 53.4808, -2.2426),
    ("Antwerp", "BE", 529247, 51.2194, 4.4025), ("Rotterdam", "NL", 651155, 51.9244, 4.4777),
    ("Bristol", "GB", 463400, 51.4545, -2.5879), ("Edinburgh", "GB", 524600, 55.9533, -3.1883),
    ("Valencia", "ES", 791413, 39.4699, -0.3763), ("Krakow", "PL", 779966, 50.0647, 19.9450),
    ("Gdansk", "PL", 470907, 54.3520, 18.6466), ("Thessaloniki", "GR", 325182, 40.6401, 22.9444),
    ("Antalya", "TR", 1319040, 36.8969, 30.7133), ("Izmir", "TR", 2936700, 38.4237, 27.1428),
    ("Basel", "CH", 177595, 47.5596, 7.5886), ("Zurich", "CH", 434008, 47.3769, 8.5417),
]

SLUG = {"GE": "ge", "AM": "am", "AZ": "az", "TR": "tr", "RU": "ru", "US": "us",
        "GB": "gb", "FR": "fr", "DE": "de", "ES": "es", "IT": "it", "NL": "nl",
        "AT": "at", "PL": "pl", "CZ": "cz", "HU": "hu", "RO": "ro", "BG": "bg",
        "RS": "rs", "HR": "hr", "GR": "gr", "PT": "pt", "IE": "ie", "DK": "dk",
        "SE": "se", "NO": "no", "FI": "fi", "EE": "ee", "LV": "lv", "LT": "lt",
        "UA": "ua", "BY": "by", "KZ": "kz", "IL": "il", "AE": "ae", "SA": "sa",
        "EG": "eg", "MA": "ma", "NG": "ng", "KE": "ke", "ZA": "za", "CA": "ca",
        "MX": "mx", "BR": "br", "AR": "ar", "CL": "cl", "CO": "co", "PE": "pe",
        "JP": "jp", "KR": "kr", "CN": "cn", "SG": "sg", "TH": "th", "ID": "id",
        "MY": "my", "PH": "ph", "IN": "in", "AU": "au", "NZ": "nz", "UZ": "uz",
        "KG": "kg", "TJ": "tj", "AL": "al", "MK": "mk", "BA": "ba", "MD": "md",
        "SK": "sk", "SI": "si", "BE": "be", "CH": "ch"}

def main():
    rows = []
    COUNTRY_NAME = {}
    with psycopg.connect(**KW) as conn, conn.cursor() as cur:
        cur.execute("select cca2, name from bo.countries")
        for cca2, cname in cur.fetchall():
            COUNTRY_NAME[cca2] = cname
    for name, cc, pop, lat, lon in CITIES:
        cid = name.lower().replace(" ", "-").replace("ã", "o").replace("é", "e") + "-" + SLUG[cc]
        rows.append((cid, name, f"{name}, {cc}", COUNTRY_NAME.get(cc) or cc, cc, lat, lon, pop))
    with psycopg.connect(**KW) as conn, conn.cursor() as cur:
        # remove any previously mis-seeded rows (bad tuple order cast lon into population)
        cur.execute("delete from bo.cities where population_source = 'seed-peer-pool'")
        # INSERT columns: city_id, name, display_name, country, country_code, center_lat, center_lon, population
        cur.executemany("""
            insert into bo.cities (city_id, name, display_name, country, country_code,
                                   center_lat, center_lon, population, population_source)
            values (%s, %s, %s, %s, %s, %s, %s, %s, 'seed-peer-pool')
            on conflict (city_id) do nothing
        """, rows)
        # fill missing country codes on pre-existing rows (e.g. tbilisi-ge)
        cur.execute("update bo.cities set country_code = split_part(city_id, '-', -1) where country_code is null")
        conn.commit()
        cur.execute("select count(*), count(*) filter (where population_source = 'seed-peer-pool') from bo.cities")
        total, seeded = cur.fetchone()
        print(f"cities: {total} total, {seeded} seeded peers")
        cur.execute("select city_id, country_code from bo.cities where city_id like 'tbilisi%'")
        print("tbilisi rows:", cur.fetchall())

if __name__ == "__main__":
    main()
