'use client';

import { Checkbox } from '@/components/ui/field';
import { TextField } from '@/components/ui/form';

/** O que levar ao cliente na retirada (aparece na agenda). */
export interface PickupTake {
  bringSamples: boolean;
  samplesDescription: string;
  bringCardMachine: boolean;
}

export const emptyPickupTake: PickupTake = {
  bringSamples: false,
  samplesDescription: '',
  bringCardMachine: false,
};

/** Corpo da API: descrição só vai quando leva mostruário. */
export function pickupTakeBody(v: PickupTake) {
  return {
    bringSamples: v.bringSamples,
    samplesDescription: v.bringSamples ? v.samplesDescription.trim() || null : null,
    bringCardMachine: v.bringCardMachine,
  };
}

export function PickupTakeFields({
  value,
  onChange,
  error,
}: {
  value: PickupTake;
  onChange: (v: PickupTake) => void;
  error?: string;
}) {
  return (
    <fieldset className="space-y-3" data-testid="pickup-take">
      <legend className="mb-2 text-sm font-semibold">Levar ao cliente</legend>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Checkbox
          label="Mostruário"
          checked={value.bringSamples}
          onChange={(e) => onChange({ ...value, bringSamples: e.target.checked })}
          data-testid="pickup-bring-samples"
        />
        <Checkbox
          label="Maquininha de cartão"
          checked={value.bringCardMachine}
          onChange={(e) => onChange({ ...value, bringCardMachine: e.target.checked })}
          data-testid="pickup-bring-card-machine"
        />
      </div>
      {value.bringSamples && (
        <TextField
          label="Qual mostruário"
          placeholder="Ex.: mostruário de veludos, catálogo de couros"
          maxLength={200}
          error={error}
          value={value.samplesDescription}
          onChange={(e) => onChange({ ...value, samplesDescription: e.target.value })}
          data-testid="pickup-samples-description"
        />
      )}
    </fieldset>
  );
}
