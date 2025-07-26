/**
 * Example: Queue Service Usage
 *
 * This example demonstrates various queue patterns including
 * basic messaging, priority queues, scheduled messages, and request queuing.
 */

import { Hono } from 'hono';
import { QueueFactory, MemoryQueueService } from '../src/core/services/queue';
import { createQueueProcessor, createRequestProcessor } from '../src/middleware/queue-processor';
import { EventBus } from '../src/core/events/event-bus';
import { QueueEventType } from '../src/core/interfaces/queue';

// Types
interface OrderMessage {
  orderId: string;
  userId: string;
  items: Array<{ productId: string; quantity: number }>;
  totalAmount: number;
}

interface NotificationMessage {
  userId: string;
  type: 'email' | 'sms' | 'push';
  subject: string;
  content: string;
}

// Create app with queue processing
const app = new Hono();
const eventBus = new EventBus();

// Use memory queue for demo (in production, use Cloudflare Queues)
const queueService = new MemoryQueueService();
QueueFactory.registerProvider({
  name: 'demo',
  isAvailable: () => true,
  getQueueService: () => queueService,
});

// 1. Basic Queue Operations
app.post('/api/orders', async (c) => {
  const order = await c.req.json<OrderMessage>();

  // Send to queue for processing
  const messageId = await queueService.send('orders', order, {
    priority: order.totalAmount > 100 ? 10 : 5, // Higher priority for large orders
    metadata: {
      source: 'api',
      timestamp: Date.now(),
    },
  });

  return c.json({
    status: 'queued',
    messageId,
    estimatedProcessingTime: '2-5 minutes',
  });
});

// 2. Scheduled Messages
app.post('/api/reminders', async (c) => {
  const { userId, message, sendAt } = await c.req.json();

  const deliveryTime = new Date(sendAt);
  const messageId = await queueService.schedule(
    'reminders',
    {
      userId,
      message,
      type: 'reminder',
    },
    deliveryTime,
  );

  return c.json({
    status: 'scheduled',
    messageId,
    scheduledFor: deliveryTime.toISOString(),
  });
});

// 3. Batch Operations
app.post('/api/notifications/broadcast', async (c) => {
  const { userIds, notification } = await c.req.json();

  // Create messages for each user
  const messages: NotificationMessage[] = userIds.map((userId: string) => ({
    userId,
    type: notification.type,
    subject: notification.subject,
    content: notification.content,
  }));

  // Send in batch
  const result = await queueService.sendBatch('notifications', messages, {
    metadata: { campaign: 'broadcast', timestamp: Date.now() },
  });

  return c.json({
    sent: result.successful.length,
    failed: result.failed.length,
    details: result.failed,
  });
});

