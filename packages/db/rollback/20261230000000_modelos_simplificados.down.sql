-- REVERSÃO MANUAL da migration 20261230000000_modelos_simplificados (Simplificação, Fase 5).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior.
-- SEGURANÇA: aborta (sem alterar nada) se
--  - algum serviço já teve tarefas geradas pelos modelos simplificados (o histórico perderia o
--    modelo de origem);
--  - outro modelo recebeu tipos de serviço ou alguma etapa de outro modelo recebeu responsável
--    padrão (a configuração do gestor se perderia).
-- Nesses casos, recupere pelo backup anterior à migration. Modelos antigos não são tocados.
BEGIN;
DO $$
DECLARE n bigint; m bigint;
BEGIN
  SELECT count(*) INTO n FROM "production_tasks"
   WHERE "template_id" IN ('5f5e0000-0000-4000-8000-000000000001', '5f5e0000-0000-4000-8000-000000000002');
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % tarefa(s) gerada(s) pelos modelos simplificados. Restaure o backup anterior à migration.', n;
  END IF;
  SELECT (SELECT count(*) FROM "production_templates"
           WHERE cardinality(coalesce("service_types", ARRAY[]::"service_type"[])) > 0
             AND "id" NOT IN ('5f5e0000-0000-4000-8000-000000000001', '5f5e0000-0000-4000-8000-000000000002'))
       + (SELECT count(*) FROM "production_template_steps"
           WHERE "default_assignee_user_id" IS NOT NULL
             AND "template_id" NOT IN ('5f5e0000-0000-4000-8000-000000000001', '5f5e0000-0000-4000-8000-000000000002'))
    INTO m;
  IF m > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % configuração(ões) de tipo de serviço/responsável por etapa em outros modelos. Restaure o backup anterior à migration.', m;
  END IF;
END $$;
DELETE FROM "production_templates"
 WHERE "id" IN ('5f5e0000-0000-4000-8000-000000000001', '5f5e0000-0000-4000-8000-000000000002');
ALTER TABLE "production_template_steps" DROP CONSTRAINT IF EXISTS "production_template_steps_default_assignee_not_upholstery";
ALTER TABLE "production_template_steps" DROP CONSTRAINT IF EXISTS "production_template_steps_default_assignee_user_id_fkey";
ALTER TABLE "production_template_steps" DROP COLUMN IF EXISTS "default_assignee_user_id";
ALTER TABLE "production_templates" DROP COLUMN IF EXISTS "service_types";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261230000000_modelos_simplificados';
COMMIT;
