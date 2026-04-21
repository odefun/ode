import { describe, expect, it } from "bun:test";
import { BoundedMap, BoundedSet } from "../bounded-collections";

describe("BoundedSet", () => {
  it("rejects non-positive capacity", () => {
    expect(() => new BoundedSet(0)).toThrow();
    expect(() => new BoundedSet(-3)).toThrow();
    expect(() => new BoundedSet(Number.NaN)).toThrow();
  });

  it("stores values up to the cap", () => {
    const set = new BoundedSet<string>(3);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.size).toBe(3);
    expect(set.has("a")).toBe(true);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("evicts the oldest entry on overflow (FIFO)", () => {
    const set = new BoundedSet<string>(2);
    set.add("a");
    set.add("b");
    set.add("c");
    expect(set.size).toBe(2);
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("does not refresh insertion order when re-adding an existing value", () => {
    const set = new BoundedSet<string>(2);
    set.add("a");
    set.add("b");
    set.add("a"); // no-op, should NOT move "a" to the end
    set.add("c");
    // If "a" had been refreshed, "b" would be evicted. Instead "a" is the oldest.
    expect(set.has("a")).toBe(false);
    expect(set.has("b")).toBe(true);
    expect(set.has("c")).toBe(true);
  });

  it("supports delete and clear", () => {
    const set = new BoundedSet<string>(4);
    set.add("a");
    set.add("b");
    expect(set.delete("a")).toBe(true);
    expect(set.delete("missing")).toBe(false);
    expect(set.size).toBe(1);
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has("b")).toBe(false);
  });

  it("returns `this` from add (chainable, Set-compatible)", () => {
    const set = new BoundedSet<string>(2);
    const result = set.add("a");
    expect(result).toBe(set);
  });
});

describe("BoundedMap", () => {
  it("rejects non-positive capacity", () => {
    expect(() => new BoundedMap<string, number>(0)).toThrow();
    expect(() => new BoundedMap<string, number>(-1)).toThrow();
  });

  it("stores entries up to the cap", () => {
    const map = new BoundedMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.size).toBe(2);
  });

  it("evicts the oldest entry on overflow (FIFO)", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);
    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("updates in place without refreshing order for existing keys", () => {
    const map = new BoundedMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 99); // update in place, must NOT move "a" to the end
    map.set("c", 3);
    // If "a" were refreshed, "b" would be evicted. Instead "a" is evicted.
    expect(map.has("a")).toBe(false);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
  });

  it("supports delete and clear", () => {
    const map = new BoundedMap<string, number>(4);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.delete("a")).toBe(true);
    expect(map.delete("missing")).toBe(false);
    expect(map.size).toBe(1);
    map.clear();
    expect(map.size).toBe(0);
  });

  it("returns `this` from set (chainable, Map-compatible)", () => {
    const map = new BoundedMap<string, number>(2);
    const result = map.set("a", 1);
    expect(result).toBe(map);
  });
});
