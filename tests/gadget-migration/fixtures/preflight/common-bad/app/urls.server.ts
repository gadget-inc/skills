export const callback = `${process.env.GADGET_APP_URL}api/callback`;
export const install = process.env.SHOPIFY_APP_URL + "auth/install";
export const preview = new URL("api/preview", process.env.VERCEL_URL);
export const fine = `https://${process.env.VERCEL_URL}/api/preview`;
export const environment = process.env.GADGET_ENV;
