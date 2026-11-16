-- Reformulação, Fase 3 — somente aditiva (nenhuma linha existente muda).

-- ============================================================ qualidade: autoaprovação do gestor
-- D4: o gestor pode aprovar a própria execução com justificativa obrigatória. NULL = aprovação
-- comum (ou inspeção ainda não decidida). Identidade e data já estão em decided_by_id/decided_at.
ALTER TABLE "quality_inspections" ADD COLUMN "self_approval_reason" VARCHAR(500);
ALTER TABLE "quality_inspections" ADD CONSTRAINT "quality_inspections_self_approval" CHECK (
  "self_approval_reason" IS NULL
  OR ("status" = 'APROVADA' AND length(btrim("self_approval_reason")) >= 10));

-- ============================================================ embalagem opcional
-- Se a embalagem era exigida quando a inspeção foi aprovada (interruptor "embalagem" da Fase 0).
-- Gravado na aprovação: ligar/desligar depois não muda o que já foi decidido. As inspeções que já
-- existem ficam TRUE (o comportamento de sempre).
ALTER TABLE "quality_inspections" ADD COLUMN "packaging_required" BOOLEAN NOT NULL DEFAULT true;

-- ============================================================ desfazer a entrega direta (D5)
-- A entrega direta desfeita CONTINUA registrada (status CONCLUIDA preservado): estas colunas a
-- marcam como desfeita, com quem, quando e por quê. Os itens dela passam a NAO_ENTREGUE e
-- inativos (valores que a tabela já aceitava), e todas as leituras de "entregue" os ignoram.
ALTER TABLE "deliveries" ADD COLUMN "reverted_at" TIMESTAMPTZ(3);
ALTER TABLE "deliveries" ADD COLUMN "reverted_by_id" UUID;
ALTER TABLE "deliveries" ADD COLUMN "revert_reason" VARCHAR(500);
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_reverted_by_id_fkey"
  FOREIGN KEY ("reverted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_revert" CHECK (
  ("reverted_at" IS NULL AND "revert_reason" IS NULL AND "reverted_by_id" IS NULL)
  OR ("reverted_at" IS NOT NULL AND "origin" = 'DIRETA' AND "status" = 'CONCLUIDA'
      AND length(btrim("revert_reason")) >= 10));
