import { AppError } from '../errors';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';
import type { OptOutService } from './optout.service';
import type { OutgoingWhatsAppMessage, SendResult } from '../types/whatsapp';
import type { WhatsAppSender } from './whatsapp.service';

export class OptedOutError extends AppError {
  constructor() {
    super(500, 'opted_out_suppressed', 'Refusing to message an opted-out learner');
  }
}

/**
 * The ONE central opt-out enforcement point. Wrap the real sender with this before handing it
 * to the webhook controller: every send path (lessons, tutor answers, certificates, future
 * reminders/broadcasts) flows through `sendWhatsAppMessage`, so no new path can bypass it.
 *
 * Fail-closed: a send to an opted-out number throws unless the message carries
 * `optOutConfirmation` — set only on the STOP-confirmation reply. Anything else to an
 * opted-out number is a bug, and throwing (no send, no progress commit) is the safe outcome.
 */
export class OptOutGuardSender implements WhatsAppSender {
  constructor(
    private readonly inner: WhatsAppSender,
    private readonly optOuts: OptOutService,
    private readonly logger: Logger = silentLogger,
  ) {}

  async sendWhatsAppMessage(message: OutgoingWhatsAppMessage): Promise<SendResult> {
    if ((await this.optOuts.isOptedOut(message.to)) && !message.optOutConfirmation) {
      this.logger.warn('whatsapp.send.suppressed_optout', {});
      throw new OptedOutError();
    }
    return this.inner.sendWhatsAppMessage(message);
  }
}
