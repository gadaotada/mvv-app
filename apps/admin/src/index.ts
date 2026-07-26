import Fastify from 'fastify';

const fastify = Fastify({});

fastify.get('/health', async (__, reply) => {
  reply.send({ status: 'ok' });
});

fastify.listen({ port: 4000 }, (error, address) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }

  console.log(`Admin listening at ${address} (PID ${process.pid})`);
});
