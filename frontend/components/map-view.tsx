"use client";

import * as React from "react";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { EyeOff, Layers, MapPin, Store } from "lucide-react";
import type { Place } from "@/lib/types";
import { cn } from "@/lib/utils";

// Google-Maps-like basemap (OpenFreeMap "liberty"), kept light in both themes
// for legibility and to avoid style-swap races that drop data layers.
const MAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const EMOJI_RULES: [RegExp, string][] = [
  [/restaurant|food|diner|steak|pizza|sushi|burger|barbecue|bbq|grill|brunch|cafeteria|delicatessen|fast.?food/, "🍽️"],
  [/coffee|tea|espresso/, "☕"],
  [/cafe|café/, "☕"],
  [/bakery|dessert|cake|pastry|patisserie/, "🍰"],
  [/ice.?cream|frozen.?yogurt/, "🍦"],
  [/bar|pub|nightclub|dance.?club|club|brewery|winery|tavern|cocktail|wine/, "🍸"],
  [/grocery|supermarket|convenience|market/, "🛒"],
  [/pet|dog|cat|animal|veterinar|groom/, "🐾"],
  [/gym|fitness|crossfit|workout|pilates|yoga|martial|boxing|swimming|pool|spa|wellness/, "💪"],
  [/salon|beauty|barber|hair|nail|tanning|massage|blow.?dry/, "💇"],
  [/clinic|medical|hospital|dental|dentist|doctor|pharmacy|drug|health|physio|optic|eye|lab|pharma/, "🏥"],
  [/movie|cinema|theater|theatre|film|drive.?in/, "🎬"],
  [/museum|gallery|art|historic|cultural|monument/, "🏛️"],
  [/hotel|lodging|resort|hostel|inn|motel|guest.?house|bed.?and.?breakfast/, "🏨"],
  [/car|auto|automotive|vehicle|gas|fuel|tire|tyre|parking|rental|dealership/, "🚗"],
  [/school|education|university|college|academy|tutor|kindergarten|preschool|training|driving.?school/, "🎓"],
  [/bank|finance|atm|insurance|credit/, "🏦"],
  [/store|shop|retail|clothing|fashion|shoe|furniture|electronics|book|jewelry|gift|toy|hardware|pharmacy/, "🛍️"],
  [/airport|airline|flight|travel|tour|transit|station/, "✈️"],
  [/beach|park|garden|forest|mountain|lake|river|nature|trail/, "🌳"],
  [/church|worship|mosque|temple|religious|synagogue/, "⛪"],
  [/office|coworking|professional|law|account|print|photo|laundry|clean|consult|agency/, "💼"],
  [/sport|stadium|arena|field|golf|tennis|recreation|playground|arcade/, "⚽"],
  [/repair|maintenance|plumb|electric|handyman|workshop/, "🔧"],
];

function emojiFor(place: Place): string {
  const hay = `${place.primary_category || ""} ${place.category_label || ""}`.toLowerCase();
  for (const [re, emoji] of EMOJI_RULES) {
    if (re.test(hay)) return emoji;
  }
  return "📍";
}

interface EmojiImage {
  id: string;
  char: string;
}

export interface MapViewProps {
  places: Place[];
  boundary?: Record<string, unknown> | null;
  densityGrid?: { lat: number; lon: number; count: number }[];
  center: { lat: number; lon: number };
  height?: number;
}

interface ToggleDef {
  id: "businesses" | "boundary" | "density";
  label: string;
  icon: React.ReactNode;
}

const TOGGLES: ToggleDef[] = [
  { id: "businesses", label: "Businesses", icon: <Store className="h-3.5 w-3.5" /> },
  { id: "boundary", label: "City Boundary", icon: <MapPin className="h-3.5 w-3.5" /> },
  { id: "density", label: "Density", icon: <Layers className="h-3.5 w-3.5" /> },
];

// Cap for map rendering: beyond this, draw an evenly-spaced sample so the map
// stays fast (symbols + popups only need a representative subset; the full list
// stays in the table and exports).
const MAX_MAP_POINTS = 400;

