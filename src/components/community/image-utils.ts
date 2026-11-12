import type { PostImage } from "../../lib/community/domain";

export const IMAGE_LIMITS = { count: 10, originalBytes: 10 * 1024 * 1024, uploadBytes: 5 * 1024 * 1024, longestSide: 2560 } as const;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function validateImageFile(file: Pick<File, "type" | "size">): void {
  if (!IMAGE_TYPES.has(file.type)) throw new Error("JPG, PNG, WebP 이미지만 첨부할 수 있어요.");
  if (file.size <= 0) throw new Error("빈 이미지 파일은 첨부할 수 없어요.");
  if (file.size > IMAGE_LIMITS.originalBytes) throw new Error("이미지 한 장은 10MB 이하로 골라 주세요.");
}

export function hasImageSignature(bytes: Uint8Array, type: string): boolean {
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/png") return [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (type === "image/webp") return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  return false;
}

export function scaledImageDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 100_000_000) {
    throw new Error("이미지 크기를 읽을 수 없어요. 다른 이미지를 골라 주세요.");
  }
  const scale = Math.min(1, IMAGE_LIMITS.longestSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Image upload cancelled", "AbortError");
}

function decodeImage(file: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    checkAborted(signal);
    const image = new Image();
    const url = URL.createObjectURL(file);
    const cleanup = () => { URL.revokeObjectURL(url); signal.removeEventListener("abort", cancel); image.onload = null; image.onerror = null; };
    const cancel = () => { cleanup(); image.src = ""; reject(new DOMException("Image upload cancelled", "AbortError")); };
    image.onload = () => { cleanup(); resolve(image); };
    image.onerror = () => { cleanup(); reject(new Error("이미지를 열 수 없어요. 다른 파일로 다시 시도해 주세요.")); };
    signal.addEventListener("abort", cancel, { once: true });
    image.src = url;
  });
}

function encodeCanvas(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("이미지를 준비하지 못했어요. 다시 시도해 주세요.")), type, quality));
}

/** Draw decoded pixels into a fresh canvas so original EXIF/location metadata is not uploaded. */
export async function prepareImageUpload(file: File, signal: AbortSignal): Promise<Blob> {
  checkAborted(signal);
  validateImageFile(file);
  if (!hasImageSignature(new Uint8Array(await file.slice(0, 12).arrayBuffer()), file.type)) {
    throw new Error("파일 형식과 이미지 내용이 달라요. JPG, PNG, WebP 파일로 다시 골라 주세요.");
  }
  checkAborted(signal);
  const image = await decodeImage(file, signal);
  checkAborted(signal);
  const dimensions = scaledImageDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width; canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이 브라우저에서는 이미지를 준비할 수 없어요. 최신 브라우저로 다시 시도해 주세요.");
  try {
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let output = await encodeCanvas(canvas, "image/webp", 0.86);
    checkAborted(signal);
    // Browsers without WebP canvas encoding return PNG. Use JPEG instead of uploading that fallback.
    const type = output.type === "image/webp" ? "image/webp" : "image/jpeg";
    if (type === "image/jpeg") {
      context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      output = await encodeCanvas(canvas, type, 0.86);
    }
    for (const quality of [0.72, 0.58]) {
      checkAborted(signal);
      if (output.size <= IMAGE_LIMITS.uploadBytes) break;
      output = await encodeCanvas(canvas, type, quality);
    }
    checkAborted(signal);
    if (!output.size || output.size > IMAGE_LIMITS.uploadBytes || !["image/jpeg", "image/webp"].includes(output.type)) {
      throw new Error("이미지 용량을 충분히 줄이지 못했어요. 조금 작은 이미지로 다시 시도해 주세요.");
    }
    return output;
  } finally { canvas.width = 0; canvas.height = 0; image.src = ""; }
}

async function responseData(response: Response): Promise<{ image?: PostImage; error?: string }> {
  try { return await response.json(); } catch { return {}; }
}

export async function uploadPostImage(file: File, signal: AbortSignal): Promise<PostImage> {
  const blob = await prepareImageUpload(file, signal);
  checkAborted(signal);
  const response = await fetch("/api/community-images", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": blob.type }, body: blob, signal,
  });
  const data = await responseData(response);
  if (!response.ok || !data.image) throw new Error(data.error || (response.status === 401 ? "로그인한 뒤 이미지를 다시 첨부해 주세요." : "이미지를 첨부하지 못했어요. 다시 시도해 주세요."));
  return data.image;
}

export async function deletePendingImage(image: PostImage, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/community-images/${encodeURIComponent(image.id)}`, {
    method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}", signal,
  });
  if (response.ok || response.status === 404) return;
  const data = await responseData(response);
  throw new Error(data.error || "첨부 이미지를 지우지 못했어요. 다시 시도해 주세요.");
}
