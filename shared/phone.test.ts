/**
 * Tests for shared/phone.ts: message parsing, the role allow-list and pairing code checks.
 */
import { describe, expect, it } from 'vitest';
import { allowedFrom, isPhoneCode, parsePhoneMessage } from './phone';

describe('parsePhoneMessage', () => {
  it('parses every valid message type', () => {
    expect(parsePhoneMessage('{"t":"hello"}')).toEqual({ t: 'hello' });
    expect(parsePhoneMessage('{"t":"step","at":12.5}')).toEqual({ t: 'step', at: 12.5 });
    expect(parsePhoneMessage('{"t":"step","at":1,"peak":3.5}')).toEqual({ t: 'step', at: 1, peak: 3.5 });
    expect(parsePhoneMessage('{"t":"step","at":1,"peak":"x"}')).toEqual({ t: 'step', at: 1 }); // bad strength is dropped, the step kept
    expect(parsePhoneMessage('{"t":"film","on":true}')).toEqual({ t: 'film', on: true });
    expect(parsePhoneMessage('{"t":"peer","connected":false}')).toEqual({ t: 'peer', connected: false });
    expect(parsePhoneMessage('{"t":"status","filming":true}')).toEqual({ t: 'status', filming: true });
  });

  it('returns null for malformed JSON, wrong field types, unknown types, non-strings and oversize strings', () => {
    const bad: unknown[] = [
      '{not json',
      '{"t":"step","at":"12"}',
      '{"t":"step"}',
      '{"t":"film","on":1}',
      '{"t":"peer","connected":"yes"}',
      '{"t":"status","filming":null}',
      '{"t":"jump"}',
      '{}',
      '[]',
      'null',
      42,
      null,
      undefined,
      { t: 'hello' },
      '{"t":"hello","pad":"' + 'a'.repeat(257 - '{"t":"hello","pad":"'.length - 2) + '"}',
    ];
    for (const raw of bad) expect(parsePhoneMessage(raw)).toBeNull();
  });
});

describe('allowedFrom', () => {
  it('lets the phone send hello, step and film only, and the game send status only', () => {
    expect(allowedFrom('phone', { t: 'hello' })).toBe(true);
    expect(allowedFrom('phone', { t: 'step', at: 1 })).toBe(true);
    expect(allowedFrom('phone', { t: 'film', on: false })).toBe(true);
    expect(allowedFrom('phone', { t: 'status', filming: true })).toBe(false);
    expect(allowedFrom('phone', { t: 'peer', connected: true })).toBe(false);

    expect(allowedFrom('game', { t: 'status', filming: true })).toBe(true);
    expect(allowedFrom('game', { t: 'step', at: 1 })).toBe(false);
    expect(allowedFrom('game', { t: 'film', on: true })).toBe(false);
  });
});

describe('isPhoneCode', () => {
  it('accepts 6 characters from the code alphabet', () => {
    expect(isPhoneCode('ABCDEF')).toBe(true);
    expect(isPhoneCode('2345KM')).toBe(true);
  });

  it('rejects wrong length, lowercase and look-alike characters', () => {
    expect(isPhoneCode('ABCDE')).toBe(false);
    expect(isPhoneCode('ABCDEFG')).toBe(false);
    expect(isPhoneCode('abcdef')).toBe(false);
    expect(isPhoneCode('ABCDEO')).toBe(false);
    expect(isPhoneCode('ABCDE0')).toBe(false);
    expect(isPhoneCode('ABCDEI')).toBe(false);
    expect(isPhoneCode('ABCDE1')).toBe(false);
  });
});
