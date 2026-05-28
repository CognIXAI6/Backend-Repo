import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeepgramClient } from '@deepgram/sdk';
import * as ffmpeg from 'fluent-ffmpeg';
import * as ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

export interface VideoAnalysisResult {
  transcript: string;
  duration: number;
  wordCount: number;
  filename: string;
}

const SUPPORTED_VIDEO_MIMES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/webm',
  'video/x-matroska',
  'video/mpeg',
  'video/ogg',
]);

const MAX_DURATION_SECONDS = 60 * 60; // 1 hour hard cap

@Injectable()
export class VideoAnalysisService {
  private readonly logger = new Logger(VideoAnalysisService.name);

  constructor(private readonly config: ConfigService) {
    ffmpeg.setFfmpegPath(ffmpegInstaller.path);
    this.logger.log(`ffmpeg path: ${ffmpegInstaller.path}`);
  }

  async analyseVideo(file: Express.Multer.File): Promise<VideoAnalysisResult> {
    if (!SUPPORTED_VIDEO_MIMES.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported file type: ${file.mimetype}. Accepted: MP4, MOV, AVI, WebM, MKV.`,
      );
    }

    this.logger.log(
      `Analysing video: ${file.originalname} (${(file.size / 1024 / 1024).toFixed(1)} MB)`,
    );

    const audioBuffer = await this.extractAudio(file.buffer, file.originalname);
    const { transcript, duration } = await this.transcribeAudio(audioBuffer);

    const wordCount = transcript.split(/\s+/).filter(Boolean).length;

    this.logger.log(
      `Video analysis complete: ${wordCount} words, ${Math.round(duration)}s duration`,
    );

    return {
      transcript,
      duration,
      wordCount,
      filename: file.originalname,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private extractAudio(videoBuffer: Buffer, originalname: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const tmpDir = os.tmpdir();
      const safeName = originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const inputPath = path.join(tmpDir, `vx-in-${Date.now()}-${safeName}`);
      const outputPath = path.join(tmpDir, `vx-out-${Date.now()}.wav`);

      const cleanup = () => {
        for (const p of [inputPath, outputPath]) {
          try { fs.unlinkSync(p); } catch {}
        }
      };

      try {
        fs.writeFileSync(inputPath, videoBuffer);
      } catch (err) {
        return reject(new BadRequestException('Could not write temporary file for processing.'));
      }

      ffmpeg(inputPath)
        .noVideo()
        .audioChannels(1)
        .audioFrequency(16000)
        .audioCodec('pcm_s16le')
        .format('wav')
        .on('end', () => {
          try {
            const audio = fs.readFileSync(outputPath);
            cleanup();
            resolve(audio);
          } catch (err) {
            cleanup();
            reject(new BadRequestException('Could not read extracted audio file.'));
          }
        })
        .on('error', (err: Error) => {
          cleanup();
          this.logger.error(`ffmpeg error: ${err.message}`);
          reject(new BadRequestException(`Audio extraction failed: ${err.message}`));
        })
        .save(outputPath);
    });
  }

  private async transcribeAudio(
    audioBuffer: Buffer,
  ): Promise<{ transcript: string; duration: number }> {
    const apiKey = this.config.get<string>('voice.deepgramApiKey');
    if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not configured');

    const deepgram = new DeepgramClient({ apiKey });

    // SDK v5: transcribeFile returns HttpResponsePromise<T> which extends Promise<T>
    // Awaiting resolves to the typed MediaTranscribeResponse (ListenV1Response).
    const result = await deepgram.listen.v1.media.transcribeFile(
      audioBuffer,
      {
        model: 'nova-2',
        smart_format: true,
        diarize: false,
        punctuate: true,
        language: 'en',
      },
    ) as any;

    if ((result as any)?.err_code) {
      const msg = (result as any)?.err_msg ?? 'Transcription failed';
      this.logger.error(`Deepgram transcription error: ${msg}`);
      throw new BadRequestException(`Transcription failed: ${msg}`);
    }

    const transcript: string =
      (result as any)?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    const duration: number = (result as any)?.metadata?.duration ?? 0;

    if (!transcript.trim()) {
      throw new BadRequestException(
        'No speech detected in the video. Ensure the video has clear audio.',
      );
    }

    if (duration > MAX_DURATION_SECONDS) {
      throw new BadRequestException(
        `Video exceeds the 1-hour limit (detected ${Math.round(duration / 60)} minutes).`,
      );
    }

    return { transcript, duration };
  }
}
