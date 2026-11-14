-- Part 1 film: the player's guess at "Out of 100 women in the US, how many have been followed?"
-- One row per locked-in guess. Only the number (0 to 100) and when it was made: no session id,
-- no words, nothing that ties a guess to a person or to a playthrough.
CREATE TABLE IF NOT EXISTS film_guesses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,                                   -- ISO 8601
  guess      INTEGER NOT NULL CHECK (guess BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS film_guesses_created ON film_guesses (created_at);
