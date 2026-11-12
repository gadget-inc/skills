import { serve } from "inngest/remix";
import { inngest, handleOrderCreated } from "../inngest.server";

export const config = { maxDuration: 800 };

const handler = serve({ client: inngest, functions: [handleOrderCreated] });

export { handler as action, handler as loader };
