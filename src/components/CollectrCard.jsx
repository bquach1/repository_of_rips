import { money } from "../utils/helpers";

export default function CollectrCard({ card }) {
  const deltaClass = card.priceDelta >= 0 ? "delta-up" : "delta-down";
  const deltaSign = card.priceDelta >= 0 ? "+" : "";

  return (
    <article className="collectr-card">
      <div className="card-image-wrap">
        <img src={card.imageUrl} alt={card.name} loading="lazy" />
      </div>

      <div className="card-body">
        <h3>{card.name}</h3>
        <p className="set-line">{card.set}</p>
        <p className="meta-line">
          <span>{card.rarity}</span>
          <span>•</span>
          <span>{card.cardNumber}</span>
        </p>
        <p className="meta-line">
          <span>{card.condition}</span>
          <span>•</span>
          <span>{card.finish}</span>
        </p>

        <div className="price-row">
          <p className="price-main">{money(card.marketPrice)}</p>
          <p className={deltaClass}>
            {deltaSign}
            {money(card.priceDelta)} ({deltaSign}
            {card.priceDeltaPercent.toFixed(2)}%)
          </p>
        </div>

        <p className="qty">Qty: {card.quantity}</p>
      </div>
    </article>
  );
}
