"""Business category system built on the Overture Places taxonomy.

Machine category ids (e.g. ``pet_groomer``) come from Overture's taxonomy.
This module adds human labels, family grouping, search aliases and matching
logic (a place matches a category if the category appears in its taxonomy
primary, hierarchy ancestors or alternate categories).
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

FAMILIES: list[dict] = [
    {"id": "food-drink", "label": "Food & Drink", "description": "Restaurants, cafes, bars, bakeries and food service"},
    {"id": "retail", "label": "Retail", "description": "Stores, shops and consumer goods"},
    {"id": "healthcare", "label": "Healthcare", "description": "Clinics, dentists, pharmacies and medical services"},
    {"id": "beauty-wellness", "label": "Beauty & Wellness", "description": "Salons, spas, barbers and wellness"},
    {"id": "fitness", "label": "Fitness & Recreation", "description": "Gyms, studios, pools and sports"},
    {"id": "pets", "label": "Pets", "description": "Pet care, grooming, veterinarians and supplies"},
    {"id": "entertainment", "label": "Entertainment & Culture", "description": "Cinemas, museums, nightlife and leisure"},
    {"id": "automotive", "label": "Automotive", "description": "Car repair, dealers, washes and fuel"},
    {"id": "services", "label": "Business Services", "description": "Professional, financial and household services"},
    {"id": "education", "label": "Education", "description": "Schools, tutoring and training"},
    {"id": "hospitality", "label": "Hospitality & Lodging", "description": "Hotels, hostels and guest houses"},
    {"id": "travel", "label": "Travel & Transport", "description": "Transit, travel services and mobility"},
    {"id": "community", "label": "Community & Government", "description": "Public services and civic facilities"},
    {"id": "nature", "label": "Nature & Geography", "description": "Parks, water features and geographic places"},
    {"id": "other", "label": "Other", "description": "Uncategorized"},
]

FAMILY_LABEL = {f["id"]: f["label"] for f in FAMILIES}

# Overture taxonomy hierarchy roots -> our families
ROOT_FAMILY = {
    "food_and_drink": "food-drink",
    "shopping": "retail",
    "health_care": "healthcare",
    "lifestyle_services": "beauty-wellness",
    "sports_and_recreation": "fitness",
    "arts_and_entertainment": "entertainment",
    "cultural_and_historic": "entertainment",
    "travel_and_transportation": "travel",
    "education": "education",
    "community_and_government": "community",
    "geographic_entities": "nature",
    "lodging": "hospitality",
    "services_and_business": "services",
}

# Categories that belong to a different family than their taxonomy root
CATEGORY_FAMILY_OVERRIDES = {
    "pet_groomer": "pets", "pet_store": "pets", "pet_boarding": "pets",
    "pet_sitting": "pets", "animal_or_pet_service": "pets", "dog_park": "pets",
    "dog_walker": "pets", "dog_trainer": "pets", "aquatic_pet_store": "pets",
    "pharmacy": "healthcare", "eyewear_store": "healthcare",
    "car_wash": "automotive", "automotive_repair": "automotive",
    "automotive_service": "automotive", "tire_shop": "automotive",
    "tire_dealer_and_repair": "automotive", "auto_dealer": "automotive",
    "used_auto_dealer": "automotive", "auto_parts_store": "automotive",
    "parking": "automotive", "car_rental_service": "automotive",
    "gas_station": "automotive", "truck_gas_station": "automotive",
    "auto_detailing": "automotive", "auto_body_shop": "automotive",
    "auto_electrical_repair": "automotive", "car_repair": "automotive",
    "gas_station_charging": "automotive",
    "medical_spa": "beauty-wellness", "health_and_wellness_club": "beauty-wellness",
    "dance_club": "entertainment", "nightclub": "entertainment",
    "comedy_club": "entertainment", "social_club": "entertainment",
    "movie_theater": "entertainment", "drive_in_theater": "entertainment",
    "dinner_theater": "entertainment", "theater": "entertainment",
    "shoe_repair": "services", "shoe_shining_service": "services",
    "day_care_preschool": "education", "preschool": "education",
    "caterer": "food-drink", "catering_service": "food-drink",
    "food_truck": "food-drink", "ice_cream_shop": "food-drink",
    "dessert_shop": "food-drink", "night_market": "food-drink",
    "hotel_bar": "food-drink", "hotel_restaurant": "food-drink",
    "breakfast_spot": "food-drink", "brunch_restaurant": "food-drink",

    # Curated family assignments for well-known Overture ids that are not
    # always observed in the discovery sample (roots unknown -> would fall to
    # "other" otherwise). These keep the taxonomy user-friendly everywhere.
    "restaurant": "food-drink", "cafe": "food-drink", "bar": "food-drink",
    "pub": "food-drink", "bakery": "food-drink", "coffee_shop": "food-drink",
    "coffee_roastery": "food-drink", "fast_food_restaurant": "food-drink",
    "pizza_restaurant": "food-drink", "sushi_restaurant": "food-drink",
    "steakhouse": "food-drink", "burger_restaurant": "food-drink",
    "bar_and_grill_restaurant": "food-drink", "barbecue_restaurant": "food-drink",
    "hot_dog_restaurant": "food-drink", "hong_kong_style_cafe": "food-drink",
    "molecular_gastronomy_restaurant": "food-drink", "spanish_restaurant": "food-drink",
    "italian_restaurant": "food-drink", "indian_restaurant": "food-drink",
    "chinese_restaurant": "food-drink", "japanese_restaurant": "food-drink",
    "cocktail_bar": "food-drink", "wine_bar": "food-drink",
    "smoothie_juice_bar": "food-drink", "tapas_bar": "food-drink",
    "irish_pub": "food-drink", "cafeteria": "food-drink",
    "internet_cafe": "food-drink", "delicatessen": "food-drink",
    "supermarket": "retail", "grocery_store": "retail",
    "korean_grocery_store": "retail", "organic_grocery_store": "retail",
    "international_grocery_store": "retail", "asian_grocery_store": "retail",
    "japanese_grocery_store": "retail", "russian_grocery_store": "retail",
    "ethical_grocery_store": "retail", "convenience_store": "retail",
    "electronics_store": "retail", "electronics_repair_shop": "retail",
    "clothing_store": "retail", "womens_clothing_store": "retail",
    "mens_clothing_store": "retail", "childrens_clothing_store": "retail",
    "second_hand_clothing_store": "retail", "designer_clothing": "retail",
    "traditional_clothing": "retail", "furniture_store": "retail",
    "furniture_accessory_store": "retail", "outdoor_furniture_store": "retail",
    "jewelry_store": "retail", "bookstore": "retail", "used_bookstore": "retail",
    "academic_bookstore": "retail", "comic_books_store": "retail",
    "books_music_and_video_store": "retail", "hardware_store": "retail",
    "hardware_home_and_garden_store": "retail", "flowers_and_gifts_store": "retail",
    "gift_shop": "retail", "toy_store": "retail", "shoe_store": "retail",
    "orthopedic_shoe_store": "retail",
    "general_dentistry": "healthcare", "cosmetic_dentistry": "healthcare",
    "pediatric_dentistry": "healthcare", "dental_clinic": "healthcare",
    "behavioral_or_mental_health_clinic": "healthcare", "vision_or_eye_care_clinic": "healthcare",
    "public_health_clinic": "healthcare", "fertility_clinic": "healthcare",
    "pediatric_clinic": "healthcare", "laboratory_testing": "healthcare",
    "optometrist": "healthcare", "optician": "healthcare", "clinic": "healthcare",
    "physical_therapy": "healthcare", "physiotherapist": "healthcare",
    "massage_therapy": "beauty-wellness", "tanning_salon": "beauty-wellness",
    "spray_tanning": "beauty-wellness", "tanning_bed": "beauty-wellness",
    "health_spa": "beauty-wellness", "day_spa": "beauty-wellness",
    "beauty_salon": "beauty-wellness", "hair_salon": "beauty-wellness",
    "kids_hair_salon": "beauty-wellness", "nail_salon": "beauty-wellness",
    "barber": "beauty-wellness", "spa": "beauty-wellness",
    "martial_arts_club": "fitness", "rock_climbing_gym": "fitness",
    "gymnastics_center": "fitness", "sport_or_fitness_facility": "fitness",
    "sport_or_recreation_club": "fitness", "swimming_pool": "fitness",
    "boxing_gym": "fitness", "gym": "fitness", "crossfit": "fitness",
    "yoga_studio": "fitness", "pilates_studio": "fitness",
    "escape_room": "entertainment", "bowling_alley": "entertainment",
    "museum": "entertainment", "history_museum": "entertainment",
    "art_museum": "entertainment", "science_museum": "entertainment",
    "contemporary_art_museum": "entertainment", "design_museum": "entertainment",
    "community_museum": "entertainment", "childrens_museum": "entertainment",
    "photography_museum": "entertainment", "salsa_club": "entertainment",
    "go_kart_club": "entertainment", "fencing_club": "entertainment",
    "cinema": "entertainment", "arcade": "entertainment",
    "laundry_service": "services", "self_service_laundry": "services",
    "coworking_space": "services", "shared_office_space": "services",
    "bank_or_credit_union": "services", "bank": "services", "atm": "services",
    "legal_service": "services", "printing_service": "services",
    "photography_service": "services", "event_photography_service": "services",
    "session_photography_service": "services", "bookkeeper": "services",
    "accountant": "services", "commercial_printer": "services",
    "t_shirt_printing_service": "services", "3d_printing_service": "services",
    "language_school": "education", "tutoring_service": "education",
    "private_tutor": "education", "driving_school": "education",
    "vocational_and_technical_school": "education", "adult_education_center": "education",
    "educational_service": "education",    "kindergarten": "education",
    "kinder_garden": "education",

    "hotel": "hospitality", "hostel": "hospitality", "guest_house": "hospitality",
    "veterinarian": "pets",
}

# Nicer human labels for categories whose machine names are awkward
LABEL_OVERRIDES = {
    "pet_groomer": "Pet Grooming",
    "movie_theater": "Cinema",
    "drive_in_theater": "Drive-In Cinema",
    "dinner_theater": "Dinner Theater",
    "laundry_service": "Laundry Service",
    "self_service_laundry": "Self-Service Laundry",
    "coworking_space": "Coworking Space",
    "shared_office_space": "Shared Office Space",
    "fast_food_restaurant": "Fast Food Restaurant",
    "coffee_shop": "Coffee Shop",
    "coffee_roastery": "Coffee Roastery",
    "general_dentistry": "Dentist",
    "cosmetic_dentistry": "Cosmetic Dentist",
    "pediatric_dentistry": "Pediatric Dentist",
    "behavioral_or_mental_health_clinic": "Mental Health Clinic",
    "vision_or_eye_care_clinic": "Eye Care Clinic",
    "public_health_clinic": "Public Health Clinic",
    "fertility_clinic": "Fertility Clinic",
    "pediatric_clinic": "Pediatric Clinic",
    "dental_clinic": "Dental Clinic",
    "laboratory_testing": "Medical Laboratory",
    "massage_therapy": "Massage Therapy",
    "tanning_salon": "Tanning Salon",
    "spray_tanning": "Spray Tanning",
    "tanning_bed": "Tanning Bed",
    "health_and_wellness_club": "Health & Wellness Club",
    "health_spa": "Health Spa",
    "day_spa": "Day Spa",
    "martial_arts_club": "Martial Arts",
    "rock_climbing_gym": "Rock Climbing Gym",
    "gymnastics_center": "Gymnastics Center",
    "sport_or_fitness_facility": "Fitness Facility",
    "sport_or_recreation_club": "Sports & Recreation Club",
    "swimming_pool": "Swimming Pool",
    "pet_boarding": "Pet Boarding",
    "pet_sitting": "Pet Sitting",
    "animal_or_pet_service": "Animal / Pet Service",
    "aquatic_pet_store": "Aquatic Pet Store",
    "dog_walker": "Dog Walker",
    "dog_trainer": "Dog Trainer",
    "dog_park": "Dog Park",
    "escape_room": "Escape Room",
    "bowling_alley": "Bowling Alley",
    "automotive_repair": "Car Repair",
    "automotive_service": "Automotive Service",
    "auto_dealer": "Car Dealer",
    "used_auto_dealer": "Used Car Dealer",
    "auto_parts_store": "Auto Parts Store",
    "auto_body_shop": "Auto Body Shop",
    "auto_detailing": "Auto Detailing",
    "auto_electrical_repair": "Auto Electrical Repair",
    "tire_shop": "Tire Shop",
    "tire_dealer_and_repair": "Tire Dealer & Repair",
    "car_wash": "Car Wash",
    "car_rental_service": "Car Rental",
    "gas_station": "Gas Station",
    "truck_gas_station": "Truck Stop",
    "bank_or_credit_union": "Bank / Credit Union",
    "legal_service": "Legal Services",
    "printing_service": "Printing Service",
    "photography_service": "Photography Service",
    "event_photography_service": "Event Photography",
    "session_photography_service": "Photo Studio",
    "bookkeeper": "Bookkeeper",
    "accountant": "Accountant",
    "commercial_printer": "Commercial Printer",
    "t_shirt_printing_service": "T-Shirt Printing",
    "3d_printing_service": "3D Printing Service",
    "grocery_store": "Supermarket & Grocery",
    "korean_grocery_store": "Korean Grocery Store",
    "organic_grocery_store": "Organic Grocery Store",
    "international_grocery_store": "International Grocery Store",
    "asian_grocery_store": "Asian Grocery Store",
    "japanese_grocery_store": "Japanese Grocery Store",
    "russian_grocery_store": "Russian Grocery Store",
    "ethical_grocery_store": "Ethical Grocery Store",
    "convenience_store": "Convenience Store",
    "electronics_store": "Electronics Store",
    "electronics_repair_shop": "Electronics Repair",
    "clothing_store": "Clothing Store",
    "womens_clothing_store": "Women's Clothing Store",
    "mens_clothing_store": "Men's Clothing Store",
    "childrens_clothing_store": "Children's Clothing Store",
    "second_hand_clothing_store": "Second-Hand Clothing Store",
    "designer_clothing": "Designer Clothing",
    "traditional_clothing": "Traditional Clothing",
    "furniture_store": "Furniture Store",
    "furniture_accessory_store": "Furniture Accessories",
    "outdoor_furniture_store": "Outdoor Furniture Store",
    "jewelry_store": "Jewelry Store",
    "bookstore": "Bookstore",
    "used_bookstore": "Used Bookstore",
    "academic_bookstore": "Academic Bookstore",
    "comic_books_store": "Comic Book Store",
    "books_music_and_video_store": "Books, Music & Video Store",
    "hardware_store": "Hardware Store",
    "hardware_home_and_garden_store": "Hardware & Garden Store",
    "flowers_and_gifts_store": "Flowers & Gifts",
    "gift_shop": "Gift Shop",
    "toy_store": "Toy Store",
    "shoe_store": "Shoe Store",
    "orthopedic_shoe_store": "Orthopedic Shoe Store",
    "eyewear_store": "Optician / Eyewear",
    "pharmacy": "Pharmacy",
    "preschool": "Preschool / Kindergarten",
    "language_school": "Language School",
    "tutoring_service": "Tutoring Service",
    "private_tutor": "Private Tutor",
    "driving_school": "Driving School",
    "vocational_and_technical_school": "Vocational School",
    "adult_education_center": "Adult Education Center",
    "educational_service": "Educational Service",
    "day_care_preschool": "Daycare & Preschool",
    "hotel_bar": "Hotel Bar",
    "hotel_restaurant": "Hotel Restaurant",
    "fast_food_restaurant": "Fast Food",
    "pizza_restaurant": "Pizza Restaurant",
    "sushi_restaurant": "Sushi Restaurant",
    "steakhouse": "Steakhouse",
    "burger_restaurant": "Burger Restaurant",
    "bar_and_grill_restaurant": "Bar & Grill",
    "barbecue_restaurant": "Barbecue Restaurant",
    "hot_dog_restaurant": "Hot Dog Stand",
    "hong_kong_style_cafe": "Hong Kong Style Cafe",
    "molecular_gastronomy_restaurant": "Molecular Gastronomy Restaurant",
    "spanish_restaurant": "Spanish Restaurant",
    "italian_restaurant": "Italian Restaurant",
    "indian_restaurant": "Indian Restaurant",
    "chinese_restaurant": "Chinese Restaurant",
    "japanese_restaurant": "Japanese Restaurant",
    "cocktail_bar": "Cocktail Bar",
    "wine_bar": "Wine Bar",
    "smoothie_juice_bar": "Smoothie & Juice Bar",
    "tapas_bar": "Tapas Bar",
    "irish_pub": "Irish Pub",
    "cafeteria": "Cafeteria",
    "internet_cafe": "Internet Cafe",
    "delicatessen": "Delicatessen",
    "caterer": "Caterer",
    "ice_cream_shop": "Ice Cream Shop",
    "dessert_shop": "Dessert Shop",
    "food_truck": "Food Truck",
    "breakfast_spot": "Breakfast Spot",
    "brunch_restaurant": "Brunch Restaurant",
    "museum": "Museum",
    "history_museum": "History Museum",
    "art_museum": "Art Museum",
    "science_museum": "Science Museum",
    "contemporary_art_museum": "Contemporary Art Museum",
    "design_museum": "Design Museum",
    "community_museum": "Community Museum",
    "childrens_museum": "Children's Museum",
    "photography_museum": "Photography Museum",
    "dance_club": "Dance Club / Nightclub",
    "nightclub": "Nightclub",
    "comedy_club": "Comedy Club",
    "social_club": "Social Club",
    "salsa_club": "Salsa Club",
    "go_kart_club": "Go-Kart Track",
    "fencing_club": "Fencing Club",
    "hotel": "Hotel",
    "hostel": "Hostel",
    "guest_house": "Guest House",
    "veterinarian": "Veterinarian",
    "pet_store": "Pet Store",
    "beauty_salon": "Beauty Salon",
    "hair_salon": "Hair Salon",
    "kids_hair_salon": "Kids' Hair Salon",
    "nail_salon": "Nail Salon",
    "barber": "Barber",
    "spa": "Spa",
    "massage_therapy": "Massage",
    "yoga_studio": "Yoga Studio",
    "pilates_studio": "Pilates Studio",
    "boxing_gym": "Boxing Gym",
    "gym": "Gym",
    "crossfit": "CrossFit",
    "kinder_garden": "Kindergarten",
    "physical_therapy": "Physiotherapy",
    "physiotherapist": "Physiotherapy",
    "cinema": "Cinema",
    "supermarket": "Supermarket",
    "car_repair": "Car Repair",
    "kindergarten": "Kindergarten",
    "optometrist": "Optometrist",
    "optician": "Optician",
    "clinic": "Clinic",
    "bar": "Bar",
    "pub": "Pub",
    "bakery": "Bakery",
    "cafe": "Cafe",
    "restaurant": "Restaurant",
    "coffee_shop": "Coffee Shop",
    "parking": "Parking",
    "bank": "Bank",
    "atm": "ATM",
}

# Search aliases so users can find categories under different names
ALIASES = {
    "pet_groomer": ["pet grooming", "grooming", "pet groomer", "dog grooming", "pet salon", "grooming salon"],
    "movie_theater": ["cinema", "movie theater", "movie theatre", "films", "kino"],
    "preschool": ["kindergarten", "nursery", "daycare", "day care", "nursery school"],
    "grocery_store": ["supermarket", "grocery", "grocer", "food store", "mağaza", "magaza"],
    "convenience_store": ["corner shop", "convenience", "bodega", "mini market", "24 hour shop"],
    "laundry_service": ["laundry", "dry cleaning", "laundromat", "wash and fold", "self-service laundry", "prachnaya"],
    "self_service_laundry": ["laundromat", "self-service laundry", "washateria"],
    "eyewear_store": ["optician", "glasses", "eyeglasses", "spectacles"],
    "general_dentistry": ["dentist", "dental", "teeth"],
    "pet_boarding": ["dog daycare", "dog boarding", "kennel", "pet hotel"],
    "barber": ["barbershop", "barber shop", "haircut", "bərbər", "berber"],
    "hair_salon": ["hairdresser", "hair salon", "hair"],
    "nail_salon": ["manicure", "pedicure", "nails"],
    "beauty_salon": ["beauty", "cosmetologist", "esthetics", "gözellik", "gozellik"],
    "gym": ["fitness center", "fitness centre", "health club", "workout", "fitnes"],
    "sport_or_fitness_facility": ["fitness center", "leisure center", "sports centre"],
    "swimming_pool": ["pool", "lido", "natatorium"],
    "martial_arts_club": ["karate", "taekwondo", "judo", "jiu jitsu", "mma"],
    "yoga_studio": ["yoga", "pilates"],
    "pilates_studio": ["pilates"],
    "coworking_space": ["coworking", "co-working", "shared office", "work space", "office space"],
    "shared_office_space": ["shared office", "serviced office", "business center"],
    "accountant": ["accounting", "bookkeeping", "tax advisor", "tax services"],
    "bookkeeper": ["bookkeeping", "accounts"],
    "legal_service": ["lawyer", "attorney", "law firm", "notary", "solicitor"],
    "printing_service": ["print shop", "copy shop", "printing", "photocopy"],
    "photography_service": ["photographer", "photo studio", "photography"],
    "pharmacy": ["drugstore", "chemist", "drug store", "apothecary"],
    "laboratory_testing": ["medical lab", "blood test", "lab", "diagnostics"],
    "physical_therapy": ["physiotherapy", "physio", "physical therapist", "rehab"],
    "physiotherapist": ["physio", "physical therapy"],
    "clinic": ["medical center", "doctor", "polyclinic", "medical clinic"],
    "optometrist": ["optician", "eye doctor", "optometry"],
    "driving_school": ["driving lessons", "driving instructor", "auto school"],
    "language_school": ["english school", "language classes", "esl"],
    "tutoring_service": ["tutor", "private lessons", "homework help"],
    "fast_food_restaurant": ["fast food", "takeaway", "take out", "quick service"],
    "pizza_restaurant": ["pizza", "pizzeria"],
    "sushi_restaurant": ["sushi", "japanese food"],
    "steakhouse": ["steak", "steak house", "grill"],
    "burger_restaurant": ["burger", "hamburger"],
    "coffee_shop": ["coffee", "espresso", "specialty coffee", "cafe"],
    "coffee_roastery": ["coffee roaster", "roastery", "roasting"],
    "cafe": ["coffee", "café", "espresso bar"],
    "bakery": ["baker", "bread", "pastry", "patisserie"],
    "ice_cream_shop": ["ice cream", "gelato", "frozen yogurt"],
    "dessert_shop": ["dessert", "cake shop", "patisserie"],
    "hotel": ["lodging", "inn", "motel", "resort"],
    "hostel": ["backpacker", "youth hostel"],
    "guest_house": ["bed and breakfast", "b&b", "guesthouse"],
    "car_wash": ["car wash", "auto wash", "detailing"],
    "automotive_repair": ["car repair", "auto repair", "garage", "mechanic", "car service"],
    "car_repair": ["mechanic", "garage", "auto repair"],
    "tire_shop": ["tires", "tyres", "tyre shop", "wheel alignment"],
    "auto_dealer": ["car dealer", "car dealership", "car sales"],
    "used_auto_dealer": ["used cars", "second hand cars"],
    "car_rental_service": ["car rental", "rent a car", "hire car"],
    "parking": ["car park", "parking garage", "parking lot"],
    "gas_station": ["petrol station", "fuel", "gasoline", "charging station"],
    "auto_detailing": ["detailing", "car detailing", "valeting"],
    "auto_body_shop": ["body shop", "paint shop", "panel beater"],
    "electronics_store": ["electronics", "appliances", "gadgets", "computer store"],
    "clothing_store": ["clothes", "fashion", "apparel", "boutique"],
    "furniture_store": ["furniture", "home furnishings", "sofa"],
    "jewelry_store": ["jewellery", "jewelry", "watches", "gold"],
    "bookstore": ["books", "book shop", "book seller"],
    "hardware_store": ["hardware", "diy", "tools", "home improvement"],
    "toy_store": ["toys", "games", "kids store"],
    "shoe_store": ["shoes", "footwear"],
    "flowers_and_gifts_store": ["flowers", "florist", "gifts", "bouquet"],
    "gift_shop": ["gifts", "souvenirs", "souvenir shop"],
    "veterinarian": ["vet", "veterinary", "animal hospital"],
    "pet_store": ["pet supplies", "pet food", "pet shop"],
    "animal_or_pet_service": ["pet services", "animal services"],
    "dog_park": ["dog run", "off leash park"],
    "museum": ["art gallery", "exhibition", "gallery"],
    "arcade": ["game arcade", "amusement arcade"],
    "escape_room": ["escape game", "puzzle room", "exit game"],
    "bowling_alley": ["bowling", "ten pin bowling"],
    "dance_club": ["nightclub", "club", "disco", "dancing"],
    "nightclub": ["club", "disco", "dance club", "night life"],
    "massage_therapy": ["massage", "masseur", "spa treatment"],
    "spa": ["wellness", "sauna", "jacuzzi", "therme"],
    "tanning_salon": ["tanning", "sunbed", "spray tan"],
    "bank": ["banking", "credit union", "savings"],
    "atm": ["cash machine", "cashpoint", "money machine"],
    "gas_station": ["petrol", "fuel station", "filling station"],
    "crossfit": ["cross fit", "functional fitness"],
    "swimming_pool": ["pool", "swim", "aquatic center"],
    "photography_service": ["photo", "photographer", "portrait studio"],
    "clinic": ["doctor", "medical", "health center"],
    "hotel_restaurant": ["hotel dining"],
    "night_market": ["night market", "street food market"],
    "gastropub": ["gastro pub", "gastropub"],
    "pub": ["bar", "tavern", "inn"],
    "bar": ["pub", "tavern", "lounge", "bar"],
}

# Popular quick-picks for the homepage
POPULAR_CATEGORIES = [
    "restaurant", "cafe", "coffee_shop", "bakery", "bar", "pub", "fast_food_restaurant",
    "pizza_restaurant", "hotel", "hostel", "gym", "yoga_studio", "swimming_pool",
    "hair_salon", "barber", "nail_salon", "beauty_salon", "spa", "massage_therapy",
    "pet_groomer", "veterinarian", "pet_store", "pet_boarding",
    "movie_theater", "museum", "arcade", "escape_room", "nightclub", "bowling_alley",
    "car_wash", "automotive_repair", "tire_shop", "car_rental_service", "parking",
    "grocery_store", "convenience_store", "electronics_store", "clothing_store",
    "furniture_store", "jewelry_store", "bookstore", "pharmacy",
    "laundry_service", "coworking_space", "accountant", "legal_service",
    "photography_service", "printing_service", "bank",
    "general_dentistry", "clinic", "laboratory_testing", "eyewear_store",
    "preschool", "language_school", "tutoring_service", "driving_school",
    "hotel", "guest_house", "gas_station", "auto_dealer",
]

# Families considered "commercial" for opportunity scanning
COMMERCIAL_FAMILIES = {
    "food-drink", "retail", "healthcare", "beauty-wellness", "fitness",
    "pets", "entertainment", "automotive", "services", "education",
    "hospitality", "travel",
}

_WORD_FIXES = {
    "b2b": "B2B", "3d": "3D", "diy": "DIY", "and": "and", "or": "or", "of": "of",
}


def _title(s: str) -> str:
    parts = re.split(r"_+", s)
    out = []
    for p in parts:
        if not p:
            continue
        if p in _WORD_FIXES:
            out.append(_WORD_FIXES[p])
        else:
            out.append(p[0].upper() + p[1:])
    return " ".join(out)


def label_for(category: str | None) -> str:
    if not category:
        return "Unknown"
    if category in LABEL_OVERRIDES:
        return LABEL_OVERRIDES[category]
    return _title(category)


def family_for(category: str, root: str | None = None) -> str:
    if category in CATEGORY_FAMILY_OVERRIDES:
        return CATEGORY_FAMILY_OVERRIDES[category]
    if root and root in ROOT_FAMILY:
        return ROOT_FAMILY[root]
    return "other"


def aliases_for(category: str) -> list[str]:
    return ALIASES.get(category, [])


# ---------------------------------------------------------------------------
# Full category registry: curated entries + dynamically discovered ones
# ---------------------------------------------------------------------------

_DISCOVERED: dict[str, dict] = {}   # id -> {label, family, root}


def register_discovered(category: str, root: str | None, count: int = 0) -> None:
    """Register a category observed in real data (not in the curated list)."""
    if not category or category in _DISCOVERED:
        return
    _DISCOVERED[category] = {
        "label": label_for(category),
        "family": family_for(category, root),
        "root": root,
        "discovered": True,
        "count": count,
    }


def load_discovered(path: str | None = None) -> None:
    """Load observed (category, root) pairs from a sample JSON, if present."""
    p = Path(path) if path else Path(__file__).resolve().parent.parent / "taxonomy_sample.json"
    if not p.exists():
        return
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        for cat, root, n in data.get("pairs", []):
            register_discovered(cat, root, n)
    except Exception:
        pass


def all_categories() -> list[dict]:
    ids = set()
    for cat in POPULAR_CATEGORIES:
        ids.add(cat)
    for cat in LABEL_OVERRIDES:
        ids.add(cat)
    for cat in _DISCOVERED:
        ids.add(cat)
    ids -= HIDDEN_CATEGORIES
    items = []
    for cat in sorted(ids):
        discovered = _DISCOVERED.get(cat)
        root = discovered["root"] if discovered else None
        items.append({
            "id": cat,
            "label": label_for(cat),
            "family": family_for(cat, root),
            "family_label": FAMILY_LABEL.get(family_for(cat, root), "Other"),
            "aliases": aliases_for(cat),
            "popular": cat in POPULAR_CATEGORIES,
            "discovered": discovered is not None,
        })
    return items


@lru_cache(maxsize=1)
def categories_by_family() -> list[dict]:
    items = all_categories()
    by_family: dict[str, list[dict]] = {}
    for it in items:
        by_family.setdefault(it["family"], []).append(it)
    return [
        {"id": f["id"], "label": f["label"], "description": f["description"],
         "categories": sorted(by_family.get(f["id"], []), key=lambda c: c["label"])}
        for f in FAMILIES
    ]


def search_categories(query: str, limit: int = 25) -> list[dict]:
    q = query.strip().lower()
    if not q:
        return all_categories()[:limit]
    results = []
    for it in all_categories():
        hay = " ".join([
            it["id"], it["label"].lower(),
            it.get("family_label", "").lower(),
            *it.get("aliases", []),
        ])
        if q in hay:
            score = 0
            if q == it["id"] or q == it["label"].lower():
                score = 3
            elif it["label"].lower().startswith(q) or it["id"].startswith(q):
                score = 2
            elif q in it["label"].lower() or q in it["id"]:
                score = 1
            results.append((score, it))
    results.sort(key=lambda x: (-x[0], x[1]["label"]))
    return [it for _, it in results[:limit]]


def get_category(category_id: str) -> dict | None:
    for it in all_categories():
        if it["id"] == category_id:
            return it
    return None


def is_commercial(category: str, root: str | None = None) -> bool:
    return family_for(category, root) in COMMERCIAL_FAMILIES


# Categories a user cannot open as a business (ATM, ...). Hidden from the
# category picker and never ranked as an opportunity.
HIDDEN_CATEGORIES = {"atm"}

# Categories that are conceptually the same business type even though Overture
# models them as separate ids. A place tagged shared_office_space is a coworking
# space for our purposes.
CATEGORY_EQUIVALENTS: dict[str, set[str]] = {
    "coworking_space": {"shared_office_space"},
    "shared_office_space": {"coworking_space"},
    "pet_groomer": {"pet_grooming"},
    "grocery_store": {"supermarket", "convenience_store"},
    "supermarket": {"grocery_store", "hypermarket"},
    "convenience_store": {"grocery_store"},
    "hair_salon": {"beauty_salon", "barber"},
    "beauty_salon": {"hair_salon", "barber"},
    "barber": {"hair_salon", "beauty_salon"},
    "gym": {"fitness_center", "sport_or_fitness_facility", "health_club"},
    "fitness_center": {"gym", "sport_or_fitness_facility"},
    "movie_theater": {"cinema"},
    "cinema": {"movie_theater"},
    "pharmacy": {"drugstore", "chemist"},
    "optometrist": {"optician"},
    "optician": {"optometrist"},
    "general_dentistry": {"dental_clinic", "dentist"},
    "dental_clinic": {"general_dentistry"},
    "laundry_service": {"self_service_laundry", "dry_cleaner"},
    "self_service_laundry": {"laundry_service"},
    "fast_food_restaurant": {"takeaway"},
    "hotel": {"inn", "motel"},
    "preschool": {"kindergarten", "kinder_garden", "nursery_school"},
    "kindergarten": {"preschool", "kinder_garden"},
    "car_repair": {"automotive_repair", "car_repair_shop"},
    "automotive_repair": {"car_repair"},
    "bank_or_credit_union": {"bank"},
    "bank": {"bank_or_credit_union"},
    "bookstore": {"used_bookstore"},
}

# Strong name/OSM-tag signals for well-defined business types. Overture's
# taxonomy is incomplete — e.g. a place named "Коворкинг Империя" can be tagged
# with a generic office category. When the name is an unambiguous match we count
# it, so real businesses are not skipped just because the taxonomy is coarse.
# Only very distinctive keywords are allowed to avoid false positives.
NAME_SIGNALS: dict[str, list[str]] = {
    "coworking_space": [r"cowork(?:ing)?\b", r"co[- ]?work\b", r"коворк", r"кoворкинг", r"koworking"],
    "self_service_laundry": [r"laundromat", r"laundrymat", r"прачечная", r"washateria", r"p\.?r\.?a\.?чeчнa"],
    "pet_groomer": [r"pet[ -]?groom", r"dog[ -]?groom", r"grooming (?:salon|studio|centre|center|shop)", r"груминг", r"gr(o|u)uming", r"grooming"],
    "karaoke_bar": [r"karaoke", r"караоке", r"karaoke"],
    "escape_room": [r"escape room", r"quest room", r"квест"],
    "dog_park": [r"dog park", r"собачья площадка"],
    "yoga_studio": [r"yoga studio", r"студия йоги", r"йога студи"],
    "crossfit": [r"crossfit", r"кроссфит"],
    "tattoo_parlor": [r"tattoo", r"тату"],
    "vape_shop": [r"vape shop", r"вейп"],
    # Azerbaijani name signals
    "cafe": [r"каfe", r"kafe", r"кyфе", r"кофе"],
    "restaurant": [r"ресторан", r"restoran"],
    "barber": [r"бəрбəр", r"berber", r"barber"],
    "beauty_salon": [r"gözellik salonu", r"gozellik", r"силаməзлик", r"gözəl"],
    "gym": [r"fitnes", r"fitness"],
    "pharmacy": [r"əczaçılıq", r"apteka", r"aptek"],
}


def leaf_category(primary: str | None, hierarchy: list[str] | None) -> str | None:
    """Most specific taxonomy category, skipping broad roots.

    A pizza restaurant has hierarchy ['food_and_drink', 'restaurant',
    'pizza_restaurant'] so its leaf is 'pizza_restaurant'. A generic place
    with primary 'shopping' and hierarchy ['shopping'] has no meaningful leaf.
    """
    h = [x for x in (hierarchy or []) if x]
    if len(h) >= 2:
        return h[-1]
    if len(h) == 1:
        return None  # just the taxonomy root — not a real business type
    return primary or None


def matches_taxonomy(category: str, primary: str | None, hierarchy: list[str] | None,
                     alternates: list[str] | None) -> bool:
    """Does a place with this taxonomy match the requested category?"""
    if primary and primary == category:
        return True
    if hierarchy and category in hierarchy:
        return True
    if alternates and category in alternates:
        return True
    # Connected categories: e.g. coworking_space matches shared_office_space.
    for alt in alternates or []:
        if alt in CATEGORY_EQUIVALENTS.get(category, set()):
            return True
    return False


def name_matches_category(category: str, name: str | None) -> bool:
    """Best-effort name-signal match for well-defined categories.

    Used only as a supplement to taxonomy matching, never as the sole signal,
    so sparse taxonomies do not hide real businesses.
    """
    if not name:
        return False
    import re
    hay = name.lower()
    for pat in NAME_SIGNALS.get(category, []):
        if re.search(pat, hay):
            return True
    return False
