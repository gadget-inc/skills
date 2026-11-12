import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export const sqs = new SQSClient({ useQueueUrlAsEndpoint: false });

export async function enqueue(queueUrl: string, job: string, payload: unknown) {
  await sqs.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify({ job, payload }) }));
}
