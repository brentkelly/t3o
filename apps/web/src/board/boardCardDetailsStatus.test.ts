import { describe, expect, it } from "vite-plus/test";

import { boardCardDetailsStatus } from "./boardCardDetailsStatus";

describe("boardCardDetailsStatus", () => {
  it.each([
    {
      name: "a card waiting on a human",
      attention: { reason: "input", tone: "attention" },
      blocked: false,
      expected: "attention",
    },
    {
      name: "needs-you outranks blocked",
      attention: { reason: "approval", tone: "attention" },
      blocked: true,
      expected: "attention",
    },
    {
      name: "a stalled card",
      attention: { reason: "stalled", tone: "warning" },
      blocked: false,
      expected: "blocked",
    },
    { name: "a card blocked by a dependency", attention: null, blocked: true, expected: "blocked" },
    {
      name: "a paused step keeps Resume discoverable",
      attention: { reason: "paused", tone: "neutral" },
      blocked: false,
      expected: "paused",
    },
    { name: "a card asking nothing of anyone", attention: null, blocked: false, expected: null },
  ] as const)("$name", ({ attention, blocked, expected }) => {
    expect(boardCardDetailsStatus(attention, blocked)).toBe(expected);
  });
});
