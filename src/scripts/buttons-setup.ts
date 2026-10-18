import dotenv from 'dotenv';
import twilio from 'twilio';
import { ensureButtonTemplates, type ContentApi } from '../services/buttonTemplates';

dotenv.config({ quiet: true });

// Only needs the Twilio account credentials, not the whole app config.
const sid = process.env['TWILIO_ACCOUNT_SID'];
const token = process.env['TWILIO_AUTH_TOKEN'];
if (!sid || !token) {
  console.error('Set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN in .env first.');
  process.exit(1);
}

const client = twilio(sid, token);
const contents = client.content.v1.contents;
const api: ContentApi = {
  list: async () =>
    (await contents.list()).map((c) => ({ sid: c.sid, friendlyName: c.friendlyName })),
  create: async (params) => {
    const made = await contents.create(params as unknown as Parameters<typeof contents.create>[0]);
    return { sid: made.sid };
  },
};

async function main(): Promise<void> {
  try {
    const templates = await ensureButtonTemplates(api);
    console.log('Add these lines to .env, then restart the server:\n');
    for (const t of templates) {
      console.log(`${t.spec.envVar}=${t.sid}${t.created ? '' : '   # already existed'}`);
    }
    // Templates that message learners outside the 24 h window must be approved by WhatsApp.
    for (const t of templates.filter((x) => x.created && x.spec.whatsappApproval)) {
      const approval = t.spec.whatsappApproval!;
      try {
        await client.request({
          method: 'post',
          uri: `https://content.twilio.com/v1/Content/${t.sid}/ApprovalRequests/whatsapp`,
          headers: { 'Content-Type': 'application/json' },
          data: approval,
        });
        console.log(`\nSubmitted ${approval.name} to WhatsApp for approval (usually minutes to hours).`);
      } catch (err) {
        console.error(
          `\nCould not auto-submit ${approval.name} for approval (${err instanceof Error ? err.message : err}).` +
            ' Submit it in Twilio Console → Messaging → Content Template Builder.',
        );
      }
    }
  } catch (err) {
    console.error('Could not create the templates:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

void main();
