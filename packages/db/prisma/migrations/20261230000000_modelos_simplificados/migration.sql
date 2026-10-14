-- Simplificação Fase 5 — modelos de produção simplificados (D6, D7, D8, D14).
-- Migration ADITIVA: nenhuma coluna existente é alterada ou removida; nenhum modelo, tarefa,
-- titular ou valor existente é reescrito. Os modelos antigos continuam ativos como modelos
-- GERAIS (sem tipo de serviço) e seguem valendo para as combinações não cobertas; tarefas já
-- geradas guardam o próprio modelo e versão (serviços em andamento não mudam).

-- Tipos de serviço do modelo (vazio = modelo geral, comportamento anterior).
ALTER TABLE "production_templates"
  ADD COLUMN "service_types" "service_type"[] DEFAULT ARRAY[]::"service_type"[];

-- Responsável padrão da etapa (nulo = responsável padrão global da preparação).
ALTER TABLE "production_template_steps" ADD COLUMN "default_assignee_user_id" UUID;
ALTER TABLE "production_template_steps"
  ADD CONSTRAINT "production_template_steps_default_assignee_user_id_fkey"
  FOREIGN KEY ("default_assignee_user_id") REFERENCES "users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Tapeçaria é sempre do titular da peça: etapa TAPECARIA nunca tem responsável padrão.
ALTER TABLE "production_template_steps"
  ADD CONSTRAINT "production_template_steps_default_assignee_not_upholstery"
  CHECK ("default_assignee_user_id" IS NULL OR "step_class" IS DISTINCT FROM 'TAPECARIA');

-- Modelos simplificados como registros NOVOS (ids fixos, iguais a SIMPLIFIED_PRODUCTION_TEMPLATES
-- em packages/shared). Sem responsável padrão gravado aqui: a configuração (quem prepara) é do
-- gestor; o seed só preenche o que estiver vazio.
INSERT INTO "production_templates" ("id", "name", "piece_types", "service_types", "updated_at")
SELECT v.id, v.name, v.pieces, v.services, now()
FROM (VALUES
  ('5f5e0000-0000-4000-8000-000000000001'::uuid, 'Reforma de estofados (simplificado)',
   ARRAY['SOFA', 'CANTO_ALEMAO']::"piece_type"[], ARRAY['REFORMA_COMPLETA']::"service_type"[]),
  ('5f5e0000-0000-4000-8000-000000000002'::uuid, 'Fabricação de cabeceiras (simplificado)',
   ARRAY['CABECEIRA']::"piece_type"[], ARRAY['FABRICACAO']::"service_type"[])
) AS v(id, name, pieces, services)
WHERE NOT EXISTS (SELECT 1 FROM "production_templates" t WHERE t."id" = v.id);

INSERT INTO "production_template_steps"
  ("id", "template_id", "position", "activity", "name", "role", "requires_materials", "optional",
   "depends_on", "step_class")
SELECT gen_random_uuid(), s.t, s.p, s.a::"production_activity", s.n, s.r::"task_role", s.m, false,
       s.d, s.c::"step_class"
FROM (VALUES
  ('5f5e0000-0000-4000-8000-000000000001'::uuid, 1, 'DESMONTAGEM', 'Desmontagem e preparação',
   'APOIO', false, ARRAY[]::int[], 'PREPARACAO'),
  ('5f5e0000-0000-4000-8000-000000000001'::uuid, 2, 'CORTE_TECIDO', 'Corte e costura',
   'PRINCIPAL', true, ARRAY[]::int[], 'TAPECARIA'),
  ('5f5e0000-0000-4000-8000-000000000001'::uuid, 3, 'MONTAGEM', 'Montagem e acabamento',
   'PRINCIPAL', true, ARRAY[1, 2], 'TAPECARIA'),
  ('5f5e0000-0000-4000-8000-000000000002'::uuid, 1, 'PREPARACAO_MDF', 'Corte e preparação',
   'APOIO', true, ARRAY[]::int[], 'PREPARACAO'),
  ('5f5e0000-0000-4000-8000-000000000002'::uuid, 2, 'REVESTIMENTO', 'Tapeçaria e acabamento',
   'PRINCIPAL', true, ARRAY[1], 'TAPECARIA')
) AS s(t, p, a, n, r, m, d, c)
WHERE NOT EXISTS (
  SELECT 1 FROM "production_template_steps" x WHERE x."template_id" = s.t AND x."position" = s.p
);
