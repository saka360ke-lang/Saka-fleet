export default async function whatsappRoutes(fastify, options) {
  // 1. Webhook Verification Handshake (GET)
  fastify.get('/webhook/whatsapp', async (request, reply) => {
    const mode = request.query['hub.mode'];
    const token = request.query['hub.verify_token'];
    const challenge = request.query['hub.challenge'];

    if (mode && token) {
      if (mode === 'subscribe' && token === process.env.META_VERIFY_TOKEN) {
        fastify.log.info('WhatsApp webhook verified successfully!');
        return reply.code(200).send(challenge);
      } else {
        return reply.code(403).send({ error: 'Verification failed: Token mismatch' });
      }
    }

    return reply.code(400).send({ error: 'Missing parameters' });
  });

  // 2. Incoming Messages & Event Listener (POST)
  fastify.post('/webhook/whatsapp', async (request, reply) => {
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
                // TODO: Route to Gemini AI & Supabase persistence
              }
            }
          }
        }
        return reply.code(200).send({ status: 'EVENT_RECEIVED' });
      } catch (err) {
        fastify.log.error(err);
        return reply.code(500).send({ error: 'Internal Server Error' });
      }
    }

    return reply.code(404).send({ error: 'Not Found' });
  });
}