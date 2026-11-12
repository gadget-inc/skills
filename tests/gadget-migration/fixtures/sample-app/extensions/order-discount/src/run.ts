// A Shopify Function runs inside Shopify and never calls the app, but a deploy without it removes it from every store
export function run(input: { cart: { lines: { id: string; quantity: number }[] } }) {
  const lines = input.cart.lines.filter((line) => line.quantity >= 3);
  return { operations: lines.map((line) => ({ productDiscountsAdd: { candidates: [{ targets: [{ cartLine: { id: line.id } }], value: { percentage: { value: 10 } } }] } })) };
}
