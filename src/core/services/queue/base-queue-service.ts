/**
 * Base implementation for queue services
 */

import type {
  IQueueService,
  IQueueMessage,
  IQueueSendOptions,
  IQueueReceiveOptions,
  IQueueBatchResult,
  IQueueMetrics,
  QueueConsumerHandler,
  IQueueEvent,
  QueueEventType,
} from '../../interfaces/queue';
import type { EventBus } from '../../events/event-bus';

export abstract class BaseQueueService implements IQueueService {
  protected eventBus?: EventBus;
  protected consumers = new Map<string, { stop: () => void }>();

  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus;
  }

  abstract send<T = unknown>(
    queueName: string,
    message: T,
    options?: IQueueSendOptions,
  ): Promise<string>;

  abstract receive<T = unknown>(
    queueName: string,
    options?: IQueueReceiveOptions,
  ): Promise<IQueueMessage<T>[]>;

  abstract delete(queueName: string, messageId: string): Promise<void>;

  abstract getMetrics(queueName: string): Promise<IQueueMetrics>;

  abstract purge(queueName: string): Promise<void>;

  /**
   * Default batch send implementation
   */
  async sendBatch<T = unknown>(
    queueName: string,
    messages: T[],
    options?: IQueueSendOptions,
  ): Promise<IQueueBatchResult> {
    const result: IQueueBatchResult = {
      successful: [],
      failed: [],
    };

    // Process messages in parallel
    const promises = messages.map(async (message, index) => {
      try {
        const messageId = await this.send(queueName, message, options);
        result.successful.push(messageId);
      } catch (error) {
        result.failed.push({
          id: `batch-${index}`,
          error: error as Error,
        });
      }
    });

    await Promise.all(promises);
    return result;
  }

  /**
   * Default batch delete implementation
   */
  async deleteBatch(queueName: string, messageIds: string[]): Promise<IQueueBatchResult> {
    const result: IQueueBatchResult = {
      successful: [],
      failed: [],
    };

    // Process deletions in parallel
    const promises = messageIds.map(async (messageId) => {
      try {
        await this.delete(queueName, messageId);
        result.successful.push(messageId);
      } catch (error) {
        result.failed.push({
          id: messageId,
          error: error as Error,
        });
      }
    });

    await Promise.all(promises);
    return result;
  }

  /**
   * Default change visibility implementation
   */
  async changeVisibility(
    _queueName: string,
    _messageId: string,
    _visibilityTimeout: number,
  ): Promise<void> {
    // Default implementation: delete and re-send with delay
    // Subclasses should override with more efficient implementation
    throw new Error('changeVisibility not implemented');
  }

  /**
   * Create a queue consumer
   */
  consume<T = unknown>(
    queueName: string,
    handler: QueueConsumerHandler<T>,
    options?: IQueueReceiveOptions,
  ): { stop: () => void } {
    let running = true;
    const pollInterval = options?.waitTimeSeconds || 5;

    const poll = async () => {
      while (running) {
        try {
          const messages = await this.receive<T>(queueName, options);

          for (const message of messages) {
            try {
              // Emit event
              this.emitEvent({
                type: QueueEventType.MESSAGE_RECEIVED,
                queueName,
                messageId: message.id,
                message: message.body,
                timestamp: Date.now(),
              });

              // Process message
              await handler(message);

              // Delete message after successful processing
              await this.delete(queueName, message.id);

              // Emit success event
              this.emitEvent({
                type: QueueEventType.MESSAGE_PROCESSED,
                queueName,
                messageId: message.id,
                timestamp: Date.now(),
              });
            } catch (error) {
              // Emit error event
              this.emitEvent({
                type: QueueEventType.MESSAGE_FAILED,
                queueName,
                messageId: message.id,
                error: error as Error,
                timestamp: Date.now(),
              });

              // Re-throw to stop processing this batch
              throw error;
            }
          }
        } catch (error) {
          // Emit consumer error event
          this.emitEvent({
            type: QueueEventType.CONSUMER_ERROR,
            queueName,
            error: error as Error,
            timestamp: Date.now(),
          });
        }

        // Wait before next poll
        if (running) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval * 1000));
        }
      }
    };

    // Start polling
    poll().catch((error) => {
      console.error(`Queue consumer error for ${queueName}:`, error);
    });

    // Emit start event
    this.emitEvent({
      type: QueueEventType.CONSUMER_STARTED,
      queueName,
      timestamp: Date.now(),
    });

    const stop = () => {
      running = false;

      // Emit stop event
      this.emitEvent({
        type: QueueEventType.CONSUMER_STOPPED,
        queueName,
        timestamp: Date.now(),
      });
    };

    // Track consumer
    const consumer = { stop };
    this.consumers.set(queueName, consumer);

    return consumer;
  }

  /**
   * Stop all consumers
   */
  stopAllConsumers(): void {
    for (const [queueName, consumer] of this.consumers) {
      consumer.stop();
      this.consumers.delete(queueName);
    }
  }

  /**
   * Emit queue event
   */
  protected emitEvent(event: IQueueEvent): void {
    if (this.eventBus) {
      this.eventBus.emit(event.type, event);
    }
  }

  /**
   * Generate unique message ID
   */
  protected generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }

  /**
   * Create queue message
   */
  protected createMessage<T>(
    id: string,
    body: T,
    metadata?: Record<string, unknown>,
  ): IQueueMessage<T> {
    return {
      id,
      body,
      timestamp: Date.now(),
      attempts: 0,
      metadata,
    };
  }
}
