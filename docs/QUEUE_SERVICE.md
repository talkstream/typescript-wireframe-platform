# Queue Service

Asynchronous task processing with support for multiple queue providers including Cloudflare Queues.

## Features

- **Multiple Providers** - Cloudflare Queues, Memory (for testing)
- **Message Priority** - Process important messages first
- **Delayed Messages** - Schedule messages for future delivery
- **Dead Letter Queue** - Handle failed messages automatically
- **Batch Operations** - Send/delete multiple messages efficiently
- **Message Deduplication** - Prevent duplicate processing
- **Long Polling** - Efficient message retrieval
- **Event Integration** - Full EventBus integration

## Quick Start

### Basic Usage

```typescript
import { QueueFactory } from '@/core/services/queue';

// Auto-detect best available provider
const queueService = QueueFactory.createAutoDetect();

// Send a message
const messageId = await queueService.send('my-queue', {
  action: 'process-order',
  orderId: '12345',
  userId: 'user123',
});

// Receive messages
const messages = await queueService.receive('my-queue', {
  maxMessages: 10,
  visibilityTimeout: 300, // 5 minutes
});

// Process and delete
for (const message of messages) {
  await processOrder(message.body);
  await queueService.delete('my-queue', message.id);
}
```

### Using Consumers

```typescript
// Create a consumer for continuous processing
const consumer = queueService.consume(
  'my-queue',
  async (message) => {
    console.log('Processing:', message.body);
    // Message is automatically deleted on success
  },
  {
    maxMessages: 5,
    waitTimeSeconds: 20, // Long polling
  },
);

// Stop consumer when done
consumer.stop();
```

## Provider Configuration

### Cloudflare Queues

```toml
# wrangler.toml
[[queues.producers]]
  queue = "my-queue"
  binding = "MY_QUEUE"

[[queues.consumers]]
  queue = "my-queue"
  max_batch_size = 10
  max_retries = 3
  dead_letter_queue = "my-dlq"
```

```typescript
// In your worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const queueService = new CloudflareQueueService(env);

    // Send message
    await queueService.send('MY_QUEUE', { data: 'test' });

    return new Response('Queued');
  },

  // Queue consumer
  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processMessage(message.body);
        message.ack();
      } catch (error) {
        message.retry();
      }
    }
  },
};
```

### Memory Queue (Testing)

```typescript
import { MemoryQueueService } from '@/core/services/queue';

const queueService = new MemoryQueueService();

// Use in tests
await queueService.send('test-queue', { test: true });
const messages = await queueService.receive('test-queue');

// Clean up
queueService.destroy();
```

## Advanced Features

### Priority Messages

```typescript
// Higher priority messages are processed first
await queueService.send('priority-queue', { task: 'urgent' }, { priority: 10 });

await queueService.send('priority-queue', { task: 'normal' }, { priority: 5 });
```

### Delayed Messages

```typescript
// Delay message visibility
await queueService.send(
  'delayed-queue',
  { reminder: 'Check status' },
  { delaySeconds: 300 }, // 5 minutes
);
```

### Message Deduplication

```typescript
// Prevent duplicate messages
const dedupId = `order-${orderId}`;
await queueService.send('orders', { orderId }, { deduplicationId: dedupId });
```

### Dead Letter Queue

```typescript
// Configure DLQ for failed messages
await queueService.configureDLQ('my-queue', {
  queueName: 'my-dlq',
  maxReceiveCount: 3,
});

// Failed messages automatically move to DLQ after 3 attempts
```

### Batch Operations

```typescript
// Send multiple messages
const messages = [
  { id: 1, data: 'first' },
  { id: 2, data: 'second' },
  { id: 3, data: 'third' },
];

const result = await queueService.sendBatch('batch-queue', messages);
console.log(`Sent: ${result.successful.length}, Failed: ${result.failed.length}`);

// Delete multiple messages
const messageIds = ['msg1', 'msg2', 'msg3'];
await queueService.deleteBatch('batch-queue', messageIds);
```

### Scheduled Messages

```typescript
// Schedule for future delivery
const deliveryTime = new Date();
deliveryTime.setHours(deliveryTime.getHours() + 1);

await queueService.schedule('scheduled-queue', { reminder: 'Meeting in 5 minutes' }, deliveryTime);

// List scheduled messages
const scheduled = await queueService.listScheduled('scheduled-queue');

// Cancel if needed
await queueService.cancelScheduled('scheduled-queue', messageId);
```

## Queue Processor Middleware

### Async Request Processing

```typescript
import { createQueueProcessor } from '@/middleware/queue-processor';

// Queue specific routes
app.use(
  createQueueProcessor({
    asyncRoutes: ['/api/heavy-task', '/api/report/generate'],
    queuedResponse: (requestId) =>
      new Response(
        JSON.stringify({
          status: 'processing',
          trackingId: requestId,
        }),
        { status: 202 },
      ),
  }),
);

// Or use regex
app.use(
  createQueueProcessor({
    asyncRoutes: /^\/api\/async\//,
    getPriority: (c) => (c.get('isPremium') ? 10 : 1),
  }),
);
```

### Processing Queued Requests

