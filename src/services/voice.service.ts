import { createHash } from 'node:crypto';
import { maskPhone, type Logger } from '../logger';
import type { VoiceNote } from '../types/whatsapp';

/** Speech-to-text: transcribe a voice note URL into text. */
export interface SpeechToTextService {
  /** Returns the transcribed text, or null if the service is unavailable. */
  transcribe(voiceNote: VoiceNote, auth: { accountSid: string; authToken: string }): Promise<string | null>;
}

/** Text-to-speech: synthesize text into a publicly accessible audio URL. */
export interface TextToSpeechService {
  /** Returns a public https URL Twilio can fetch, or null if unavailable. */
  synthesize(text: string): Promise<string | null>;
}

/** Voice input + output services. Either may be absent (voice off). */
export interface VoiceServices {
  stt?: SpeechToTextService;
  tts?: TextToSpeechService;
}

/** Disabled voice: no transcription, no synthesis. */
export class DisabledVoiceService implements VoiceServices {
  readonly stt: SpeechToTextService = {
    transcribe: async () => null,
  };
  readonly tts: TextToSpeechService = {
    synthesize: async () => null,
  };
}

/**
 * OpenAI-compatible STT/TTS provider.
 *
 * STT: POST {baseUrl}/audio/transcribe with the audio file (form data), returns { text }.
 * TTS: POST {baseUrl}/audio/speech with { model, voice, input }, returns audio bytes (mp3).
 * The audio bytes are written to MEDIA_DIR and served publicly at {publicBaseUrl}/media/<hash>.mp3.
 */
export class OpenAIVoiceService implements SpeechToTextService, TextToSpeechService {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly sttModel: string;
  private readonly ttsModel: string;
  private readonly ttsVoice: string;
  private readonly mediaDir: string;
  private readonly publicBaseUrl: string | undefined;
  private readonly logger: Logger;

  constructor({
    baseUrl,
    apiKey,
    sttModel = 'whisper-1',
    ttsModel = 'tts-1',
    ttsVoice = 'alloy',
    mediaDir = './media',
    publicBaseUrl,
    logger,
  }: {
    baseUrl: string;
    apiKey: string;
    sttModel?: string;
    ttsModel?: string;
    ttsVoice?: string;
    mediaDir?: string;
    publicBaseUrl?: string;
    logger?: Logger;
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.sttModel = sttModel;
    this.ttsModel = ttsModel;
    this.ttsVoice = ttsVoice;
    this.mediaDir = mediaDir;
    this.publicBaseUrl = publicBaseUrl;
    this.logger = logger ?? (console as unknown as Logger);
  }

  async transcribe(
    voiceNote: VoiceNote,
    auth: { accountSid: string; authToken: string },
  ): Promise<string | null> {
    try {
      // Download the audio from Twilio's protected media URL.
      const audio = await this.downloadTwilioMedia(voiceNote.mediaUrl, auth);
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(audio)], { type: voiceNote.contentType }), 'voice.ogg');
      form.append('model', this.sttModel);
      form.append('language', 'en');

      const resp = await fetch(`${this.baseUrl}/audio/transcribe`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      });
      if (!resp.ok) {
        this.logger.error('voice.stt.failed', {
          status: resp.status,
          to: maskPhone(voiceNote.mediaUrl),
        });
        return null;
      }
      const data = (await resp.json()) as { text?: string };
      return data.text ?? null;
    } catch (err) {
      this.logger.error('voice.stt.error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  async synthesize(text: string): Promise<string | null> {
    if (!this.publicBaseUrl) {
      this.logger.warn('voice.tts.no_public_url', {});
      return null;
    }
    try {
      const resp = await fetch(`${this.baseUrl}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: this.ttsModel, voice: this.ttsVoice, input: text }),
      });
      if (!resp.ok) {
        this.logger.error('voice.tts.failed', { status: resp.status });
        return null;
      }
      const bytes = await resp.arrayBuffer();
      const hash = createHash('sha256').update(text).digest('hex').slice(0, 16);
      const fileName = `voice-${hash}.mp3`;
      const fs = await import('node:fs/promises');
      await fs.writeFile(`${this.mediaDir}/${fileName}`, Buffer.from(bytes));
      return `${this.publicBaseUrl}/media/${fileName}`;
    } catch (err) {
      this.logger.error('voice.tts.error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async downloadTwilioMedia(
    mediaUrl: string,
    auth: { accountSid: string; authToken: string },
  ): Promise<Buffer> {
    const resp = await fetch(mediaUrl, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${auth.accountSid}:${auth.authToken}`).toString('base64')}`,
      },
    });
    if (!resp.ok) {
      throw new Error(`Twilio media download failed: ${resp.status}`);
    }
    const ab = await resp.arrayBuffer();
    return Buffer.from(ab);
  }
}
