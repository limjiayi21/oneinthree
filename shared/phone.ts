/**
 * Phone controller contract: the messages between the phone page (src/phone/),
 * the relay (worker/phoneRelay.ts) and the game (src/net/phoneLink.ts).
 * Written by the orchestrator; see docs/INTERACTIVE_CONTROLS_PLAN.md.
 * No DOM or Worker types here: both tsconfigs include this file.
 */

/** Pairing code alphabet: letters and digits with look-alikes (O/0, I/1/L) removed. */
export const PHONE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const PHONE_CODE_LENGTH = 6;

export type PhoneRole = 'game' | 'phone';

/** `POST /api/phone/pair` response. */
export interface PhonePairResponse {
  code: string;
}

export const phonePairPath = '/api/phone/pair';
export const phoneWsPath = (code: string, role: PhoneRole) =>
  `/api/phone/${encodeURIComponent(code)}/ws?role=${role}`;

/** Sent by the phone. */
export type PhoneToGame =
  | { t: 'hello' }
  | { t: 'step'; at: number } // phone's performance.now() in ms
  | { t: 'film'; on: boolean }; // sets the state, never toggles

/** Sent by the relay to both sides when the other side joins or leaves. */
export type RelayMessage = { t: 'peer'; connected: boolean };

/** Sent by the game so the phone shows the right record button state. */
export type GameToPhone = { t: 'status'; filming: boolean };

export type PhoneMessage = PhoneToGame | RelayMessage | GameToPhone;

export function isPhoneCode(code: string): boolean {
  if (code.length !== PHONE_CODE_LENGTH) return false;
  for (const ch of code) if (!PHONE_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** Parses one WebSocket message. Returns null for anything that is not exactly a known message. */
export function parsePhoneMessage(raw: unknown): PhoneMessage | null {
  if (typeof raw !== 'string' || raw.length > 256) return null;
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  switch (o.t) {
    case 'hello':
      return { t: 'hello' };
    case 'step':
      return typeof o.at === 'number' && Number.isFinite(o.at) ? { t: 'step', at: o.at } : null;
    case 'film':
      return typeof o.on === 'boolean' ? { t: 'film', on: o.on } : null;
    case 'peer':
      return typeof o.connected === 'boolean' ? { t: 'peer', connected: o.connected } : null;
    case 'status':
      return typeof o.filming === 'boolean' ? { t: 'status', filming: o.filming } : null;
    default:
      return null;
  }
}

/** Which messages each role may send through the relay. The relay drops everything else. */
export function allowedFrom(role: PhoneRole, m: PhoneMessage): boolean {
  return role === 'phone' ? m.t === 'hello' || m.t === 'step' || m.t === 'film' : m.t === 'status';
}
