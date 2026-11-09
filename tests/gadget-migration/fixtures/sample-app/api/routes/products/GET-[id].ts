export default async function route({ request, reply }) {
  await reply.send(request.params.id);
}
