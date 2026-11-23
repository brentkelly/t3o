import { describe, expect, it } from "vite-plus/test";

import { splitBoardThreadTabTitle } from "./boardThreadTabTitle";

describe("splitBoardThreadTabTitle", () => {
  it("splits off the card key the supervisor prefixes", () => {
    expect(splitBoardThreadTabTitle("T3O-129", "T3O-129 · Building")).toEqual({
      prefix: "T3O-129 · ",
      rest: "Building",
    });
  });

  it.each([
    ["a renamed title", "T3O-129", "Fix the flake"],
    ["another card's key", "T3O-12", "T3O-129 · Building"],
    ["the bare prefix", "T3O-129", "T3O-129 · "],
    ["a key with no separator", "T3O-129", "T3O-129 Building"],
  ])("keeps %s whole", (_name, cardKey, title) => {
    expect(splitBoardThreadTabTitle(cardKey, title)).toEqual({ prefix: "", rest: title });
  });
});
