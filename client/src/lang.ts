// ─── Native-language support ─────────────────────────────────────────
// Free, offline data: country → primary language + ccTLD + native city
// names + category-term translations. Lets search run BOTH in English
// and in the country's native language (huge yield boost on local
// businesses whose sites only exist in the local language).

/** ISO-3166 alpha-2 → primary spoken/written language (ISO-639-1). */
export const COUNTRY_LANG: Record<string, string> = {
  GE: 'ka', AM: 'hy', AZ: 'az', TR: 'tr', RU: 'ru', UA: 'uk',
  US: 'en', GB: 'en', CA: 'en', AU: 'en', NZ: 'en', IE: 'en',
  DE: 'de', AT: 'de', CH: 'de', FR: 'fr', BE: 'fr', LU: 'fr',
  IT: 'it', ES: 'es', MX: 'es', AR: 'es', CL: 'es', CO: 'es', PE: 'es',
  PT: 'pt', BR: 'pt', NL: 'nl', SE: 'sv', NO: 'nb', DK: 'da', FI: 'fi',
  IS: 'is', PL: 'pl', CZ: 'cs', SK: 'sk', HU: 'hu', RO: 'ro',
  BG: 'bg', GR: 'el', RS: 'sr', HR: 'hr', SI: 'sl', BA: 'bs',
  MK: 'mk', AL: 'sq', ME: 'sr', XK: 'sq', MD: 'ro', BY: 'be',
  EE: 'et', LV: 'lv', LT: 'lt', IL: 'he', SA: 'ar', AE: 'ar',
  QA: 'ar', KW: 'ar', BH: 'ar', OM: 'ar', JO: 'ar', LB: 'ar',
  IQ: 'ar', EG: 'ar', MA: 'ar', DZ: 'ar', TN: 'ar', LY: 'ar',
  IR: 'fa', AF: 'fa', PK: 'ur', IN: 'hi', BD: 'bn', LK: 'si',
  NP: 'ne', CN: 'zh', TW: 'zh', HK: 'zh', JP: 'ja', KR: 'ko',
  KP: 'ko', MN: 'mn', KZ: 'kk', UZ: 'uz', TM: 'tk', KG: 'ky',
  TJ: 'tg', TH: 'th', VN: 'vi', KH: 'km', LA: 'lo', MM: 'my',
  MY: 'ms', SG: 'en', ID: 'id', PH: 'en', TL: 'pt',
  NG: 'en', GH: 'en', KE: 'en', TZ: 'sw', UG: 'en', ZA: 'en',
  ET: 'am',
};

/** ISO-2 → country-code top-level domain (for `site:.ge` style queries). */
export const COUNTRY_TLD: Record<string, string> = {
  GE: 'ge', AM: 'am', AZ: 'az', TR: 'com.tr', RU: 'ru', UA: 'ua',
  US: 'com', GB: 'co.uk', CA: 'ca', AU: 'com.au', NZ: 'co.nz',
  IE: 'ie', DE: 'de', AT: 'at', CH: 'ch', FR: 'fr', BE: 'be',
  LU: 'lu', IT: 'it', ES: 'es', MX: 'mx', AR: 'com.ar', CL: 'cl',
  CO: 'com.co', PE: 'com.pe', PT: 'pt', BR: 'com.br', NL: 'nl',
  SE: 'se', NO: 'no', DK: 'dk', FI: 'fi', IS: 'is', PL: 'pl',
  CZ: 'cz', SK: 'sk', HU: 'hu', RO: 'ro', BG: 'bg', GR: 'gr',
  RS: 'rs', HR: 'hr', SI: 'si', BA: 'ba', MK: 'mk', AL: 'al',
  ME: 'me', MD: 'md', BY: 'by', EE: 'ee', LV: 'lv', LT: 'lt',
  IL: 'co.il', SA: 'com.sa', AE: 'ae', QA: 'com.qa', KW: 'com.kw',
  BH: 'com.bh', OM: 'om', JO: 'jo', LB: 'com.lb', IQ: 'iq',
  EG: 'com.eg', MA: 'co.ma', DZ: 'dz', TN: 'tn', LY: 'ly',
  IR: 'ir', AF: 'af', PK: 'pk', IN: 'in', BD: 'com.bd', LK: 'lk',
  NP: 'com.np', CN: 'cn', TW: 'com.tw', HK: 'hk', JP: 'jp',
  KR: 'kr', KP: 'kp', MN: 'mn', KZ: 'kz', UZ: 'uz', TM: 'tm',
  KG: 'kg', TJ: 'tj', TH: 'co.th', VN: 'vn', KH: 'com.kh',
  LA: 'la', MM: 'mm', MY: 'com.my', SG: 'com.sg', ID: 'co.id',
  PH: 'ph', TL: 'tl', NG: 'com.ng', GH: 'com.gh', KE: 'co.ke',
  TZ: 'co.tz', UG: 'co.ug', ZA: 'co.za', ET: 'com.et',
};

