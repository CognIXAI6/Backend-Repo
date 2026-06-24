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

    const id = speakerId ?? randomUUID();
    const overwrite = !!speakerId;

    const url = new URL(`${this.baseUrl}/registration`);
    if (overwrite) url.searchParams.set('overwrite', 'true');

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speaker_id: id,
        speaker_name: speakerName,
        audio_url: audioUrl,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`Voice registration upstream error (${response.status}): ${body}`);
      throw new Error('Failed to register voice profile');
    }

    const data = (await response.json()) as {
      success: boolean;
      speaker_id: string;
      embedding_id: string;
    };

    if (!data.success) {
      this.logger.error(`Voice registration unsuccessful for speaker: ${speakerName}`);
      throw new Error('Failed to register voice profile');
    }

    return {
      speakerId: data.speaker_id,
      embeddingId: data.embedding_id,
    };
  }

  /**
   * Verifies whether an audio clip matches a previously registered speaker.
   */
  async verifySpeaker(
    speakerId: string,
    audioUrl: string,
  ): Promise<SpeakerVerificationResult> {
    this.assertEnabled();

    const response = await fetch(`${this.baseUrl}/verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        speaker_id: speakerId,
        audio_url: audioUrl,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(`Voice verification upstream error (${response.status}): ${body}`);
      throw new Error('Failed to verify voice profile');
    }

    const data = (await response.json()) as {
      success: boolean;
      verified: boolean;
      speaker_id: string;
      similarity_score: number;
      threshold: number;
    };

    return {
      verified: data.verified,
      similarityScore: data.similarity_score,
      threshold: data.threshold,
      speakerId: data.speaker_id,
    };
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

    const body: Record<string, unknown> = { audio_url: audioUrl };
    if (candidateSpeakerIds.length > 0) {
      body.speaker_ids = candidateSpeakerIds;
    }

    const response = await fetch(`${this.baseUrl}/speakers/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      this.logger.error(`Voice identification upstream error (${response.status}): ${raw}`);
      throw new Error('Failed to identify speaker');
    }

    const data = (await response.json()) as {
      success: boolean;
      identified: boolean;
      best_match: { speaker_id: string; speaker_name: string | null; similarity_score: number } | null;
      threshold: number;
      candidates_checked: number;
    };

    return {
      identified: data.identified,
      speakerId: data.best_match?.speaker_id ?? null,
      speakerName: data.best_match?.speaker_name ?? null,
      similarityScore: data.best_match?.similarity_score ?? 0,
      threshold: data.threshold,
      candidatesChecked: data.candidates_checked,
    };
  }

  private assertEnabled(): void {
    if (!this.baseUrl) {
      throw new Error('Voice verification service is not configured (VOICE_VERIFICATION_URL missing)');
    }
  }
}
