import { describe, expect, it } from 'vitest';
import { LocalFakeWhatsAppSender } from '../src/services/localFakeSender';

describe('local fake WhatsApp sender', () => {
  it('returns synthetic delivery ids without requiring a transport', async () => {
    const sender = new LocalFakeWhatsAppSender();
    const first = await sender.sendWhatsAppMessage({ to: 'whatsapp:+15555550123', body: 'test-only' });
    const second = await sender.sendWhatsAppMessage({ to: 'whatsapp:+15555550123', body: 'test-only' });
    expect(first.sid).toMatch(/^SM[0-9a-f]{32}$/);
    expect(second.sid).toMatch(/^SM[0-9a-f]{32}$/);
    expect(second.sid).not.toBe(first.sid);
  });
});
