import type { IncomingMessage, ServerResponse } from 'node:http';

export function hasUnreadRequestBody(request: IncomingMessage): boolean {
  if (request.readableEnded) return false;

  const contentLength = request.headers['content-length'];
  return request.headers['transfer-encoding'] !== undefined || (contentLength !== undefined && contentLength !== '0');
}

export function markConnectionForClosure(response: ServerResponse): void {
  response.shouldKeepAlive = false;
  response.setHeader('connection', 'close');
}
