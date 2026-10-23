import { createClient } from '@supabase/supabase-js';
import { handleSuperadminFlow } from '../services/superadmin.js';

let supabaseClient = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
  supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// Helper function to dispatch WhatsApp message via Meta Cloud API
async function sendWhatsAppReply(toPhone, messageBody) {
  const phoneNumberId = process.env.META_PHONE_NUMBER_ID;
  const token = process.env.META_WHATSAPP_TOKEN;
  if (!phoneNumberId || !token) return;

  try {
    const cleanPhone = toPhone.startsWith('+') ? toPhone.slice(1) : toPhone;
    await fetch(`https://graph.facebook.com/v17.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: cleanPhone,
        type: 'text',
        text: { body: messageBody }
      })
    });
  } catch (err) {
    console.error('[WhatsApp Service Error]:', err.message);
  }
}

export default async function whatsappRoutes(fastify, options) {
  const verifyWebhook = async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    const expectedToken = process.env.WHATSAPP_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;

    if (mode === 'subscribe' && token === expectedToken) {
      fastify.log.info('WhatsApp webhook verified successfully!');
      return reply.status(200).send(challenge);
    } else {
      return reply.status(403).send('Forbidden');
    }
  };

  // 1. Webhook Verification Handshake (GET)
  fastify.get('/webhook', verifyWebhook);
  fastify.get('/webhook/whatsapp', verifyWebhook);
  fastify.get('/api/whatsapp/webhook', verifyWebhook);

  // 2. Incoming Messages & Event Listener (POST)
  const handleWebhookEvent = async (request, reply) => {
    const body = request.body;

    if (body.object === 'whatsapp_business_account') {
      try {
        for (const entry of body.entry) {
          for (const change of entry.changes) {
            if (change.field === 'messages') {
              const messages = change.value.messages;

              if (messages && messages.length > 0) {
                const message = messages[0];
                const from = message.from;
                const msgBody = message.text ? message.text.body : '';

                fastify.log.info(`Incoming WhatsApp message from ${from}: ${msgBody}`);

                // Superadmin Intercept Middleware
                if (supabaseClient) {
                  const superadminRes = await handleSuperadminFlow(supabaseClient, from, msgBody);
                  if (superadminRes.isSuperadmin) {
                    if (superadminRes.reply) {
                      await sendWhatsAppReply(from, superadminRes.reply);
                    }
                    return reply.status(200).send({ status: 'superadmin_handled' });
                  }
                }
              }
            }
          }
        }
        return reply.status(200).send({ status: 'EVENT_RECEIVED' });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: 'Internal Server Error' });
      }
    }

    return reply.status(404).send({ error: 'Not Found' });
  };

  fastify.post('/webhook', handleWebhookEvent);
  fastify.post('/webhook/whatsapp', handleWebhookEvent);
  fastify.post('/api/whatsapp/webhook', handleWebhookEvent);
}
