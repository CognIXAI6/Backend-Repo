/**
 * Wraps raw linear16 (signed 16-bit PCM, no container) audio bytes in a
 * minimal 44-byte WAV header. Native mobile clients stream audio to the
 * backend this way — no file format at all, just a continuous sample
 * stream — which Deepgram accepts fine (it's told the encoding explicitly
 * over the connection) but anything that auto-detects format from file
 * content, like Cloudinary's upload validation, cannot: raw PCM has no
 * magic bytes identifying it as any kind of file, so it's rejected outright.
 * Wrapping it here produces a genuinely valid, playable .wav buffer.
 */
export function wrapPcm16AsWav(pcmData: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // Subchunk1Size — 16 for PCM
  header.writeUInt16LE(1, 20); // AudioFormat — 1 = PCM (uncompressed)
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}