export function MapView({ places, boundary, densityGrid, center, height = 540 }: MapViewProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<maplibregl.Map | null>(null);
  const popupRef = React.useRef<maplibregl.Popup | null>(null);
  const [visible, setVisible] = React.useState<Record<string, boolean>>({
    businesses: true,
    boundary: true,
    density: false,
  });

  // Build GeoJSON sources + emoji image registry. NO clustering: clustered
  // sources depend on the geojson-vt worker, which is unreliable here and
  // silently renders nothing. A plain symbol layer over an evenly-sampled
  // point set is dependable and fast.
  const { placesSource, emojiImages, shownCount, totalCount } = React.useMemo(() => {
    const pts = places.filter((p) => p.lat !== undefined && p.lon !== undefined);
    const total = pts.length;
    const step = Math.max(1, Math.ceil(total / MAX_MAP_POINTS));
    const sampled = pts.filter((_, i) => i % step === 0);
    const emojiIds = new Map<string, string>();
    const features = sampled.map((p) => {
      const emoji = emojiFor(p);
      if (!emojiIds.has(emoji)) emojiIds.set(emoji, `emoji-${emojiIds.size}`);
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
        properties: { id: p.id, emoji_id: emojiIds.get(emoji) },
      };
    });
    return {
      placesSource: {
        type: "FeatureCollection" as const,
        features,
      },
      emojiImages: Array.from(emojiIds.entries()).map(([char, id]) => ({ id, char })),
      shownCount: sampled.length,
      totalCount: total,
    };
  }, [places]);

  const boundarySource = React.useMemo(() => {
    if (!boundary) return null;
    return boundary as unknown as GeoJSON.FeatureCollection | GeoJSON.Feature;
  }, [boundary]);

  const densitySource = React.useMemo(() => {
    if (!densityGrid || densityGrid.length === 0) return null;
    return {
      type: "FeatureCollection" as const,
      features: densityGrid.map((g) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [g.lon, g.lat] },
        properties: { count: g.count },
      })),
    };
  }, [densityGrid]);

  // Build the initial style: Google-like basemap + our sources/layers injected
  // at construction time (adding clustered GeoJSON sources during the "load"
  // event is unreliable in some MapLibre builds — sources declared in the
  // style itself always work).
  const dataLayers = React.useMemo(() => {
    const layers: any[] = [
      {
        id: "discs",
        type: "circle",
        source: "places",
        paint: {
          "circle-color": "#ffffff",
          "circle-radius": 11,
          "circle-opacity": 0.92,
          "circle-stroke-width": 1.2,
          "circle-stroke-color": "#94a3b8",
        },
      },
      {
        id: "business-icons",
        type: "symbol",
        source: "places",
        layout: {
          "icon-image": ["get", "emoji_id"],
          "icon-size": 0.85,
          "icon-allow-overlap": true,
          "icon-ignore-placement": true,
        },
      },
    ];
    if (boundarySource) {
      layers.push(
        {
          id: "boundary-fill",
          type: "fill",
          source: "boundary",
          paint: { "fill-color": "#6366f1", "fill-opacity": 0.06 },
        },
        {
          id: "boundary-line",
          type: "line",
          source: "boundary",
          paint: { "line-color": "#818cf8", "line-width": 2, "line-dasharray": [3, 2], "line-opacity": 0.9 },
        },
      );
    }
    if (densitySource) {
      layers.push({
        id: "density-heat",
        type: "heatmap",
        source: "density",
        // Density is off by default — bake it in so correctness never depends on the load event.
        layout: { visibility: "none" },
        paint: {
          "heatmap-weight": ["interpolate", ["linear"], ["get", "count"], 0, 0, 10, 0.6, 50, 1],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 12, 3],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"], 0,
            "rgba(99,102,241,0)", 0.3, "rgba(129,140,248,0.5)", 0.6, "rgba(217,70,239,0.7)", 1, "rgba(244,63,94,0.9)",
          ],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 18, 12, 42],
          "heatmap-opacity": 0.55,
        },
      });
    }
    return layers;
  }, [boundarySource, densitySource, emojiImages]);

  const extraSources = React.useMemo(() => {
    const src: Record<string, any> = {
      places: {
        type: "geojson",
        data: placesSource as unknown as GeoJSON.FeatureCollection,
      },
    };
    if (boundarySource) src.boundary = { type: "geojson", data: boundarySource as GeoJSON.GeoJSON };
    if (densitySource) src.density = { type: "geojson", data: densitySource as unknown as GeoJSON.FeatureCollection };
    return src;
  }, [placesSource, boundarySource, densitySource]);

  function registerEmojiImages(map: maplibregl.Map) {
    for (const img of emojiImages) {
      if (map.hasImage(img.id)) continue;
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.font = "44px system-ui, 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(img.char, 32, 34);
        const imageData = ctx.getImageData(0, 0, 64, 64);
        map.addImage(img.id, { width: 64, height: 64, data: imageData.data as unknown as Uint8Array });
      }
    }
  }

  const setLayerVisibility = React.useCallback((map: maplibregl.Map, id: string, on: boolean) => {
    try {
      map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    } catch {
      /* layer not ready */
    }
  }, []);

  const applyVisibility = React.useCallback(
    (map: maplibregl.Map) => {
      setLayerVisibility(map, "discs", visible.businesses);
      setLayerVisibility(map, "business-icons", visible.businesses);
      setLayerVisibility(map, "boundary-fill", visible.boundary);
      setLayerVisibility(map, "boundary-line", visible.boundary);
      setLayerVisibility(map, "density-heat", visible.density);
    },
    [visible, setLayerVisibility],
  );

  // Initialise map once — sources/layers are part of the initial style so the
  // clustering pipeline is reliable. The guard is set synchronously so React
  // StrictMode's double-mount cannot race the async style fetch and create two
  // maps on the same container (which breaks the load event / handlers).
  const initStartedRef = React.useRef(false);
  React.useEffect(() => {
    if (!containerRef.current || initStartedRef.current) return;
    initStartedRef.current = true;
    let cancelled = false;
    let map: maplibregl.Map | null = null;

    (async () => {
      let style: Record<string, any> | null = null;
      try {
        const res = await fetch(MAP_STYLE);
        if (res.ok) style = await res.json();
      } catch {
        /* fall back to style URL below */
      }
      if (cancelled || !containerRef.current) return;

      const m = new maplibregl.Map({
        container: containerRef.current,
        style: (style
          ? {
              ...style,
              sources: { ...(style.sources || {}), ...extraSources },
              layers: [...(style.layers || []), ...dataLayers],
            }
          : MAP_STYLE) as any,
        center: [center.lon, center.lat],
        zoom: 11,
        attributionControl: { compact: true },
      });
      map = m;
      mapRef.current = m;
      m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

      // Our sources/layers are baked into the initial style object, so all
      // setup can run immediately after construction — the "load" event is
      // unreliable with inline styles (it can fire before handlers attach).
      const setup = () => {
        try {
          registerEmojiImages(m);
        } catch {
          /* emoji markers are decorative; fall back to plain discs */
        }
        try {
          applyVisibility(m);
        } catch {
          /* visibility re-applied on toggle anyway */
        }
        try {
          fitMap(m);
        } catch {
          /* map still usable without auto-fit */
        }
      };
      setup();
      m.on("load", setup);

      // Emoji images require the style to be ready — retry until it is.
      const retryEmojis = () => {
        try {
          if (m.isStyleLoaded() || m.loaded()) {
            registerEmojiImages(m);
            return;
          }
        } catch {
          /* retry */
        }
        setTimeout(retryEmojis, 120);
      };
      retryEmojis();

      m.on("click", (e) => {
        const features = m.queryRenderedFeatures(e.point, {
          layers: ["business-icons", "discs"],
        });
        if (!features.length) return;
        const props = features[0].properties as Record<string, unknown> | null;
        if (!props?.id) return;
        const place = places.find((p) => p.id === props.id);
        if (place) showPopup(m, place, e.lngLat, popupRef);
      });
      for (const layer of ["business-icons", "discs"]) {
        m.on("mouseenter", layer, () => (m.getCanvas().style.cursor = "pointer"));
        m.on("mouseleave", layer, () => (m.getCanvas().style.cursor = ""));
      }
    })();

    return () => {
      cancelled = true;
      initStartedRef.current = false; // let a StrictMode remount start fresh
      map?.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function fitMap(map: maplibregl.Map) {
    if (boundarySource) {
      try {
        const b = new maplibregl.LngLatBounds();
        const coords = extractCoords(boundarySource);
        for (const c of coords) b.extend(c);
        if (!b.isEmpty()) {
          map.fitBounds(b, { padding: 40, maxZoom: 13.5 });
          return;
        }
      } catch {
        /* fall through */
      }
    }
    if (places.length) {
      const b = new maplibregl.LngLatBounds();
      for (const p of places) b.extend([p.lon, p.lat]);
      if (!b.isEmpty()) map.fitBounds(b, { padding: 40, maxZoom: 13.5 });
    }
  }

  // Toggle layers
  React.useEffect(() => {
    const map = mapRef.current;
    if (map) applyVisibility(map);
  }, [visible, applyVisibility]);

  // Fit bounds when data first arrives (map may have been created before data)
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded() || !places.length) return;
    const t = setTimeout(() => fitMap(map), 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places.length, boundarySource]);

  function toggle(id: string) {
    setVisible((v) => ({ ...v, [id]: !v[id] }));
  }

  return (
    <div className="relative overflow-hidden rounded-xl border border-border">
      <div ref={containerRef} style={{ width: "100%", height }} />
      <div className="absolute left-3 top-3 z-10 flex flex-col gap-1.5 rounded-lg border border-border bg-card/95 p-1.5 shadow-card backdrop-blur">
        {TOGGLES.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => toggle(t.id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              visible[t.id] ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-muted",
            )}
          >
            {visible[t.id] ? t.icon : <EyeOff className="h-3.5 w-3.5" />}
            {t.label}
          </button>
        ))}
      </div>
      <div className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md bg-card/90 px-2 py-1 text-[10px] text-muted-foreground shadow backdrop-blur">
        {totalCount.toLocaleString()} detected businesses · Overture Maps
        {shownCount < totalCount ? ` · showing ${shownCount.toLocaleString()} on map` : ""}
      </div>
    </div>
  );
}