/**
 * Category term translations. Covers the ~30 most-used categories in the
 * app's native languages (Caucasus + neighborhood + major global ones).
 * English fallback: the category's English label.
 */
export const CATEGORY_TERMS: Record<string, Record<string, string>> = {
  // en terms
  cafe:        { en: 'cafe', ka: 'კაფე', hy: 'սրճարան', az: 'kafe', ru: 'кафе', tr: 'kafe', de: 'Café', fr: 'café', es: 'cafetería', it: 'caffè', pt: 'café', pl: 'kawiarnia', el: 'καφέ', ar: 'مقهى', he: 'בית קפה', zh: '咖啡馆', ja: 'カフェ', ko: '카페', uk: 'кафе' },
  restaurant:  { en: 'restaurant', ka: 'რესტორანი', hy: 'ռեստորան', az: 'restoran', ru: 'ресторан', tr: 'restoran', de: 'Restaurant', fr: 'restaurant', es: 'restaurante', it: 'ristorante', pt: 'restaurante', pl: 'restauracja', el: 'εστιατόριο', ar: 'مطعم', he: 'מסעדה', zh: '餐厅', ja: 'レストラン', ko: '레스토랑', uk: 'ресторан' },
  bar:         { en: 'bar', ka: 'ბარი', hy: 'բար', az: 'bar', ru: 'бар', tr: 'bar', de: 'Bar', fr: 'bar', es: 'bar', it: 'bar', pt: 'bar', pl: 'bar', el: 'μπαρ', ar: 'حانة', he: 'בר', zh: '酒吧', ja: 'バー', ko: '바', uk: 'бар' },
  pub:         { en: 'pub', ka: 'პაბი', ru: 'паб', tr: 'pub', de: 'Pub', fr: 'pub', es: 'pub', it: 'pub', pl: 'pub', uk: 'паб' },
  fast_food:   { en: 'fast food', ka: 'ფასტფუდი', ru: 'фастфуд', tr: 'fast food', de: 'Fastfood', fr: 'restauration rapide', es: 'comida rápida', ja: 'ファストフード', ko: '패스트푸드', uk: 'фастфуд' },
  hotel:       { en: 'hotel', ka: 'სასტუმრო', hy: 'հյուրանոց', az: 'otel', ru: 'отель', tr: 'otel', de: 'Hotel', fr: 'hôtel', es: 'hotel', it: 'hotel', pt: 'hotel', pl: 'hotel', el: 'ξενοδοχείο', ar: 'فندق', he: 'מלון', zh: '酒店', ja: 'ホテル', ko: '호텔', uk: 'готель' },
  gym:         { en: 'gym', ka: 'სპორტული დარბაზი', ru: 'спортзал', tr: 'spor salonu', de: 'Fitnessstudio', fr: 'salle de sport', es: 'gimnasio', it: 'palestra', uk: 'спортзал' },
  beauty_salon:{ en: 'beauty salon', ka: 'კოსმეტოლოგი', ru: 'салон красоты', tr: 'güzellik salonu', de: 'Schönheitssalon', fr: 'salon de beauté', es: 'salón de belleza', uk: 'салон краси' },
  hair_salon:  { en: 'hair salon', ka: 'თმის შეჭრა', ru: 'парикмахерская', tr: 'kuaför', de: 'Friseur', fr: 'coiffeur', es: 'peluquería', uk: 'перукарня' },
  pharmacy:    { en: 'pharmacy', ka: 'აფთიაქი', hy: 'դեղատուն', ru: 'аптека', tr: 'eczane', de: 'Apotheke', fr: 'pharmacie', es: 'farmacia', it: 'farmacia', el: 'φαρμακείο', uk: 'аптека' },
  hospital:    { en: 'hospital', ka: 'საავადმყოფო', ru: 'больница', tr: 'hastane', de: 'Krankenhaus', fr: 'hôpital', es: 'hospital', uk: 'лікарня' },
  clinic:      { en: 'clinic', ka: 'კლინიკა', ru: 'клиника', tr: 'klinik', de: 'Klinik', fr: 'clinique', es: 'clínica', uk: 'клініка' },
  dentist:     { en: 'dentist', ka: 'სტომატოლოგი', ru: 'стоматолог', tr: 'diş hekimi', de: 'Zahnarzt', fr: 'dentiste', es: 'dentista', uk: 'стоматолог' },
  supermarket: { en: 'supermarket', ka: 'სუპერმარკეტი', ru: 'супермаркет', tr: 'süpermarket', de: 'Supermarkt', fr: 'supermarché', es: 'supermercado', uk: 'супермаркет' },
  grocery:     { en: 'grocery store', ka: 'მაღაზია', ru: 'продуктовый магазин', tr: 'bakkal', uk: 'продуктовий магазин' },
  clothing:    { en: 'clothing store', ka: 'ტანსაცმლის მაღაზია', ru: 'магазин одежды', tr: 'giyim mağazası', de: 'Bekleidungsgeschäft', uk: 'магазин одягу' },
  electronics: { en: 'electronics store', ka: 'ელექტრონიკის მაღაზია', ru: 'магазин электроники', tr: 'elektronik mağazası', uk: 'магазин електроніки' },
  furniture:   { en: 'furniture store', ka: 'ავეჯის მაღაზია', ru: 'магазин мебели', tr: 'mobilya', uk: 'магазин меблів' },
  hardware:    { en: 'hardware store', ka: 'სამშენებლო მაღაზია', ru: 'хозяйственный магазин', uk: 'господарський магазин' },
  bank:        { en: 'bank', ka: 'ბანკი', ru: 'банк', tr: 'banka', de: 'Bank', fr: 'banque', es: 'banco', uk: 'банк' },
  school:      { en: 'school', ka: 'სკოლა', ru: 'школа', tr: 'okul', de: 'Schule', fr: 'école', es: 'escuela', uk: 'школа' },
  cinema:      { en: 'cinema', ka: 'კინოთეატრი', ru: 'кинотеатр', tr: 'sinema', de: 'Kino', fr: 'cinéma', es: 'cine', uk: 'кінотеатр' },
  bakery:      { en: 'bakery', ka: 'საცხობი', ru: 'пекарня', tr: 'fırın', de: 'Bäckerei', fr: 'boulangerie', es: 'panadería', uk: 'пекарня' },
  car_repair:  { en: 'car repair', ka: 'ავტოსერვისი', ru: 'автосервис', tr: 'oto tamir', uk: 'автосервіс' },
  laundry:     { en: 'laundry', ka: 'სამრეცხაო', ru: 'химчистка', tr: 'çamaşırhane', uk: 'хімчистка' },
  coworking:   { en: 'coworking', ka: 'ქოუორქინგი', ru: 'коворкинг', tr: 'coworking', uk: 'коворкинг' },
  night_club:  { en: 'night club', ka: 'ღამის კლუბი', ru: 'ночной клуб', tr: 'gece kulübü', uk: 'нічний клуб' },
  car_rental:  { en: 'car rental', ka: 'ავტომობილების გაქირავება', ru: 'прокат авто', tr: 'araç kiralama', uk: 'прокат авто' },
  nail_salon:  { en: 'nail salon', ka: 'მანიკური', ru: 'маникюр', tr: 'manikür', uk: 'манікюр' },
  spa:         { en: 'spa', ka: 'სპა', ru: 'спа', tr: 'spa', uk: 'спа' },
  pet_groomer: { en: 'pet grooming', ka: 'ცხოველთა მოვლა', ru: 'груминг', tr: 'pet kuaför', uk: 'грумінг' },
  ice_cream:   { en: 'ice cream', ka: 'ნაყინი', ru: 'мороженое', tr: 'dondurma', uk: 'морозиво' },
};

