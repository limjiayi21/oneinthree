/**
 * Shared limits for a push-to-talk clip. The browser and the Worker both
 * enforce these so a public demo cannot upload a long recording.
 *
 * 8 seconds at 48 kbps is about 48 KB. 192 KB leaves headroom for Safari's
 * AAC clips and container overhead, and is far below the old 4 MB cap.
 */

export const MAX_CLIP_MS = 8000;
export const MAX_CLIP_BYTES = 192 * 1024;

export interface AudioFileType {
  /** MIME type with no parameters. `audio/webm`, never `audio/webm;codecs=opus`. */
  type: string;
  ext: string;
  filename: string;
}

/**
 * MediaRecorder reports `audio/webm;codecs=opus` (and Safari `audio/mp4;codecs=mp4a.40.2`).
 * A multipart part whose Content-Type contains an unquoted semicolon is not a
 * safe file: some parsers, including gateways in front of speech-to-text,
 * split the header on `;` and then see a truncated or empty body. The bytes
 * are still webm/opus. Strip the parameters and name the file to match.
 */
export function baseAudioType(mime: string, name = ''): AudioFileType {
  const raw = (mime || '').split(';')[0].trim().toLowerCase();
  const fromName = name.toLowerCase();
  let ext = 'webm';
  let type = 'audio/webm';
  if (raw.includes('mp4') || raw.includes('m4a') || raw.includes('aac') || fromName.endsWith('.mp4') || fromName.endsWith('.m4a')) {
    ext = raw.includes('m4a') || fromName.endsWith('.m4a') ? 'm4a' : 'mp4';
    type = ext === 'm4a' ? 'audio/m4a' : 'audio/mp4';
  } else if (raw.includes('ogg') || raw.includes('opus') || fromName.endsWith('.ogg') || fromName.endsWith('.opus')) {
    ext = 'ogg';
    type = 'audio/ogg';
  } else if (raw.includes('mpeg') || raw.includes('mp3') || fromName.endsWith('.mp3')) {
    ext = 'mp3';
    type = 'audio/mpeg';
  } else if (raw.includes('wav') || fromName.endsWith('.wav')) {
    ext = 'wav';
    type = 'audio/wav';
  } else if (raw.includes('webm') || fromName.endsWith('.webm')) {
    ext = 'webm';
    type = 'audio/webm';
  }
  return { type, ext, filename: `clip.${ext}` };
}
