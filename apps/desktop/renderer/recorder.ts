import { useCallback, useRef, useState } from 'react';

/** Minimal 16-bit mono WAV encoder for the microphone. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): string {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);

  const write = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  write(0, 'RIFF');
  view.setUint32(4, 36 + length * 2, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  write(36, 'data');
  view.setUint32(40, length * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk[i] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/** Hold-to-talk microphone capture. */
export function useRecorder() {
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const context = useRef<AudioContext | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const processor = useRef<ScriptProcessorNode | null>(null);
  const chunks = useRef<Float32Array[]>([]);

  const start = useCallback(async () => {
    if (recording) return;
    setError(null);
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(media);
      const node = audioContext.createScriptProcessor(4096, 1, 1);
      chunks.current = [];
      node.onaudioprocess = (event) => {
        chunks.current.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      };
      source.connect(node);
      node.connect(audioContext.destination);
      context.current = audioContext;
      stream.current = media;
      processor.current = node;
      setRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone unavailable');
    }
  }, [recording]);

  const stop = useCallback(async (): Promise<string | null> => {
    if (!recording) return null;
    setRecording(false);
    const audioContext = context.current;
    const media = stream.current;
    const node = processor.current;
    context.current = null;
    stream.current = null;
    processor.current = null;
    try {
      node?.disconnect();
      media?.getTracks().forEach((track) => track.stop());
      await audioContext?.close();
    } catch {
      // The stream may already be torn down.
    }
    const sampleRate = audioContext?.sampleRate ?? 48_000;
    const wav = encodeWav(chunks.current, sampleRate);
    chunks.current = [];
    return wav;
  }, [recording]);

  return { recording, error, start, stop };
}