/** Native-language names for common cities (extends engine's CITY_EN_MAP reverse). */
export const NATIVE_CITY_NAMES: Record<string, string> = {
  // Georgia
  'Tbilisi': 'თბილისი', 'Batumi': 'ბათუმი', 'Kutaisi': 'ქუთაისი',
  'Rustavi': 'რუსთავი', 'Zugdidi': 'ზუგდიდი', 'Gori': 'გორი',
  'Poti': 'ფოთი', 'Telavi': 'თელავი',
  // Armenia / Azerbaijan
  'Yerevan': 'Երևան', 'Gyumri': 'Գյումրի', 'Vanadzor': 'Վանաձոր',
  'Baku': 'Bakı', 'Ganja': 'Gəncə',
  // Russia / Ukraine / Belarus
  'Moscow': 'Москва', 'Saint Petersburg': 'Санкт-Петербург', 'Novosibirsk': 'Новосибирск',
  'Yekaterinburg': 'Екатеринбург', 'Kazan': 'Казань',
  'Kyiv': 'Київ', 'Kharkiv': 'Харків', 'Odesa': 'Одеса', 'Lviv': 'Львів',
  'Minsk': 'Мінск',
  // Turkey
  'Istanbul': 'İstanbul', 'Ankara': 'Ankara', 'Izmir': 'İzmir',
  'Antalya': 'Antalya', 'Bursa': 'Bursa', 'Adana': 'Adana',
  // Middle East
  'Dubai': 'دبي', 'Abu Dhabi': 'أبوظبي', 'Riyadh': 'الرياض', 'Jeddah': 'جدة',
  'Doha': 'الدوحة', 'Kuwait City': 'مدينة الكويت', 'Manama': 'المنامة',
  'Muscat': 'مسقط', 'Cairo': 'القاهرة', 'Alexandria': 'الإسكندرية',
  'Tehran': 'تهران', 'Baghdad': 'بغداد', 'Beirut': 'بيروت', 'Amman': 'عمّان',
  // South Asia
  'Mumbai': 'मुंबई', 'Delhi': 'दिल्ली', 'New Delhi': 'नई दिल्ली', 'Bengaluru': 'बेंगलुरु',
  'Chennai': 'चेन्नई', 'Kolkata': 'कोलकाता', 'Hyderabad': 'हैदराबाद', 'Karachi': 'کراچی',
  'Lahore': 'لاہور', 'Islamabad': 'اسلام آباد', 'Dhaka': 'ঢাকা', 'Colombo': 'කොළඹ',
  'Kathmandu': 'काठमाडौं',
  // East Asia
  'Tokyo': '東京', 'Osaka': '大阪', 'Kyoto': '京都', 'Yokohama': '横浜', 'Nagoya': '名古屋',
  'Seoul': '서울', 'Busan': '부산',
  'Beijing': '北京', 'Shanghai': '上海', 'Shenzhen': '深圳', 'Guangzhou': '广州',
  'Hangzhou': '杭州', 'Chengdu': '成都',
  'Taipei': '臺北', 'Hong Kong': '香港',
  // Europe
  'London': 'London', 'Manchester': 'Manchester', 'Birmingham': 'Birmingham',
  'Paris': 'Paris', 'Lyon': 'Lyon', 'Marseille': 'Marseille',
  'Berlin': 'Berlin', 'Munich': 'München', 'Hamburg': 'Hamburg', 'Frankfurt': 'Frankfurt',
  'Vienna': 'Wien', 'Zurich': 'Zürich', 'Geneva': 'Genève',
  'Madrid': 'Madrid', 'Barcelona': 'Barcelona', 'Lisbon': 'Lisboa',
  'Rome': 'Roma', 'Milan': 'Milano', 'Naples': 'Napoli', 'Turin': 'Torino',
  'Amsterdam': 'Amsterdam', 'Rotterdam': 'Rotterdam', 'Brussels': 'Bruxelles',
  'Warsaw': 'Warszawa', 'Krakow': 'Kraków', 'Prague': 'Praha',
  'Budapest': 'Budapest', 'Bucharest': 'București', 'Sofia': 'София',
  'Belgrade': 'Београд', 'Zagreb': 'Zagreb', 'Ljubljana': 'Ljubljana',
  'Bratislava': 'Bratislava', 'Athens': 'Αθήνα',
  'Helsinki': 'Helsinki', 'Stockholm': 'Stockholm', 'Oslo': 'Oslo',
  'Copenhagen': 'København', 'Dublin': 'Dublin', 'Reykjavik': 'Reykjavík',
  'Riga': 'Rīga', 'Vilnius': 'Vilnius', 'Tallinn': 'Tallinn',
  // Americas
  'New York': 'New York', 'Los Angeles': 'Los Angeles', 'Chicago': 'Chicago',
  'Houston': 'Houston', 'San Francisco': 'San Francisco', 'Seattle': 'Seattle',
  'Boston': 'Boston', 'Miami': 'Miami', 'Austin': 'Austin', 'Denver': 'Denver',
  'Toronto': 'Toronto', 'Vancouver': 'Vancouver', 'Montreal': 'Montréal',
  'Mexico City': 'Ciudad de México', 'Guadalajara': 'Guadalajara',
  'São Paulo': 'São Paulo', 'Rio de Janeiro': 'Rio de Janeiro',
  'Buenos Aires': 'Buenos Aires', 'Santiago': 'Santiago',
  'Bogotá': 'Bogotá', 'Lima': 'Lima',
  // Africa / Southeast Asia
  'Lagos': 'Lagos', 'Nairobi': 'Nairobi', 'Addis Ababa': 'Addis Ababa',
  'Johannesburg': 'Johannesburg', 'Cape Town': 'Cape Town',
  'Bangkok': 'กรุงเทพมหานคร', 'Jakarta': 'Jakarta', 'Manila': 'Maynila',
  'Ho Chi Minh City': 'Thành phố Hồ Chí Minh', 'Hanoi': 'Hà Nội',
  'Kuala Lumpur': 'Kuala Lumpur', 'Singapore': 'Singapore',
  'Phnom Penh': 'ភ្នំពេញ', 'Vientiane': 'ວຽງຈັນ', 'Yangon': 'ရန်ကုန်',
};

