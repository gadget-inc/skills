export const run: ActionRun = async ({ params }) => {
  await fetch(process.env.EXTERNAL_WEBHOOK_URL!, { method: "POST", body: JSON.stringify(params) });
};

export const params = { orderId: { type: "string" } };
