// stands in for the guide's Inngest route: what matters here is the config that sets its function's duration
export const config = { maxDuration: 800 };

export const loader = async () => new Response("ok");
export const action = loader;
