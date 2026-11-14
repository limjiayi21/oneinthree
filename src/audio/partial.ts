/**
 * Live partial captions while the microphone is open.
 * Uses the browser speech recogniser when it exists. The real transcript
 * still comes from the server; this only fills the silence before that.
 */

interface PartialResult {
  isFinal: boolean;
  0: { transcript: string };
}

interface PartialEvent {
  resultIndex: number;
  results: ArrayLike<PartialResult>;
}

interface Recogniser {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((ev: PartialEvent) => void) | null;
  onerror: (() => void) | null;
  start(): void;
  abort(): void;
}

type RecogniserCtor = new () => Recogniser;

function ctor(): RecogniserCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecogniserCtor; webkitSpeechRecognition?: RecogniserCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Starts listening for interim text. stop() is safe to call twice. */
export function openPartialCaption(onText: (text: string) => void): { stop(): void } {
  const Ctor = ctor();
  if (!Ctor) return { stop() {} };
  let rec: Recogniser;
  try {
    rec = new Ctor();
  } catch {
    return { stop() {} };
  }
  rec.lang = 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  rec.onerror = () => {};
  rec.onresult = (ev) => {
    let text = '';
    for (let i = 0; i < ev.results.length; i++) text += ev.results[i][0].transcript;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean) onText(clean.slice(0, 160));
  };
  try {
    rec.start();
  } catch {
    return { stop() {} };
  }
  let stopped = false;
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try {
        rec.abort();
      } catch {
        /* already ended */
      }
    },
  };
}
