/**
 * Queue processor middleware for async request handling
 */

import type { Context, Next } from 'hono';

import type { IQueueService } from '../core/interfaces/queue';
import type { EventBus } from '../core/events/event-bus';
import { QueueFactory } from '../core/services/queue';

interface QueueProcessorOptions {
  /**
   * Queue service instance or provider name
   */
  queueService?: IQueueService | string;

  /**
   * Queue name prefix
   */
  queuePrefix?: string;

  /**
   * Routes to process asynchronously
   */
  asyncRoutes?: string[] | RegExp | ((path: string) => boolean);

  /**
   * Response to return for queued requests
   */
  queuedResponse?: (requestId: string) => Response;

  /**
   * Error response
   */
  errorResponse?: (error: Error) => Response;

  /**
   * Event bus for notifications
   */
  eventBus?: EventBus;

  /**
   * Max request size for queuing (bytes)
   */
  maxRequestSize?: number;

  /**
   * Request priority function
   */
  getPriority?: (c: Context) => number;

  /**
   * Custom metadata extractor
   */
  getMetadata?: (c: Context) => Record<string, unknown>;
}

interface QueuedRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  timestamp: number;
  userId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Create queue processor middleware
 */
export function createQueueProcessor(options: QueueProcessorOptions = {}) {
  // Get queue service
  const queueService =
    typeof options.queueService === 'string'
      ? QueueFactory.getQueueService(options.queueService, options.eventBus)
      : options.queueService || QueueFactory.createAutoDetect(options.eventBus);

  const queuePrefix = options.queuePrefix || 'request';
  const maxRequestSize = options.maxRequestSize || 1024 * 1024; // 1MB default

  const shouldQueue = (path: string): boolean => {
    if (!options.asyncRoutes) return false;

    if (Array.isArray(options.asyncRoutes)) {
      return options.asyncRoutes.includes(path);
    }

    if (options.asyncRoutes instanceof RegExp) {
      return options.asyncRoutes.test(path);
    }

    if (typeof options.asyncRoutes === 'function') {
      return options.asyncRoutes(path);
    }

    return false;
  };

  const defaultQueuedResponse = (requestId: string): Response => {
    return new Response(
      JSON.stringify({
        status: 'queued',
        requestId,
        message: 'Request queued for processing',
      }),
      {
        status: 202,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': requestId,
        },
      },
    );
  };

  const defaultErrorResponse = (error: Error): Response => {
    return new Response(
      JSON.stringify({
        error: 'Failed to queue request',
        message: error.message,
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  return async function queueProcessor(c: Context, next: Next) {
    const path = c.req.path;

    // Check if this request should be queued
    if (!shouldQueue(path)) {
      return next();
    }

    try {
      // Extract request data
      const requestId = crypto.randomUUID();
      const contentLength = parseInt(c.req.header('content-length') || '0');

      // Check request size
      if (contentLength > maxRequestSize) {
        return new Response('Request too large for queuing', { status: 413 });
      }

      // Parse body if present
      let body: unknown;
      const contentType = c.req.header('content-type') || '';

      if (contentType.includes('application/json')) {
        try {
          body = await c.req.json();
        } catch {
          body = await c.req.text();
        }
      } else if (contentType.includes('text/')) {
        body = await c.req.text();
      } else if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
        // For other content types, store as base64
        const buffer = await c.req.arrayBuffer();
        body = {
          type: 'binary',
          contentType,
          data: btoa(String.fromCharCode(...new Uint8Array(buffer))),
        };
      }

      // Extract headers
      const headers: Record<string, string> = {};
      c.req.raw.headers.forEach((value, key) => {
        // Skip sensitive headers
        if (!['authorization', 'cookie', 'x-api-key'].includes(key.toLowerCase())) {
          headers[key] = value;
        }
      });

      // Create queued request
      const queuedRequest: QueuedRequest = {
        id: requestId,
        method: c.req.method,
        url: c.req.url,
        headers,
        body,
        timestamp: Date.now(),
        userId: c.get('userId'),
        metadata: options.getMetadata?.(c),
      };

      // Determine queue name
      const queueName = `${queuePrefix}-${c.req.method.toLowerCase()}`;

      // Send to queue
      await queueService.send(queueName, queuedRequest, {
        priority: options.getPriority?.(c),
        metadata: {
          path,
          method: c.req.method,
          userId: c.get('userId'),
          ...queuedRequest.metadata,
        },
      });

      // Emit event
      if (options.eventBus) {
        options.eventBus.emit('request:queued', {
          requestId,
          path,
          method: c.req.method,
          queueName,
          timestamp: Date.now(),
        });
      }

      // Return queued response
      const response = options.queuedResponse || defaultQueuedResponse;
      return response(requestId);
    } catch (error) {
      console.error('Failed to queue request:', error);

      // Emit error event
      if (options.eventBus) {
        options.eventBus.emit('request:queue:error', {
          path,
          method: c.req.method,
          error,
          timestamp: Date.now(),
        });
      }

      const errorResponse = options.errorResponse || defaultErrorResponse;
      return errorResponse(error as Error);
    }
  };
}

/**
 * Create request processor for handling queued requests
 */
export function createRequestProcessor(
  handler: (request: Request) => Promise<Response>,
  options: {
    queueService?: IQueueService | string;
    queuePrefix?: string;
    eventBus?: EventBus;
    concurrency?: number;
  } = {},
) {
  const queueService =
    typeof options.queueService === 'string'
      ? QueueFactory.getQueueService(options.queueService, options.eventBus)
      : options.queueService || QueueFactory.createAutoDetect(options.eventBus);

  const queuePrefix = options.queuePrefix || 'request';
  const concurrency = options.concurrency || 1;

  const processRequest = async (queuedRequest: QueuedRequest): Promise<void> => {
    try {
      // Reconstruct request
      const headers = new Headers(queuedRequest.headers);

      // Reconstruct body
      let body: BodyInit | undefined;
      if (queuedRequest.body) {
        if (
          typeof queuedRequest.body === 'object' &&
          'type' in queuedRequest.body &&
          queuedRequest.body.type === 'binary'
        ) {
          // Decode binary data
          const binaryData = queuedRequest.body as {
            type: string;
            contentType: string;
            data: string;
          };
          const decoded = atob(binaryData.data);
          const bytes = new Uint8Array(decoded.length);
          for (let i = 0; i < decoded.length; i++) {
            bytes[i] = decoded.charCodeAt(i);
          }
          body = bytes.buffer;
          headers.set('content-type', binaryData.contentType);
        } else if (typeof queuedRequest.body === 'string') {
          body = queuedRequest.body;
        } else {
          body = JSON.stringify(queuedRequest.body);
          headers.set('content-type', 'application/json');
        }
      }

      const request = new Request(queuedRequest.url, {
        method: queuedRequest.method,
        headers,
        body:
          body && queuedRequest.method !== 'GET' && queuedRequest.method !== 'HEAD'
            ? body
            : undefined,
      });

      // Add request ID header
      request.headers.set('X-Request-ID', queuedRequest.id);
      request.headers.set('X-Queued-At', queuedRequest.timestamp.toString());

      // Process request
      const response = await handler(request);

      // Emit success event
      if (options.eventBus) {
        options.eventBus.emit('request:processed', {
          requestId: queuedRequest.id,
          status: response.status,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      console.error(`Failed to process request ${queuedRequest.id}:`, error);

      // Emit error event
      if (options.eventBus) {
        options.eventBus.emit('request:process:error', {
          requestId: queuedRequest.id,
          error,
          timestamp: Date.now(),
        });
      }

      throw error;
    }
  };

  const startProcessing = (queueName: string) => {
    const consumers = [];

    for (let i = 0; i < concurrency; i++) {
      const consumer = queueService.consume<QueuedRequest>(
        queueName,
        async (message) => {
          await processRequest(message.body);
        },
        {
          maxMessages: 1,
          visibilityTimeout: 300, // 5 minutes
          waitTimeSeconds: 20, // Long polling
        },
      );

      consumers.push(consumer);
    }

    return {
      stop: () => {
        consumers.forEach((consumer) => consumer.stop());
      },
    };
  };

  // Start processors for each method
  const methods = ['get', 'post', 'put', 'patch', 'delete'];
  const processors = methods.map((method) => startProcessing(`${queuePrefix}-${method}`));

  return {
    stop: () => {
      processors.forEach((p) => p.stop());
    },
  };
}
