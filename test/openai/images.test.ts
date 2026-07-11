import { describe, expect, it } from "vitest";
import {
  assertRequestSize,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_IMAGE_BYTES,
} from "../../src/http/limits.js";
import { decodeImages } from "../../src/openai/images.js";

const signatures = {
  "image/png": Buffer.from("89504e470d0a1a0a", "hex"),
  "image/jpeg": Buffer.from("ffd8ff", "hex"),
  "image/webp": Buffer.from("524946460000000057454250", "hex"),
} as const;

function dataUrl(
  mediaType: keyof typeof signatures,
  size = signatures[mediaType].byteLength,
): string {
  const bytes = Buffer.alloc(size);
  signatures[mediaType].copy(bytes);
  return `data:${mediaType};base64,${bytes.toString("base64")}`;
}

describe("decodeImages", () => {
  it.each(
    Object.keys(signatures) as Array<keyof typeof signatures>,
  )("validates and counts %s without changing the data URL", (mediaType) => {
    const url = dataUrl(mediaType);

    expect(decodeImages([{ type: "input_image", image_url: url }])).toEqual([
      {
        mediaType,
        dataUrl: url,
        decodedBytes: signatures[mediaType].byteLength,
      },
    ]);
  });

  it("accepts Chat image parts", () => {
    const url = dataUrl("image/png");
    expect(decodeImages([{ type: "image_url", image_url: { url } }])).toEqual([
      { mediaType: "image/png", dataUrl: url, decodedBytes: 8 },
    ]);
  });

  it.each([
    ["PNG declared as JPEG", "image/jpeg", signatures["image/png"]],
    ["JPEG declared as WebP", "image/webp", signatures["image/jpeg"]],
    ["WebP declared as PNG", "image/png", signatures["image/webp"]],
  ])("rejects a declaration/signature mismatch: %s", (_name, mediaType, bytes) => {
    expect(() =>
      decodeImages([
        {
          type: "input_image",
          image_url: `data:${mediaType};base64,${bytes.toString("base64")}`,
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "invalid_image", status: 400 }),
    );
  });

  it.each([
    ["empty data", "data:image/png;base64,"],
    ["whitespace", "data:image/png;base64,iVBO Rw=="],
    ["invalid alphabet", "data:image/png;base64,iVBO*Rw=="],
    ["invalid padding", "data:image/png;base64,iVBORw0KGgo"],
    ["non-canonical padding bits", "data:image/png;base64,iV=="],
    ["wrong case", "data:image/PNG;base64,iVBORw0KGgo="],
  ])("strictly rejects %s", (_name, url) => {
    expect(() =>
      decodeImages([{ type: "input_image", image_url: url }]),
    ).toThrowError(expect.objectContaining({ code: "invalid_image" }));
  });

  it("rejects an image over 10 MiB", () => {
    expect(() =>
      decodeImages([
        {
          type: "input_image",
          image_url: dataUrl("image/png", MAX_IMAGE_BYTES + 1),
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "image_too_large", status: 413 }),
    );
  });

  it("rejects more than 24 MiB decoded in aggregate", () => {
    const imageSize = Math.floor(MAX_TOTAL_IMAGE_BYTES / 3) + 1;
    const parts = Array.from({ length: 3 }, () => ({
      type: "input_image" as const,
      image_url: dataUrl("image/png", imageSize),
    }));

    expect(() => decodeImages(parts)).toThrowError(
      expect.objectContaining({
        code: "image_aggregate_too_large",
        status: 413,
      }),
    );
  });

  it("rejects more than eight images", () => {
    const parts = Array.from({ length: 9 }, () => ({
      type: "input_image" as const,
      image_url: dataUrl("image/png"),
    }));

    expect(() => decodeImages(parts)).toThrowError(
      expect.objectContaining({ code: "too_many_images", status: 400 }),
    );
  });

  it("shares the 32 MiB encoded request limit", () => {
    expect(() => assertRequestSize(32 * 1024 * 1024 + 1)).toThrowError(
      expect.objectContaining({ code: "request_too_large", status: 413 }),
    );
  });
});
