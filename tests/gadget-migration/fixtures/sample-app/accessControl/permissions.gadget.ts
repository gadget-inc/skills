import type { GadgetPermissions } from "gadget-server";

// indented with tabs
export const permissions: GadgetPermissions = {
	type: "gadget/permissions/v1",
	roles: {
		"shopify-app-users": {
			storageKey: "Role-Shopify-App",
			models: {
				widget: { read: { filter: "accessControl/filters/shopify/widget.gelly" } },
			},
		},
		unauthenticated: {
			storageKey: "unauthenticated",
		},
	},
};
