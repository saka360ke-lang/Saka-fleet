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