function extractCoords(src: GeoJSON.FeatureCollection | GeoJSON.Feature): [number, number][] {
  const out: [number, number][] = [];
  const walk = (g: GeoJSON.Geometry | null) => {
    if (!g) return;
    if (g.type === "Point") out.push(g.coordinates as [number, number]);
    else if (g.type === "MultiPoint") (g.coordinates as [number, number][]).forEach((c) => out.push(c));
    else if (g.type === "LineString") (g.coordinates as [number, number][]).forEach((c) => out.push(c));
    else if (g.type === "MultiLineString") (g.coordinates as [number, number][][]).forEach((l) => l.forEach((c) => out.push(c)));
    else if (g.type === "Polygon") (g.coordinates as [number, number][][]).forEach((r) => r.forEach((c) => out.push(c)));
    else if (g.type === "MultiPolygon") (g.coordinates as [number, number][][][]).forEach((p) => p.forEach((r) => r.forEach((c) => out.push(c))));
    else if (g.type === "GeometryCollection") g.geometries.forEach(walk);
  };
  const feats = src.type === "FeatureCollection" ? src.features : [src];
  for (const f of feats) walk(f.geometry ?? null);
  return out;
}

// Emoji icons for business-type rows in the popup (avoids importing an icon
// library into the plain-HTML popup).
function popupEmoji(place: Place): string {
  const hay = `${place.primary_category || ""} ${place.category_label || ""}`.toLowerCase();
  for (const [re, emoji] of EMOJI_RULES) {
    if (re.test(hay)) return emoji;
  }
  return "📍";
}

