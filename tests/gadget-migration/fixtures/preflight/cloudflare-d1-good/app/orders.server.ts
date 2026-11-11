// at most 33 rows of 3 parameters per statement, under D1's 100
export async function saveLineItems(db: D1Database, items: { id: string; orderId: string; title: string }[]) {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < items.length; i += 33) {
    const chunk = items.slice(i, i + 33);
    statements.push(db.prepare(`insert into line_item (id, order_id, title) values ${chunk.map(() => "(?, ?, ?)").join(", ")}`).bind(...chunk.flatMap((x) => [x.id, x.orderId, x.title])));
  }
  if (statements.length) await db.batch(statements);
}
