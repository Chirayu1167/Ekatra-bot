import { randomUUID } from 'node:crypto';
import type { OutgoingWhatsAppMessage, SendResult } from '../types/whatsapp';
import type { WhatsAppSender } from './whatsapp.service';

/** Local-only transport: accepts delivery without contacting Twilio or logging message data. */
export class LocalFakeWhatsAppSender implements WhatsAppSender {
  async sendWhatsAppMessage(_message: OutgoingWhatsAppMessage): Promise<SendResult> {
    return { sid: `SM${randomUUID().replaceAll('-', '')}` };
  }
}
