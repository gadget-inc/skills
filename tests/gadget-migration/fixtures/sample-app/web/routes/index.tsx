import { useAction, useFindMany } from "@gadgetinc/react";
import { api } from "../api";

export default function Index() {
  const [{ data }] = useFindMany(api.widget, { first: 50, live: true, search: "blue" });
  const [, create] = useAction(api.widget.create);
  return <div onClick={() => create({ name: import.meta.env.VITE_DEFAULT_NAME })}>{data?.length}</div>;
}
