/**
 * A short in-character reaction played the moment a turn is sent, so the
 * street is not silent while the real line is still being written.
 * These are synthesized once and replayed. They are not words.
 */
export type FillerKind = 'huh' | 'scoff' | 'sigh';

export function fillerKind(stance: string | undefined): FillerKind {
  if (stance === 'hostile' || stance === 'intimidate' || stance === 'escalate') return 'scoff';
  if (stance === 'back_off' || stance === 'guilt' || stance === 'gone') return 'sigh';
  return 'huh';
}

/** Mono samples at `sampleRate`. Huh is a short voiced fall, scoff a burst, sigh a longer breath. */
export function fillerSamples(kind: FillerKind, sampleRate = 44100): Float32Array {
  const seconds = kind === 'sigh' ? 0.48 : kind === 'scoff' ? 0.22 : 0.18;
  const n = Math.floor(sampleRate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const u = i / n;
    if (kind === 'huh') {
      const f = 150 - 70 * u;
      const env = Math.sin(Math.PI * u) * (u < 0.15 ? u / 0.15 : 1);
      out[i] = Math.sin(2 * Math.PI * f * t) * 0.35 * env;
    } else if (kind === 'scoff') {
      const noise = Math.sin(i * 12.7) * Math.sin(i * 0.37);
      const env = u < 0.2 ? u / 0.2 : Math.exp(-6 * (u - 0.2));
      const blip = u < 0.35 ? Math.sin(2 * Math.PI * 180 * t) * (1 - u) * 0.2 : 0;
      out[i] = (noise * 0.28 + blip) * env;
    } else {
      const noise = Math.sin(i * 1.7) * Math.sin(i * 0.13);
      const env = Math.sin(Math.PI * u) * Math.exp(-1.4 * u);
      const voice = Math.sin(2 * Math.PI * (120 - 40 * u) * t) * 0.12 * (1 - u);
      out[i] = noise * 0.22 * env + voice;
    }
  }
  return out;
}
