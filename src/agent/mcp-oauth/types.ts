/** Minimal fetch shape used across the mcp-oauth modules; injectable for tests. */
export type FetchLike = (url: string, init?: any) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}>;