```typescript
import { createRequestProcessor } from '@/middleware/queue-processor';

// Create processor for queued requests
const processor = createRequestProcessor(
  async (request) => {
    // Handle the reconstructed request
    const response = await app.fetch(request);
    return response;
  },
  {
    concurrency: 5, // Process 5 requests in parallel
    queuePrefix: 'request',
  },
);

// Stop when shutting down
process.on('SIGTERM', () => processor.stop());
```

## Event Integration

```typescript
import { EventBus } from '@/core/events/event-bus';
import { QueueEventType } from '@/core/interfaces/queue';

const eventBus = new EventBus();
const queueService = QueueFactory.createAutoDetect(eventBus);

// Listen to queue events
eventBus.on(QueueEventType.MESSAGE_SENT, (event) => {
  console.log(`Message sent: ${event.messageId} to ${event.queueName}`);
});

eventBus.on(QueueEventType.MESSAGE_FAILED, (event) => {
  console.error(`Processing failed: ${event.error.message}`);
});

eventBus.on(QueueEventType.MESSAGE_DLQ, (event) => {
  console.warn(`Message moved to DLQ: ${event.messageId}`);
});
```

## Monitoring

### Queue Metrics

```typescript
const metrics = await queueService.getMetrics('my-queue');
console.log({
  pending: metrics.approximateMessageCount,
  processing: metrics.approximateMessageNotVisibleCount,
  created: new Date(metrics.createdTimestamp),
  modified: new Date(metrics.lastModifiedTimestamp),
});
```

### Health Checks

```typescript
app.get('/health/queues', async (c) => {
  const queues = ['orders', 'notifications', 'reports'];
  const health = {};

  for (const queue of queues) {
    try {
      const metrics = await queueService.getMetrics(queue);
      health[queue] = {
        status: 'healthy',
        pending: metrics.approximateMessageCount,
        processing: metrics.approximateMessageNotVisibleCount,
      };
    } catch (error) {
      health[queue] = {
        status: 'unhealthy',
        error: error.message,
      };
    }
  }

  return c.json(health);
});
```

## Best Practices

### 1. Message Design

```typescript
// Good: Self-contained message
await queueService.send('process-order', {
  orderId: '12345',
  userId: 'user123',
  items: [...],
  totalAmount: 99.99,
  timestamp: Date.now()
});

// Bad: Message with external dependencies
await queueService.send('process-order', {
  orderId: '12345' // Requires database lookup
});
```

### 2. Error Handling

```typescript
const consumer = queueService.consume('my-queue', async (message) => {
  try {
    // Validate message
    if (!message.body.requiredField) {
      throw new Error('Invalid message format');
    }

    // Process with timeout
    await Promise.race([
      processMessage(message.body),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 30000)),
    ]);
  } catch (error) {
    // Log for debugging
    console.error(`Failed to process ${message.id}:`, error);

    // Check if retryable
    if (isRetryableError(error)) {
      throw error; // Will retry
    }

    // Non-retryable: delete to prevent infinite loop
    await queueService.delete('my-queue', message.id);
  }
});
```

### 3. Idempotency

```typescript
// Use deduplication for critical operations
const processPayment = async (payment) => {
  const dedupId = `payment-${payment.transactionId}`;

  await queueService.send('payments', payment, {
    deduplicationId: dedupId,
    metadata: {
      idempotencyKey: payment.transactionId,
    },
  });
};

// In consumer
const consumer = queueService.consume('payments', async (message) => {
  const { transactionId } = message.body;

  // Check if already processed
  const processed = await checkProcessed(transactionId);
  if (processed) {
    return; // Skip duplicate
  }

  await processPayment(message.body);
  await markProcessed(transactionId);
});
```

### 4. Monitoring and Alerting

```typescript
// Monitor queue depth
setInterval(async () => {
  const metrics = await queueService.getMetrics('critical-queue');

  if (metrics.approximateMessageCount > 1000) {
    await sendAlert('Queue depth critical', {
      queue: 'critical-queue',
      depth: metrics.approximateMessageCount,
    });
  }
}, 60000); // Check every minute
```

## Testing

```typescript
import { describe, it, expect } from 'vitest';
import { MemoryQueueService } from '@/core/services/queue';

describe('Order Processing', () => {
  it('should process orders through queue', async () => {
    const queueService = new MemoryQueueService();
    const processed: any[] = [];

    // Set up consumer
    const consumer = queueService.consume('orders', async (message) => {
      processed.push(message.body);
    });

    // Send test messages
    await queueService.send('orders', { orderId: '123', amount: 50 });
    await queueService.send('orders', { orderId: '456', amount: 100 });

    // Wait for processing
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(processed).toHaveLength(2);
    expect(processed[0].orderId).toBe('123');
    expect(processed[1].orderId).toBe('456');

    consumer.stop();
    queueService.destroy();
  });
});
```

## Troubleshooting

### Messages Not Processing

1. Check consumer is running
2. Verify queue names match
3. Check visibility timeout isn't too long
4. Look for errors in consumer logs

### High Memory Usage

1. Reduce batch size
2. Process messages faster
3. Use streaming for large payloads
4. Monitor queue depth

### Message Loss

1. Enable DLQ for critical queues
2. Log all message IDs
3. Use deduplication
4. Monitor failed message events
