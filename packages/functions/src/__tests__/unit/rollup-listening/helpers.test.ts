import { describe, it, expect } from "vitest";
import { mergeIntervals } from "@/rollup-listening/handler";

describe("mergeIntervals", () => {
  it("returns empty array for empty input", () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it("returns a single interval unchanged", () => {
    expect(mergeIntervals([[10, 20]])).toEqual([[10, 20]]);
  });

  it("merges two overlapping intervals", () => {
    expect(mergeIntervals([[0, 10], [5, 15]])).toEqual([[0, 15]]);
  });

  it("merges two adjacent intervals (touching boundaries)", () => {
    expect(mergeIntervals([[0, 10], [10, 20]])).toEqual([[0, 20]]);
  });

  it("does not merge disjoint intervals", () => {
    expect(mergeIntervals([[0, 10], [20, 30]])).toEqual([[0, 10], [20, 30]]);
  });

  it("merges multiple overlapping intervals into one", () => {
    expect(mergeIntervals([[0, 5], [3, 8], [6, 12]])).toEqual([[0, 12]]);
  });

  it("handles unsorted input by sorting before merging", () => {
    expect(mergeIntervals([[20, 30], [0, 10], [5, 15]])).toEqual([[0, 15], [20, 30]]);
  });

  it("handles overlapping intervals where one contains another", () => {
    expect(mergeIntervals([[0, 30], [5, 15]])).toEqual([[0, 30]]);
  });

  it("computes correct total listen seconds after merging", () => {
    const merged = mergeIntervals([[0, 60], [30, 120]]);
    const total = merged.reduce((sum, [s, e]) => sum + (e - s), 0);
    expect(total).toBe(120);
  });
});
