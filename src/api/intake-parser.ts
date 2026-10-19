import { errorResponse } from './http';
import { getStreamAsArrayBuffer, MaxBufferError } from 'get-stream';

export const MAX_INTAKE_BODY_BYTES = 65_536;

/**
 * Reads the raw intake body with a hard byte limit before JSON decoding.
 * `get-stream` owns byte counting and cancellation, including oversized
 * streams that are still open.
 *
 * The byte limit is enforced before the media-type check and before any
 * token/idempotency decision: an oversized body is always 413, and malformed
 * JSON is the framework-compatible 400.
 */
export const parseIntakeBody = async (
  request: Request,
): Promise<{ data: unknown } | { error: Response }> => {
  if (!request.body) {
    return {
      error: errorResponse(
        400,
        'validation_error',
        'An intake JSON body is required.',
      ),
    } as const;
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await getStreamAsArrayBuffer(request.body, {
      maxBuffer: MAX_INTAKE_BODY_BYTES,
    });
  } catch (error) {
    // Never inspect or log buffered data: it can contain contact details.
    if (error instanceof MaxBufferError) {
      return {
        error: errorResponse(
          413,
          'payload_too_large',
          `The intake request body must not exceed ${MAX_INTAKE_BODY_BYTES} bytes.`,
        ),
      } as const;
    }

    return {
      error: errorResponse(400, 'validation_error', 'The request is invalid.'),
    } as const;
  }

  const contentType = request.headers.get('content-type')?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return {
      error: errorResponse(
        415,
        'unsupported_media_type',
        'Use Content-Type: application/json for intake requests.',
      ),
    } as const;
  }

  try {
    return { data: JSON.parse(new TextDecoder().decode(bytes)) } as const;
  } catch {
    return {
      error: errorResponse(400, 'validation_error', 'The request is invalid.'),
    } as const;
  }
};
