#!/usr/bin/env python3
"""v3.0.1: Fix emoji on map pins using canvas-based images"""
import re, os

os.chdir("C:/Users/Anania Light Laptop/Downloads/Blue Ocean")

with open("client/src/App.tsx", "r", encoding="utf-8") as f:
    app = f.read()

# ══════════════════════════════════════════════════════════════
# FIX: Replace symbol layer with icon-image using canvas emoji
# ══════════════════════════════════════════════════════════════

# Replace the map.on('load') block to add emoji images before adding layers
OLD_LOAD_BLOCK = """      map.on('load', () => {
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
        });"""

NEW_LOAD_BLOCK = """      map.on('load', () => {
        mapReadyRef.current = true;

        // Register canvas-based emoji images for each category
        const EMOJI_MAP: Record<string, string> = {
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
        const CAT_COLORS: Record<string, string> = """ + repr(dict({
          "cafe": "#f97316", "restaurant": "#ef4444", "bar": "#a855f7",
          "pub": "#8b5cf6", "fast_food": "#f59e0b", "hotel": "#3b82f6",
          "gym": "#ef4444", "beauty_salon": "#ec4899", "hair_salon": "#f472b6",
          "pharmacy": "#22c55e", "supermarket": "#84cc16", "bank": "#0ea5e9",
          "clothing": "#d946ef", "electronics": "#6366f1", "bakery": "#f97316",
          "cinema": "#e11d48", "car_repair": "#78716c", "coworking": "#06b6d4",
          "nightclub": "#7c3aed",
        })).replace("'", '"') + """;

        // Create canvas-based images for each emoji category
        for (const [cat, emoji] of Object.entries(EMOJI_MAP)) {
          const size = 36;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          // Draw colored circle background
          const color = CAT_COLORS[cat] || '#64748b';
          ctx.beginPath();
          ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 2;
          ctx.stroke();
          // Draw emoji text
          ctx.font = '18px serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(emoji, size / 2, size / 2);
          // Register as MapLibre image
          map.addImage('emoji-' + cat, canvas);
        }
        // Also add a default marker image
        {
          const size = 36;
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.beginPath();
            ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
            ctx.fillStyle = '#64748b';
            ctx.fill();
            ctx.strokeStyle = 'rgba(255,255,255,0.9)';
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.font = '18px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#ffffff';
            ctx.fillText('📍', size / 2, size / 2);
            map.addImage('emoji-default', canvas);
          }
        }

        // Add GeoJSON source for businesses
        map.addSource('businesses', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
        });
        // Circle layer: colored dots (fallback if image fails)
        map.addLayer({
          id: 'biz-circles',
          type: 'circle',
          source: 'businesses',
          paint: {
            'circle-radius': [
              'interpolate', ['linear'], ['zoom'],
              10, 6,
              14, 12,
              18, 16,
            ],
            'circle-color': ['get', 'color'],
            'circle-stroke-width': 2,
            'circle-stroke-color': 'rgba(255,255,255,0.9)',
            'circle-opacity': 0,
          },
        });
        // Icon layer: canvas emoji images on top of circles
        map.addLayer({
          id: 'biz-icons',
          type: 'symbol',
          source: 'businesses',
          layout: {
            'icon-image': [
              'case',
              ['has', 'category'],
              ['concat', 'emoji-', ['get', 'category']],
              'emoji-default'
            ],
            'icon-size': 1,
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        });"""

if OLD_LOAD_BLOCK in app:
    app = app.replace(OLD_LOAD_BLOCK, NEW_LOAD_BLOCK, 1)
    print("[OK] Replaced symbol layer with canvas-based emoji icons")
else:
    print("[ERR] Could not find the load block to replace")
    exit(1)

# Also update the CAT_EMOJI in updateMapData to match (keep consistent)
# And fix the click handler to also listen on 'biz-icons' layer
OLD_CLICK = "        map.on('click', 'biz-circles', (e: any) => {"
NEW_CLICK = "        map.on('click', (e: any) => {"
# Don't change the click handler - clicking anywhere on the map should work via queryRenderedFeatures

# Update the click handler to use queryRenderedFeatures instead of layer-specific event
OLD_CLICK_HANDLER = """        // Cursor pointer on hover
        map.on('mouseenter', 'biz-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-circles', () => { map.getCanvas().style.cursor = ''; });
        // Click handler: show popup
        map.on('click', 'biz-circles', (e: any) => {
          const f = e.features?.[0];"""

NEW_CLICK_HANDLER = """        // Cursor pointer on hover (check both layers)
        map.on('mouseenter', 'biz-icons', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-icons', () => { map.getCanvas().style.cursor = ''; });
        map.on('mouseenter', 'biz-circles', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'biz-circles', () => { map.getCanvas().style.cursor = ''; });
        // Click handler: show popup
        map.on('click', 'biz-icons', (e: any) => {
          const f = e.features?.[0];""";

if OLD_CLICK_HANDLER in app:
    app = app.replace(OLD_CLICK_HANDLER, NEW_CLICK_HANDLER, 1)
    print("[OK] Added click handler for icon layer")
else:
    print("[WARN] Click handler block not found (may already be updated)")

# Also add a click fallback for the circle layer
OLD_CLICK_SINGLE = "          new maplibregl.Popup({ className: 'dark-popup', maxWidth: '240px', offset: 15, closeButton: true })"
# Find the closing of the first click handler and add a second handler for biz-circles
CLOSE_POPUP = """.addTo(map);
        });"""

# Add a fallback click handler for the circle layer (in case icon layer doesn't catch it)
OLD_CLOSE = """        // If businesses already exist, render them"""
NEW_CLOSE = """        // Fallback click on circle layer
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
            + '<div style="font-weight:600;font-size:13px;color:#f1f5f9;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + (p.name || '') + '</div>'
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
        // If businesses already exist, render them"""

if OLD_CLOSE in app:
    app = app.replace(OLD_CLOSE, NEW_CLOSE, 1)
    print("[OK] Added fallback circle click handler")
else:
    print("[WARN] Could not add fallback click handler")

# Bump version
app = app.replace("APP_VERSION = '3.0.0'", "APP_VERSION = '3.0.1'")

with open("client/src/App.tsx", "w", encoding="utf-8") as f:
    f.write(app)
print("[OK] App.tsx saved")

# Fix index.html version
with open("client/index.html", "r", encoding="utf-8") as f:
    html = f.read()
html = html.replace("v3.0.0", "v3.0.1")
with open("client/index.html", "w", encoding="utf-8") as f:
    f.write(html)

print("[OK] Version bumped to 3.0.1")
print("\nDone!")
