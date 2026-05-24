function money(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value);
}

function PortfolioStats({ cardCount, totalQuantity, totalValue, totalDelta }) {
  return (
    <section className="surface stats-grid" aria-label="Portfolio summary">
      <article>
        <h3>Total Cards</h3>
        <p>{cardCount}</p>
      </article>
      <article>
        <h3>Total Quantity</h3>
        <p>{totalQuantity}</p>
      </article>
      <article>
        <h3>Portfolio Value</h3>
        <p>{money(totalValue)}</p>
      </article>
      <article className={totalDelta >= 0 ? "delta-up" : "delta-down"}>
        <h3>Total Delta</h3>
        <p>{money(totalDelta)}</p>
      </article>
    </section>
  );
}

export default PortfolioStats;
