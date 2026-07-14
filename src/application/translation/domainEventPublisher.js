export function createTranslationDomainEventPublisher() {
  return Object.freeze({
    publish() {
      throw new Error('Translation domain event publisher is not implemented');
    }
  });
}
