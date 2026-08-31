export function createGlossaryController({ glossary } = {}) {
  assertGlossary(glossary);

  return Object.freeze({
    listEntries() {
      return glossary.listEntries();
    },

    listCategories() {
      return glossary.listCategories();
    },

    createCategory(input) {
      return glossary.createCategory(input);
    },

    updateCategory(input) {
      return glossary.updateCategory(input.id, input);
    },

    reorderCategories(ids) {
      return glossary.reorderCategories(ids);
    },

    deleteCategory({ id }) {
      return glossary.deleteCategory(id);
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
  for (const methodName of ['listEntries', 'createEntry', 'updateEntry', 'deleteEntry', 'listCategories', 'createCategory', 'updateCategory', 'reorderCategories', 'deleteCategory']) {
    if (!glossary || typeof glossary[methodName] !== 'function') {
      throw new TypeError(`glossary.${methodName} must be a function.`);
    }
  }
}
