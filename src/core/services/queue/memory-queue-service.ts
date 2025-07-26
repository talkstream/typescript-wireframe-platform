/**
 * In-memory queue implementation for testing and development
 */

import type {
  IQueueMessage,
  IQueueSendOptions,
  IQueueReceiveOptions,
  IQueueMetrics,
  IAdvancedQueueService,
  IDeadLetterQueueConfig,
  IQueueBatchResult,
} from '../../interfaces/queue';

import { BaseQueueService } from './base-queue-service';

interface QueueData {
  messages: IQueueMessage[];
  invisibleMessages: Map<string, { message: IQueueMessage; visibleAt: number }>;
  dlqConfig?: IDeadLetterQueueConfig;
  receiveCount: Map<string, number>;
  createdAt: number;
  lastModified: number;
}

interface ScheduledMessage {
  message: IQueueMessage;
  deliveryTime: number;
}

/**
 * In-memory queue service for testing
 */
export class MemoryQueueService extends BaseQueueService implements IAdvancedQueueService {
  private queues = new Map<string, QueueData>();
  private scheduledMessages = new Map<string, ScheduledMessage[]>();
  private processingInterval?: NodeJS.Timeout;

  constructor() {
    super();
    this.startProcessing();
  }

  private getOrCreateQueue(queueName: string): QueueData {
    if (!this.queues.has(queueName)) {
      this.queues.set(queueName, {
        messages: [],
        invisibleMessages: new Map(),
        receiveCount: new Map(),
        createdAt: Date.now(),
        lastModified: Date.now(),
      });
    }
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }
    return queue;
  }

  async send<T = unknown>(
    queueName: string,
    message: T,
    options?: IQueueSendOptions,
  ): Promise<string> {
    const queue = this.getOrCreateQueue(queueName);
    const messageId = this.generateMessageId();

    const queueMessage = this.createMessage(messageId, message, options?.metadata);

    // Handle priority
    if (options?.priority !== undefined) {
      queueMessage.metadata = {
        ...queueMessage.metadata,
        priority: options.priority,
      };
    }

    // Handle deduplication
    if (options?.deduplicationId) {
      const isDuplicate = queue.messages.some(
        (msg) => msg.metadata?.deduplicationId === options.deduplicationId,
      );
      if (isDuplicate) {
        return messageId; // Return without adding
      }
      queueMessage.metadata = {
        ...queueMessage.metadata,
        deduplicationId: options.deduplicationId,
      };
    }

    // Handle delay
    if (options?.delaySeconds) {
      const visibleAt = Date.now() + options.delaySeconds * 1000;
      queue.invisibleMessages.set(messageId, { message: queueMessage, visibleAt });
    } else {
      queue.messages.push(queueMessage);
      this.sortMessagesByPriority(queue);
    }

    queue.lastModified = Date.now();

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

  async receive<T = unknown>(
    queueName: string,
    options?: IQueueReceiveOptions,
  ): Promise<IQueueMessage<T>[]> {
    const queue = this.getOrCreateQueue(queueName);
    const maxMessages = options?.maxMessages || 1;
    const visibilityTimeout = (options?.visibilityTimeout || 30) * 1000;
    const waitTimeSeconds = options?.waitTimeSeconds || 0;

    // Wait for messages if long polling
    if (waitTimeSeconds > 0 && queue.messages.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, waitTimeSeconds * 1000));
    }

    // Process invisible messages that should be visible now
    this.processInvisibleMessages(queue);

    // Get available messages
    const messages: IQueueMessage<T>[] = [];
    const now = Date.now();

    for (let i = 0; i < Math.min(maxMessages, queue.messages.length); i++) {
      const message = queue.messages.shift();
      if (!message) continue;

      // Update receive count
      const receiveCount = (queue.receiveCount.get(message.id) || 0) + 1;
      queue.receiveCount.set(message.id, receiveCount);

      // Check DLQ
      if (queue.dlqConfig && receiveCount > queue.dlqConfig.maxReceiveCount) {
        // Move to DLQ
        await this.send(queue.dlqConfig.queueName, message.body, {
          metadata: {
            ...message.metadata,
            originalQueue: queueName,
            failureReason: 'Max receive count exceeded',
          },
        });

        // Emit DLQ event
        this.emitEvent({
          type: 'queue:message:dlq' as import('../../interfaces/queue').QueueEventType,
          queueName,
          messageId: message.id,
          message: message.body,
          timestamp: Date.now(),
        });

        continue;
      }

      // Make message invisible
      const visibleAt = now + visibilityTimeout;
      queue.invisibleMessages.set(message.id, { message, visibleAt });

      // Update attempts
      message.attempts = (message.attempts || 0) + 1;
      messages.push(message as IQueueMessage<T>);
    }

    queue.lastModified = Date.now();
    return messages;
  }

  async delete(queueName: string, messageId: string): Promise<void> {
    const queue = this.getOrCreateQueue(queueName);

    // Remove from invisible messages
    queue.invisibleMessages.delete(messageId);
    queue.receiveCount.delete(messageId);
    queue.lastModified = Date.now();

    // Emit event
    this.emitEvent({
      type: 'queue:message:deleted' as import('../../interfaces/queue').QueueEventType,
      queueName,
      messageId,
      timestamp: Date.now(),
    });
  }

  async changeVisibility(
    queueName: string,
    messageId: string,
    visibilityTimeout: number,
  ): Promise<void> {
    const queue = this.getOrCreateQueue(queueName);
    const invisible = queue.invisibleMessages.get(messageId);

    if (!invisible) {
      throw new Error(`Message ${messageId} not found`);
    }

    invisible.visibleAt = Date.now() + visibilityTimeout * 1000;
    queue.lastModified = Date.now();
  }

  async getMetrics(queueName: string): Promise<IQueueMetrics> {
    const queue = this.getOrCreateQueue(queueName);

    return {
      approximateMessageCount: queue.messages.length,
      approximateMessageNotVisibleCount: queue.invisibleMessages.size,
      createdTimestamp: queue.createdAt,
      lastModifiedTimestamp: queue.lastModified,
    };
  }

  async purge(queueName: string): Promise<void> {
    const queue = this.getOrCreateQueue(queueName);
    queue.messages = [];
    queue.invisibleMessages.clear();
    queue.receiveCount.clear();
    queue.lastModified = Date.now();
  }

  // Advanced features

  async configureDLQ(queueName: string, dlqConfig: IDeadLetterQueueConfig): Promise<void> {
    const queue = this.getOrCreateQueue(queueName);
    queue.dlqConfig = dlqConfig;

    // Create DLQ if it doesn't exist
    this.getOrCreateQueue(dlqConfig.queueName);
  }

  async moveMessage(sourceQueue: string, targetQueue: string, messageId: string): Promise<void> {
    const source = this.getOrCreateQueue(sourceQueue);
    const invisible = source.invisibleMessages.get(messageId);

    if (!invisible) {
      throw new Error(`Message ${messageId} not found`);
    }

    // Send to target queue
    await this.send(targetQueue, invisible.message.body, {
      metadata: {
        ...invisible.message.metadata,
        movedFrom: sourceQueue,
      },
    });

    // Delete from source
    await this.delete(sourceQueue, messageId);
  }

  async retryFailedMessages(queueName: string, messageIds: string[]): Promise<IQueueBatchResult> {
    const queue = this.getOrCreateQueue(queueName);
    const result: IQueueBatchResult = {
      successful: [],
      failed: [],
    };

    for (const messageId of messageIds) {
      const invisible = queue.invisibleMessages.get(messageId);

      if (!invisible) {
        result.failed.push({
          id: messageId,
          error: new Error('Message not found'),
        });
        continue;
      }

      // Make visible immediately
      invisible.visibleAt = Date.now();
      queue.messages.push(invisible.message);
      queue.invisibleMessages.delete(messageId);

      this.sortMessagesByPriority(queue);
      result.successful.push(messageId);
    }

    return result;
  }

  async schedule<T = unknown>(
    queueName: string,
    message: T,
    deliveryTime: Date,
    options?: IQueueSendOptions,
  ): Promise<string> {
    const messageId = this.generateMessageId();
    const queueMessage = this.createMessage(messageId, message, options?.metadata);

    const scheduled: ScheduledMessage = {
      message: queueMessage,
      deliveryTime: deliveryTime.getTime(),
    };

    const scheduledList = this.scheduledMessages.get(queueName) || [];
    scheduledList.push(scheduled);
    this.scheduledMessages.set(queueName, scheduledList);

    return messageId;
  }

  async listScheduled(
    queueName: string,
    startTime?: Date,
    endTime?: Date,
  ): Promise<IQueueMessage[]> {
    const scheduled = this.scheduledMessages.get(queueName) || [];
    const start = startTime?.getTime() || 0;
    const end = endTime?.getTime() || Number.MAX_SAFE_INTEGER;

    return scheduled
      .filter((s) => s.deliveryTime >= start && s.deliveryTime <= end)
      .map((s) => s.message);
  }

  async cancelScheduled(queueName: string, messageId: string): Promise<void> {
    const scheduled = this.scheduledMessages.get(queueName) || [];
    const filtered = scheduled.filter((s) => s.message.id !== messageId);

    if (filtered.length === scheduled.length) {
      throw new Error(`Scheduled message ${messageId} not found`);
    }

    this.scheduledMessages.set(queueName, filtered);
  }

  // Helper methods

  private processInvisibleMessages(queue: QueueData): void {
    const now = Date.now();
    const toMakeVisible: string[] = [];

    for (const [messageId, invisible] of queue.invisibleMessages) {
      if (invisible.visibleAt <= now) {
        toMakeVisible.push(messageId);
        queue.messages.push(invisible.message);
      }
    }

    for (const messageId of toMakeVisible) {
      queue.invisibleMessages.delete(messageId);
    }

    if (toMakeVisible.length > 0) {
      this.sortMessagesByPriority(queue);
    }
  }

  private sortMessagesByPriority(queue: QueueData): void {
    queue.messages.sort((a, b) => {
      const priorityA = (a.metadata?.priority as number) || 0;
      const priorityB = (b.metadata?.priority as number) || 0;
      return priorityB - priorityA; // Higher priority first
    });
  }

  private startProcessing(): void {
    // Process scheduled messages and invisible messages periodically
    this.processingInterval = setInterval(() => {
      this.processScheduledMessages();

      for (const [_queueName, queue] of this.queues) {
        this.processInvisibleMessages(queue);
      }
    }, 1000); // Check every second
  }

  private processScheduledMessages(): void {
    const now = Date.now();

    for (const [queueName, scheduled] of this.scheduledMessages) {
      const toDeliver: ScheduledMessage[] = [];
      const remaining: ScheduledMessage[] = [];

      for (const item of scheduled) {
        if (item.deliveryTime <= now) {
          toDeliver.push(item);
        } else {
          remaining.push(item);
        }
      }

      if (toDeliver.length > 0) {
        this.scheduledMessages.set(queueName, remaining);
        const queue = this.getOrCreateQueue(queueName);

        for (const item of toDeliver) {
          queue.messages.push(item.message);
        }

        this.sortMessagesByPriority(queue);
      }
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    this.stopAllConsumers();
    this.queues.clear();
    this.scheduledMessages.clear();
  }
}
