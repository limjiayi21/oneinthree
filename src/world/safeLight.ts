/**
 * A place of safety, marked in the street: a warm pool of light on the ground with a faint beam above it.
 * It is dim until it matters, then pulses gently so it can be seen from down the street.
 */
import * as THREE from 'three';

export interface SafeLight {
  /** 0 = barely there, 1 = fully lit and pulsing. Eased, so changes fade in. */
  setStrength(target: number): void;
  update(dt: number): void;
  dispose(): void;
}

/** The visible circle's radius (m). */
export const SAFE_LIGHT_RADIUS = 0.75;
/** Stepping within this distance of the centre counts as stepping into it: a little more than it looks. */
export const SAFE_LIGHT_TRIGGER = 1.0;

export function createSafeLight(scene: THREE.Scene, at: THREE.Vector3, colour = 0xffc977): SafeLight {
  const group = new THREE.Group();
  group.position.set(at.x, 0, at.z);

  const pool = new THREE.Mesh(
    new THREE.CircleGeometry(SAFE_LIGHT_RADIUS, 48),
    new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  pool.rotation.x = -Math.PI / 2;
  pool.position.y = 0.03;

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(SAFE_LIGHT_RADIUS * 0.92, SAFE_LIGHT_RADIUS, 64),
    new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.035;

  // The beam: an open cylinder that fades out towards the top.
  const beamGeo = new THREE.CylinderGeometry(SAFE_LIGHT_RADIUS * 0.85, SAFE_LIGHT_RADIUS, 3.2, 40, 1, true);
  const alpha = new Float32Array(beamGeo.attributes.position!.count);
  for (let i = 0; i < alpha.length; i++) alpha[i] = beamGeo.attributes.position!.getY(i) < 0 ? 1 : 0;
  beamGeo.setAttribute('alpha', new THREE.BufferAttribute(alpha, 1));
  const beamMat = new THREE.ShaderMaterial({
    uniforms: { colour: { value: new THREE.Color(colour) }, strength: { value: 0 } },
    vertexShader: 'attribute float alpha; varying float vA; void main() { vA = alpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 colour; uniform float strength; varying float vA; void main() { gl_FragColor = vec4(colour, vA * vA * strength); }',
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.position.y = 1.6;

  group.add(pool, ring, beam);
  group.visible = false; // nothing there until it matters
  scene.add(group);

  let strength = 0;
  let target = 0;
  let t = 0;
  return {
    setStrength(v) {
      target = Math.max(0, Math.min(1, v));
    },
    update(dt) {
      t += dt;
      strength += (target - strength) * (1 - Math.exp(-6 * dt));
      group.visible = strength > 0.01;
      const pulse = 0.82 + 0.18 * Math.sin(t * 2.6);
      const s = strength * pulse;
      (pool.material as THREE.MeshBasicMaterial).opacity = 0.5 * s;
      (ring.material as THREE.MeshBasicMaterial).opacity = 0.85 * s;
      beamMat.uniforms.strength!.value = 0.4 * s;
    },
    dispose() {
      scene.remove(group);
      pool.geometry.dispose();
      (pool.material as THREE.Material).dispose();
      ring.geometry.dispose();
      (ring.material as THREE.Material).dispose();
      beamGeo.dispose();
      beamMat.dispose();
    },
  };
}
