import { useMemo, useState } from 'react';

import type { TranscriptWord } from '../packages/model/src/index';

const CHUNK_SIZE = 40;

export function TranscriptNavigator({
  label,
  onSelectWord,
  selectedWordId,
  words,
}: {
  label: string;
  onSelectWord?: (wordId: string) => void;
  selectedWordId?: string;
  words: TranscriptWord[];
}) {
  const [query, setQuery] = useState('');
  const [chunkIndex, setChunkIndex] = useState(0);
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];
    return words
      .map((word, index) => ({ index, word }))
      .filter(({ word }) => word.text.toLowerCase().includes(normalized));
  }, [query, words]);
  const safeChunk = Math.min(
    chunkIndex,
    Math.max(0, Math.ceil(words.length / CHUNK_SIZE) - 1),
  );
  const start = safeChunk * CHUNK_SIZE;
  const visibleWords = words.slice(start, start + CHUNK_SIZE);
  const chunkCount = Math.max(1, Math.ceil(words.length / CHUNK_SIZE));

  function jumpToWord(index: number) {
    setChunkIndex(Math.floor(index / CHUNK_SIZE));
  }

  return (
    <section className="transcript-navigator" aria-label={label}>
      <header>
        <label>
          Find in {label.toLowerCase()}
          <input
            type="search"
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              setQuery(next);
              const first = words.findIndex((word) =>
                word.text.toLowerCase().includes(next.trim().toLowerCase()),
              );
              if (next.trim() && first >= 0) jumpToWord(first);
            }}
          />
        </label>
        <div className="transcript-chunk-controls">
          <button
            type="button"
            disabled={safeChunk === 0}
            onClick={() => setChunkIndex((current) => Math.max(0, current - 1))}
          >
            Previous chunk
          </button>
          <button
            type="button"
            disabled={safeChunk >= chunkCount - 1}
            onClick={() =>
              setChunkIndex((current) => Math.min(chunkCount - 1, current + 1))
            }
          >
            Next chunk
          </button>
        </div>
      </header>
      <p role="status" aria-live="polite">
        Words {words.length ? start + 1 : 0}–
        {Math.min(start + CHUNK_SIZE, words.length)} of {words.length}
        {query.trim() ? ` · ${matches.length} matches` : ''}
      </p>
      {matches.length ? (
        <div className="transcript-match-jumps" aria-label="Transcript matches">
          {matches.slice(0, 20).map(({ index, word }) => (
            <button
              type="button"
              key={word.id}
              onClick={() => jumpToWord(index)}
            >
              Jump to word {index + 1}
            </button>
          ))}
        </div>
      ) : null}
      <p className="transcript-chunk-copy">
        {visibleWords.map((word) => word.text).join(' ')}
      </p>
      <ol
        className="transcript-word-window"
        start={start + 1}
        data-rendered-words={visibleWords.length}
        data-total-words={words.length}
      >
        {visibleWords.map((word) => (
          <li key={word.id}>
            {onSelectWord ? (
              <button
                type="button"
                aria-pressed={selectedWordId === word.id}
                onClick={() => onSelectWord(word.id)}
              >
                {word.text}
              </button>
            ) : (
              <span>{word.text}</span>
            )}
            <small>
              {word.startMs}–{word.endMs} ms
            </small>
          </li>
        ))}
      </ol>
    </section>
  );
}
