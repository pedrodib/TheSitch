import { useState } from 'react';
import { isValidPeriod } from '../shared/period';
import type { Period } from '../shared/types';

/** Inputs may be empty mid-edit. Only a confirmed, valid range reaches the city and IPC. */
export function CustomPeriod({ value, onChange }: { value: Period; onChange: (period: Period) => void }) {
  const [draft, setDraft] = useState<Period>({ start: value.start, end: value.end });
  const valid = isValidPeriod(draft);
  const dirty = draft.start !== value.start || draft.end !== value.end;
  const apply = () => {
    if (valid && dirty) onChange({ ...draft });
  };
  return (
    <form
      className="date-inputs custom-period"
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      <input
        aria-label="Data inicial"
        type="date"
        value={draft.start}
        max={draft.end || undefined}
        onChange={(e) => setDraft({ ...draft, start: e.target.value })}
        aria-invalid={!valid}
        aria-describedby={!valid ? 'custom-period-help' : undefined}
      />
      <span>até</span>
      <input
        aria-label="Data final"
        type="date"
        value={draft.end}
        min={draft.start || undefined}
        onChange={(e) => setDraft({ ...draft, end: e.target.value })}
        aria-invalid={!valid}
        aria-describedby={!valid ? 'custom-period-help' : undefined}
      />
      <button type="submit" className="outline-button" disabled={!valid || !dirty}>
        Aplicar
      </button>
      {!valid && (
        <small id="custom-period-help" role="status">
          Complete as datas; início até fim, com intervalo máximo de 10 anos. A cidade mantém o último período
          válido.
        </small>
      )}
    </form>
  );
}
