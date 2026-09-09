// Image attachment helpers — web adaptation of the Android image attachment
// pipeline (canvas re-encode instead of Expo ImageManipulator).

import type { ImageAttachmentLimits, ImageMediaType, PromptImage } from '../types'

export const IMAGE_ATTACHMENT_LIMITS: ImageAttachmentLimits = {
  maxImageBytes: 4 * 1024 * 1024,
  maxImagesPerMessage: 5,
  maxMessageImageBytes: 20 * 1024 * 1024,
  maxImagePixels: 4096 * 4096,
  maxImageDimension: 4096,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
}

const REENCODE_THRESHOLD_BYTES = 1.5 * 1024 * 1024
const TARGET_MAX_DIMENSION = 2048
const JPEG_QUALITY_STEPS = [0.9, 0.8, 0.7, 0.6, 0.5]

function isSupportedImageType(type: string): type is ImageMediaType {
  return (IMAGE_ATTACHMENT_LIMITS.mediaTypes as readonly string[]).includes(type)
}

async function loadBitmap(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(file)
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new Error('The image could not be decoded.'))
      image.src = url
    })
  } finally {
    // the bitmap/element keeps its own copy; revoke once decoded
    setTimeout(() => URL.revokeObjectURL(url), 5_000)
  }
}

function bitmapSize(bitmap: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  return { width: bitmap.width, height: bitmap.height }
}

function scaleFor(bitmap: ImageBitmap | HTMLImageElement): number {
  const { width, height } = bitmapSize(bitmap)
  const longest = Math.max(width, height)
  return longest > TARGET_MAX_DIMENSION ? TARGET_MAX_DIMENSION / longest : 1
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob === null ? reject(new Error('The image could not be re-encoded.')) : resolve(blob)),
      type,
      quality,
    )
  })
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('The image could not be read.'))
    reader.readAsDataURL(blob)
  })
}

function dataUrlToBase64(dataUrl: string): string {
  const commaIndex = dataUrl.indexOf(',')
  return commaIndex === -1 ? '' : dataUrl.slice(commaIndex + 1)
}

/**
 * Convert a picked image file into a PromptImage: small files pass through as
 * base64; larger ones are re-encoded to JPEG at descending quality until they
 * fit the per-image budget.
 */
export async function fileToPromptImage(file: File): Promise<PromptImage> {
  if (!isSupportedImageType(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || 'unknown'}`)
  }
  const bitmap = await loadBitmap(file)
  const { width, height } = bitmapSize(bitmap)
  if (width * height > IMAGE_ATTACHMENT_LIMITS.maxImagePixels) {
    throw new Error('The image is too large.')
  }

  const base64Of = async (blob: Blob): Promise<string> => dataUrlToBase64(await readAsDataUrl(blob))

  if (file.size <= REENCODE_THRESHOLD_BYTES) {
    const data = await base64Of(file)
    return {
      mediaType: file.type,
      data,
      bytes: file.size,
      width,
      height,
      ...(file.name !== undefined && file.name.length > 0 ? { name: file.name } : {}),
    }
  }

  const scale = scaleFor(bitmap)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(width * scale))
  canvas.height = Math.max(1, Math.round(height * scale))
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('The image could not be re-encoded.')
  context.drawImage(bitmap as CanvasImageSource, 0, 0, canvas.width, canvas.height)

  for (const quality of JPEG_QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
    if (blob.size <= IMAGE_ATTACHMENT_LIMITS.maxImageBytes) {
      const data = await base64Of(blob)
      return {
        mediaType: 'image/jpeg',
        data,
        bytes: blob.size,
        width: canvas.width,
        height: canvas.height,
        ...(file.name !== undefined && file.name.length > 0 ? { name: file.name } : {}),
      }
    }
  }
  throw new Error('The image is too large to send.')
}

export function totalImageBytes(images: readonly PromptImage[]): number {
  return images.reduce((sum, image) => sum + image.bytes, 0)
}
