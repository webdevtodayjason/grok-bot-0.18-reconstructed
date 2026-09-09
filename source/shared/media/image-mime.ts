import { AUDIO_MIME_FROM_EXTENSION, CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION, EXTENSION_FROM_IMAGE_MIME, IMAGE_MIME_FROM_EXTENSION, VIDEO_MIME_FROM_EXTENSION, extensionOf } from "./media-extensions.js";
export function imageMimeFromPath(filePath: string): string | undefined { return IMAGE_MIME_FROM_EXTENSION[extensionOf(filePath)]; }
export function servableImageMimeFromPath(filePath: string): string | undefined { const extension = extensionOf(filePath); return IMAGE_MIME_FROM_EXTENSION[extension] ?? CLIENT_NATIVE_IMAGE_MIME_FROM_EXTENSION[extension]; }
/**
 * ATTACH-1/B5. ONE resolver decides what counts as a picture, on both sides of the attachment.
 *
 * The console renders .heic and .heif (servableImageMimeFromPath knows them) while the splitter that
 * decides which channel an attachment travels used imageMimeFromPath, which does not. An iPhone
 * screenshot therefore landed in the plain-file list and was never an image at all -- and would not
 * have been one even after the wire is fixed. Two names for the same question is the bug; this is
 * the one both sides ask.
 */
export function attachmentImageMimeFromPath(filePath: string): string | undefined { return servableImageMimeFromPath(filePath); }
export function extensionFromImageMime(mime: string): string | undefined { return EXTENSION_FROM_IMAGE_MIME[mime.toLowerCase()]; }
export function videoMimeFromPath(filePath: string): string | undefined { return VIDEO_MIME_FROM_EXTENSION[extensionOf(filePath)]; }
export function audioMimeFromPath(filePath: string): string | undefined { return AUDIO_MIME_FROM_EXTENSION[extensionOf(filePath)]; }
