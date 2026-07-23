export function createGlossaryController({ glossary } = {}) {
  assertGlossary(glossary);

  return Object.freeze({
    listEntries() {
      return glossary.listEntries();
    },

    createEntry(input) {
      return glossary.createEntry(input);
    },

    updateEntry(input) {
      return glossary.updateEntry(input.id, input);
    },

    deleteEntry({ id }) {
      return glossary.deleteEntry(id);
    }
  });
}

function assertGlossary(glossary) {
  for (const methodName of ['listEntries', 'createEntry', 'updateEntry', 'deleteEntry']) {
    if (!glossary || typeof glossary[methodName] !== 'function') {
      throw new TypeError(`glossary.${methodName} must be a function.`);
    }
  }
}
