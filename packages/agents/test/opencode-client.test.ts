import { describe, expect, it } from "bun:test";
import {
  extractInfoError,
  formatInfoError,
  isAbortError,
  isOversizedImageError,
} from "../opencode/client";

describe("opencode info-error detection", () => {
  it("returns null when no error is present", () => {
    expect(extractInfoError({})).toBeNull();
    expect(extractInfoError({ info: {} })).toBeNull();
    expect(extractInfoError({ info: { error: null } })).toBeNull();
  });

  it("extracts an APIError from info.error", () => {
    const err = extractInfoError({
      info: {
        error: {
          name: "APIError",
          data: { message: "boom", statusCode: 400, isRetryable: false },
        },
      },
    });
    expect(err).toEqual({
      name: "APIError",
      data: { message: "boom", statusCode: 400, isRetryable: false },
    });
  });

  it("formats info errors with name, status code, and message", () => {
    expect(
      formatInfoError({
        name: "APIError",
        data: { message: "quota exceeded", statusCode: 429 },
      })
    ).toBe("OpenCode APIError (status 429): quota exceeded");
  });

  it("formats info errors that are missing a message", () => {
    expect(formatInfoError({ name: "UnknownError", data: {} })).toBe("OpenCode UnknownError");
  });

  it("detects the oversized-image Anthropic APIError", () => {
    expect(
      isOversizedImageError({
        name: "APIError",
        data: {
          message:
            "messages.9.content.18.image.source.base64.data: At least one of the image dimensions exceed max allowed size for many-image requests: 2000 pixels",
          statusCode: 400,
        },
      })
    ).toBe(true);
  });

  it("does not misclassify unrelated APIErrors as image errors", () => {
    expect(
      isOversizedImageError({
        name: "APIError",
        data: { message: "rate limit reached", statusCode: 429 },
      })
    ).toBe(false);
  });

  it("does not treat non-API errors as image errors", () => {
    expect(
      isOversizedImageError({
        name: "ProviderAuthError",
        data: { message: "image dimensions exceed 2000 pixels" },
      })
    ).toBe(false);
  });

  it("flags MessageAbortedError as a non-fatal abort", () => {
    expect(isAbortError({ name: "MessageAbortedError", data: {} })).toBe(true);
  });

  it("does not flag provider failures as aborts", () => {
    expect(isAbortError({ name: "APIError", data: { message: "boom" } })).toBe(false);
    expect(isAbortError({ name: "ProviderAuthError", data: {} })).toBe(false);
  });
});
