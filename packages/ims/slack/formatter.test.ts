import { describe, expect, it } from "bun:test";
import { markdownToSlack } from "./formatter";

describe("Slack Markdown formatter", () => {
  it("keeps CommonMark bold and italic semantically distinct", () => {
    expect(markdownToSlack("**Running** and *thinking*"))
      .toBe("*Running* and _thinking_");
  });

  it("preserves Markdown blockquotes used by reasoning previews", () => {
    expect(markdownToSlack("> inspected the repository"))
      .toBe("> inspected the repository");
  });
});
