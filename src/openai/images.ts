import { ProxyError } from "../http/errors.js";
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
  MAX_TOTAL_IMAGE_BYTES,
} from "../http/limits.js";
import type { DecodedImage, ImageMediaType, InlineImagePart } from "./types.js";

const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/;

function isBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  for (let index = 0; index < value.length - padding; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) return false;
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

function hasSignature(mediaType: ImageMediaType, bytes: Buffer): boolean {
  if (mediaType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  if (mediaType === "image/jpeg") {
    return bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"));
  }
  return (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function imageUrl(part: InlineImagePart): string {
  return typeof part.image_url === "string"
    ? part.image_url
    : part.image_url.url;
}

export function decodeImages(
  parts: readonly InlineImagePart[],
): DecodedImage[] {
  if (parts.length > MAX_IMAGES) {
    throw ProxyError.public(
      400,
      "too_many_images",
      `Requests may contain at most ${MAX_IMAGES} images`,
    );
  }

  const images: DecodedImage[] = [];
  let totalBytes = 0;

  for (const [index, part] of parts.entries()) {
    const dataUrl = imageUrl(part);
    const match = DATA_URL.exec(dataUrl);
    const mediaType = match?.[1] as ImageMediaType | undefined;
    const encoded = match?.[2];
    if (!mediaType || !encoded || !isBase64(encoded)) {
      throw ProxyError.public(
        400,
        "invalid_image",
        "Image must be a non-empty canonical PNG, JPEG, or WebP base64 data URL",
        `images.${index}`,
      );
    }

    const bytes = Buffer.from(encoded, "base64");
    if (
      bytes.toString("base64") !== encoded ||
      !hasSignature(mediaType, bytes)
    ) {
      throw ProxyError.public(
        400,
        "invalid_image",
        "Image signature does not match its declared media type",
        `images.${index}`,
      );
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw ProxyError.public(
        413,
        "image_too_large",
        "Decoded image exceeds the 10 MiB limit",
        `images.${index}`,
      );
    }

    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw ProxyError.public(
        413,
        "image_aggregate_too_large",
        "Decoded images exceed the 24 MiB aggregate limit",
      );
    }
    images.push({ mediaType, dataUrl, decodedBytes: bytes.byteLength });
  }

  return images;
}
