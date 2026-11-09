import type { GadgetModel } from "gadget-server"
import { gizmoDefaults } from "../../shared/gizmoDefaults"

// written without semicolons, with a value import, the way some apps format their files
export const schema: GadgetModel = {
  type: "gadget/model-schema/v1",
  storageKey: "Gizmo",
  fields: {
    label: { type: "string", storageKey: "g1" },
    weight: { type: "number", storageKey: "g2" },
  },
}
