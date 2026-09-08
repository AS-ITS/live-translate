export function GlobalGlossaryPage({ children, GlossaryPanel, entries, onEntriesChange }) {
  return (
    <section className="feature-page meeting-center-page glossary-page" aria-labelledby="glossary-page-title">
      <div className="glossary-page-content">
        {children || (GlossaryPanel ? <GlossaryPanel entries={entries} onEntriesChange={onEntriesChange} /> : null)}
      </div>
    </section>
  );
}
