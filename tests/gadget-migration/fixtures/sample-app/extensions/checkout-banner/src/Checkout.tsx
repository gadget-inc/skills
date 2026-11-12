export async function loadBanner(token: string) {
  const response = await fetch("https://sample-app.gadget.app/banner", { headers: { Authorization: `Bearer ${token}` } });
  return response.json();
}
