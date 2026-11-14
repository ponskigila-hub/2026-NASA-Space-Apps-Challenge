import { useEffect, useRef } from 'react';
import * as THREE from 'three';

const MOON_TEXTURE = `${import.meta.env.BASE_URL}moon-texture.jpg`;

export default function Moon() {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      return;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 30);
    camera.position.z = 5.05;
    const sphere = new THREE.SphereGeometry(1.39, 72, 48);
    const material = new THREE.MeshStandardMaterial({ roughness: 1 });
    const globe = new THREE.Mesh(sphere, material);
    globe.rotation.set(0.04, 1.52, -0.12);
    scene.add(globe, new THREE.AmbientLight(0xcbc1e9, 0.29));
    const light = new THREE.DirectionalLight(0xf4edff, 2.9);
    light.position.set(-3.3, 1.75, 3.1);
    scene.add(light);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    let alive = true;
    let ready = false;
    let frame = 0;
    let last = 0;
    const draw = () => renderer.render(scene, camera);
    const tick = (time: number) => {
      if (last) globe.rotation.y += Math.min(time - last, 64) * 0.00017;
      last = time;
      draw();
      frame = requestAnimationFrame(tick);
    };
    const updateMotion = () => {
      cancelAnimationFrame(frame);
      last = 0;
      if (!ready) return;
      draw();
      if (!motion.matches && !document.hidden) frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(() => {
      renderer.setSize(host.clientWidth, host.clientHeight, false);
      camera.aspect = host.clientWidth / Math.max(1, host.clientHeight);
      camera.updateProjectionMatrix();
      if (ready) draw();
    });
    resize.observe(host);
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateMotion);

    const texture = new THREE.TextureLoader().load(MOON_TEXTURE, loaded => {
      if (!alive) { loaded.dispose(); return; }
      loaded.colorSpace = THREE.SRGBColorSpace;
      material.map = loaded;
      material.needsUpdate = true;
      ready = true;
      host.append(renderer.domElement);
      host.dataset.ready = 'true';
      updateMotion();
    });

    return () => {
      alive = false;
      delete host.dataset.ready;
      cancelAnimationFrame(frame);
      resize.disconnect();
      motion.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateMotion);
      sphere.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={container} className="moon-scene" aria-hidden="true" />;
}
