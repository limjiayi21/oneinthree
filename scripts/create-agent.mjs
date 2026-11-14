#!/usr/bin/env node
/**
 * Create the live-voice agent on the ElevenLabs account.
 *
 *   npm run agent:create
 *
 * Reads ELEVENLABS_API_KEY from the environment or .dev.vars, prints the
 * agent id, and never prints the key. Put that id in .dev.vars as
 * ELEVENLABS_AGENT_ID. Re-running creates another agent; delete the old one
 * in the dashboard if you do not want both.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LLM, buildAgentDraft } from '../worker/agent.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const file = resolve(root, '.dev.vars');
  if (!existsSync(file)) return '';
  const m = readFileSync(file, 'utf8').match(/^ELEVENLABS_API_KEY=(.*)$/m);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
}

const llm = (process.env.ELEVENLABS_AGENT_LLM || AGENT_LLM).trim();
const draft = buildAgentDraft(llm);
const key = readKey();
if (!key) {
  console.error('No ELEVENLABS_API_KEY in the environment or .dev.vars.');
  console.error('The agent that would be created uses llm=%s, voice=%s, tts=%s, expressive_mode=true.', llm, draft.conversation_config.tts.voice_id, draft.conversation_config.tts.model_id);
  process.exit(1);
}

const res = await fetch('https://api.elevenlabs.io/v1/convai/agents/create', {
  method: 'POST',
  headers: { 'xi-api-key': key, 'content-type': 'application/json' },
  body: JSON.stringify(draft),
});
const text = await res.text();
if (!res.ok) {
  console.error(`Create agent failed: HTTP ${res.status}`);
  console.error(text.slice(0, 500));
  process.exit(1);
}
const body = JSON.parse(text);
const id = body.agent_id || body.agentId;
if (!id) {
  console.error('ElevenLabs did not return an agent_id.');
  console.error(text.slice(0, 500));
  process.exit(1);
}
console.log(`Created agent ${id}`);
console.log('Add this line to .dev.vars (gitignored):');
console.log(`ELEVENLABS_AGENT_ID=${id}`);
console.log('Then restart npm run dev and press L, or open ?agent=1');
