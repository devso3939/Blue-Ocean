#!/usr/bin/env python3
"""v3.0.0: Complete map rewrite using GeoJSON layers + enrichment improvements"""
import re, os

os.chdir("C:/Users/Anania Light Laptop/Downloads/Blue Ocean")

with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()

# ══════════════════════════════════════════════════════════════
# REPLACE THE ENTIRE MAP SECTION (lines 131-266)
# ══════════════════════════════════════════════════════════════

# Find the exact start and end of the map section
# Start: "  // Initialize map when selectedCity changes"
# End: just before "  // Discover all opportunities"

MAP_START = "  // Initialize map when selectedCity changes"
MAP_END = "  // Discover all opportunities"

start_idx = app.find(MAP_START)
end_idx = app.find(MAP_END)

if start_idx < 0 or end_idx < 0:
    print("[ERR] Could not find map section boundaries")
    exit(1)

# Also need to remove the old refs that we don't need anymore
# Keep mapRef and mapInstanceRef, remove markersRef and maplibreRef
# Actually, we'll repurpose maplibreRef to store the maplibregl module

OLD_MAP_SECTION = app[start_idx:end_idx]

NEW_MAP_SECTION = """  // ─── Map initialization ─────────────────────────────────────────
  // Initialize map when selectedCity changes
  useEffect(() => {
    if (!selectedCity || !mapRef.current) return;
    if (mapInstanceRef.current) {
      mapInstanceRef.current.flyTo({ center: [selectedCity.lon, selectedCity.lat], zoom: 12, duration: 1500 });
      return;
    }
    import('maplibre-gl').then((maplibregl) => {
      if (!mapRef.current || mapInstanceRef.current) return;
      maplibreRef.current = maplibregl;
      const map = new maplibregl.Map({
        container: mapRef.current,
        style: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
        center: [selectedCity.lon, selectedCity.lat],
        zoom: 12,
      });
      map.addControl(new maplibregl.NavigationControl());
      mapInstanceRef.current = map;

      map.on('load', () => {
        mapReadyRef.current = true;
        // Add GeoJSON source for businesses
        map.addSource('businesses', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // Circle layer: colored dots
        map.addLayer({
          id: 'biz-circles',
          type: 'circle',
          source: 'businesses',
          paint: {
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              10, 5,
              14, 10,
              18, 14,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 2,
            'circle-stroke-color': 'rgba(255,255,255,0.9)',
            'circle-opacity': 0.9,
          },
        });
        // Symbol layer: emoji labels on top of circles
        map.addLayer({
          id: 'biz-labels',
          type: 'symbol',
          source: 'businesses',
          layout: {
            'text-field': ['get', 'emoji'],
            'text-size': 14,
            'text-allow-overlap': true,
            'text-ignore-placement': true,
          },
          paint: {
            'text-color': '#ffffff',
          },
        });
        // Cursor pointer on hover
        map.on('mouseenter', 'biz-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-circles', () => { map.getCanvas().style.cursor = ''; });
        // Click handler: show popup
        map.on('click', 'biz-circles', (e: any) => {
          const f = e.features?.[0];
          if (!f) return;
          const p = f.properties;
          const coords = f.geometry.coordinates;
          const gmapsUrl = 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent((p.name || '') + ' ' + (p.address || ''));
          const osmUrl = 'https://www.openstreetmap.org/?mlat=' + coords[1] + '&mlon=' + coords[0] + '#map=17/' + coords[1] + '/' + coords[0];
          let contactHtml = '';
          if (p.phone) contactHtml += '<div style="margin:3px 0"><a href="tel:' + p.phone + '" style="color:#60a5fa;text-decoration:none;font-size:12px">📞 ' + p.phone + '</a></div>';
          if (p.email) contactHtml += '<div style="font-size:11px;color:#94a3b8;margin:3px 0;word-break:break-all">✉️ ' + p.email + '</div>';
          if (p.website) contactHtml += '<div style="margin:3px 0"><a href="' + p.website + '" target="_blank" style="color:#60a5fa;text-decoration:none;font-size:11px">🌐 ' + p.website.replace(/^https?:\\/\\//, '').slice(0, 25) + '</a></div>';
          if (p.address) contactHtml += '<div style="font-size:10px;color:#64748b;margin:3px 0">📍 ' + p.address + '</div>';
          let socialHtml = '';
          if (p.facebook) socialHtml += '<a href="' + p.facebook + '" target="_blank" style="color:#60a5fa;font-size:9px;text-decoration:none;background:rgba(96,165,250,0.1);padding:2px 5px;border-radius:3px">FB</a> ';
          if (p.instagram) socialHtml += '<a href="' + p.instagram + '" target="_blank" style="color:#e879f9;font-size:9px;text-decoration:none;background:rgba(232,121,249,0.1);padding:2px 5px;border-radius:3px">IG</a>';
          const html = '<div style="padding:10px 12px;max-width:220px;font-family:system-ui,sans-serif">'
            + '<div style="font-weight:600;font-size:13px;color:#f1f5f9;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (p.emoji || '') + ' ' + (p.name || '') + '</div>'
            + '<div style="display:inline-block;background:' + (p.color || '#64748b') + '22;color:' + (p.color || '#64748b') + ';font-size:9px;padding:1px 6px;border-radius:99px;margin-bottom:6px">' + (p.categoryLabel || '') + '</div>'
            + contactHtml
            + (socialHtml ? '<div style="display:flex;gap:3px;margin-top:3px">' + socialHtml + '</div>' : '')
            + '<div style="margin-top:6px;padding-top:5px;border-top:1px solid #1e293b;display:flex;gap:4px">'
            + '<a href="' + gmapsUrl + '" target="_blank" style="background:#1a73e8;color:white;padding:3px 7px;border-radius:4px;font-size:10px;font-weight:600;text-decoration:none">📍 Maps</a>'
            + '<a href="' + osmUrl + '" target="_blank" style="background:#1e293b;color:#94a3b8;padding:3px 7px;border-radius:4px;font-size:10px;font-weight:600;text-decoration:none">OSM</a>'
            + '</div></div>';
          new maplibregl.Popup({ className: 'dark-popup', maxWidth: '240px', offset: 15, closeButton: true })
            .setLngLat(coords)
            .setHTML(html)
            .addTo(map);
        });
        // If businesses already exist, render them
        if (businesses.size > 0) {
          updateMapData(map, businesses);
        }
      });
    });
  }, [selectedCity, opportunities.length]);

  // Update map data whenever businesses change
  useEffect(() => {
    if (!mapInstanceRef.current || !mapReadyRef.current) return;
    updateMapData(mapInstanceRef.current, businesses);
  }, [businesses]);

  function updateMapData(map: any, biz: Map<string, Business[]>) {
    const allBiz: Business[] = [];
    biz.forEach(bizs => allBiz.push(...bizs));
    if (allBiz.length === 0) return;

    const CAT_EMOJI: Record<string, string> = {
      cafe: '☕', restaurant: '🍽️', bar: '🍸', pub: '🍺', fast_food: '🍔',
      hotel: '🏨', gym: '💪', beauty_salon: '💄', hair_salon: '💇',
      pharmacy: '💊', supermarket: '🛒', bank: '🏦', clothing: '👗',
      electronics: '📱', bakery: '🥐', cinema: '🎬', car_repair: '🔧',
      pet_groomer: '🐕', coworking: '💻', spa: '🧖', school: '📚',
      clinic: '🏥', hospital: '🏥', dentistry: '🦷', post_office: '📮',
      library: '📖', nightclub: '🎶', car_rental: '🚗', veterinary: '🐾',
      florist: '🌸', optician: '👓', butcher: '🥩', ice_cream: '🍦',
      grocery: '🥬', convenience: '🏪', department_store: '🏬',
      jewelry: '💎', sports: '⚽', books: '📖', fuel: '⛽',
      art: '🎨', bicycle: '🚲', marketplace: '🏪',
    };

    const features = allBiz.slice(0, 500).map(b => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [b.lon, b.lat] },
      properties: {
        name: b.name,
        category: b.category,
        categoryLabel: b.categoryLabel,
        color: (CAT_COLORS as Record<string,string>)[b.category] || '#64748b',
        emoji: (CAT_EMOJI as Record<string,string>)[b.category] || '📍',
        phone: b.phone || '',
        email: b.email || '',
        website: b.website || '',
        address: b.address || '',
        facebook: b.facebook || '',
        instagram: b.instagram || '',
      },
    }));

    const geojson = { type: 'FeatureCollection' as const, features };
    const source = map.getSource('businesses');
    if (source) {
      source.setData(geojson);
    }

    // Fit bounds to all markers
    if (allBiz.length > 1) {
      const bounds = new (maplibreRef.current as any).LngLatBounds();
      allBiz.forEach(b => bounds.extend([b.lon, b.lat]));
      map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 1200 });
    }
  }

"""

