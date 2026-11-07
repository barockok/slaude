/** The console's `useApi(path)`, bound to the /panel client. */
import { createUseApi } from "../../shared/useApi";
import { api } from "../client";

export type { ApiState } from "../../shared/useApi";
export const useApi = createUseApi(api);
