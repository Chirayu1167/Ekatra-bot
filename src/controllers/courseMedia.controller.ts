import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from 'express';
import { AppError, BadRequestError } from '../errors';

const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

function hasMpegAudioFrame(bytes: Buffer): boolean {
  let start = 0;
  if (bytes.length >= 10 && bytes.toString('ascii', 0, 3) === 'ID3') {
    const tagSize =
      ((bytes[6] ?? 0) & 0x7f) * 2 ** 21 +
      ((bytes[7] ?? 0) & 0x7f) * 2 ** 14 +
      ((bytes[8] ?? 0) & 0x7f) * 2 ** 7 +
      ((bytes[9] ?? 0) & 0x7f);
    start = 10 + tagSize + ((bytes[5] ?? 0) & 0x10 ? 10 : 0);
  }

  const end = Math.min(bytes.length - 3, start + 4096);
  for (let i = start; i <= end; i++) {
    const first = bytes[i] ?? 0;
    const second = bytes[i + 1] ?? 0;
    const third = bytes[i + 2] ?? 0;
    const version = (second >> 3) & 0b11;
    const layer = (second >> 1) & 0b11;
    const sampleRate = (third >> 2) & 0b11;
    if (
      first === 0xff &&
      (second & 0b11100000) === 0b11100000 &&
      version !== 0b01 &&
      layer !== 0 &&
      sampleRate !== 0b11
    ) {
      return true;
    }
  }
  return false;
}

export function createCourseAudioUploadController({
  mediaDir,
  publicBaseUrl,
}: {
  mediaDir?: string;
  publicBaseUrl?: string;
}): RequestHandler {
  return async (req, res) => {
    if (!mediaDir || !publicBaseUrl) {
      throw new AppError(
        503,
        'audio_upload_unavailable',
        'Audio uploads require MEDIA_DIR and PUBLIC_BASE_URL to be configured.',
      );
    }
    if (
      req.is('application/octet-stream') !== 'application/octet-stream' ||
      !Buffer.isBuffer(req.body)
    ) {
      throw new BadRequestError('Upload an MP3 audio file.');
    }
    if (
      req.body.length === 0 ||
      req.body.length > MAX_AUDIO_BYTES ||
      !hasMpegAudioFrame(req.body)
    ) {
      throw new BadRequestError('The upload must be a valid MP3 no larger than 16 MB.');
    }

    const baseUrl = new URL(publicBaseUrl);
    if (baseUrl.protocol !== 'https:') {
      throw new AppError(
        503,
        'audio_upload_unavailable',
        'Audio uploads require an HTTPS PUBLIC_BASE_URL.',
      );
    }

    const fileName = `course-audio-${randomUUID()}.mp3`;
    const targetDir = path.resolve(mediaDir);
    await mkdir(targetDir, { recursive: true });
    await writeFile(path.join(targetDir, fileName), req.body, { flag: 'wx' });

    res.status(201).json({ url: `${baseUrl.origin}/media/${fileName}` });
  };
}
