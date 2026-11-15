import { describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import { phonePairUrl, qrSvg } from './qr';

describe('phone pairing QR', () => {
  it('builds the pairing link from the page origin and the code', () => {
    expect(phonePairUrl('https://oneinthree.example.workers.dev', 'K7QD')).toBe('https://oneinthree.example.workers.dev/phone.html?code=K7QD');
  });

  it('encodes exactly that link', () => {
    const url = phonePairUrl('https://oneinthree.example.workers.dev', 'K7QD');
    // The same payload uqr renders: a scanner reads back what the phone page expects.
    expect(encode(url).data.length).toBeGreaterThan(0);
    const svg = qrSvg(url);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox');
  });

  it('is dark on light, with a quiet border, so phone cameras read it on a dark page', () => {
    const svg = qrSvg('https://example.com/phone.html?code=AB12');
    expect(svg).toContain('#ffffff');
    expect(svg).toContain('#000000');
  });
});