# Remove old CAT_EMOJI constant (it's now inside updateMapData)
# Find and remove the old CAT_EMOJI that's between the old map section and runAnalysis

app_new = app[:start_idx] + NEW_MAP_SECTION + app[end_idx:]

# Remove the old CAT_EMOJI block that's now orphaned (between end of old map and runAnalysis)
# It should be right after the map section ends
OLD_CAT_EMOJI = """  const CAT_EMOJI: Record<string, string> = {
    cafe: '☕', restaurant: '🍽️', bar: '🍸', pub: '🍺', fast_food: '🍔',
    hotel: '🏨', gym: '💪', beauty_salon: '💄', hair_salon: '💇',
    pharmacy: '💊', supermarket: '🛒', bank: '🏦', clothing: '👗',
    electronics: '📱', bakery: '🥐', cinema: '🎬', car_repair: '🔧',
    pet_groomer: '🐕', coworking: '💻', spa: '🧖', school: '📚',
    clinic: '🏥', hospital: '🏥', dentistry: '🦷', post_office: '📮',
    library: '📖', nightclub: '🎶', car_rental: '🚗', veterinary: '🐾',
    florist: '🌸', optician: '👓', butcher: '🥩', ice_cream: '🍦',
    grocery: '🥬', convenience: '🏪', department_store: '🏬',
    jewelry: '💎', sports: '⚽', books: '📖', fuel: '⛽',
    art: '🎨', bicycle: '🚲', marketplace: '🏪',
  };"""

