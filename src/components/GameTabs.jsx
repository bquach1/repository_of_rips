function GameTabs({ games, selectedGame, onSelectGame }) {
  return (
    <div className="game-tabs" role="tablist" aria-label="Select card game">
      {games.map((game) => (
        <button
          key={game}
          type="button"
          role="tab"
          aria-selected={game === selectedGame}
          className={game === selectedGame ? "chip chip-active" : "chip"}
          onClick={() => onSelectGame(game)}
        >
          {game}
        </button>
      ))}
    </div>
  );
}

export default GameTabs;
