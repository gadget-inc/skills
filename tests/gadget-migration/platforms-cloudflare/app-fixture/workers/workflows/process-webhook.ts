// the guide's ProcessWebhook, from "Receive webhooks"
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { handleWebhook } from "../../app/services/webhooks.server";

type WebhookParams = { shop: string; topic: string; payload: unknown };

export class ProcessWebhook extends WorkflowEntrypoint<Env, WebhookParams> {
  async run(event: WorkflowEvent<WebhookParams>, step: WorkflowStep) {
    await step.do(
      "handle webhook",
      // 9 retries give the step 10 attempts, starting 2 seconds apart, like Gadget's webhook processing
      { retries: { limit: 9, delay: "2 seconds", backoff: "exponential" } },
      async () => await handleWebhook(event.payload.shop, event.payload.topic, event.payload.payload)
    );
  }
}
