/**
 * Cloudflare Queues implementation
 */

import type {
  IQueueMessage,
  IQueueSendOptions,
  IQueueReceiveOptions,
  IQueueMetrics,
} from '../../interfaces/queue';

import { BaseQueueService } from './base-queue-service';

/**
 * Cloudflare Queue binding interface
 */
interface CloudflareQueue {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<void>;
  sendBatch(messages: Array<{ body: unknown; delaySeconds?: number }>): Promise<void>;
}

/**
 * Environment with queue bindings
 */
interface QueueEnv {
  [key: string]: CloudflareQueue | unknown;
}

/**
 * Cloudflare Queues service implementation
 */
export class CloudflareQueueService extends BaseQueueService {
  private env: QueueEnv;
  private messagesMap = new Map<string, IQueueMessage[]>();

  constructor(env: QueueEnv) {
    super();
    this.env = env;
  }

  /**
   * Get queue binding by name
   */
  private getQueue(queueName: string): CloudflareQueue {
    const queue = this.env[queueName];
    if (!queue || typeof (queue as CloudflareQueue).send !== 'function') {
      throw new Error(`Queue ${queueName} not found or not bound`);
    }
    return queue as CloudflareQueue;
  }

  async send<T = unknown>(
    queueName: string,
    message: T,
    options?: IQueueSendOptions,
  ): Promise<string> {
    const queue = this.getQueue(queueName);
    const messageId = this.generateMessageId();

    // Wrap message with metadata
    const wrappedMessage = {
      id: messageId,
      body: message,
      timestamp: Date.now(),
      metadata: options?.metadata,
      priority: options?.priority,
      deduplicationId: options?.deduplicationId,
    };

    await queue.send(wrappedMessage, {
      delaySeconds: options?.delaySeconds,
    });

    // Emit event
    this.emitEvent({
      type: 'queue:message:sent' as import('../../interfaces/queue').QueueEventType,
      queueName,
      messageId,
      message,
      timestamp: Date.now(),
    });

    return messageId;
  }

  async sendBatch<T = unknown>(
    queueName: string,
    messages: T[],
    options?: IQueueSendOptions,
  ): Promise<import('../../interfaces/queue').IQueueBatchResult> {
    const queue = this.getQueue(queueName);
    const result: import('../../interfaces/queue').IQueueBatchResult = {
      successful: [],
      failed: [],
    };

    try {
      const batch = messages.map((message) => {
        const messageId = this.generateMessageId();
        result.successful.push(messageId);

        return {
          body: {
            id: messageId,
            body: message,
            timestamp: Date.now(),
            metadata: options?.metadata,
            priority: options?.priority,
            deduplicationId: options?.deduplicationId,
          },
          delaySeconds: options?.delaySeconds,
        };
      });

      await queue.sendBatch(batch);
    } catch (error) {
      // If batch fails, all messages fail
      result.failed = result.successful.map((id) => ({
        id,
        error: error as Error,
      }));
      result.successful = [];
    }

    return result;
  }

  async receive<T = unknown>(
    queueName: string,
    options?: IQueueReceiveOptions,
  ): Promise<IQueueMessage<T>[]> {
    // Note: Cloudflare Queues uses a push model with queue consumers
    // This method simulates pull-based receiving for compatibility

    // Get messages from our internal map (populated by queue consumer)
    const messages = this.messagesMap.get(queueName) || [];
    const maxMessages = options?.maxMessages || 10;

    // Take up to maxMessages
    const result = messages.slice(0, maxMessages);

    // Remove taken messages from the map
    this.messagesMap.set(queueName, messages.slice(maxMessages));

    return result as IQueueMessage<T>[];
  }

  async delete(queueName: string, messageId: string): Promise<void> {
    // In Cloudflare Queues, messages are automatically deleted
    // after successful processing in the consumer
    // This method is a no-op for compatibility

    this.emitEvent({
      type: 'queue:message:deleted' as import('../../interfaces/queue').QueueEventType,
      queueName,
      messageId,
      timestamp: Date.now(),
    });
  }

  async getMetrics(queueName: string): Promise<IQueueMetrics> {
    // Cloudflare Queues doesn't provide direct metrics API
    // Return approximate values based on internal state
    const messages = this.messagesMap.get(queueName) || [];

    return {
      approximateMessageCount: messages.length,
      approximateMessageNotVisibleCount: 0,
      createdTimestamp: Date.now() - 86400000, // Dummy value
      lastModifiedTimestamp: Date.now(),
    };
  }

  async purge(queueName: string): Promise<void> {
    // Clear internal message map
    this.messagesMap.delete(queueName);
  }

  /**
   * Register a Cloudflare Queue consumer
   * This should be called in the queue handler export
   */
  registerConsumer<T = unknown>(
    queueName: string,
    handler: (batch: MessageBatch<T>) => Promise<void>,
  ): void {
    // This is called by Cloudflare Workers runtime
    // Store messages for pull-based receive simulation
    const wrapper = async (batch: MessageBatch<unknown>) => {
      // Convert messages to our format
      const messages: IQueueMessage[] = batch.messages.map((msg) => ({
        id: msg.id || this.generateMessageId(),
        body: (msg.body as any).body || msg.body, // Unwrap if needed
        timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
        attempts: msg.attempts || 1,
        metadata: (msg.body as any).metadata,
      }));

      // Store for pull-based receiving
      const existing = this.messagesMap.get(queueName) || [];
      this.messagesMap.set(queueName, [...existing, ...messages]);

      // Call the handler with typed batch
      await handler(batch as MessageBatch<T>);
    };

    // Register with Cloudflare runtime
    const g = globalThis as any;
    g.__queueHandlers = g.__queueHandlers || {};
    g.__queueHandlers[queueName] = wrapper;
  }
}

/**
 * Cloudflare Queue message batch
 */
interface MessageBatch<T = unknown> {
  queue: string;
  messages: Array<{
    id: string;
    body: T;
    timestamp: string;
    attempts: number;
    retry: () => void;
    ack: () => void;
  }>;
  ackAll: () => void;
  retryAll: () => void;
}

/**
 * Helper to create queue consumer export
 */
export function createQueueConsumer<T = unknown>(
  queueService: CloudflareQueueService,
  queueName: string,
  handler: (message: IQueueMessage<T>) => Promise<void>,
) {
  return {
    async queue(batch: MessageBatch<T>): Promise<void> {
      for (const message of batch.messages) {
        try {
          const queueMessage: IQueueMessage<T> = {
            id: message.id,
            body: (message.body as any).body || message.body,
            timestamp: new Date(message.timestamp).getTime(),
            attempts: message.attempts,
            metadata: (message.body as any).metadata,
          };

          await handler(queueMessage);
          message.ack();
        } catch (error) {
          console.error(`Failed to process message ${message.id}:`, error);
          message.retry();
        }
      }
    },
  };
}
