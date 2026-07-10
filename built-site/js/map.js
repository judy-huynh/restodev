/* Map + overlays. Everything rendered here comes from the tenant config:
   basemap style, camera, and the overlay list (which may be empty).

   Layouts that demote the map (Record's collapsed inset) pass { defer: true }:
   nothing touches Mapbox — no basemap tiles, no token use — until init() is
   called on first reveal. Every method is safe to call before then; the
   latest stories are kept and applied once the map exists. */
import { storyColor } from './config.js';

export function createMapController(tenant, { onStoryClick, onMapClick }, { defer = false } = {}) {
  let map = null;
  let started = false;
  let lastStories = [];
  let pinMarker = null;

  const overlayState = {};
  (tenant.overlays?.layers || []).forEach(l => { overlayState[l.id] = !!l.defaultOn; });

  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });

  function init() {
    if (started) return ready;
    started = true;

    mapboxgl.accessToken = tenant.map.mapboxToken;
    map = new mapboxgl.Map({
      container: 'map',
      style: tenant.map.styleUrl,
      center: tenant.map.center,
      zoom: tenant.map.zoom,
      minZoom: tenant.map.minZoom ?? 2,
    });

    map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.addControl(
      new mapboxgl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }),
      'bottom-right'
    );

    // 'load' can be slow (or stall entirely in headless contexts) on some
    // basemap styles; 'idle' also fires once rendering settles. Set up on
    // whichever arrives first.
    let setUp = false;
    const setup = async () => {
      if (setUp) return;
      setUp = true;
      map.addSource('stories', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 's-glow',
        type: 'circle',
        source: 'stories',
        paint: { 'circle-radius': 22, 'circle-opacity': 0.13, 'circle-color': ['get', 'color'] },
      });
      map.addLayer({
        id: 's-dots',
        type: 'circle',
        source: 'stories',
        paint: {
          // floor raised so dots stay legible on wide, low-zoom views (rural WV)
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 6.5, 14, 11],
          'circle-color': ['get', 'color'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': 'white',
          'circle-opacity': 0.95,
        },
      });

      map.on('click', 's-dots', e => onStoryClick?.(e.features[0].properties.storyId));
      map.on('mouseenter', 's-dots', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 's-dots', () => (map.getCanvas().style.cursor = ''));
      map.on('click', e => onMapClick?.(e.lngLat.lat, e.lngLat.lng));

      await loadOverlays();
      applyStories();
      resolveReady();
    };
    map.on('load', setup);
    map.once('idle', setup);
    // Neither event fires until the map first RENDERS — and a canvas that
    // sits below the fold at construction (Story's companion map lives
    // under the hero) may not render until scrolled into view. The style
    // still loads either way, so poll for it as the fallback trigger.
    const poll = setInterval(() => {
      if (setUp) { clearInterval(poll); return; }
      if (map.isStyleLoaded()) { clearInterval(poll); setup(); }
    }, 250);
    return ready;
  }

  if (!defer) init();

  async function loadOverlays() {
    for (const layer of tenant.overlays?.layers || []) {
      try {
        if (layer.type === 'geojson') {
          const res = await fetch(layer.url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          map.addSource(`ov-${layer.id}`, { type: 'geojson', data: await res.json() });
          map.addLayer(
            {
              id: `ov-${layer.id}`,
              type: layer.renderAs === 'circle' ? 'circle' : 'fill',
              source: `ov-${layer.id}`,
              paint: layer.renderAs === 'circle'
                ? {
                    'circle-radius': layer.radius ?? 6,
                    'circle-color': layer.color,
                    'circle-opacity': layer.opacity ?? 0.8,
                    'circle-stroke-width': 1.5,
                    'circle-stroke-color': 'white',
                  }
                : { 'fill-color': layer.color, 'fill-opacity': layer.opacity ?? 0.2 },
              layout: { visibility: overlayState[layer.id] ? 'visible' : 'none' },
            },
            's-glow'
          );
        }
      } catch (e) {
        console.warn(`overlay '${layer.id}' failed to load:`, e);
      }
    }
  }

  function toggleOverlay(id) {
    overlayState[id] = !overlayState[id];
    if (map?.getLayer(`ov-${id}`)) {
      map.setLayoutProperty(`ov-${id}`, 'visibility', overlayState[id] ? 'visible' : 'none');
    }
    return overlayState[id];
  }

  function applyStories() {
    const features = lastStories
      .filter(s => s.lat != null && s.lng != null)
      .map(s => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lng, s.lat] },
        properties: { storyId: s.id, color: storyColor(tenant, s) },
      }));
    map?.getSource('stories')?.setData({ type: 'FeatureCollection', features });
  }

  function setStories(stories) {
    lastStories = stories;
    applyStories();
  }

  function flyTo(lat, lng, zoom = 14) {
    map?.flyTo({ center: [lng, lat], zoom, duration: 700 });
  }

  /* Emphasize one story's dot and dim the rest (null restores everything).
     Used by layouts that sync the map to the page — safe before init. */
  function focusStory(storyId) {
    if (!map?.getLayer('s-dots')) return;
    if (storyId == null) {
      map.setPaintProperty('s-dots', 'circle-opacity', 0.95);
      map.setPaintProperty('s-glow', 'circle-opacity', 0.1);
      return;
    }
    const isFocus = ['==', ['get', 'storyId'], storyId];
    map.setPaintProperty('s-dots', 'circle-opacity', ['case', isFocus, 1, 0.35]);
    map.setPaintProperty('s-glow', 'circle-opacity', ['case', isFocus, 0.3, 0.04]);
  }

  /* A container revealed after init (display toggles) needs a manual resize —
     Mapbox only watches the window. */
  function resize() {
    map?.resize();
  }

  // A single "you are here" marker for the submission flow. Re-dropping moves
  // it rather than stacking; clearPin() removes it when the form closes.
  function dropPin(lat, lng) {
    if (!map) return;
    if (pinMarker) pinMarker.remove();
    pinMarker = new mapboxgl.Marker({ color: tenant.theme.primary }).setLngLat([lng, lat]).addTo(map);
  }
  function clearPin() {
    if (pinMarker) { pinMarker.remove(); pinMarker = null; }
  }

  return {
    get map() { return map; },
    ready, init, resize, toggleOverlay, setStories, flyTo, focusStory, dropPin, clearPin, overlayState,
  };
}
