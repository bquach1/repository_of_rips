import CollectrCard from "./CollectrCard";

function CollectrCardGrid({ cards }) {
  if (!cards.length) {
    return (
      <section className="surface empty-state">
        <h2>No cards in this category</h2>
        <p>Try switching game tabs or loading a new Collectr export.</p>
      </section>
    );
  }

  return (
    <section className="card-grid" aria-label="Card collection grid">
      {cards.map((card) => (
        <CollectrCard key={card.id} card={card} />
      ))}
    </section>
  );
}

export default CollectrCardGrid;