function showPopup(
  map: maplibregl.Map,
  place: Place,
  lngLat: maplibregl.LngLat,
  popupRef: React.MutableRefObject<maplibregl.Popup | null>,
) {
  const gmaps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${place.name || ""} ${place.address || ""} ${place.lat},${place.lon}`.trim(),
  )}`;
  const osm = `https://www.openstreetmap.org/?mlat=${place.lat}&mlon=${place.lon}#map=17/${place.lat}/${place.lon}`;

  const rows: { icon: string; label: string; href: string }[] = [];
  if (place.address) rows.push({ icon: "📍", label: place.address, href: gmaps });
  for (const ph of place.phones || []) rows.push({ icon: "📞", label: ph, href: `tel:${ph}` });
  for (const em of place.emails || []) rows.push({ icon: "✉️", label: em, href: `mailto:${em}` });
  for (const w of place.websites || []) rows.push({ icon: "🌐", label: w.replace(/^https?:\/\/(www\.)?/, ""), href: w });
  for (const s of place.socials || []) {
    const host = (() => {
      try {
        return new URL(s).hostname.replace(/^www\./, "");
      } catch {
        return "Social";
      }
    })();
    rows.push({ icon: "🔗", label: host, href: s });
  }

  const conf = Math.round(place.confidence * 100);
  const confColor = conf >= 70 ? "#34d399" : conf >= 45 ? "#fbbf24" : "#fb7185";
  const emoji = popupEmoji(place);

  const el = document.createElement("div");
  el.className = "w-[300px] overflow-hidden rounded-xl bg-[#101218] text-[#e6e8ee]";
  el.innerHTML = `
    <!-- Header band -->
    <div class="flex items-center gap-3 border-b border-white/10 px-4 pb-3 pt-4">
      <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/25 to-cyan-500/20 text-2xl">${emoji}</div>
      <div class="min-w-0 flex-1">
        <div class="truncate text-[15px] font-semibold leading-tight text-white">${escapeHtml(place.name || "Unnamed business")}</div>
        ${place.category_label ? `<div class="truncate text-[11px] text-[#8b93a5]">${escapeHtml(place.category_label)}</div>` : ""}
      </div>
      <span class="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold tabular-nums" style="background:${confColor}1f;color:${confColor}">${conf}%</span>
    </div>
    ${place.brand ? `<div class="px-4 pt-2 text-[11px] text-[#8b93a5]">${escapeHtml(place.brand)}</div>` : ""}
    <!-- Contact rows -->
    <div class="px-4 py-3">
      ${rows
        .slice(0, 5)
        .map(
          (r) => `
        <a href="${escapeHtml(r.href)}" target="_blank" rel="noreferrer" class="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-white/5">
          <span class="w-5 shrink-0 text-center text-[13px]">${r.icon}</span>
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-[#c3c9d4] group-hover:text-white">${escapeHtml(r.label)}</span>
        </a>`,
        )
        .join("")}
      ${rows.length === 0 ? `<div class="px-2 py-1 text-[12px] text-[#6b7280]">No contact details in the open data.</div>` : ""}
    </div>
    <!-- Map links -->
    <div class="grid grid-cols-2 gap-2 border-t border-white/10 px-4 py-3">
      <a href="${escapeHtml(gmaps)}" target="_blank" rel="noreferrer" class="inline-flex items-center justify-center gap-1.5 rounded-lg bg-[#1c6ef3] px-2 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-[#155bd0]">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 20l-5.447-2.724A1 1 0 0 1 3 16.382V5.618a1 1 0 0 1 1.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0 0 21 18.382V7.618a1 1 0 0 0-.553-.894L15 4m0 13V4m0 0L9 7"/></svg>
        Google Maps
      </a>
      <a href="${escapeHtml(osm)}" target="_blank" rel="noreferrer" class="inline-flex items-center justify-center gap-1.5 rounded-lg bg-white/10 px-2 py-2 text-[12px] font-semibold text-white transition-colors hover:bg-white/20">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        OpenStreetMap
      </a>
    </div>
    ${place.sources?.length ? `<div class="border-t border-white/10 px-4 py-2 text-[10px] text-[#5b6472]">source: ${escapeHtml(place.sources.join(", "))}</div>` : ""}
  `;

  popupRef.current?.remove();
  popupRef.current = new maplibregl.Popup({ closeButton: true, offset: 16, maxWidth: "320px", className: "blueocean-popup" })
    .setLngLat(lngLat)
    .setDOMContent(el)
    .addTo(map);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
