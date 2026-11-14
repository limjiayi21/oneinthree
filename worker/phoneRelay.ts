/**
 * PhoneRelayDO: one SQLite-backed Durable Object per pairing code.
 *
 * It pairs one phone with one game and forwards messages between them
 * (contract in shared/phone.ts). It stores no player data: only an "issued"
 * flag and the time both sides were last gone. A code expires 10 minutes after
 * its last socket left (or after it was issued, if nobody ever connected); an
 * alarm then wipes the storage and the code answers 404.
 *
 * Uses the WebSocket Hibernation API: sockets are tagged with their role and
 * one socket is kept per role (a new connection replaces the old one).
 * Every incoming message is parsed and checked with parsePhoneMessage and
 * allowedFrom; anything else is dropped silently.
 *
 * Internal request from the Worker: POST /issue -> 200 (claimed) or 409 (code live).
 */
import { DurableObject } from 'cloudflare:workers';
import { allowedFrom, parsePhoneMessage, type PhoneMessage, type PhoneRole } from '../shared/phone';
import type { Env } from './session';

const TTL_MS = 10 * 60 * 1000;
const other = (role: PhoneRole): PhoneRole => (role === 'game' ? 'phone' : 'game');
const peer = (connected: boolean): string => JSON.stringify({ t: 'peer', connected } satisfies PhoneMessage);

export class PhoneRelayDO extends DurableObject<Env> {
  /** True while the code is issued and not expired. */
  private async live(): Promise<boolean> {
    if (!(await this.ctx.storage.get('issued'))) return false;
    if (this.ctx.getWebSockets().length) return true;
    const since = (await this.ctx.storage.get<number>('since')) ?? 0;
    return Date.now() - since < TTL_MS;
  }

  /** Both sides are gone: start the expiry clock. */
  private async idle(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.put('since', now);
    await this.ctx.storage.setAlarm(now + TTL_MS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/issue' && request.method === 'POST') {
      if (await this.live()) return new Response(null, { status: 409 });
      await this.ctx.storage.put('issued', true);
      await this.idle();
      return new Response(null, { status: 200 });
    }

    const role = url.searchParams.get('role');
    if (url.pathname !== '/ws' || (role !== 'game' && role !== 'phone')) return new Response('Not found', { status: 404 });
    if (request.headers.get('upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (!(await this.live())) return new Response('Unknown code', { status: 404 });

    const { 0: client, 1: server } = new WebSocketPair();
    for (const old of this.ctx.getWebSockets(role)) old.close(1000, 'replaced');
    this.ctx.acceptWebSocket(server, [role]);
    const mate = this.ctx.getWebSockets(other(role))[0];
    if (mate) {
      server.send(peer(true));
      mate.send(peer(true));
    } else {
      server.send(peer(false));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const role = this.ctx.getTags(ws)[0] as PhoneRole | undefined;
    if (!role) return;
    const msg = parsePhoneMessage(message);
    if (!msg || !allowedFrom(role, msg)) return;
    const out = JSON.stringify(msg);
    for (const mate of this.ctx.getWebSockets(other(role))) mate.send(out);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.left(ws);
  }

  private async left(ws: WebSocket): Promise<void> {
    const role = this.ctx.getTags(ws)[0] as PhoneRole | undefined;
    if (!role) return;
    // A replaced socket closing is not the side leaving.
    if (this.ctx.getWebSockets(role).some((s) => s !== ws)) return;
    const mates = this.ctx.getWebSockets(other(role));
    for (const mate of mates) mate.send(peer(false));
    if (!mates.length) await this.idle();
  }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length) return;
    const since = (await this.ctx.storage.get<number>('since')) ?? 0;
    if (Date.now() - since >= TTL_MS) await this.ctx.storage.deleteAll();
    else await this.ctx.storage.setAlarm(since + TTL_MS);
  }
}
