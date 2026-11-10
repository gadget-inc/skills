// node --import ./register.mjs: adds resolve-ts.mjs
import { register } from "node:module";

register("./resolve-ts.mjs", import.meta.url);
