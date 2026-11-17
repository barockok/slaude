/** The portal's API client, mounted at /portal, and its `useApi(path)`. */
import { createApi } from "../lib/api";
import { createUseApi } from "../shared/useApi";

export const api = createApi("portal");
export const useApi = createUseApi(api);
