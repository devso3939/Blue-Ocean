"""Unit tests for per-city name-signal learning.

Run:  cd backend && .venv/Scripts/python.exe test_learning.py
"""
import sys

sys.path.insert(0, ".")
from app.services.learning import apply_signals, extract_tokens, learn_signals


def p(name, leaf, matched=None, signal=None):
    return {
        "name": name,
        "leaf": leaf,
        "matched": set(matched or []),
        "matched_signal": set(signal or []),
    }


def test_extract_tokens():
    ts = extract_tokens("Dog Grooming Studio")
    assert "grooming" in ts
    assert "dog" not in ts        # weak word, never standalone
    assert "studio" not in ts     # weak word, never standalone
    assert "dog grooming" in ts   # bigram with a strong word is a signal
    assert "grooming studio" in ts


def test_extract_tokens_local_language():
    ts = extract_tokens("ზოოსალონი ბასტიკუნები")
    assert "ზოოსალონი" in ts
    ts2 = extract_tokens("Салон груминга")
    assert "груминга" in ts2


def test_learning_rescues_generic_groomers():
    places = []
    # taxonomy-matched pet groomers — the seed set
    for i in range(15):
        places.append(p(f"Happy Grooming Studio {i}", "pet_groomer", {"pet_groomer"}))
    for i in range(5):
        places.append(p(f"Master Groom {i}", "pet_groomer", {"pet_groomer"}))
    for i in range(2):
        places.append(p(f"Max Groom {i}", "pet_groomer", {"pet_groomer"}))
    for i in range(3):
        places.append(p(f"ზოოსალონი ბასტიკუნები {i}", "pet_groomer", {"pet_groomer"}))
    # noise: dog parks, human salons, pet-supply stores
    for i in range(12):
        places.append(p(f"Dog Park {i}", "dog_park", {"dog_park"}))
    for i in range(15):
        places.append(p(f"Beauty Salon {i}", "beauty_salon", {"beauty_salon"}))
    for i in range(3):
        places.append(p(f"Pet Grooming Supplies {i}", "pet_store", {"pet_store"}))
    # targets: real groomers that a coarse taxonomy classifies generically
    places += [
        p("Grooming Studio A", "animal_or_pet_service", {"animal_or_pet_service"}),
        p("Grooming Studio B", "animal_or_pet_service", {"animal_or_pet_service"}),
        p("ზოოსალონი ნაპირი", "animal_or_pet_service", {"animal_or_pet_service"}),
        p("Untagged Grooming House", None),
        p("Dog Grooming Garage", None),
    ]

    signals = learn_signals(places)
    assert "pet_groomer" in signals, signals.keys()
    toks = signals["pet_groomer"]
    assert "grooming" in toks, toks
    assert "groom" in toks, toks
    assert "ზოოსალონი" in toks, toks
    # weak / contaminated tokens never learned
    assert "dog" not in toks
    assert "park" not in toks
    assert "salon" not in toks
    assert "pet" not in toks

    changed = apply_signals(places, signals)
    assert len(changed) == 5, [pl["name"] for pl in changed]
    by_name = {pl["name"]: pl for pl in places}

    # generic pet-service places and untagged groomers are now counted
    assert "pet_groomer" in by_name["Grooming Studio A"]["matched"]
    assert "pet_groomer" in by_name["ზოოსალონი ნაპირი"]["matched"]
    assert "pet_groomer" in by_name["Untagged Grooming House"]["matched"]
    assert "pet_groomer" in by_name["Dog Grooming Garage"]["matched"]
    assert "pet_groomer" in by_name["Grooming Studio A"]["matched_signal"]

    # specific different business types are NOT overridden
    assert "pet_groomer" not in by_name["Dog Park 0"]["matched"]
    assert "pet_groomer" not in by_name["Beauty Salon 0"]["matched"]
    assert "pet_groomer" not in by_name["Pet Grooming Supplies 0"]["matched"]


def test_coworking_learned_from_office_names():
    places = []
    for i in range(8):
        places.append(p(f"Coworking Hub {i}", "coworking_space", {"coworking_space"}))
    for i in range(4):
        places.append(p(f"Коворкинг {i}", "coworking_space", {"coworking_space"}))
    for i in range(10):
        places.append(p(f"Business Center {i}", "corporate_or_business_office", {"corporate_or_business_office"}))
    # the target: a coworking space Overture tagged as a generic office
    places.append(p("Коворкинг Империя", "corporate_or_business_office", {"corporate_or_business_office"}))
    places.append(p("Coworking Zone", None))

    signals = learn_signals(places)
    assert "coworking_space" in signals
    toks = signals["coworking_space"]
    assert "coworking" in toks
    assert "коворкинг" in toks
    assert "business" not in toks  # too shared with office centres

    apply_signals(places, signals)
    by_name = {pl["name"]: pl for pl in places}
    assert "coworking_space" in by_name["Коворкинг Империя"]["matched"]
    assert "coworking_space" in by_name["Coworking Zone"]["matched"]
    assert "coworking_space" not in by_name["Business Center 0"]["matched"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {fn.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"ERROR {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    sys.exit(1 if failed else 0)
