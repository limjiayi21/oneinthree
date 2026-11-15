/**
 * A QR code for pairing the phone: scanning it opens the phone page with the code filled in.
 */
import { renderSVG } from 'uqr';

/** The page the phone opens to pair with this game. */
export function phonePairUrl(origin: string, code: string): string {
  return `${origin}/phone.html?code=${encodeURIComponent(code)}`;
}

/** Black modules on white with a 2-module quiet zone, so cameras read it on the dark intro. */
export function qrSvg(text: string): string {
  return renderSVG(text, { border: 2, pixelSize: 1, whiteColor: '#ffffff', blackColor: '#000000' });
}
