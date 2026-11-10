import { useLoaderData } from "react-router";
import { withDb } from "../db.server";

export const loader = async () => ({ sessions: Number((await withDb((db) => db.query("select count(*) from shopify_session"))).rows[0].count) });

export default function Index() {
  const { sessions } = useLoaderData<typeof loader>();
  return <p>{`rendered on Workers with ${sessions} sessions`}</p>;
}
