export function GlobalGlossaryPage({ children }) {
  return (
    <section className="feature-page meeting-center-page glossary-page" aria-labelledby="glossary-page-title">
      <div className="glossary-page-content">
        {children}
      </div>
    </section>
  );
}
