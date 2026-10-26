// 3D taxi layer drawn inside the MapLibre WebGL context. Vehicles are
// positioned in Mercator space, so they stay locked to streets while the map
// pitches, rotates and zooms. Three.js does the drawing.
import * as THREE from 'three';
import { MercatorCoordinate } from 'maplibre-gl';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const STATUS_COLOR = {
  free: 0x15803d,
  on_trip: 0xf59e0b,
  offline: 0x94a3b8,
};
const ALERT_COLOR = 0xdc2626;
const TRAIL_POINTS = 40;
const TAXI_LENGTH = 7.2; // metres, before the zoom scale-up in render()

export function createFleetLayer({ origin }) {
  const originMerc = MercatorCoordinate.fromLngLat(origin, 0);
  const meterScale = originMerc.meterInMercatorCoordinateUnits();
  const items = new Map(); // id -> { group, body, taxi, pillar, ring, trail, trailGeo }
  const trailPts = new Map(); // id -> [{x,y}] in model meters
  let map = null;
  let renderer = null;
  let camera = null;
  let scene = null;
  let root = null;
  let lastZoom = null;
  let taxiModel = null; // shared voxel taxi; items hold clones of it

  // Mercator lng/lat -> model space meters (y flipped, matching the matrix below).
  function toModel(lng, lat) {
    const m = MercatorCoordinate.fromLngLat({ lng, lat }, 0);
    return { x: (m.x - originMerc.x) / meterScale, y: -(m.y - originMerc.y) / meterScale };
  }

  const layer = {
    id: 'taxi-3d',
    type: 'custom',
    renderingMode: '3d',

    onAdd(m, gl) {
      map = m;
      renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      camera = new THREE.Camera();
      scene = new THREE.Scene();
      root = new THREE.Group();
      scene.add(root);
      scene.add(new THREE.AmbientLight(0xffffff, 1.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.6);
      sun.position.set(-40, 80, 120);
      scene.add(sun);
      // Voxel taxi built from the pixel-art views (cad/voxel_taxi.py). The GLB is
      // Y-up, nose along +X, with per-face vertex colours and no material.
      new GLTFLoader().load('/taxi-voxel.glb', (gltf) => {
        if (!root) return;
        const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
        gltf.scene.traverse((o) => {
          if (o.isMesh) o.material = material;
        });
        const box = new THREE.Box3().setFromObject(gltf.scene);
        gltf.scene.scale.setScalar(TAXI_LENGTH / (box.max.x - box.min.x));
        gltf.scene.rotation.set(Math.PI / 2, 0, 0); // Y-up -> Z-up
        taxiModel = new THREE.Group();
        taxiModel.rotation.z = Math.PI / 2; // nose +X -> +Y (north at heading 0)
        taxiModel.add(gltf.scene);
        for (const it of items.values()) addTaxi(it);
        map.triggerRepaint();
      });
    },

    // maplibre-gl v6 passes an options object. mainMatrix maps Mercator units to clip space,
    // which is what the translate-and-scale transform below expects.
    render(gl, options) {
      if (!renderer) return;
      const matrix = options.defaultProjectionData.mainMatrix;
      const z = map.getZoom();
      // Keep vehicles readable: draw bigger when zoomed out, true size when close.
      // At city zoom (~14) a taxi is drawn about 16x its true size.
      const s = Math.min(96, Math.max(1, 2 ** (18 - z)));
      if (lastZoom !== s) {
        lastZoom = s;
        for (const it of items.values()) it.body.scale.setScalar(s);
      }
      const m = new THREE.Matrix4().fromArray(matrix);
      const l = new THREE.Matrix4()
        .makeTranslation(originMerc.x, originMerc.y, originMerc.z)
        .scale(new THREE.Vector3(meterScale, -meterScale, meterScale));
      camera.projectionMatrix = m.multiply(l);
      renderer.resetState();
      renderer.render(scene, camera);
      // No triggerRepaint here: MapLibre repaints on camera moves, and update() asks for one
      // when positions change. Forcing it every frame kept the GPU busy while idle.
    },

    onRemove() {
      for (const it of items.values()) disposeItem(it);
      items.clear();
      renderer?.dispose();
      renderer = null;
      taxiModel?.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose();
      });
      taxiModel = null;
    },
  };

  function makeItem() {
    const group = new THREE.Group();
    // Taxi model, long axis along +y (north at heading 0); added once the GLB loads.
    const body = new THREE.Group();
    body.scale.setScalar(1);
    group.add(body);

    // Status pillar: a 3D beacon that reads well when the map is pitched.
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 6, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    pillar.rotation.x = Math.PI / 2;
    pillar.position.z = 3;
    body.add(pillar); // under body so it scales with the taxi

    // Ground ring, shown only when an alert is active.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(3.2, 4.2, 32),
      new THREE.MeshBasicMaterial({ color: ALERT_COLOR, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 0.05;
    ring.visible = false;
    body.add(ring);

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_POINTS * 3), 3));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0x14532d, transparent: true, opacity: 0.6 }));
    root.add(trail);

    root.add(group);
    const it = { group, body, taxi: null, pillar, ring, trail, trailGeo };
    addTaxi(it);
    return it;
  }

  function addTaxi(it) {
    if (!taxiModel || it.taxi) return;
    it.taxi = taxiModel.clone(); // shares geometry and material with taxiModel
    it.body.add(it.taxi);
  }

  function disposeItem(it) {
    if (it.taxi) it.body.remove(it.taxi); // shared; disposed with taxiModel
    it.group.traverse((o) => {
      o.geometry?.dispose();
      o.material?.dispose();
    });
    it.trailGeo.dispose();
    it.trail.material.dispose();
    root.remove(it.group, it.trail);
  }

  // Apply a snapshot. Vehicles not in it are removed.
  // Live mode accumulates trails; playback shows positions only.
  function update(vehicles, { playback = false } = {}) {
    if (!root) return;
    const seen = new Set();
    for (const v of vehicles) {
      seen.add(v.id);
      let it = items.get(v.id);
      if (!it) {
        it = makeItem();
        it.body.scale.setScalar(lastZoom ?? 1);
        items.set(v.id, it);
      }
      const p = toModel(v.lng, v.lat);
      it.group.position.set(p.x, p.y, 0);
      it.group.rotation.z = (-v.heading * Math.PI) / 180;
      const hex = STATUS_COLOR[v.status] ?? STATUS_COLOR.free;
      it.pillar.material.color.setHex(hex);
      it.ring.visible = !playback && v.alerts.length > 0;
      if (it.ring.visible) it.ring.material.color.setHex(ALERT_COLOR);

      if (playback) {
        it.trailGeo.setDrawRange(0, 0);
        continue;
      }
      if (!trailPts.has(v.id)) trailPts.set(v.id, []);
      const pts = trailPts.get(v.id);
      const last = pts[pts.length - 1];
      if (!last || last.x !== p.x || last.y !== p.y) {
        pts.push(p);
        if (pts.length > TRAIL_POINTS) pts.shift();
      }
      const arr = it.trailGeo.attributes.position.array;
      pts.forEach((q, i) => {
        arr[i * 3] = q.x;
        arr[i * 3 + 1] = q.y;
        arr[i * 3 + 2] = 0.1;
      });
      it.trailGeo.attributes.position.needsUpdate = true;
      it.trailGeo.setDrawRange(0, pts.length);
      it.trail.material.color.setHex(hex);
    }
    for (const id of [...items.keys()]) {
      if (!seen.has(id)) {
        disposeItem(items.get(id));
        items.delete(id);
        trailPts.delete(id);
      }
    }
    map.triggerRepaint();
  }

  return { layer, update, toModel };
}
