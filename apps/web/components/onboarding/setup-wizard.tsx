'use client';

import {
  SETUP_CARD_FEES_BPS,
  SETUP_FABRICS,
  SETUP_FOAMS,
  SETUP_KM_SUGGESTED_CENTS,
  SETUP_PIECES,
  type SetupAnswers,
  type SetupPieceKey,
} from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Check, ImagePlus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert, Card } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api } from '@/lib/api';
import { BR_CITIES } from '@/lib/br-cities';

/**
 * Perguntas do primeiro acesso (item 2 da lista de 26/11/2026). Uma pergunta por tela, com
 * respostas de tocar. No fim, o sistema monta sozinho a base do orçamento, o frete, a
 * maquininha, o imposto, o horário, o prazo, a logo da proposta e a meta do mês.
 */

const centsText = (c: number | null) =>
  c === null ? '' : (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
const parseCents = (s: string): number | null => {
  const t = s.replace(/[^\d,]/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const DAYS = [
  [1, 'Seg'],
  [2, 'Ter'],
  [3, 'Qua'],
  [4, 'Qui'],
  [5, 'Sex'],
  [6, 'Sáb'],
  [0, 'Dom'],
] as const;

function Chip({
  on,
  onClick,
  children,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      data-testid={testId}
      onClick={onClick}
      className={clsx(
        'inline-flex min-h-12 items-center gap-2 rounded-xl border px-4 text-[15px] font-medium transition-colors',
        on
          ? 'border-brand-700 bg-brand-50 text-brand-800'
          : 'border-line-strong bg-surface text-ink hover:bg-subtle',
      )}
    >
      {on && <Check className="size-4" aria-hidden />}
      {children}
    </button>
  );
}

function Money({
  value,
  onChange,
  label,
  suffix,
}: {
  value: number | null;
  onChange: (c: number | null) => void;
  label: string;
  suffix?: string;
}) {
  const [text, setText] = useState(centsText(value));
  return (
    <label className="flex items-center gap-2">
      <span className="text-sm text-ink-muted">R$</span>
      <Input
        aria-label={label}
        inputMode="decimal"
        className="w-32"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseCents(e.target.value));
        }}
        onBlur={() => setText(centsText(parseCents(text)))}
      />
      {suffix && <span className="text-sm text-ink-muted">{suffix}</span>}
    </label>
  );
}

