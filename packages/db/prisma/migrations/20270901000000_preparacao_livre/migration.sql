-- 2026-11-19 (pedido do Raphael): etapas de preparação/desmontagem não têm responsável escolhido
-- pelo dono. Ficam livres no tablet dos ajudantes disponíveis; o primeiro que toca em Iniciar
-- fica com a tarefa.
--
-- Só dados: as etapas de preparação ainda NÃO iniciadas (fila semanal) perdem o responsável
-- automático que receberam antes e passam a ser livres. Nada iniciado, pausado ou concluído muda
-- (o histórico de quem fez continua igual). As que estavam esperando "sem responsável" são
-- liberadas pela reavaliação automática da API (release tick), sem passo manual.
UPDATE "production_tasks" AS t
SET "assignee_user_id" = NULL,
    "version" = t."version" + 1,
    "updated_at" = now()
FROM "production_plans" AS p
WHERE p."id" = t."plan_id"
  AND p."mode" = 'FILA_SEMANAL'
  AND t."step_class" = 'PREPARACAO'
  AND t."status"::text IN ('RASCUNHO', 'BLOQUEADA', 'PROGRAMADA', 'LIBERADA')
  AND t."started_at" IS NULL
  AND t."assignee_user_id" IS NOT NULL;

-- As etapas de preparação dos modelos deixam de ter responsável padrão (ninguém é escolhido).
UPDATE "production_template_steps"
SET "default_assignee_user_id" = NULL
WHERE "step_class" = 'PREPARACAO'
  AND "default_assignee_user_id" IS NOT NULL;
