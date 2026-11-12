import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { notifyExternalSystem } from "./services/external.server";

export class NotifyExternalSystem extends WorkflowEntrypoint<Env, { orderId: string }> {
  async run(event: WorkflowEvent<{ orderId: string }>, step: WorkflowStep) {
    await step.do("notify", { retries: { limit: 6, delay: "1 second", backoff: "exponential" } }, async () => await notifyExternalSystem(event.payload));
  }
}
