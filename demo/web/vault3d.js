// SPDX-License-Identifier: Apache-2.0
// The vault in 3D (three.js, bundled locally so the stage works offline). Presentation only.
// It draws the vault and its rings; scene.js keeps drawing sparks and labels on top. If WebGL is
// not available, nothing changes: scene.js keeps drawing its own 2D vault.
import * as THREE from "./vendor/three.module.js";

const flat = document.getElementById("vault-scene");
if (flat) {
  try {
    const host = flat.parentElement;
    const gl = document.createElement("canvas");
    gl.id = "vault-3d";
    gl.setAttribute("aria-hidden", "true");
    host.insertBefore(gl, flat);
    const renderer = new THREE.WebGLRenderer({ canvas: gl, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 2, 0.1, 100);
    camera.position.set(0, 0.4, 7.2);

    const dark = () => document.body.classList.contains("dark");
    const TEAL = new THREE.Color(0x3cc8dd), TEAL_L = new THREE.Color(0x0b7f91), RED = new THREE.Color(0xff6e5a);

    const vault = new THREE.Group();
    scene.add(vault);
    // Core: a faceted crystal with a glowing edge cage.
    const coreGeo = new THREE.IcosahedronGeometry(0.85, 0);
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x123049, metalness: 0.5, roughness: 0.2, emissive: 0x0e5566, emissiveIntensity: 1.1, flatShading: true });
    const core = new THREE.Mesh(coreGeo, coreMat);
    vault.add(core);
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(coreGeo), new THREE.LineBasicMaterial({ color: TEAL, transparent: true, opacity: 0.95 }));
    vault.add(edges);
    // Shield: a hexagonal frame in front of the core.
    const hexPts = [];
    for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + Math.PI / 6; hexPts.push(new THREE.Vector3(Math.cos(a) * 1.25, Math.sin(a) * 1.25, 0)); }
    const hex = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(hexPts), new THREE.LineBasicMaterial({ color: TEAL, transparent: true, opacity: 0.9 }));
    vault.add(hex);
    // Orbits.
    const rings = [1.7, 2.15, 2.6].map((r, i) => {
      const m = new THREE.Mesh(new THREE.TorusGeometry(r, i ? 0.006 : 0.012, 8, 160), new THREE.MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.85 - i * 0.2 }));
      m.rotation.x = Math.PI / 2 + (i - 1) * 0.35;
      m.rotation.y = i * 0.6;
      vault.add(m);
      return m;
    });
    // Starfield of approvals drifting in.
    const N = 700, pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) { pos[i * 3] = -9 + Math.random() * 9; pos[i * 3 + 1] = (Math.random() - 0.5) * 5; pos[i * 3 + 2] = (Math.random() - 0.5) * 3; }
    const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: TEAL, size: 0.05, transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    scene.add(dust);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.PointLight(0x5ed6e8, 18, 20); key.position.set(2.5, 2, 4); scene.add(key);
    const hit = new THREE.PointLight(0xff6e5a, 0, 12); hit.position.set(-2, 0, 2.5); scene.add(hit);

    let red = 0, teal = 0;
    window.vault3d = {
      refuse() { red = 1; },
      pay() { teal = 1; },
    };
    window.__vault3d = true;

    const fit = () => {
      const r = flat.getBoundingClientRect();
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      gl.style.cssText = `position:absolute;left:${flat.offsetLeft}px;top:${flat.offsetTop}px;width:${r.width}px;height:${r.height}px;pointer-events:none;border-radius:12px`;
      renderer.setSize(r.width, r.height, false);
      camera.aspect = r.width / Math.max(1, r.height);
      // Keep the vault in the right half, where scene.js aims its sparks.
      camera.setViewOffset(r.width, r.height, -r.width * 0.1, 0, r.width, r.height);
      camera.updateProjectionMatrix();
    };
    new ResizeObserver(fit).observe(flat);
    fit();

    const clock = new THREE.Clock();
    const loop = () => {
      const t = clock.getElapsedTime();
      const base = dark() ? TEAL : TEAL_L;
      vault.rotation.y = t * 0.35;
      core.rotation.x = t * 0.2;
      rings.forEach((m, i) => { m.rotation.z = t * (0.15 + i * 0.07) * (i % 2 ? -1 : 1); });
      const c = base.clone().lerp(RED, red * 0.85).lerp(new THREE.Color(0x9ff3ff), teal * 0.6);
      edges.material.color.copy(c); hex.material.color.copy(c);
      rings.forEach((m) => m.material.color.copy(c));
      coreMat.emissive.copy(new THREE.Color(0x0e5566).lerp(RED, red * 0.5).lerp(TEAL, teal * 0.6));
      hit.intensity = red * 40; key.intensity = 18 + teal * 30;
      vault.scale.setScalar(1 + red * 0.08 * Math.sin(t * 40) + teal * 0.06);
      red *= 0.96; teal *= 0.96;
      const p = dustGeo.attributes.position.array;
      for (let i = 0; i < N; i++) { p[i * 3] += 0.012; if (p[i * 3] > -0.6) { p[i * 3] = -9; } }
      dustGeo.attributes.position.needsUpdate = true;
      dust.material.color.copy(base);
      renderer.render(scene, camera);
      requestAnimationFrame(loop);
    };
    loop();
  } catch (e) {
    window.__vault3d = false;
    document.getElementById("vault-3d")?.remove();
  }
}
