/**
 * Queue service interfaces for asynchronous task processing
 */

/**
 * Message to be processed in the queue
 */
export interface IQueueMessage<T = unknown> {
  id: string;
  body: T;
  timestamp: number;
  attempts?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Options for sending messages to the queue
 */
export interface IQueueSendOptions {
  /** Delay in seconds before the message becomes visible */
  delaySeconds?: number;
  /** Custom metadata to attach to the message */
  metadata?: Record<string, unknown>;
  /** Priority (higher numbers processed first) */
  priority?: number;
  /** Deduplication ID to prevent duplicate messages */
  deduplicationId?: string;
}

/**
 * Options for receiving messages from the queue
 */
export interface IQueueReceiveOptions {
  /** Maximum number of messages to receive */
  maxMessages?: number;
  /** Visibility timeout in seconds */
  visibilityTimeout?: number;
  /** Wait time in seconds for long polling */
  waitTimeSeconds?: number;
}

/**
 * Options for batch operations
 */
export interface IQueueBatchOptions {
  /** Maximum number of retries for failed messages */
  maxRetries?: number;
  /** Retry delay in seconds */
  retryDelay?: number;
  /** Whether to continue on individual message failures */
  continueOnError?: boolean;
}

/**
 * Result of a batch operation
 */
export interface IQueueBatchResult {
  successful: string[];
  failed: Array<{
    id: string;
    error: Error;
  }>;
}

/**
 * Queue consumer handler
 */
export type QueueConsumerHandler<T = unknown> = (message: IQueueMessage<T>) => Promise<void> | void;

/**
 * Dead letter queue configuration
 */
export interface IDeadLetterQueueConfig {
  /** Queue name for failed messages */
  queueName: string;
  /** Maximum receive count before moving to DLQ */
  maxReceiveCount: number;
}

/**
 * Queue metrics
 */
export interface IQueueMetrics {
  /** Approximate number of messages in the queue */
  approximateMessageCount: number;
  /** Approximate number of messages not visible */
  approximateMessageNotVisibleCount: number;
  /** Queue creation timestamp */
  createdTimestamp?: number;
  /** Last modified timestamp */
  lastModifiedTimestamp?: number;
}

/**
 * Main queue service interface
 */
export interface IQueueService {
  /**
   * Send a single message to the queue
   */
  send<T = unknown>(queueName: string, message: T, options?: IQueueSendOptions): Promise<string>;

  /**
   * Send multiple messages to the queue
   */
  sendBatch<T = unknown>(
    queueName: string,
    messages: T[],
    options?: IQueueSendOptions,
  ): Promise<IQueueBatchResult>;

  /**
   * Receive messages from the queue
   */
  receive<T = unknown>(
    queueName: string,
    options?: IQueueReceiveOptions,
  ): Promise<IQueueMessage<T>[]>;

  /**
   * Delete a message from the queue
   */
  delete(queueName: string, messageId: string): Promise<void>;

  /**
   * Delete multiple messages from the queue
   */
  deleteBatch(queueName: string, messageIds: string[]): Promise<IQueueBatchResult>;

  /**
   * Change message visibility timeout
   */
  changeVisibility(queueName: string, messageId: string, visibilityTimeout: number): Promise<void>;

  /**
   * Get queue metrics
   */
  getMetrics(queueName: string): Promise<IQueueMetrics>;

  /**
   * Purge all messages from the queue
   */
  purge(queueName: string): Promise<void>;

  /**
   * Create a queue consumer
   */
  consume<T = unknown>(
    queueName: string,
    handler: QueueConsumerHandler<T>,
    options?: IQueueReceiveOptions,
  ): { stop: () => void };
}

/**
 * Advanced queue service with additional features
 */
export interface IAdvancedQueueService extends IQueueService {
  /**
   * Configure dead letter queue
   */
  configureDLQ(queueName: string, dlqConfig: IDeadLetterQueueConfig): Promise<void>;

  /**
   * Move message to another queue
   */
  moveMessage(sourceQueue: string, targetQueue: string, messageId: string): Promise<void>;

  /**
   * Retry failed messages
   */
  retryFailedMessages(queueName: string, messageIds: string[]): Promise<IQueueBatchResult>;

  /**
   * Schedule a message for future delivery
   */
  schedule<T = unknown>(
    queueName: string,
    message: T,
    deliveryTime: Date,
    options?: IQueueSendOptions,
  ): Promise<string>;

  /**
   * List scheduled messages
   */
  listScheduled(queueName: string, startTime?: Date, endTime?: Date): Promise<IQueueMessage[]>;

  /**
   * Cancel a scheduled message
   */
  cancelScheduled(queueName: string, messageId: string): Promise<void>;
}

/**
 * Queue provider interface for different implementations
 */
export interface IQueueProvider {
  /**
   * Provider name (e.g., 'cloudflare', 'sqs', 'redis')
   */
  name: string;

  /**
   * Check if the provider is available
   */
  isAvailable(): boolean;

  /**
   * Get queue service instance
   */
  getQueueService(): IQueueService;
}

/**
 * Queue event types
 */
export enum QueueEventType {
  MESSAGE_SENT = 'queue:message:sent',
  MESSAGE_RECEIVED = 'queue:message:received',
  MESSAGE_PROCESSED = 'queue:message:processed',
  MESSAGE_FAILED = 'queue:message:failed',
  MESSAGE_DELETED = 'queue:message:deleted',
  MESSAGE_DLQ = 'queue:message:dlq',
  CONSUMER_STARTED = 'queue:consumer:started',
  CONSUMER_STOPPED = 'queue:consumer:stopped',
  CONSUMER_ERROR = 'queue:consumer:error',
}

/**
 * Queue event payload
 */
export interface IQueueEvent<T = unknown> {
  type: QueueEventType;
  queueName: string;
  messageId?: string;
  message?: T;
  error?: Error;
  timestamp: number;
  metadata?: Record<string, unknown>;
}
