-- REVERSÃO MANUAL da migration 20270302000000_modulos_configuraveis (Reformulação, Fase 0).
-- Uso somente com backup recente e a aplicação PARADA, voltando ao código anterior (que ignora a
-- tabela). SEGURANÇA: aborta (sem alterar nada) se alguma funcionalidade está DESLIGADA — a
-- versão anterior a trataria como ligada sem aviso. Religue pela tela Empresa → Funcionalidades
-- antes de reverter. Linhas com a funcionalidade ligada equivalem ao padrão: nada se perde.
BEGIN;
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM "module_settings" WHERE NOT "enabled";
  IF n > 0 THEN
    RAISE EXCEPTION 'Reversão bloqueada: % funcionalidade(s) desligada(s) em module_settings. Religue antes de reverter.', n;
  END IF;
END $$;
DROP TABLE "module_settings";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20270302000000_modulos_configuraveis';
COMMIT;
