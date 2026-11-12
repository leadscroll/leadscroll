import { ApiClientError } from './http';

const fileNameFromDisposition = (header: null | string): null | string => {
  if (!header) {
    return null;
  }

  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // Fall through to the plain filename parameter.
    }
  }

  return /filename="([^"]+)"/iu.exec(header)?.[1] ?? null;
};

/**
 * Downloads an authenticated API response as a file.
 *
 * Native fetch is deliberate here: the response is a binary/text download that
 * can be large, so it is handed to the browser as a blob rather than being
 * decoded by the JSON request helpers.
 */
export const downloadFile = async (
  path: string,
  fallbackFileName: string,
  accept = 'application/octet-stream',
): Promise<void> => {
  const response = await fetch(path, { headers: { Accept: accept } });
  if (!response.ok) {
    let message = 'The file could not be downloaded.';
    try {
      const payload = (await response.json()) as { message?: unknown };
      if (typeof payload.message === 'string') {
        message = payload.message;
      }
    } catch {
      // Keep the generic message for a non-JSON failure.
    }

    throw new ApiClientError(response.status, message);
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.download =
    fileNameFromDisposition(response.headers.get('content-disposition')) ??
    fallbackFileName;
  anchor.href = objectUrl;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
};
