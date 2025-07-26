/**
 * Factory for creating queue service instances
 */

import type { IQueueService, IQueueProvider } from '../../interfaces/queue';
import type { EventBus } from '../../events/event-bus';

import { CloudflareQueueService } from './cloudflare-queue-service';
import { MemoryQueueService } from './memory-queue-service';
import { BaseQueueService } from './base-queue-service';

/**
 * Queue provider implementation
 */
class QueueProvider implements IQueueProvider {
  constructor(
    public name: string,
    private factory: () => IQueueService,
    private available: () => boolean,
  ) {}

  isAvailable(): boolean {
    return this.available();
  }

  getQueueService(): IQueueService {
    if (!this.isAvailable()) {
      throw new Error(`Queue provider ${this.name} is not available`);
    }
    return this.factory();
  }
}

/**
 * Queue service factory
 */
export class QueueFactory {
  private static providers = new Map<string, IQueueProvider>();
  private static defaultProvider?: string;

  /**
   * Register built-in providers
   */
  static {
    // Cloudflare Queues
    this.registerProvider(
      new QueueProvider(
        'cloudflare',
        () => new CloudflareQueueService(globalThis as Record<string, unknown>),
        () => typeof globalThis !== 'undefined' && 'Queue' in globalThis,
      ),
    );

    // Memory queue (always available)
    this.registerProvider(
      new QueueProvider(
        'memory',
        () => new MemoryQueueService(),
        () => true,
      ),
    );
  }

  /**
   * Register a queue provider
   */
  static registerProvider(provider: IQueueProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Set default provider
   */
  static setDefaultProvider(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Queue provider ${name} not found`);
    }
    this.defaultProvider = name;
  }

  /**
   * Get queue service by provider name
   */
  static getQueueService(providerName?: string, eventBus?: EventBus): IQueueService {
    const name = providerName || this.defaultProvider || this.getFirstAvailable();

    if (!name) {
      throw new Error('No queue provider available');
    }

    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(`Queue provider ${name} not found`);
    }

    const service = provider.getQueueService();

    // Inject event bus if supported
    if (eventBus && 'eventBus' in service) {
      (service as BaseQueueService).eventBus = eventBus;
    }

    return service;
  }

  /**
   * Get first available provider
   */
  private static getFirstAvailable(): string | undefined {
    for (const [name, provider] of this.providers) {
      if (provider.isAvailable()) {
        return name;
      }
    }
    return undefined;
  }

  /**
   * List all registered providers
   */
  static listProviders(): Array<{ name: string; available: boolean }> {
    return Array.from(this.providers.entries()).map(([name, provider]) => ({
      name,
      available: provider.isAvailable(),
    }));
  }

  /**
   * Create queue service with auto-detection
   */
  static createAutoDetect(eventBus?: EventBus): IQueueService {
    // Priority order
    const priorities = ['cloudflare', 'memory'];

    for (const name of priorities) {
      const provider = this.providers.get(name);
      if (provider?.isAvailable()) {
        console.info(`Auto-detected queue provider: ${name}`);
        return this.getQueueService(name, eventBus);
      }
    }

    // Fallback to memory
    console.warn('No production queue provider available, using memory queue');
    return this.getQueueService('memory', eventBus);
  }
}
