/**
 * Files the server imports as text (`with { type: "text" }`): Bun resolves
 * them with the module graph, so they ship wherever src/ does.
 */
declare module "*.css" {
  const text: string;
  export default text;
}
