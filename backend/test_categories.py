import sys

sys.path.insert(0, ".")
from app.services import analysis as analysis_service

categories = ["restaurant", "cafe", "gym", "movie_theater", "beauty_salon",
              "pet_groomer", "general_dentistry", "grocery_store", "laundry_service",
              "coworking_space", "bar", "bakery", "hair_salon", "hotel"]
for cat in categories:
    try:
        a = analysis_service.analyze_category("tbilisi-ge", cat)
        s = a.stats
        print(f"{s.label:28s} | existing {s.count:5d} | per10k {str(s.per_10k):>7s} | "
              f"bench {str(s.expected_per_10k):>7s} | expected {str(s.expected_count):>8s} | "
              f"gap {str(s.gap):>7s} | score {s.opportunity_score} | conf {s.data_confidence}")
    except Exception as e:
        print(f"{cat:28s} | ERROR {type(e).__name__}: {e}")