if OLD_CAT_EMOJI in app_new:
    app_new = app_new.replace(OLD_CAT_EMOJI, "", 1)
    print("[OK] Removed orphaned CAT_EMOJI block")

# Also remove the old addMarkers function that's now orphaned
# Find it between updateMapData and runAnalysis
OLD_ADDMARKERS_START = "  function addMarkers(map: any, biz: Map<string, Business[]>) {"
OLD_ADDMARKERS_END = "  // Discover all opportunities"
am_start = app_new.find(OLD_ADDMARKERS_START)
am_end = app_new.find(OLD_ADDMARKERS_END)
if am_start >= 0 and am_end >= 0 and am_start < am_end:
    app_new = app_new[:am_start] + app_new[am_end:]
    print("[OK] Removed orphaned addMarkers function")
else:
    print("[WARN] Could not find orphaned addMarkers to remove")

with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app_new)
print("[OK] App.tsx saved (map rewritten)")

# ══════════════════════════════════════════════════════════════
# 2. BUMP VERSION
# ══════════════════════════════════════════════════════════════
with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()
app = app.replace("APP_VERSION = '2.9.7'", "APP_VERSION = '3.0.0'")
with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app)

with open("client/index.html", "r", encoding="utf-8") as f:
    html = f.read()
html = html.replace("v2.9.7", "v3.0.0")
with open("client/index.html", "w", encoding="utf-8") as f:
    f.write(html)

print("[OK] Version bumped to 3.0.0")
print("\nDone!")
