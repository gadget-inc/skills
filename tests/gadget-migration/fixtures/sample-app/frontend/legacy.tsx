import { useFindOne } from "@gadgetinc/react";
import { api } from "./api";

// an app created before the web/ layout keeps its frontend here
export function Legacy({ id }: { id: string }) {
  const [{ data }] = useFindOne(api.widget, id);
  return <span>{data?.name}</span>;
}
