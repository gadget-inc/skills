export async function notifyWarehouse(orderId: string) {
  const response = await fetch("https://warehouse.example.com/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId }) });
  if (!response.ok) throw new Error(`warehouse answered ${response.status}`);
}
