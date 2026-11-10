import { scheduleRoute } from "../schedules.server";
import { pruneSessions } from "../services/sessions.server";

export const action = scheduleRoute(pruneSessions);