/**
 * Locale context for a scan. Set once per run by views via
 * setScanContext() before queryBusinesses(); consumed by query builders
 * and enrichment engines so searches run in native language + English.
 */
export interface ScanContext {
  countryCode: string;   // 'GE'
  countryName: string;   // 'Georgia'
  lang: string;          // 'ka'
  cityNative: string;    // 'თბილისი' (may equal English name)
  cityEn: string;        // 'Tbilisi'
}

let _scanCtx: ScanContext | null = null;

export function setScanContext(ctx: ScanContext | null): void {
  _scanCtx = ctx;
}

export function getScanContext(): ScanContext | null {
  return _scanCtx;
}

/** Build a scan context from resolveCity() results. */
export function buildScanContext(
  countryCode: string,
  countryName: string,
  cityName: string
): ScanContext {
  const lang = COUNTRY_LANG[countryCode] || 'en';
  // The city name as typed is usually the native or English form; keep both.
  const native = NATIVE_CITY_NAMES[cityName] || cityName;
  return {
    countryCode,
    countryName,
    lang,
    cityNative: native,
    cityEn: cityName,
  };
}

/** Translate a category label into the scan's language (fallback English). */
export function categoryInNative(category: string, englishLabel: string): string {
  if (!_scanCtx) return englishLabel;
  const term = CATEGORY_TERMS[category];
  if (!term) return englishLabel;
  return term[_scanCtx.lang] || term.en || englishLabel;
}

