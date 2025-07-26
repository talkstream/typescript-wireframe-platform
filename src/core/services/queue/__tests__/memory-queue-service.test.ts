import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { MemoryQueueService } from '../memory-queue-service';
import type { IQueueMessage } from '../../../interfaces/queue';

describe('MemoryQueueService', () => {
  let service: MemoryQueueService;

  beforeEach(() => {
    service = new MemoryQueueService();
  });

  afterEach(() => {
    service.destroy();
  });

  describe('basic operations', () => {
    it('should send and receive messages', async () => {
      const message = { data: 'test' };
      const messageId = await service.send('test-queue', message);

      expect(messageId).toBeTruthy();

      const messages = await service.receive<typeof message>('test-queue');
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toEqual(message);
      expect(messages[0].id).toBeTruthy();
      expect(messages[0].timestamp).toBeGreaterThan(0);
    });

    it('should receive multiple messages', async () => {
      await service.send('test-queue', { num: 1 });
      await service.send('test-queue', { num: 2 });
      await service.send('test-queue', { num: 3 });

      const messages = await service.receive('test-queue', { maxMessages: 2 });
      expect(messages).toHaveLength(2);
      expect(messages[0].body).toEqual({ num: 1 });
      expect(messages[1].body).toEqual({ num: 2 });

      const remaining = await service.receive('test-queue');
      expect(remaining).toHaveLength(1);
      expect(remaining[0].body).toEqual({ num: 3 });
    });

    it('should handle delayed messages', async () => {
      await service.send('test-queue', { data: 'delayed' }, { delaySeconds: 1 });

      // Should not receive immediately
      const immediate = await service.receive('test-queue');
      expect(immediate).toHaveLength(0);

      // Wait for delay
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const delayed = await service.receive('test-queue');
      expect(delayed).toHaveLength(1);
      expect(delayed[0].body).toEqual({ data: 'delayed' });
    });

    it('should delete messages', async () => {
      await service.send('test-queue', { data: 'test' });
      const messages = await service.receive('test-queue');
      expect(messages).toHaveLength(1);

      await service.delete('test-queue', messages[0].id);

      // Message should not become visible again
      await new Promise((resolve) => setTimeout(resolve, 100));
      const remaining = await service.receive('test-queue');
      expect(remaining).toHaveLength(0);
    });
  });

  describe('priority messages', () => {
    it('should process higher priority messages first', async () => {
      await service.send('test-queue', { msg: 'low' }, { priority: 1 });
      await service.send('test-queue', { msg: 'high' }, { priority: 10 });
      await service.send('test-queue', { msg: 'medium' }, { priority: 5 });

      const messages = await service.receive('test-queue', { maxMessages: 3 });
      expect(messages[0].body).toEqual({ msg: 'high' });
      expect(messages[1].body).toEqual({ msg: 'medium' });
      expect(messages[2].body).toEqual({ msg: 'low' });
    });
  });

  describe('deduplication', () => {
    it('should prevent duplicate messages', async () => {
      const dedupId = 'unique-123';

      await service.send('test-queue', { msg: 'first' }, { deduplicationId: dedupId });
      await service.send('test-queue', { msg: 'duplicate' }, { deduplicationId: dedupId });
      await service.send('test-queue', { msg: 'different' });

      const messages = await service.receive('test-queue', { maxMessages: 10 });
      expect(messages).toHaveLength(2);
      expect(messages[0].body).toEqual({ msg: 'first' });
      expect(messages[1].body).toEqual({ msg: 'different' });
    });
  });

  describe('visibility timeout', () => {
    it('should make messages invisible during processing', async () => {
      await service.send('test-queue', { data: 'test' });

      const messages = await service.receive('test-queue', { visibilityTimeout: 1 });
      expect(messages).toHaveLength(1);

      // Should not be visible immediately
      const immediate = await service.receive('test-queue');
      expect(immediate).toHaveLength(0);

      // Should become visible after timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const visible = await service.receive('test-queue');
      expect(visible).toHaveLength(1);
    });

    it('should change visibility timeout', async () => {
      await service.send('test-queue', { data: 'test' });
      const messages = await service.receive('test-queue', { visibilityTimeout: 10 });

      // Extend visibility
      await service.changeVisibility('test-queue', messages[0].id, 1);

      // Should become visible after new timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const visible = await service.receive('test-queue');
      expect(visible).toHaveLength(1);
    });
  });

  describe('batch operations', () => {
    it('should send batch messages', async () => {
      const messages = [{ num: 1 }, { num: 2 }, { num: 3 }];
      const result = await service.sendBatch('test-queue', messages);

      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);

      const received = await service.receive('test-queue', { maxMessages: 10 });
      expect(received).toHaveLength(3);
    });

    it('should delete batch messages', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push(await service.send('test-queue', { num: i }));
      }

      const messages = await service.receive('test-queue', { maxMessages: 10 });
      const messageIds = messages.map((m) => m.id);

      const result = await service.deleteBatch('test-queue', messageIds);
      expect(result.successful).toHaveLength(3);
      expect(result.failed).toHaveLength(0);
    });
  });

  describe('dead letter queue', () => {
    it('should move messages to DLQ after max receives', async () => {
      await service.configureDLQ('test-queue', {
        queueName: 'test-dlq',
        maxReceiveCount: 2,
      });

      await service.send('test-queue', { data: 'test' });

      // First receive
      let messages = await service.receive('test-queue');
      expect(messages).toHaveLength(1);
      await service.changeVisibility('test-queue', messages[0].id, 0);

      // Second receive
      messages = await service.receive('test-queue');
      expect(messages).toHaveLength(1);
      await service.changeVisibility('test-queue', messages[0].id, 0);

      // Third receive should move to DLQ
      messages = await service.receive('test-queue');
      expect(messages).toHaveLength(0);

      // Check DLQ
      const dlqMessages = await service.receive('test-dlq');
      expect(dlqMessages).toHaveLength(1);
      expect(dlqMessages[0].body).toEqual({ data: 'test' });
      expect(dlqMessages[0].metadata?.originalQueue).toBe('test-queue');
    });
  });

  describe('scheduled messages', () => {
    it('should schedule messages for future delivery', async () => {
      const futureTime = new Date(Date.now() + 1000);
      const messageId = await service.schedule('test-queue', { data: 'scheduled' }, futureTime);

      expect(messageId).toBeTruthy();

      // Should not be available immediately
      const immediate = await service.receive('test-queue');
      expect(immediate).toHaveLength(0);

      // Wait for scheduled time
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const scheduled = await service.receive('test-queue');
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0].body).toEqual({ data: 'scheduled' });
    });

    it('should list scheduled messages', async () => {
      const future1 = new Date(Date.now() + 1000);
      const future2 = new Date(Date.now() + 2000);

      await service.schedule('test-queue', { msg: 'first' }, future1);
      await service.schedule('test-queue', { msg: 'second' }, future2);

      const scheduled = await service.listScheduled('test-queue');
      expect(scheduled).toHaveLength(2);
    });

    it('should cancel scheduled messages', async () => {
      const futureTime = new Date(Date.now() + 1000);
      const messageId = await service.schedule('test-queue', { data: 'scheduled' }, futureTime);

      await service.cancelScheduled('test-queue', messageId);

      // Wait for scheduled time
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const messages = await service.receive('test-queue');
      expect(messages).toHaveLength(0);
    });
  });

  describe('metrics', () => {
    it('should return queue metrics', async () => {
      await service.send('test-queue', { num: 1 });
      await service.send('test-queue', { num: 2 });
      await service.send('test-queue', { num: 3 });

      const messages = await service.receive('test-queue', { maxMessages: 1 });
      expect(messages).toHaveLength(1);

      const metrics = await service.getMetrics('test-queue');
      expect(metrics.approximateMessageCount).toBe(2);
      expect(metrics.approximateMessageNotVisibleCount).toBe(1);
      expect(metrics.createdTimestamp).toBeGreaterThan(0);
      expect(metrics.lastModifiedTimestamp).toBeGreaterThan(0);
    });
  });

  describe('consumer', () => {
    it('should consume messages', async () => {
      const processed: IQueueMessage[] = [];
      const handler = vi.fn(async (message: IQueueMessage) => {
        processed.push(message);
      });

      const consumer = service.consume('test-queue', handler, {
        waitTimeSeconds: 0.1,
      });

      await service.send('test-queue', { data: 'test1' });
      await service.send('test-queue', { data: 'test2' });

      // Wait for processing
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(handler).toHaveBeenCalledTimes(2);
      expect(processed).toHaveLength(2);
      expect(processed[0].body).toEqual({ data: 'test1' });
      expect(processed[1].body).toEqual({ data: 'test2' });

      consumer.stop();
    });

    it('should handle consumer errors', async () => {
      const handler = vi.fn(async () => {
        throw new Error('Processing failed');
      });

      const consumer = service.consume('test-queue', handler, {
        waitTimeSeconds: 0.1,
      });

      await service.send('test-queue', { data: 'test' });

      // Wait for processing attempt
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(handler).toHaveBeenCalled();

      // Message should still be in queue (not deleted)
      consumer.stop();

      // Make message visible again
      const messages = await service.receive('test-queue');
      expect(messages).toHaveLength(0); // Still invisible due to error
    });
  });

  describe('advanced features', () => {
    it('should move messages between queues', async () => {
      await service.send('source-queue', { data: 'test' });
      const messages = await service.receive('source-queue');

      await service.moveMessage('source-queue', 'target-queue', messages[0].id);

      // Check target queue
      const targetMessages = await service.receive('target-queue');
      expect(targetMessages).toHaveLength(1);
      expect(targetMessages[0].body).toEqual({ data: 'test' });
      expect(targetMessages[0].metadata?.movedFrom).toBe('source-queue');
    });

    it('should retry failed messages', async () => {
      await service.send('test-queue', { data: 'test1' });
      await service.send('test-queue', { data: 'test2' });

      const messages = await service.receive('test-queue', { maxMessages: 2 });
      const messageIds = messages.map((m) => m.id);

      // Retry messages
      const result = await service.retryFailedMessages('test-queue', messageIds);
      expect(result.successful).toHaveLength(2);

      // Messages should be visible again
      const retried = await service.receive('test-queue', { maxMessages: 2 });
      expect(retried).toHaveLength(2);
    });

    it('should purge queue', async () => {
      await service.send('test-queue', { num: 1 });
      await service.send('test-queue', { num: 2 });
      await service.send('test-queue', { num: 3 });

      await service.purge('test-queue');

      const messages = await service.receive('test-queue', { maxMessages: 10 });
      expect(messages).toHaveLength(0);
    });
  });
});
