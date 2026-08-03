import { describe, expect, it } from "bun:test";
import { collectSlackRootAndLatestMessages } from "./api";

describe("slack message helpers", () => {
  it("walks cursor pages and retains the root plus newest replies", async () => {
    const cursors: Array<string | undefined> = [];
    const messages = await collectSlackRootAndLatestMessages({
      threadId: "1.0",
      limit: 3,
      fetchPage: async (cursor, pageLimit) => {
        cursors.push(cursor);
        expect(pageLimit).toBe(200);
        if (!cursor) {
          return {
            messages: [{ ts: "1.0" }, { ts: "2.0" }, { ts: "3.0" }],
            response_metadata: { next_cursor: "page-2" },
          };
        }
        return {
          messages: [{ ts: "4.0" }, { ts: "5.0" }],
          response_metadata: { next_cursor: "" },
        };
      },
    });

    expect(cursors).toEqual([undefined, "page-2"]);
    expect(messages.map((message) => message.ts)).toEqual(["1.0", "4.0", "5.0"]);
  });

  it("does not paginate when only the root is requested", async () => {
    let calls = 0;
    const messages = await collectSlackRootAndLatestMessages({
      threadId: "1.0",
      limit: 1,
      fetchPage: async (_cursor, pageLimit) => {
        calls += 1;
        expect(pageLimit).toBe(1);
        return {
          messages: [{ ts: "1.0" }],
          response_metadata: { next_cursor: "ignored" },
        };
      },
    });

    expect(calls).toBe(1);
    expect(messages.map((message) => message.ts)).toEqual(["1.0"]);
  });
});