// 4. Queue Processor Middleware for Heavy Tasks
app.use(
  '/api/reports/*',
  createQueueProcessor({
    queueService: 'demo',
    asyncRoutes: /^\/api\/reports\/generate/,
    queuedResponse: (requestId) =>
      new Response(
        JSON.stringify({
          status: 'processing',
          requestId,
          message: 'Report generation started',
          trackUrl: `/api/reports/status/${requestId}`,
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    getPriority: (c) => {
      const isPremium = c.req.header('X-Premium-User') === 'true';
      return isPremium ? 100 : 10;
    },
    eventBus,
  }),
);

// 5. Dead Letter Queue Setup
app.post('/api/setup-dlq', async (c) => {
  // Configure DLQ for critical queues
  await queueService.configureDLQ('orders', {
    queueName: 'orders-dlq',
    maxReceiveCount: 3,
  });

  await queueService.configureDLQ('payments', {
    queueName: 'payments-dlq',
    maxReceiveCount: 2, // More strict for payments
  });

  return c.json({ status: 'configured' });
});

// 6. Queue Metrics Dashboard
app.get('/api/queues/metrics', async (c) => {
  const queues = ['orders', 'notifications', 'reminders', 'reports'];
  const metrics: Record<string, any> = {};

  for (const queue of queues) {
    try {
      const queueMetrics = await queueService.getMetrics(queue);
      metrics[queue] = {
        pending: queueMetrics.approximateMessageCount,
        processing: queueMetrics.approximateMessageNotVisibleCount,
        created: new Date(queueMetrics.createdTimestamp || Date.now()).toISOString(),
        lastModified: new Date(queueMetrics.lastModifiedTimestamp || Date.now()).toISOString(),
      };
    } catch {
      metrics[queue] = { status: 'no data' };
    }
  }

  return c.json(metrics);
});

// 7. Message Visibility Control
app.post('/api/messages/:messageId/extend', async (c) => {
  const { messageId } = c.req.param();
  const { queueName, additionalSeconds } = await c.req.json();

  await queueService.changeVisibility(queueName, messageId, additionalSeconds);

  return c.json({
    status: 'extended',
    newVisibilityTimeout: additionalSeconds,
  });
});

// 8. Event Monitoring
eventBus.on(QueueEventType.MESSAGE_SENT, (event) => {
  console.log(`📤 Message sent to ${event.queueName}: ${event.messageId}`);
});

eventBus.on(QueueEventType.MESSAGE_PROCESSED, (event) => {
  console.log(`✅ Message processed from ${event.queueName}: ${event.messageId}`);
});

eventBus.on(QueueEventType.MESSAGE_FAILED, (event) => {
  console.error(`❌ Message failed in ${event.queueName}: ${event.error?.message}`);
});

eventBus.on(QueueEventType.MESSAGE_DLQ, (event) => {
  console.warn(`⚠️ Message moved to DLQ from ${event.queueName}: ${event.messageId}`);
});

// Queue Consumers
const startConsumers = () => {
  // Order processor
  const orderConsumer = queueService.consume<OrderMessage>(
    'orders',
    async (message) => {
      console.log(`Processing order ${message.body.orderId}`);

      // Simulate processing
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Simulate occasional failures
      if (Math.random() < 0.1) {
        throw new Error('Payment gateway timeout');
      }

      console.log(`Order ${message.body.orderId} completed`);
    },
    { maxMessages: 5, visibilityTimeout: 300 },
  );

  // Notification processor
  const notificationConsumer = queueService.consume<NotificationMessage>(
    'notifications',
    async (message) => {
      const { userId, type, subject } = message.body;
      console.log(`Sending ${type} notification to ${userId}: ${subject}`);

      // Simulate sending
      await new Promise((resolve) => setTimeout(resolve, 500));
    },
    { maxMessages: 10, waitTimeSeconds: 5 },
  );

  // Reminder processor
  const reminderConsumer = queueService.consume(
    'reminders',
    async (message) => {
      console.log(`Sending reminder to ${message.body.userId}: ${message.body.message}`);
    },
    { maxMessages: 1 },
  );

  // DLQ processor
  const dlqConsumer = queueService.consume('orders-dlq', async (message) => {
    console.error(`Processing failed order from DLQ: ${JSON.stringify(message.body)}`);
    // Send to manual review, alert admins, etc.
  });

  return {
    stop: () => {
      orderConsumer.stop();
      notificationConsumer.stop();
      reminderConsumer.stop();
      dlqConsumer.stop();
    },
  };
};

// Request processor for queued API requests
const requestProcessor = createRequestProcessor(
  async (request) => {
    console.log(`Processing queued request: ${request.method} ${request.url}`);

    // In real app, this would process the actual request
    return new Response(
      JSON.stringify({
        status: 'completed',
        requestId: request.headers.get('X-Request-ID'),
        processedAt: new Date().toISOString(),
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      },
    );
  },
  {
    queueService,
    concurrency: 3,
    eventBus,
  },
);

// Example HTML Dashboard
app.get('/', (c) => {
  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Queue Service Example</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 40px; }
        .section { margin: 20px 0; padding: 20px; border: 1px solid #ddd; }
        button { margin: 5px; padding: 10px; }
        .metrics { background: #f5f5f5; padding: 10px; margin: 10px 0; }
        .log { background: #000; color: #0f0; padding: 10px; height: 200px; overflow-y: auto; font-family: monospace; }
      </style>
    </head>
    <body>
      <h1>Queue Service Example</h1>
      
      <div class="section">
        <h2>Send Order</h2>
        <button onclick="sendOrder()">Send Order to Queue</button>
        <button onclick="sendPriorityOrder()">Send Priority Order</button>
      </div>
      
      <div class="section">
        <h2>Schedule Reminder</h2>
        <input type="text" id="reminderMessage" placeholder="Reminder message" value="Check your appointment">
        <input type="number" id="delayMinutes" placeholder="Delay (minutes)" value="1">
        <button onclick="scheduleReminder()">Schedule</button>
      </div>
      
      <div class="section">
        <h2>Broadcast Notification</h2>
        <input type="text" id="notificationSubject" placeholder="Subject" value="Special Offer">
        <button onclick="broadcastNotification()">Broadcast to 10 Users</button>
      </div>
      
      <div class="section">
        <h2>Queue Metrics</h2>
        <button onclick="loadMetrics()">Refresh Metrics</button>
        <div id="metrics" class="metrics">Loading...</div>
      </div>
      
      <div class="section">
        <h2>Console Log</h2>
        <div id="log" class="log"></div>
      </div>
      
      <script>
        // Simple console capture
        const logDiv = document.getElementById('log');
        const originalLog = console.log;
        console.log = function(...args) {
          originalLog.apply(console, args);
          logDiv.innerHTML += args.join(' ') + '\\n';
          logDiv.scrollTop = logDiv.scrollHeight;
        };
        
        async function sendOrder() {
          const order = {
            orderId: 'ORD-' + Date.now(),
            userId: 'user123',
            items: [
              { productId: 'PROD-1', quantity: 2 },
              { productId: 'PROD-2', quantity: 1 }
            ],
            totalAmount: 49.99
          };
          
          const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(order)
          });
          
          const result = await response.json();
          console.log('Order queued:', result.messageId);
        }
        
        async function sendPriorityOrder() {
          const order = {
            orderId: 'ORD-PRIORITY-' + Date.now(),
            userId: 'vip-user',
            items: [{ productId: 'PROD-VIP', quantity: 1 }],
            totalAmount: 299.99
          };
          
          const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(order)
          });
          
          const result = await response.json();
          console.log('Priority order queued:', result.messageId);
        }
        
        async function scheduleReminder() {
          const message = document.getElementById('reminderMessage').value;
          const delayMinutes = parseInt(document.getElementById('delayMinutes').value);
          const sendAt = new Date(Date.now() + delayMinutes * 60000);
          
          const response = await fetch('/api/reminders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userId: 'user123',
              message,
              sendAt: sendAt.toISOString()
            })
          });
          
          const result = await response.json();
          console.log('Reminder scheduled for', sendAt.toLocaleTimeString());
        }
        
        async function broadcastNotification() {
          const subject = document.getElementById('notificationSubject').value;
          const userIds = Array.from({length: 10}, (_, i) => \`user\${i + 1}\`);
          
          const response = await fetch('/api/notifications/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userIds,
              notification: {
                type: 'email',
                subject,
                content: 'Check out our latest deals!'
              }
            })
          });
          
          const result = await response.json();
          console.log(\`Broadcast sent: \${result.sent} success, \${result.failed} failed\`);
        }
        
        async function loadMetrics() {
          const response = await fetch('/api/queues/metrics');
          const metrics = await response.json();
          
          const metricsDiv = document.getElementById('metrics');
          metricsDiv.innerHTML = '<pre>' + JSON.stringify(metrics, null, 2) + '</pre>';
        }
        
        // Auto-refresh metrics
        setInterval(loadMetrics, 5000);
        loadMetrics();
      </script>
    </body>
    </html>
  `);
});

// Start everything
const consumers = startConsumers();

export default app;

// Cleanup on shutdown
if (typeof process !== 'undefined') {
  process.on('SIGTERM', () => {
    consumers.stop();
    requestProcessor.stop();
    queueService.destroy();
  });
}