/** Native ccTLD for the scan, e.g. 'ge'. */
export function countryTld(): string {
  if (!_scanCtx) return '';
  return COUNTRY_TLD[_scanCtx.countryCode] || '';
}

/**
 * v6.9.16: native "contact / phone / email" search keywords for the scan's
 * language. Local business sites write contact pages in the local language
 * ("お問い合わせ", "联系", "تماس", "επικοινωνία"); English-only tails miss them.
 * Returns English terms too — search engines treat extra terms loosely.
 */
const CONTACT_TERMS: Record<string, string> = {
  en: 'contact phone email',
  ka: 'კონტაქტი ტელეფონი',
  hy: 'կապ հեռախոս',
  az: 'əlaqə telefon',
  ru: 'контакты телефон',
  uk: 'контакти телефон',
  tr: 'iletişim telefon',
  de: 'kontakt telefon',
  fr: 'contact téléphone',
  es: 'contacto teléfono',
  it: 'contatti telefono',
  pt: 'contacto telefone',
  pl: 'kontakt telefon',
  nl: 'contact telefoon',
  sv: 'kontakt telefon',
  el: 'επικοινωνία τηλέφωνο',
  ar: 'اتصال هاتف',
  he: 'קשר טלפון',
  fa: 'تماس تلفن',
  hi: 'संपर्क फोन',
  th: 'ติดต่อ โทร',
  vi: 'liên hệ điện thoại',
  id: 'kontak telepon',
  ms: 'hubungi telefon',
  ja: 'お問い合わせ 電話番号',
  ko: '연락처 전화번호',
  zh: '联系方式 电话',
};

export function contactTermsNative(): string {
  if (!_scanCtx) return CONTACT_TERMS.en;
  return CONTACT_TERMS[_scanCtx.lang] || CONTACT_TERMS.en;
}
