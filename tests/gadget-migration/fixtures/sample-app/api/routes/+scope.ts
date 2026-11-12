export default async function (server) {
  await server.register(import("@fastify/cors"));
}
