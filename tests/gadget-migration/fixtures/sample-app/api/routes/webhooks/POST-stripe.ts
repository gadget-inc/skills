export default async function route({ reply }) {
  await reply.send({ configured: Boolean(process.env.STRIPE_SECRET), env: process.env.GADGET_ENV });
}
