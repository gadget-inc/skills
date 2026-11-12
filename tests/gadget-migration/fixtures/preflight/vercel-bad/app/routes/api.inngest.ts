import { serve } from "inngest/remix";
import { inngest, handleOrderCreated } from "../inngest.server";

const handler = serve({ client: inngest, functions: [handleOrderCreated] });

export { handler as action, handler as loader };
