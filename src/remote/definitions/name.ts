/** A definition name, and the `env:<name>` reference to it. Stricter than the reference grammar's id (`INTERNAL_ID`, 1 to 64 characters of `[A-Za-z0-9._-]`). Kept in its own module so the payload and the agent schema can use it without loading the ssh kind. */
export const ENV_DEF_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
/** Most environments one agent may allow. */
export const ENV_ALLOW_MAX = 16;
