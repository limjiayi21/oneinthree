/** Map existing strategy labels onto facial cues, without changing the stance. */
import type { WomanStrategy } from '../../shared/types';

export type Address = 'silence' | 'firm' | 'polite' | 'excuse' | 'police' | 'help' | 'hostile' | 'plead' | 'engage' | 'film' | 'unclear';

const FACE_CUE: Record<WomanStrategy, Address> = {
  ignore: 'silence',
  polite_deflect: 'polite',
  firm_boundary: 'firm',
  hostile: 'hostile',
  excuse: 'excuse',
  threaten_attention: 'police',
  seek_help: 'help',
  engage: 'engage',
  plead: 'plead',
  unclear: 'unclear',
};

export function addressOf(strategy: WomanStrategy, _text: string): Address {
  return FACE_CUE[strategy];
}
