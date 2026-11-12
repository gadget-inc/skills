export async function saveLineItems(db: D1Database, items: { id: string; orderId: string; title: string }[]) {
  const values = items.map(() => "(?, ?, ?)").join(", ");
  await db.prepare(`insert into line_item (id, order_id, title) values ${values}`).bind(...items.flatMap((i) => [i.id, i.orderId, i.title])).run();
}
