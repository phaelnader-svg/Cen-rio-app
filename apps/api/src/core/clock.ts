/**
 * Relógio operacional da aplicação: o horário do servidor. Os testes (e o relógio de teste,
 * só em APP_ENV=test) podem deslocá-lo para simular virada de dia/semana de forma
 * determinística. Presença, ajuda, ocorrências E a liberação/início das tarefas usam o mesmo
 * relógio — antes, a liberação usava `new Date()` e ignorava o relógio de teste.
 */
let clockFn: () => Date = () => new Date();
export const now = () => clockFn();
export function setClock(fn?: () => Date) {
  clockFn = fn ?? (() => new Date());
}

/**
 * Carimbo de tarefas "para já" (apoio, resolução, correção, embalagem, antecipação): nunca no
 * futuro do relógio operacional nem do real. Em produção os dois coincidem; com o relógio de
 * teste adiantado, a tarefa fica na data real (como antes) e continua liberada.
 */
export function immediateAt() {
  const real = new Date();
  const c = clockFn();
  return c.getTime() < real.getTime() ? c : real;
}
