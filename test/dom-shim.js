/*
 * Just enough of a browser to let web/js/app/atlas.js load in Node.
 *
 * atlas.js is the map screen: it wires up Leaflet and the DOM at import
 * time (event listeners, etc.), which normally means it can only run in a
 * browser. But most of what it exports for testing — offsetTransitCoords,
 * snapToStations — is plain geometry that never touches either. This shim
 * exists only to get past module load; none of it needs to behave like a
 * real DOM or a real Leaflet, it just needs to not throw.
 */

function chainable() {
  const obj = {};
  return new Proxy(obj, { get: () => () => obj, apply: () => obj });
}

global.window = { addEventListener() {}, __map: null };
global.document = {
  addEventListener() {},
  getElementById() { return chainable(); },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement() { return chainable(); },
};

global.L = {
  map: chainable, latLng: (a, b) => ({ lat: a, lng: b }),
  latLngBounds: chainable, divIcon: chainable, marker: chainable,
  polyline: chainable, polygon: chainable, layerGroup: chainable,
  tileLayer: chainable, control: { layers: chainable },
  DomEvent: { stopPropagation() {} },
  Draw: {
    Event: { CREATED: 'draw:created' },
    Marker: function Marker() { return chainable(); },
    Polyline: function Polyline() { return chainable(); },
    Polygon: function Polygon() { return chainable(); },
  },
};
