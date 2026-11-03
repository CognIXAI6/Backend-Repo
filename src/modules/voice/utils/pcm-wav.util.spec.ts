import { wrapPcm16AsWav } from './pcm-wav.util';

describe('wrapPcm16AsWav', () => {
  it('produces a 44-byte RIFF/WAVE header followed by the untouched PCM data', () => {
    const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const wav = wrapPcm16AsWav(pcm, 16000, 1);

    expect(wav.length).toBe(44 + pcm.length);
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
    expect(wav.toString('ascii', 12, 16)).toBe('fmt ');
    expect(wav.toString('ascii', 36, 40)).toBe('data');
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it('encodes sample rate, channel count, and data size correctly for mono 16kHz', () => {
    const pcm = Buffer.alloc(32000); // 1 second of mono 16kHz 16-bit audio
    const wav = wrapPcm16AsWav(pcm, 16000, 1);

    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF chunk size
    expect(wav.readUInt16LE(20)).toBe(1); // PCM format
    expect(wav.readUInt16LE(22)).toBe(1); // channels
    expect(wav.readUInt32LE(24)).toBe(16000); // sample rate
    expect(wav.readUInt32LE(28)).toBe(32000); // byte rate = rate * channels * 2
    expect(wav.readUInt16LE(32)).toBe(2); // block align = channels * 2
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data subchunk size
  });

  it('scales byte rate and block align correctly for stereo', () => {
    const pcm = Buffer.alloc(100);
    const wav = wrapPcm16AsWav(pcm, 44100, 2);

    expect(wav.readUInt16LE(22)).toBe(2); // channels
    expect(wav.readUInt32LE(28)).toBe(44100 * 2 * 2); // byte rate
    expect(wav.readUInt16LE(32)).toBe(4); // block align
  });
});