function CityPicker({
  onPick,
  exclude,
  placeholder,
}: {
  onPick: (c: string) => void;
  exclude: string[];
  placeholder: string;
}) {
  const [q, setQ] = useState('');
  const found = useMemo(() => {
    const n = norm(q.trim());
    return n.length < 2
      ? []
      : BR_CITIES.filter((c) => norm(c).includes(n) && !exclude.includes(c)).slice(0, 8);
  }, [q, exclude]);
  return (
    <div>
      <Input
        value={q}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
      />
      {found.length > 0 && (
        <ul className="mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line">
          {found.map((c) => (
            <li key={c}>
              <button
                type="button"
                className="w-full px-4 py-3 text-left text-[15px] hover:bg-subtle"
                onClick={() => {
                  onPick(c);
                  setQ('');
                }}
              >
                {c}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Reduz a logo para no máximo 600 px e devolve em data URL (PNG). */
async function logoToDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('Não foi possível abrir a imagem.'));
      i.src = url;
    });
    const scale = Math.min(1, 600 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Draft = Omit<SetupAnswers, 'fabrics' | 'foams'> & {
  fabrics: Record<string, number | null>;
  foams: Record<string, number | null>;
};

const INITIAL: Draft = {
  pieces: [],
  fabrics: {},
  foams: Object.fromEntries(SETUP_FOAMS.map((f) => [f.name, f.suggestedCents])),
  logistics: { mode: 'KM', valueCents: SETUP_KM_SUGGESTED_CENTS },
  onSite: false,
  city: '',
  servedCities: [],
  maxInstallments: 3,
  taxRegime: 'SIMPLES',
  workingDays: [1, 2, 3, 4, 5],
  workdayStart: '08:00',
  workdayEnd: '18:00',
  leadDays: 15,
  teamSize: 2,
  logoDataUrl: null,
  monthlyGoalCents: null,
};

export function SetupWizard() {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [d, setD] = useState<Draft>(INITIAL);
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));
  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const steps: { title: string; hint?: string; ready: boolean; body: React.ReactNode }[] = [
    {
      title: 'Que peças você mais faz?',
      hint: 'Marque todas. Cada uma entra na sua tabela de mão de obra, e o preço você coloca depois.',
      ready: d.pieces.length > 0,
      body: (
        <div className="flex flex-wrap gap-2">
          {SETUP_PIECES.map((p) => (
            <Chip
              key={p.key}
              testId={`peca-${p.key}`}
              on={d.pieces.includes(p.key)}
              onClick={() => set({ pieces: toggle<SetupPieceKey>(d.pieces, p.key) })}
            >
              {p.label}
            </Chip>
          ))}
        </div>
      ),
    },
    {
      title: 'Quais tecidos você usa e quanto paga no metro?',
      hint: 'O preço já vem com um valor médio. Troque pelo que você paga.',
      ready: true,
      body: (
        <div className="space-y-3">
          {SETUP_FABRICS.map((f) => {
            const on = f.name in d.fabrics;
            return (
              <div key={f.name} className="flex flex-wrap items-center gap-3">
                <Chip
                  on={on}
                  onClick={() => {
                    const next = { ...d.fabrics };
                    if (on) delete next[f.name];
                    else next[f.name] = f.suggestedCents;
                    set({ fabrics: next });
                  }}
                >
                  {f.name}
                </Chip>
                {on && (
                  <Money
                    label={`Preço do metro de ${f.name}`}
                    value={d.fabrics[f.name] ?? null}
                    suffix="o metro"
                    onChange={(c) => set({ fabrics: { ...d.fabrics, [f.name]: c } })}
                  />
                )}
              </div>
            );
          })}
        </div>
      ),
    },
    {
      title: 'Quanto você paga na espuma?',
      hint: 'Preço do metro cúbico. Já vem um valor médio.',
      ready: true,
      body: (
        <div className="space-y-3">
          {SETUP_FOAMS.map((f) => (
            <div key={f.name} className="flex items-center gap-3">
              <span className="w-12 font-semibold">{f.name}</span>
              <Money
                label={`Preço do metro cúbico da ${f.name}`}
                value={d.foams[f.name] ?? null}
                suffix="o m³"
                onChange={(c) => set({ foams: { ...d.foams, [f.name]: c } })}
              />
            </div>
          ))}
        </div>
      ),
    },
    {
      title: 'Você faz retirada e entrega? Como cobra?',
      ready: d.logistics.mode === 'NAO' || d.logistics.valueCents !== null,
      body: (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Chip
              on={d.logistics.mode === 'KM'}
              onClick={() =>
                set({ logistics: { mode: 'KM', valueCents: SETUP_KM_SUGGESTED_CENTS } })
              }
            >
              Cobro por km rodado
            </Chip>
            <Chip
              on={d.logistics.mode === 'FIXO'}
              onClick={() => set({ logistics: { mode: 'FIXO', valueCents: 8000 } })}
            >
              Cobro um valor fixo
            </Chip>
            <Chip
              on={d.logistics.mode === 'NAO'}
              onClick={() => set({ logistics: { mode: 'NAO', valueCents: null } })}
            >
              Não faço
            </Chip>
          </div>
          {d.logistics.mode !== 'NAO' && (
            <div className="space-y-1">
              <Money
                key={d.logistics.mode}
                label={d.logistics.mode === 'KM' ? 'Valor do km rodado' : 'Valor do frete'}
                value={d.logistics.valueCents}
                suffix={d.logistics.mode === 'KM' ? 'por km' : 'por frete'}
                onChange={(c) => set({ logistics: { ...d.logistics, valueCents: c } })}
              />
              <p className="text-sm text-ink-muted">
                {d.logistics.mode === 'KM'
                  ? 'O sistema calcula a distância de cada cidade sozinho e cobra a ida e a volta.'
                  : 'O mesmo valor para todas as cidades que você atende.'}
              </p>
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Você faz serviço na casa do cliente?',
      hint: 'Por exemplo, trocar o tecido de cadeiras sem levar para a oficina.',
      ready: true,
      body: (
        <div className="flex flex-wrap gap-2">
          <Chip on={d.onSite} onClick={() => set({ onSite: true })}>
            Sim, às vezes
          </Chip>
          <Chip on={!d.onSite} onClick={() => set({ onSite: false })}>
            Não
          </Chip>
        </div>
      ),
    },
    {
      title:
        d.logistics.mode === 'NAO'
          ? 'Em que cidade fica a oficina?'
          : 'Em que cidade fica a oficina e quais cidades você atende?',
      ready: d.city !== '',
      body: (
        <div className="space-y-4">
          {d.city ? (
            <div className="flex items-center gap-2">
              <span className="font-semibold">Oficina em {d.city}</span>
              <Button size="sm" variant="ghost" onClick={() => set({ city: '' })}>
                Trocar
              </Button>
            </div>
          ) : (
            <CityPicker
              placeholder="Digite a cidade da oficina"
              exclude={[]}
              onPick={(c) => set({ city: c, servedCities: d.servedCities.filter((x) => x !== c) })}
            />
          )}
          {d.city && d.logistics.mode !== 'NAO' && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-ink-soft">Outras cidades que você atende</p>
              {d.servedCities.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {d.servedCities.map((c) => (
                    <span
                      key={c}
                      className="inline-flex items-center gap-1 rounded-full bg-subtle px-3 py-1.5 text-sm"
                    >
                      {c}
                      <button
                        type="button"
                        aria-label={`Tirar ${c}`}
                        onClick={() => set({ servedCities: d.servedCities.filter((x) => x !== c) })}
                      >
                        <X className="size-4" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <CityPicker
                placeholder="Digite para acrescentar uma cidade"
                exclude={[d.city, ...d.servedCities]}
                onPick={(c) => set({ servedCities: [...d.servedCities, c] })}
              />
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Em até quantas vezes você aceita cartão?',
      hint: 'O sistema monta as taxas da maquininha com a média do mercado. Depois você confere com a sua.',
      ready: true,
      body: (
        <div className="flex flex-wrap gap-2">
          {Object.keys(SETUP_CARD_FEES_BPS).map((k) => {
            const n = Number(k);
            return (
              <Chip
                key={n}
                on={d.maxInstallments === n}
                onClick={() => set({ maxInstallments: n })}
              >
                {n === 1 ? 'Só à vista' : `${n}x`}
              </Chip>
            );
          })}
        </div>
      ),
    },
    {
      title: 'A sua empresa é MEI ou Simples?',
      hint: 'É para colocar o imposto certo no orçamento.',
      ready: true,
      body: (
        <div className="flex flex-wrap gap-2">
          <Chip on={d.taxRegime === 'MEI'} onClick={() => set({ taxRegime: 'MEI' })}>
            MEI
          </Chip>
          <Chip on={d.taxRegime === 'SIMPLES'} onClick={() => set({ taxRegime: 'SIMPLES' })}>
            Simples
          </Chip>
          <Chip on={d.taxRegime === 'NAO_SEI'} onClick={() => set({ taxRegime: 'NAO_SEI' })}>
            Não sei agora
          </Chip>
        </div>
      ),
    },
    {
      title: 'Em que dias e horário a oficina trabalha?',
      ready: d.workingDays.length > 0 && d.workdayStart < d.workdayEnd,
      body: (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {DAYS.map(([n, label]) => (
              <Chip
                key={n}
                on={d.workingDays.includes(n)}
                onClick={() => set({ workingDays: toggle(d.workingDays, n) })}
              >
                {label}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2">
              <span className="text-sm text-ink-muted">Das</span>
              <Input
                type="time"
                className="w-32"
                value={d.workdayStart}
                onChange={(e) => set({ workdayStart: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="text-sm text-ink-muted">às</span>
              <Input
                type="time"
                className="w-32"
                value={d.workdayEnd}
                onChange={(e) => set({ workdayEnd: e.target.value })}
              />
            </label>
          </div>
        </div>
      ),
    },
    {
      title: 'Em quantos dias você costuma entregar uma reforma?',
      hint: 'Já vem preenchido em todo orçamento novo. Dá para mudar em cada um.',
      ready: d.leadDays > 0,
      body: (
        <div className="flex flex-wrap items-center gap-2">
          {[7, 10, 15, 20, 30].map((n) => (
            <Chip key={n} on={d.leadDays === n} onClick={() => set({ leadDays: n })}>
              {n} dias
            </Chip>
          ))}
          <label className="flex items-center gap-2">
            <span className="text-sm text-ink-muted">Outro:</span>
            <Input
              inputMode="numeric"
              className="w-20"
              aria-label="Outro prazo em dias"
              value={[7, 10, 15, 20, 30].includes(d.leadDays) ? '' : String(d.leadDays)}
              onChange={(e) => {
                const n = Number(e.target.value.replace(/\D/g, ''));
                if (n > 0 && n <= 180) set({ leadDays: n });
              }}
            />
          </label>
        </div>
      ),
    },
    {
      title: 'Quantas pessoas trabalham na oficina, contando você?',
      ready: d.teamSize > 0,
      body: (
        <div className="flex flex-wrap gap-2">
          {[
            [1, 'Só eu'],
            [2, '2'],
            [3, '3'],
            [5, '4 a 6'],
            [8, '7 a 10'],
            [12, 'Mais de 10'],
          ].map(([n, label]) => (
            <Chip key={n} on={d.teamSize === n} onClick={() => set({ teamSize: n as number })}>
              {label}
            </Chip>
          ))}
        </div>
      ),
    },
    {
      title: 'Quer colocar a logo da tapeçaria?',
      hint: 'Ela sai na proposta que o cliente recebe. Se não tiver agora, pode pular.',
      ready: true,
      body: (
        <div className="flex flex-wrap items-center gap-4">
          {d.logoDataUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={d.logoDataUrl}
              alt="Logo escolhida"
              className="size-24 rounded-xl border border-line object-contain"
            />
          )}
          <label className="inline-flex h-12 cursor-pointer items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 font-semibold hover:bg-subtle">
            <ImagePlus className="size-5" aria-hidden />
            {d.logoDataUrl ? 'Trocar a logo' : 'Escolher a logo'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  set({ logoDataUrl: await logoToDataUrl(f) });
                } catch (err) {
                  setError(err instanceof Error ? err.message : 'Não foi possível abrir a imagem.');
                }
              }}
            />
          </label>
          {d.logoDataUrl && (
            <Button variant="ghost" onClick={() => set({ logoDataUrl: null })}>
              Tirar
            </Button>
          )}
        </div>
      ),
    },
    {
      title: 'Quanto você quer faturar por mês?',
      hint: 'Vira a sua meta no Financeiro e no jogo. Se não quiser meta, pode pular.',
      ready: true,
      body: (
        <Money
          label="Meta de faturamento do mês"
          value={d.monthlyGoalCents}
          suffix="por mês"
          onChange={(c) => set({ monthlyGoalCents: c })}
        />
      ),
    },
  ];

  const last = step === steps.length - 1;
  const current = steps[step]!;

  async function finish() {
    setSaving(true);
    setError(null);
    try {
      const body: SetupAnswers = {
        ...d,
        fabrics: Object.entries(d.fabrics).map(([name, priceCents]) => ({ name, priceCents })),
        foams: Object.entries(d.foams).map(([name, priceCents]) => ({ name, priceCents })),
        servedCities: d.logistics.mode === 'NAO' ? [] : d.servedCities,
        logistics: d.logistics.mode === 'NAO' ? { mode: 'NAO', valueCents: null } : d.logistics,
      };
      await api('/api/onboarding/setup', { method: 'POST', body });
      await qc.invalidateQueries();
      toast('ok', 'Pronto! O sistema já está montado com as suas respostas.');
      router.push('/painel');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6" data-testid="setup-wizard">
      <div>
        <p className="text-sm font-medium text-ink-muted">
          Pergunta {step + 1} de {steps.length}
        </p>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-subtle" aria-hidden>
          <div
            className="h-full rounded-full bg-brand-700 transition-all"
            style={{ width: `${((step + 1) / steps.length) * 100}%` }}
          />
        </div>
      </div>
      <Card className="space-y-5 p-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{current.title}</h1>
          {current.hint && <p className="mt-1 text-[15px] text-ink-muted">{current.hint}</p>}
        </div>
        {current.body}
        {error && <Alert tone="danger">{error}</Alert>}
      </Card>
      <div className="flex items-center justify-between gap-3">
        {step > 0 ? (
          <Button
            variant="ghost"
            icon={<ArrowLeft className="size-4" aria-hidden />}
            onClick={() => setStep(step - 1)}
          >
            Voltar
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => router.push('/painel')}>
            Responder depois
          </Button>
        )}
        {last ? (
          <Button size="lg" loading={saving} onClick={finish} data-testid="setup-concluir">
            Montar o meu sistema
          </Button>
        ) : (
          <Button
            size="lg"
            disabled={!current.ready}
            onClick={() => setStep(step + 1)}
            data-testid="setup-proxima"
          >
            Próxima
          </Button>
        )}
      </div>
    </div>
  );
}
