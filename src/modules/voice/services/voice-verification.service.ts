import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';

export interface SpeakerRegistrationResult {
  speakerId: string;
  embeddingId: string;
}

export interface SpeakerVerificationResult {
  verified: boolean;
  similarityScore: number;
  threshold: number;
  speakerId: string;
}

export interface SpeakerIdentificationResult {
  identified: boolean;
  speakerId: string | null;
  speakerName: string | null;
  similarityScore: number;
  threshold: number;
  candidatesChecked: number;
}

@Injectable()
export class VoiceVerificationService {
  private readonly logger = new Logger(VoiceVerificationService.name);
  private readonly baseUrl: string | undefined;

  // ── Circuit breaker state ─────────────────────────────────────────────────
  private failureCount = 0;
  private circuitOpenUntil = 0;
  private readonly FAILURE_THRESHOLD = 5;
  private readonly CIRCUIT_OPEN_MS = 60_000;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('voice.voiceVerificationUrl');
    if (!this.baseUrl) {
      this.logger.warn('VOICE_VERIFICATION_URL not set — voice ID features disabled');
    } else {
      this.logger.log(`VoiceVerificationService ready → ${this.baseUrl}`);
    }
  }

  get isEnabled(): boolean {
    return !!this.baseUrl;
  }

  /**
   * Registers a speaker's voice profile with the external service.
   * Returns the speaker_id and embedding_id to be stored on the user/speaker row.
   */
  async registerSpeaker(
    speakerName: string,
    audioUrl: string,
    speakerId?: string,
  ): Promise<SpeakerRegistrationResult> {
    this.assertEnabled();
    this.assertCircuitClosed();

    const id = speakerId ?? randomUUID();
    const overwrite = !!speakerId;

    const url = new URL(`${this.baseUrl}/registration`);
    if (overwrite) url.searchParams.set('overwrite', 'true');

    try {
      const data = await this.fetchJsonWithTimeout<{
        success: boolean;
        speaker_id: string;
        embedding_id: string;
      }>(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          speaker_id: id,
          speaker_name: speakerName,
          audio_url: audioUrl,
        }),
      });

      if (!data.success) {
        this.logger.error(`Voice registration unsuccessful for speaker: ${speakerName}`);
        throw new Error('Failed to register voice profile');
      }

      this.recordSuccess();
      return { speakerId: data.speaker_id, embeddingId: data.embedding_id };
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Verifies whether an audio clip matches a previously registered speaker.
   */
  async verifySpeaker(
    speakerId: string,
    audioUrl: string,
  ): Promise<SpeakerVerificationResult> {
    this.assertEnabled();
    this.assertCircuitClosed();

    try {
      const data = await this.fetchJsonWithTimeout<{
        success: boolean;
        verified: boolean;
        speaker_id: string;
        similarity_score: number;
        threshold: number;
      }>(`${this.baseUrl}/verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker_id: speakerId, audio_url: audioUrl }),
      });

      this.recordSuccess();
      return {
        verified: data.verified,
        similarityScore: data.similarity_score,
        threshold: data.threshold,
        speakerId: data.speaker_id,
      };
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * 1:N identification — finds the best-matching registered speaker for an audio clip.
   * Pass candidateSpeakerIds to restrict the search to a known list (e.g. a user's contacts).
   */
  async identifySpeaker(
    audioUrl: string,
    candidateSpeakerIds: string[],
  ): Promise<SpeakerIdentificationResult> {
    this.assertEnabled();
    this.assertCircuitClosed();

    const body: Record<string, unknown> = { audio_url: audioUrl };
    if (candidateSpeakerIds.length > 0) {
      body.speaker_ids = candidateSpeakerIds;
    }

    try {
      const data = await this.fetchJsonWithTimeout<{
        success: boolean;
        identified: boolean;
        best_match: { speaker_id: string; speaker_name: string | null; similarity_score: number } | null;
        threshold: number;
        candidates_checked: number;
      }>(`${this.baseUrl}/speakers/identify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      this.recordSuccess();
      return {
        identified: data.identified,
        speakerId: data.best_match?.speaker_id ?? null,
        speakerName: data.best_match?.speaker_name ?? null,
        similarityScore: data.best_match?.similarity_score ?? 0,
        threshold: data.threshold,
        candidatesChecked: data.candidates_checked,
      };
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchJsonWithTimeout<T>(
    url: string,
    init: RequestInit,
    timeoutMs = 10_000,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Voice verification upstream error (${response.status}): ${body.slice(0, 500)}`,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`Voice verification timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertEnabled(): void {
    if (!this.baseUrl) {
      throw new Error('Voice verification service is not configured (VOICE_VERIFICATION_URL missing)');
    }
  }

  private assertCircuitClosed(): void {
    if (Date.now() < this.circuitOpenUntil) {
      throw new Error('Voice verification temporarily unavailable (circuit open)');
    }
  }

  private recordSuccess(): void {
    this.failureCount = 0;
    this.circuitOpenUntil = 0;
  }

  private recordFailure(): void {
    this.failureCount += 1;
    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + this.CIRCUIT_OPEN_MS;
      this.logger.warn(
        `Voice verification circuit opened after ${this.failureCount} failures — pausing for ${this.CIRCUIT_OPEN_MS / 1000}s`,
      );
    }
  }
}
