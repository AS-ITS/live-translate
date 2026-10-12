import Redis from 'ioredis';

export class RedisRelayBus {
  constructor({ redisUrl, publisher, subscriber, RedisClass = Redis, logger = console } = {}) {
    if (!publisher && !redisUrl) throw new TypeError('RedisRelayBus requires redisUrl or publisher.');
    if (redisUrl) {
      let parsedUrl;
      try { parsedUrl = new URL(redisUrl); } catch { parsedUrl = null; }
      if (!parsedUrl || parsedUrl.protocol !== 'rediss:') throw new TypeError('RedisRelayBus requires a rediss:// URL.');
    }
    this.publisher = publisher || new RedisClass(redisUrl);
    // Pub/Sub clients cannot safely issue ordinary commands. Keep this connection dedicated to subscriptions.
    this.subscriber = subscriber || new RedisClass(redisUrl);
    this.logger = logger;
  }

  async publish(channel, packet) {
    await this.publisher.publish(channel, JSON.stringify(packet));
  }

  async subscribe(channel, onPacket, onLoss = () => {}) {
    const onMessage = (receivedChannel, raw) => {
      if (receivedChannel !== channel) return;
      try { onPacket(JSON.parse(raw)); } catch (error) { this.logger.warn?.('relay_packet_rejected', { message: error.message }); }
    };
    const onEnd = () => onLoss();
    this.subscriber.on('message', onMessage);
    this.subscriber.once('end', onEnd);
    await this.subscriber.subscribe(channel);
    return async () => {
      this.subscriber.off('message', onMessage);
      this.subscriber.off('end', onEnd);
      await this.subscriber.unsubscribe(channel);
    };
  }

  async close() {
    await Promise.all([this.publisher.quit(), this.subscriber.quit()]);
  }
}
