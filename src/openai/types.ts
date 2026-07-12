export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface DecodedImage {
  mediaType: ImageMediaType;
  dataUrl: string;
  decodedBytes: number;
}

export type InlineImagePart =
  | {
      type: "image_url";
      image_url: { url: string };
    }
  | {
      type: "input_image";
      image_url: string;
    };
