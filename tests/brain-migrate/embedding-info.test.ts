import { describe, expect, test } from "bun:test";
import { embeddingMismatch, readEmbeddingInfo } from "../../src/brain-migrate/embedding-info";

const eng = (atttypmod: number | null) => ({ executeRaw: async () => (atttypmod === null ? [] : [{ atttypmod }]) }) as any;

describe("readEmbeddingInfo", () => {
  test("the column width wins; a default brain has no model", async () => {
    expect(await readEmbeddingInfo(eng(1280), () => null)).toEqual({ embeddingModel: null, embeddingDimensions: 1280 });
    expect(await readEmbeddingInfo(eng(1280), () => ({ embedding_model: "m", embedding_dimensions: 9 }))).toEqual({ embeddingModel: "m", embeddingDimensions: 1280 });
  });
  test("falls back to config when the column has no width; a throwing config is tolerated", async () => {
    expect(await readEmbeddingInfo(eng(-1), () => ({ embedding_dimensions: 1536 }))).toEqual({ embeddingModel: null, embeddingDimensions: 1536 });
    expect(await readEmbeddingInfo(eng(null), () => { throw new Error("x"); })).toEqual({ embeddingModel: null, embeddingDimensions: null });
  });
});

describe("embeddingMismatch", () => {
  const d = (embeddingModel: string | null, embeddingDimensions: number | null) => ({ embeddingModel, embeddingDimensions });
  test("null model on both sides with equal dimensions passes", () => {
    expect(embeddingMismatch(d(null, 1280), d(null, 1280))).toBeNull();
  });
  test("different dimensions are refused, naming both", () => {
    const m = embeddingMismatch(d(null, 1280), d(null, 1536))!;
    expect(m).toMatch(/1280/); expect(m).toMatch(/1536/);
  });
  test("models differ only when both are non-null", () => {
    expect(embeddingMismatch(d("a", 2), d("b", 2))).toMatch(/'a'.*'b'/);
    expect(embeddingMismatch(d("a", 2), d(null, 2))).toBeNull();
    expect(embeddingMismatch(d(null, 2), d("b", 2))).toBeNull();
  });
});
